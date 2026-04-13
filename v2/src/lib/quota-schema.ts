/**
 * quota-schema.ts - Schema validation for quota data pipeline
 *
 * All readers/writers of quota JSON/YAML must validate through these functions.
 * Shell mirror: ~/_claude-configs/shell-config/lib/quota-schema.sh
 *
 * Return shape: {ok: boolean, errors: string[]}
 * 3 consecutive bad reads -> quarantine file (rename to .corrupt-{ts})
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';

export const QUOTA_SCHEMA_VERSION = 1;

const EPOCH_WINDOW_S = 30 * 24 * 3600; // +/-30 days

// ---- P1-h: File-backed bad-read counter ----------------------------------------
// Per-spawn bun invalidates module-level state — counters must be file-backed so the
// 3-strike quarantine contract survives across invocations. The module-level Map is
// kept ONLY as a within-process cache; the file is the source of truth.
// Race note (P1-h): concurrent bun spawns can race on RMW of the counts file
// (last-write-wins). This is accepted — quarantine is a 3-strike approximation.

interface BadReadEntry { count: number; first_bad_at: number; last_bad_at: number; }
type BadReadCounts = Record<string, BadReadEntry>;

// Within-process cache — reduces file I/O for repeated bad reads in same spawn.
const BAD_READ_COUNTS = new Map<string, number>();

function _badCountsPath(): string {
  return `${homedir()}/.claude/session-health/.lkg-bad-read-counts.json`;
}

function _loadBadCounts(): BadReadCounts {
  const p = _badCountsPath();
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, 'utf-8');
    return JSON.parse(raw) as BadReadCounts;
  } catch {
    // Parse error → log via heartbeat (best-effort import to avoid circular dep)
    try {
      const { writeHeartbeat } = require('./heartbeat') as typeof import('./heartbeat');
      writeHeartbeat('quota-schema', 'bad_read_counts_parse_error', {
        status: 'warn',
        extra: { path: p },
      });
    } catch { /* heartbeat unavailable — absorb */ }
    return {};
  }
}

function _saveBadCounts(counts: BadReadCounts): void {
  const p = _badCountsPath();
  const tmp = `${p}.tmp.${process.pid}`;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(tmp, JSON.stringify(counts));
    renameSync(tmp, p);
  } catch { /* best-effort — do not throw to caller */ }
}

function _getBadCount(key: string): number {
  // Prefer in-process cache; fall back to file for first access from this spawn
  if (BAD_READ_COUNTS.has(key)) return BAD_READ_COUNTS.get(key)!;
  const counts = _loadBadCounts();
  const val = counts[key]?.count ?? 0;
  BAD_READ_COUNTS.set(key, val);
  return val;
}

function _incrementBadCount(key: string): number {
  const counts = _loadBadCounts();
  const prev = counts[key];
  const now = Date.now();
  const entry: BadReadEntry = {
    count: (prev?.count ?? 0) + 1,
    first_bad_at: prev?.first_bad_at ?? now,
    last_bad_at: now,
  };
  counts[key] = entry;
  _saveBadCounts(counts);
  BAD_READ_COUNTS.set(key, entry.count);
  return entry.count;
}

