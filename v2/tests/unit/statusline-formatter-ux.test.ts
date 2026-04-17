/**
 * Statusline Formatter UX Polish — Unit Tests
 *
 * Covers Tasks #27 + #28 (formatter side):
 * - Weekly loss-risk coloring (fmtSlotWeeklyQuotaColored)
 * - Low-sample confidence marker (fmtBurnRate)
 * - Ban indicator on slot badge (fmtSlotBadge)
 * - Stale data banner (fmtStaleWarning)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StatuslineFormatter } from '../../src/lib/statusline-formatter';
import type { MergedQuotaSlot } from '../../src/types/session-health';

// ── Test accessor ──────────────────────────────────────────────────────────────
// Private static methods are tested via casting to any.
const Fmt = StatuslineFormatter as any;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Minimal valid slot — fields not under test default to safe values */
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
    // seven_day_resets_at: 4 days from now (week ~43% progressed = >20%)
    seven_day_resets_at: new Date(Date.now() + 4 * 24 * 3600_000).toISOString(),
    ...overrides,
  };
}

// ── beforeEach / afterEach: ensure NO_COLOR is set for deterministic output ──

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

// ── fmtSlotWeeklyQuotaColored ─────────────────────────────────────────────────

describe('fmtSlotWeeklyQuotaColored — color rules', () => {
  test('CERTAIN LOSS: projected < 100 AND sample >= 3 AND week_progress >= 20 → red', () => {
    // week_progress: seven_day_resets_at 4 days from now → ~57% progress (>20)
    const slot = makeSlot({
      weekly_projected_util: 85,   // < 100
      weekly_best_case_projected_util: 97,
      burn_sample_count_5h: 3,     // >= 3
    });
    const { color } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    // NO_COLOR=1 → color is empty string
    expect(color).toBe('');
  });

  test('CERTAIN LOSS color is red when NO_COLOR unset', () => {
    delete process.env.NO_COLOR;
    // week_progress ~57% (4 days remaining), sample_count >= 3, projected < 100
    const slot = makeSlot({
      weekly_projected_util: 85,
      weekly_best_case_projected_util: 97,
      burn_sample_count_5h: 3,
    });
    const { color } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(color).toContain('\x1b[1m');          // bold
    expect(color).toContain('\x1b[38;5;196m');   // red
  });

  test('LIKELY LOSS: best_case < 95 → red+bold (even with 0 samples)', () => {
    delete process.env.NO_COLOR;
    const slot = makeSlot({
      weekly_best_case_projected_util: 90,  // < 95
      weekly_projected_util: 110,           // above threshold (rule 2 fires first)
      burn_sample_count_5h: 0,
    });
    const { color } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(color).toContain('\x1b[38;5;196m');   // red
  });

  test('TRENDING LOSS: projected < 90 → orange+bold', () => {
    delete process.env.NO_COLOR;
    // Use reset far in future (< 20% week progress) to disable rule 1
    const slot = makeSlot({
      weekly_projected_util: 80,            // < 90
      weekly_best_case_projected_util: 98,  // >= 95 (rule 2 does not fire)
      burn_sample_count_5h: 5,
      // ~162h remaining = 3% progress, well below the 20% rule-1 threshold
      seven_day_resets_at: new Date(Date.now() + 162 * 3600_000).toISOString(),
    });
    const { color } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(color).toContain('\x1b[38;5;208m');   // orange
    expect(color).toContain('\x1b[1m');           // bold
  });

  test('MARGIN AT RISK: projected 90–95 → yellow (no bold)', () => {
    delete process.env.NO_COLOR;
    // Use reset far in future (< 20% week progress) to disable rule 1
    const slot = makeSlot({
      weekly_projected_util: 92,
      weekly_best_case_projected_util: 98,
      burn_sample_count_5h: 5,
      // ~162h remaining = 3% progress, well below the 20% rule-1 threshold
      seven_day_resets_at: new Date(Date.now() + 162 * 3600_000).toISOString(),
    });
    const { color } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(color).toContain('\x1b[38;5;226m');   // yellow
    expect(color).not.toContain('\x1b[1m');       // no bold
  });

  test('ON TRACK: projected 95–105 → green', () => {
    delete process.env.NO_COLOR;
    const slot = makeSlot({
      weekly_projected_util: 100,
      weekly_best_case_projected_util: 100,
      burn_sample_count_5h: 5,
    });
    const { color } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(color).toContain('\x1b[38;5;46m');    // green
  });

  test('WASTING: projected > 105 → blue', () => {
    delete process.env.NO_COLOR;
    const slot = makeSlot({
      weekly_projected_util: 120,
      weekly_best_case_projected_util: 110,
      burn_sample_count_5h: 5,
    });
    const { color } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(color).toContain('\x1b[38;5;33m');    // blue
  });

  test('MISSING DATA: null projections → neutral (neutralId)', () => {
    delete process.env.NO_COLOR;
    const slot = makeSlot({
      weekly_projected_util: null,
      weekly_best_case_projected_util: null,
      burn_sample_count_5h: 0,
    });
    const { color } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(color).toContain('\x1b[38;5;250m');   // neutralId
  });
});

