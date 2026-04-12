/**
 * calibration-source.ts — Read calibration-state.{slot}.json written by fetch-quotas.sh.
 *
 * Used by statusline-formatter to upgrade live_util_estimate display from
 * token-only to calibration-aware "~live" label when confidence >= low.
 *
 * File path: ~/.claude/session-health/calibration-state.{slot}.json
 * Shell writer: ~/_claude-configs/hot-swap/scripts/fetch-quotas.sh (_update_calibration_state)
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { validateCalibrationState } from '../quota-schema';

export interface CalibrationState {
  schema_version: number;
  slot: string;
  last_updated_epoch: number;
  tokens_per_percent_samples: number[];
  tokens_per_percent_avg: number;
  tokens_per_percent_stddev: number;
  confidence: 'none' | 'low' | 'high';
  last_drift_event: number | null;
  last_drift_magnitude_pct: number | null;
}

export interface CalibrationReadResult {
  state: CalibrationState | null;
  ageS: number;   // seconds since last_updated_epoch
  isStale: boolean; // ageS > 900 (15 min — calibration only updates on API fetch ~10-60min)
}

const STALE_TTL_S = 900;  // 15 min — if no new API fetch, calibration is still valid

/**
 * Read calibration state for the given slot.
 * Returns null state on file missing, parse error, or slot mismatch.
 * isStale=true when ageS > 900s (no new API fetch in 15 min).
 */
export function readCalibrationState(slotId: string): CalibrationReadResult {
  const NULL_RESULT: CalibrationReadResult = { state: null, ageS: 0, isStale: true };

  const path = `${homedir()}/.claude/session-health/calibration-state.${slotId}.json`;

  try {
    if (!existsSync(path)) return NULL_RESULT;

    const raw = readFileSync(path, 'utf-8');
    const obj = JSON.parse(raw) as unknown;

    const result = validateCalibrationState(obj);
    if (!result.ok) return NULL_RESULT;

    const state = obj as CalibrationState;

    // Slot guard
    if (state.slot !== slotId) return NULL_RESULT;

    const nowS = Math.floor(Date.now() / 1000);
    const ageS = Math.max(0, nowS - state.last_updated_epoch);
    const isStale = ageS > STALE_TTL_S;

    return { state, ageS, isStale };
  } catch {
    return NULL_RESULT;
  }
}