function _clearBadCount(key: string): void {
  const counts = _loadBadCounts();
  if (key in counts) {
    delete counts[key];
    _saveBadCounts(counts);
  }
  BAD_READ_COUNTS.delete(key);
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export interface ReadResult<T> {
  data: T | null;
  isStale: boolean;
  fromLkg: boolean;
}

// ---- Internal helpers --------------------------------------------------------

function epochInRange(val: unknown): boolean {
  if (typeof val !== 'number') return false;
  const now = Math.floor(Date.now() / 1000);
  return val >= now - EPOCH_WINDOW_S && val <= now + EPOCH_WINDOW_S;
}

function pctInRange(val: unknown): boolean {
  if (typeof val !== 'number') return false;
  return val >= 0 && val <= 100;
}

function isNumberOrNull(val: unknown): boolean {
  return val === null || typeof val === 'number';
}

const VALID_PACING = new Set([
  'under', 'slow', 'on_track', 'fast', 'over', 'wasted',
  'way_too_slow', 'not_fast_enough', 'a_bit_too_slow', 'good',
  'much_too_fast', 'way_too_fast', 'exhausted', 'reset', 'unknown',
]);

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pass(): ValidationResult { return { ok: true, errors: [] }; }
function fail(errors: string[]): ValidationResult { return { ok: false, errors }; }

// ---- validateHotSwapQuota ---------------------------------------------------
// Validates top-level slot-keyed object. Each slot: five_hour_util, seven_day_util.
export function validateHotSwapQuota(obj: unknown): ValidationResult {
  if (!isObj(obj)) return fail(['parse: not an object']);

  const slotEntries = Object.entries(obj).filter(([, v]) => isObj(v));
  if (slotEntries.length === 0) return fail(['required: no slot entries found']);

  const errors: string[] = [];
  for (const [slotId, slot] of slotEntries) {
    if (!isObj(slot)) continue;
    if (!('five_hour_util' in slot) || !('seven_day_util' in slot)) {
      errors.push(`required: slot ${slotId} missing five_hour_util or seven_day_util`);
      continue;
    }
    if (!pctInRange(slot.five_hour_util)) {
      errors.push(`range: slot ${slotId} five_hour_util out of [0,100]: ${slot.five_hour_util}`);
    }
    if (!pctInRange(slot.seven_day_util)) {
      errors.push(`range: slot ${slotId} seven_day_util out of [0,100]: ${slot.seven_day_util}`);
    }
  }

  return errors.length === 0 ? pass() : fail(errors);
}

// ---- validateMergedCache ----------------------------------------------------
// Required: ts (epoch), active_slot (string), slots (object).
// Per-slot: five_hour_util [0-100], pacing_status_5h (enum), target_burn_rate_5h (number|null).
export function validateMergedCache(obj: unknown): ValidationResult {
  if (!isObj(obj)) return fail(['parse: not an object']);

  const errors: string[] = [];

  if (typeof obj.ts !== 'number') errors.push('required: ts missing or not a number');
  if (typeof obj.active_slot !== 'string') errors.push('required: active_slot missing or not a string');
  if (!isObj(obj.slots)) errors.push('required: slots missing or not an object');

  if (errors.length > 0) return fail(errors);

  if (!epochInRange(obj.ts as number)) {
    errors.push(`range: ts ${obj.ts} outside +/-30d window`);
  }

  const slots = obj.slots as Record<string, unknown>;
  for (const [slotId, slot] of Object.entries(slots)) {
    if (!isObj(slot)) {
      errors.push(`required: slot ${slotId} not an object`);
      continue;
    }
    if ('five_hour_util' in slot && !pctInRange(slot.five_hour_util)) {
      errors.push(`range: slot ${slotId} five_hour_util out of [0,100]: ${slot.five_hour_util}`);
    }
    if ('pacing_status_5h' in slot && slot.pacing_status_5h !== null && slot.pacing_status_5h !== undefined) {
      if (!VALID_PACING.has(slot.pacing_status_5h as string)) {
        errors.push(`range: slot ${slotId} pacing_status_5h invalid: ${slot.pacing_status_5h}`);
      }
    }
    if ('target_burn_rate_5h' in slot && !isNumberOrNull(slot.target_burn_rate_5h)) {
      errors.push(`range: slot ${slotId} target_burn_rate_5h must be number or null`);
    }
  }

  return errors.length === 0 ? pass() : fail(errors);
}

// ---- validateLiveBurnEstimate -----------------------------------------------
// Required: ts, slot, tokens_5h, tokens_per_hour, live_util_estimate [0-100], calibration_age_s.
export function validateLiveBurnEstimate(obj: unknown): ValidationResult {
  if (!isObj(obj)) return fail(['parse: not an object']);

  const errors: string[] = [];

  for (const key of ['ts', 'slot', 'tokens_5h', 'tokens_per_hour', 'live_util_estimate', 'calibration_age_s']) {
    if (!(key in obj)) errors.push(`required: ${key} missing`);
  }
  if (errors.length > 0) return fail(errors);

  if (!epochInRange(obj.ts as number)) {
    errors.push(`range: ts ${obj.ts} outside +/-30d window`);
  }
  // live_util_estimate may be null (uncalibrated — calibration task #23 not yet done)
  if (obj.live_util_estimate !== null && !pctInRange(obj.live_util_estimate)) {
    errors.push(`range: live_util_estimate out of [0,100]: ${obj.live_util_estimate}`);
  }
  if (typeof obj.tokens_per_hour !== 'number') {
    errors.push('range: tokens_per_hour must be a number');
  }
  const cAge = obj.calibration_age_s;
  if (typeof cAge !== 'number' || cAge < 0) {
    errors.push('range: calibration_age_s must be non-negative number');
  }

  return errors.length === 0 ? pass() : fail(errors);
}

// ---- validateRateLimitState -------------------------------------------------
// Required: consecutive_rate_limits (int), backoff_until_epoch (epoch), last_hit (string).
export function validateRateLimitState(obj: unknown): ValidationResult {
  if (!isObj(obj)) return fail(['parse: not an object']);

  const errors: string[] = [];

  for (const key of ['consecutive_rate_limits', 'backoff_until_epoch', 'last_hit']) {
    if (!(key in obj)) errors.push(`required: ${key} missing`);
  }
  if (errors.length > 0) return fail(errors);

  const crl = obj.consecutive_rate_limits;
  if (typeof crl !== 'number' || !Number.isInteger(crl) || crl < 0) {
    errors.push('range: consecutive_rate_limits must be non-negative integer');
  }
  const bue = obj.backoff_until_epoch;
  if (typeof bue !== 'number') {
    errors.push('range: backoff_until_epoch must be a number');
  } else if (bue !== 0 && !epochInRange(bue)) {
    errors.push(`range: backoff_until_epoch ${bue} outside +/-30d window`);
  }
  if (typeof obj.last_hit !== 'string' || obj.last_hit === '') {
    errors.push('required: last_hit must be non-empty string');
  }

  return errors.length === 0 ? pass() : fail(errors);
}

// ---- validateCalibrationState -----------------------------------------------
// Required: schema_version (1), slot (string), last_updated_epoch (epoch),
//           tokens_per_percent_samples (number[]), tokens_per_percent_avg (number),
//           tokens_per_percent_stddev (number), confidence ("none"|"low"|"high"),
//           last_drift_event (epoch|null), last_drift_magnitude_pct (number|null)
export function validateCalibrationState(obj: unknown): ValidationResult {
  if (!isObj(obj)) return fail(['parse: not an object']);

  const errors: string[] = [];

  for (const key of [
    'schema_version', 'slot', 'last_updated_epoch', 'tokens_per_percent_samples',
    'tokens_per_percent_avg', 'tokens_per_percent_stddev', 'confidence',
  ]) {
    if (!(key in obj)) errors.push(`required: ${key} missing`);
  }
  if (errors.length > 0) return fail(errors);

  if (obj.schema_version !== 1) {
    errors.push(`range: schema_version must be 1, got ${obj.schema_version}`);
  }
  if (typeof obj.slot !== 'string' || obj.slot === '') {
    errors.push('required: slot must be non-empty string');
  }
  if (!epochInRange(obj.last_updated_epoch as number)) {
    errors.push(`range: last_updated_epoch ${obj.last_updated_epoch} outside +/-30d window`);
  }
  if (!Array.isArray(obj.tokens_per_percent_samples)) {
    errors.push('required: tokens_per_percent_samples must be array');
  } else if (obj.tokens_per_percent_samples.length > 10) {
    errors.push(`range: tokens_per_percent_samples length ${obj.tokens_per_percent_samples.length} > 10`);
  }
  if (typeof obj.tokens_per_percent_avg !== 'number' || (obj.tokens_per_percent_avg as number) < 0) {
    errors.push('range: tokens_per_percent_avg must be non-negative number');
  }
  if (typeof obj.tokens_per_percent_stddev !== 'number' || (obj.tokens_per_percent_stddev as number) < 0) {
    errors.push('range: tokens_per_percent_stddev must be non-negative number');
  }
  const validConf = new Set(['none', 'low', 'high']);
  if (!validConf.has(obj.confidence as string)) {
    errors.push(`range: confidence must be none|low|high, got ${obj.confidence}`);
  }
  // last_drift_event: null or epoch
  if ('last_drift_event' in obj && obj.last_drift_event !== null) {
    if (!epochInRange(obj.last_drift_event as number)) {
      errors.push(`range: last_drift_event ${obj.last_drift_event} outside +/-30d window`);
    }
  }
  // last_drift_magnitude_pct: null or non-negative number
  if ('last_drift_magnitude_pct' in obj && obj.last_drift_magnitude_pct !== null) {
    if (typeof obj.last_drift_magnitude_pct !== 'number' || (obj.last_drift_magnitude_pct as number) < 0) {
      errors.push('range: last_drift_magnitude_pct must be non-negative number or null');
    }
  }

  return errors.length === 0 ? pass() : fail(errors);
}

// ---- readWithLkg ------------------------------------------------------------
// Reads path, validates. On bad read falls back to lkg_path (with isStale=true).
// 3 consecutive bad reads -> quarantine path to .corrupt-{epoch}.
export function readWithLkg<T>(
  path: string,
  validate: (obj: unknown) => ValidationResult,
  lkgPath: string,
): ReadResult<T> {
  let parsed: T | null = null;
  let valid = false;

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, 'utf-8');
      const obj = JSON.parse(raw) as unknown;
      const result = validate(obj);
      if (result.ok) {
        parsed = obj as T;
        valid = true;
      }
    } catch {
      // parse failure - fall through to lkg
    }
  }

  if (valid && parsed !== null) {
    _clearBadCount(path);
    try {
      mkdirSync(dirname(lkgPath), { recursive: true });
      // PID-qualified tmp path: concurrent bun processes must not race on the
      // same `.tmp` file, which truncates in-flight writes from another process.
      const tmpPath = `${lkgPath}.tmp.${process.pid}`;
      writeFileSync(tmpPath, JSON.stringify(parsed));
      renameSync(tmpPath, lkgPath);
    } catch { /* best-effort lkg update */ }
    return { data: parsed, isStale: false, fromLkg: false };
  }

  // Bad read — file-backed counter (P1-h)
  const newCount = _incrementBadCount(path);

  if (newCount >= 3 && existsSync(path)) {
    const quarantine = `${path}.corrupt-${Math.floor(Date.now() / 1000)}`;
    try { renameSync(path, quarantine); } catch { /* best-effort */ }
    _clearBadCount(path);
  }

  // Fallback to lkg
  if (existsSync(lkgPath)) {
    try {
      const raw = readFileSync(lkgPath, 'utf-8');
      const obj = JSON.parse(raw) as T;
      const stale = { ...(obj as object), isStale: true } as T;
      return { data: stale, isStale: true, fromLkg: true };
    } catch { /* lkg also corrupt */ }
  }

  return { data: null, isStale: true, fromLkg: false };
}

export const _quotaSchemaHealthPath = `${homedir()}/.claude/session-health/pipeline-heartbeat.jsonl`;