describe('fmtSlotWeeklyQuotaColored — inline projection', () => {
  test('with sample_count >= 3: shows →{projected}% in text', () => {
    const slot = makeSlot({
      seven_day_util: 60,
      weekly_budget_remaining_hours: 72,
      weekly_projected_util: 95,
      burn_sample_count_5h: 3,
    });
    const { text } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(text).toContain('→95%');
  });

  test('with sample_count < 3 and best_case available: shows best_case projection', () => {
    const slot = makeSlot({
      seven_day_util: 60,
      weekly_budget_remaining_hours: 72,
      weekly_projected_util: 95,
      weekly_best_case_projected_util: 98,
      burn_sample_count_5h: 1,
    });
    const { text } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(text).toContain('→98%');  // shows best_case (not weekly_projected)
  });

  test('no projection available: plain format without arrow (space-separated format)', () => {
    const slot = makeSlot({
      seven_day_util: 60,
      weekly_budget_remaining_hours: 72,
      weekly_projected_util: null,
      weekly_best_case_projected_util: null,
      burn_sample_count_5h: 0,
    });
    const { text } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(text).not.toContain('→');
    // New format: "72h 60%" (space, not parens)
    expect(text).toMatch(/\d+h \d+%/);
    expect(text).not.toMatch(/\d+h\(\d+%\)/);
  });

  test('text contains hours and pct', () => {
    const slot = makeSlot({
      seven_day_util: 65,
      weekly_budget_remaining_hours: 100,
      weekly_projected_util: null,
      weekly_best_case_projected_util: null,
      burn_sample_count_5h: 0,
    });
    const { text } = Fmt.fmtSlotWeeklyQuotaColored(slot);
    expect(text).toContain('100h');
    expect(text).toContain('65%');
  });
});

// ── fmtBurnRate — low-sample confidence marker ─────────────────────────────────

describe('fmtBurnRate — low-sample confidence', () => {
  test('sample_count < 3: rate prefixed with ~ (tilde)', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 5,
      burn_sample_count_5h: 2,
      pacing_status_5h: 'good',
    });
    const result = Fmt.fmtBurnRate(slot) as string;
    expect(result).toContain('~5%/h');
  });

  test('sample_count < 3: color is neutralLight (245) not pacing color', () => {
    delete process.env.NO_COLOR;
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 5,
      burn_sample_count_5h: 2,
      pacing_status_5h: 'way_too_slow',  // would be red if high-confidence
    });
    const result = Fmt.fmtBurnRate(slot) as string;
    expect(result).toContain('\x1b[38;5;245m');   // neutralLight
    expect(result).not.toContain('\x1b[38;5;196m'); // NOT pacingRed
  });

  test('sample_count >= 3: no tilde prefix', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 5,
      burn_sample_count_5h: 3,
      pacing_status_5h: 'good',
    });
    const result = Fmt.fmtBurnRate(slot) as string;
    expect(result).not.toContain('~');
    expect(result).toContain('5%/h');
  });

  test('sample_count >= 3: uses pacing color (green for good)', () => {
    delete process.env.NO_COLOR;
    const slot = makeSlot({
      burn_rate_1h_avg_5h: 5,
      burn_sample_count_5h: 4,
      pacing_status_5h: 'good',
    });
    const result = Fmt.fmtBurnRate(slot) as string;
    expect(result).toContain('\x1b[38;5;46m');    // pacingGreen
  });

  test('no actual rate: falls back to target (dim gray), no tilde', () => {
    const slot = makeSlot({
      burn_rate_1h_avg_5h: null,
      five_hour_burn_rate: null,
      target_burn_rate_5h: 8,
      burn_sample_count_5h: 0,
    });
    const result = Fmt.fmtBurnRate(slot) as string;
    expect(result).not.toContain('~');
    expect(result).toContain('8%/h');
  });
});

