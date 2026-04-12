/**
 * Live Burn Blend — Unit Tests
 *
 * Covers Task #22: TS formatter blend live-burn-estimate into statusline.
 *
 * Tests:
 * - readLiveBurnEstimate: file missing → null
 * - readLiveBurnEstimate: slot mismatch → null
 * - readLiveBurnEstimate: ageS > 30 → isStale=true (estimate still returned)
 * - fmtBurnRate: fresh live data appends tokens/h suffix
 * - fmtBurnRate: stale/null live data → no suffix
 * - fmtTokPerHour: edge cases
 * - Integration: mock fmtBurnRate via slot + liveEstimate args
 */

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { StatuslineFormatter } from '../../src/lib/statusline-formatter';
import type { MergedQuotaSlot } from '../../src/types/session-health';
import * as liveBurnSource from '../../src/lib/sources/live-burn-source';
import type { LiveBurnEstimate } from '../../src/lib/sources/live-burn-source';

// ── Test accessor ─────────────────────────────────────────────────────────────
const Fmt = StatuslineFormatter as any;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSlot(overrides: Partial<MergedQuotaSlot> = {}): MergedQuotaSlot {
  return {
    email: 'test@example.com',
    status: 'active',
    subscription_type: 'max',
    five_hour_util: 50,
    seven_day_util: 60,
    weekly_budget_remaining_hours: 72,
    weekly_reset_day: 'Mon',
    daily_reset_time: '14:00',
    last_fetched: Date.now(),
    is_fresh: true,
    urgency: 5,
    rank: 1,
    reason: 'test',
    ...overrides,
  };
}

function makeLiveEstimate(overrides: Partial<LiveBurnEstimate> = {}): LiveBurnEstimate {
  return {
    schema_version: 1,
    ts: Math.floor(Date.now() / 1000),
    slot: 'slot-1',
    tokens_5h: 1_000_000,
    tokens_per_hour: 3_200,
    tokens_last_1h: 3_200,
    live_util_estimate: null,
    calibration_age_s: 400,
    sample_mtime_min: null,
    sample_mtime_max: null,
    session_count: 2,
    window_hours: 5,
    ...overrides,
  };
}

// ── NO_COLOR fixture ──────────────────────────────────────────────────────────

let origNoColor: string | undefined;
beforeEach(() => {
  origNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = '1';
});
afterEach(() => {
  if (origNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = origNoColor;
  }
});

// ── readLiveBurnEstimate ──────────────────────────────────────────────────────

describe('readLiveBurnEstimate — file missing', () => {
  test('returns null estimate when file does not exist', () => {
    // Use a non-existent slot so real file (if any) won't match
    const result = liveBurnSource.readLiveBurnEstimate('slot-nonexistent-zzz');
    // Either the file is missing → null, or the slot doesn't match → null
    expect(result.estimate).toBeNull();
  });
});

describe('readLiveBurnEstimate — slot mismatch', () => {
  test('returns null when active slot differs from estimate slot', () => {
    // The real live-burn-estimate.json is for slot-1; pass slot-99 to trigger mismatch
    const result = liveBurnSource.readLiveBurnEstimate('slot-99-nomatch');
    expect(result.estimate).toBeNull();
    expect(result.ageS).toBe(0);
    expect(result.isStale).toBe(true);
    expect(result.fromLkg).toBe(false);
  });
});

