/**
 * live-burn-source.ts — Tier 2 live burn estimate reader
 *
 * Reads ~/.claude/session-health/live-burn-estimate.json written every 5s by
 * the transcript-sampler launchd service. Returns null on slot mismatch or
 * any parse/IO error (fail-open: caller gets API baseline).
 *
 * LKG path: live-burn-estimate.lkg.json — used on bad reads (stale but valid).
 * Staleness threshold: 30s (sampler writes every 5s; >30s = something is wrong).
 * Dead threshold:      60s (sampler appears dead → emit notification).
 */

import { statSync } from 'fs';
import { homedir } from 'os';
import { readWithLkg, validateLiveBurnEstimate } from '../quota-schema';

export interface LiveBurnEstimate {
  schema_version: number;
  ts: number;                     // epoch seconds of write
  slot: string;                   // e.g. "slot-1"
  tokens_5h: number;              // total tokens in last 5h window
  tokens_per_hour: number;        // tokens/hr derived from window
  tokens_last_1h: number;         // tokens seen in last 1h
  live_util_estimate: number | null; // % of 5h budget — null if uncalibrated (#23)
  calibration_age_s: number;      // seconds since last API calibration pair
  sample_mtime_min: number | null; // oldest transcript mtime sampled (epoch s)
  sample_mtime_max: number | null; // newest transcript mtime sampled (epoch s)
  session_count: number;          // number of session files in window
  window_hours: number;           // sampling window (always 5)
}

export interface LiveBurnReadResult {
  estimate: LiveBurnEstimate | null;
  ageS: number;       // seconds since ts field (0 when estimate is null)
  isStale: boolean;   // ageS > 30s
  fromLkg: boolean;   // true when returned from last-known-good fallback
}

const LIVE_BURN_PATH = `${homedir()}/.claude/session-health/live-burn-estimate.json`;
const LIVE_BURN_LKG  = `${homedir()}/.claude/session-health/live-burn-estimate.lkg.json`;

const STALE_TTL_S = 30;  // sampler writes every 5s — >30s is stale

/**
 * Read and validate the live burn estimate for the given active slot.
 *
 * Returns null estimate when:
 * - File missing/corrupt (readWithLkg returns null)
 * - estimate.slot !== activeSlot (wrong session's data)
 * - Any unexpected throw (absorbed)
 *
 * isStale=true when ageS > 30 (estimate may still be returned for display).
 */
export function readLiveBurnEstimate(activeSlot: string): LiveBurnReadResult {
  const NULL_RESULT: LiveBurnReadResult = { estimate: null, ageS: 0, isStale: true, fromLkg: false };

  try {
    const { data, isStale: lkgStale, fromLkg } = readWithLkg<LiveBurnEstimate>(
      LIVE_BURN_PATH,
      validateLiveBurnEstimate,
      LIVE_BURN_LKG,
    );

    if (!data) return NULL_RESULT;

    // Slot guard — only return data for the active session's slot
    if (data.slot !== activeSlot) return NULL_RESULT;

    // Compute age from ts field (epoch seconds)
    const nowS = Math.floor(Date.now() / 1000);
    const ageS = Math.max(0, nowS - data.ts);
    const isStale = ageS > STALE_TTL_S;

    return { estimate: data, ageS, isStale: isStale || lkgStale, fromLkg };
  } catch {
    return NULL_RESULT;
  }
}

/**
 * Get file mtime age in seconds (independent of ts field).
 * Used for dead-sampler detection where ts might be stale while file still exists.
 * Returns null if file is absent.
 */
export function liveBurnFileMtimeAgeS(): number | null {
  try {
    const { mtimeMs } = statSync(LIVE_BURN_PATH);
    return Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  } catch {
    return null;
  }
}