// ── fmtSlotBadge — ban indicator ───────────────────────────────────────────────

describe('fmtSlotBadge — ban indicator', () => {
  test('not banned: shows 👤SN|email format', () => {
    const result = Fmt.fmtSlotBadge('1', 'user@test.com', false) as string;
    expect(result).toContain('👤S1');
    expect(result).toContain('user@test.com');
    expect(result).not.toContain('⛔');
  });

  test('banned: shows ⛔SN|email format', () => {
    const result = Fmt.fmtSlotBadge('2', 'user@test.com', true) as string;
    expect(result).toContain('⛔S2');
    expect(result).toContain('user@test.com');
    expect(result).not.toContain('👤');
  });

  test('banned: dimmed with neutralLight (245) when NO_COLOR unset', () => {
    delete process.env.NO_COLOR;
    const result = Fmt.fmtSlotBadge('1', 'user@test.com', true) as string;
    expect(result).toContain('\x1b[38;5;245m');
  });

  test('not banned: uses neutralId (250) when NO_COLOR unset', () => {
    delete process.env.NO_COLOR;
    const result = Fmt.fmtSlotBadge('1', 'user@test.com', false) as string;
    expect(result).toContain('\x1b[38;5;250m');
  });
});

// ── fmtStaleWarning ────────────────────────────────────────────────────────────
// NOTE: fmtStaleWarning is deprecated — replaced by per-field staleTier decorator.
// It now always returns '' regardless of age.
// Staleness UX is tested in tests/formatter-stale.test.ts via staleTier() + per-field tests.

describe('fmtStaleWarning — stale data banner', () => {
  test('age < 15min: returns empty string', () => {
    const tenMinAgo = Date.now() - 10 * 60_000;
    const result = StatuslineFormatter.fmtStaleWarning(tenMinAgo);
    expect(result).toBe('');
  });

  test('age exactly 15min: returns empty string (deprecated — no longer emits banner)', () => {
    const fifteenMinAgo = Date.now() - 15 * 60_000 - 1000;
    const result = StatuslineFormatter.fmtStaleWarning(fifteenMinAgo);
    expect(result).toBe('');
  });

  test('age 15-30min: returns empty string (deprecated — per-field ⚠ used instead)', () => {
    const twentyMinAgo = Date.now() - 20 * 60_000;
    const result = StatuslineFormatter.fmtStaleWarning(twentyMinAgo);
    expect(result).toBe('');
  });

  test('age 15-30min: no ANSI color codes emitted (no banner)', () => {
    delete process.env.NO_COLOR;
    const twentyMinAgo = Date.now() - 20 * 60_000;
    const result = StatuslineFormatter.fmtStaleWarning(twentyMinAgo);
    expect(result).toBe('');
  });

  test('age > 30min: returns empty string (deprecated — per-field ⚠ used instead)', () => {
    const fortyMinAgo = Date.now() - 40 * 60_000;
    const result = StatuslineFormatter.fmtStaleWarning(fortyMinAgo);
    expect(result).toBe('');
  });

  test('age > 30min: no ANSI color codes when deprecated', () => {
    delete process.env.NO_COLOR;
    const fortyMinAgo = Date.now() - 40 * 60_000;
    const result = StatuslineFormatter.fmtStaleWarning(fortyMinAgo);
    expect(result).toBe('');
  });

  test('fresh data (0 minutes): no warning', () => {
    const result = StatuslineFormatter.fmtStaleWarning(Date.now());
    expect(result).toBe('');
  });
});