describe('readLiveBurnEstimate — staleness', () => {
  test('isStale=true when ageS > 30', () => {
    // Write a file with ts 60s in the past
    const dir = `${homedir()}/.claude/session-health`;
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const path = `${dir}/live-burn-estimate.json`;
    const lkgPath = `${dir}/live-burn-estimate.lkg.json`;

    const staleTs = Math.floor(Date.now() / 1000) - 60; // 60s ago
    const payload = JSON.stringify({
      schema_version: 1,
      ts: staleTs,
      slot: 'slot-test-stale',
      tokens_5h: 500_000,
      tokens_per_hour: 100_000,
      tokens_last_1h: 100_000,
      live_util_estimate: null,
      calibration_age_s: 10,
      sample_mtime_min: null,
      sample_mtime_max: null,
      session_count: 1,
      window_hours: 5,
    });

    const origContent = existsSync(path) ? require('fs').readFileSync(path, 'utf-8') : null;
    writeFileSync(path, payload);

    try {
      const result = liveBurnSource.readLiveBurnEstimate('slot-test-stale');
      expect(result.estimate).not.toBeNull();
      expect(result.ageS).toBeGreaterThan(30);
      expect(result.isStale).toBe(true);
    } finally {
      // Restore original or remove test file
      if (origContent !== null) {
        writeFileSync(path, origContent);
      } else {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
      // Clean up lkg if we wrote to it
      try { unlinkSync(lkgPath); } catch { /* ignore */ }
    }
  });

  test('isStale=false when ageS <= 30', () => {
    const dir = `${homedir()}/.claude/session-health`;
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const path = `${dir}/live-burn-estimate.json`;
    const lkgPath = `${dir}/live-burn-estimate.lkg.json`;

    const freshTs = Math.floor(Date.now() / 1000) - 5; // 5s ago
    const payload = JSON.stringify({
      schema_version: 1,
      ts: freshTs,
      slot: 'slot-test-fresh',
      tokens_5h: 500_000,
      tokens_per_hour: 100_000,
      tokens_last_1h: 100_000,
      live_util_estimate: null,
      calibration_age_s: 10,
      sample_mtime_min: null,
      sample_mtime_max: null,
      session_count: 1,
      window_hours: 5,
    });

    const origContent = existsSync(path) ? require('fs').readFileSync(path, 'utf-8') : null;
    writeFileSync(path, payload);

    try {
      const result = liveBurnSource.readLiveBurnEstimate('slot-test-fresh');
      expect(result.estimate).not.toBeNull();
      expect(result.ageS).toBeLessThanOrEqual(30);
      expect(result.isStale).toBe(false);
    } finally {
      if (origContent !== null) {
        writeFileSync(path, origContent);
      } else {
        try { unlinkSync(path); } catch { /* ignore */ }
      }
      try { unlinkSync(lkgPath); } catch { /* ignore */ }
    }
  });
});

// ── fmtTokPerHour ──────────────────────────────────────────────────────────────

describe('fmtTokPerHour — edge cases', () => {
  test('0 → "0"', () => {
    expect(Fmt.fmtTokPerHour(0)).toBe('0');
  });

  test('negative → "0"', () => {
    expect(Fmt.fmtTokPerHour(-100)).toBe('0');
  });

  test('999 → "999"', () => {
    expect(Fmt.fmtTokPerHour(999)).toBe('999');
  });

  test('1000 → "1.0k"', () => {
    expect(Fmt.fmtTokPerHour(1000)).toBe('1.0k');
  });

  test('1500 → "1.5k"', () => {
    expect(Fmt.fmtTokPerHour(1500)).toBe('1.5k');
  });

  test('3200 → "3.2k"', () => {
    expect(Fmt.fmtTokPerHour(3200)).toBe('3.2k');
  });

  test('99999 → "100.0k"', () => {
    expect(Fmt.fmtTokPerHour(99999)).toBe('100.0k');
  });

  test('100000 → "100k"', () => {
    expect(Fmt.fmtTokPerHour(100_000)).toBe('100k');
  });

  test('1000000 → "1000k"', () => {
    expect(Fmt.fmtTokPerHour(1_000_000)).toBe('1000k');
  });

  test('Infinity → "0"', () => {
    expect(Fmt.fmtTokPerHour(Infinity)).toBe('0');
  });
});

// ── fmtBurnRate — live suffix ─────────────────────────────────────────────────

describe('fmtBurnRate — live suffix', () => {
  test('appends tok/h suffix when live estimate is fresh', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 5,
      burn_sample_count_5h: 3,
      pacing_status_5h: 'good',
    });
    const live = makeLiveEstimate({ tokens_per_hour: 3_200, session_count: 2 });
    const result: string = Fmt.fmtBurnRate(slot, live, 10); // ageS=10 → fresh
    expect(result).toContain('🔥:');
    expect(result).toContain('3.2k/h~live');
  });

  test('omits suffix when liveEstimate is null', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 5,
      burn_sample_count_5h: 3,
    });
    const result: string = Fmt.fmtBurnRate(slot, null, 0);
    expect(result).toContain('🔥:');
    expect(result).not.toContain('~live');
  });

  test('omits suffix when ageS > 30 (stale)', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 5,
      burn_sample_count_5h: 3,
    });
    const live = makeLiveEstimate({ tokens_per_hour: 3_200, session_count: 2 });
    const result: string = Fmt.fmtBurnRate(slot, live, 45); // ageS=45 → stale
    expect(result).toContain('🔥:');
    expect(result).not.toContain('~live');
  });

  test('omits suffix when session_count === 0 (no active sessions)', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 5,
      burn_sample_count_5h: 3,
    });
    const live = makeLiveEstimate({ tokens_per_hour: 3_200, session_count: 0 });
    const result: string = Fmt.fmtBurnRate(slot, live, 5);
    expect(result).not.toContain('~live');
  });

  test('no suffix when both 5h and 7d rates absent — returns empty string', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: null,
      five_hour_burn_rate: null,
      seven_day_burn_rate_per_day: null,
      target_burn_rate_5h: null,
      target_burn_rate_7d_per_day: null,
      burn_sample_count_5h: 0,
    });
    const live = makeLiveEstimate({ tokens_per_hour: 3_200, session_count: 2 });
    const result: string = Fmt.fmtBurnRate(slot, live, 5);
    // No rates → empty string (not even the live suffix, because there's no 🔥 base)
    expect(result).toBe('');
  });

  test('suffix uses fmtTokPerHour formatting (sub-1k)', () => {
    const slot = makeSlot({ burn_rate_1h_avg_5h: 5, burn_sample_count_5h: 3 });
    const live = makeLiveEstimate({ tokens_per_hour: 800, session_count: 1 });
    const result: string = Fmt.fmtBurnRate(slot, live, 5);
    expect(result).toContain('800/h~live');
  });

  test('suffix uses fmtTokPerHour formatting (over 100k)', () => {
    const slot = makeSlot({ burn_rate_1h_avg_5h: 5, burn_sample_count_5h: 3 });
    const live = makeLiveEstimate({ tokens_per_hour: 8_073_665, session_count: 24 });
    const result: string = Fmt.fmtBurnRate(slot, live, 5);
    // 8073665 / 1000 = 8073.665 → "8074k"
    expect(result).toContain('8074k/h~live');
  });
});

// ── Integration: fmtBurnRate preserves existing behavior ─────────────────────

describe('fmtBurnRate — existing behavior preserved (no live data)', () => {
  test('low-confidence marker present when sample_count < 3', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 7,
      burn_sample_count_5h: 1,
    });
    const result: string = Fmt.fmtBurnRate(slot);
    expect(result).toContain('~7%/h');
    expect(result).not.toContain('~live');
  });

  test('min-max range shown when sample_count >= 3 and min != max', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 7,
      burn_rate_1h_min_5h: 4,
      burn_rate_1h_max_5h: 10,
      burn_sample_count_5h: 5,
    });
    const result: string = Fmt.fmtBurnRate(slot);
    expect(result).toContain('4-10%/h');
  });

  test('7d rate appended after pipe when both 5h and 7d present', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 5,
      burn_sample_count_5h: 3,
      seven_day_burn_rate_per_day: 14,
    });
    const result: string = Fmt.fmtBurnRate(slot);
    expect(result).toContain('|');
    expect(result).toContain('14%/d');
  });
});
