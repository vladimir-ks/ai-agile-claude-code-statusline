/**
 * Formatter Staleness Decorator Tests
 *
 * Verifies W3c behaviour:
 * - staleTier() returns correct tier based on cache age
 * - fmtStaleWarning() returns empty string (replaced by per-field decorator)
 * - fmtSlotDailyBudget / fmtSlotWeeklyQuotaColored / fmtBurnRate apply tier correctly:
 *     warn   → numbers preserved + ' ⚠' appended
 *     severe → field replaced with '⚠' only
 * - No '~live' suffix appears anywhere (Edit 1 regression guard)
 * - No 'STALE' text appears in render output (Edit 2 regression guard)
 */

import { describe, it, expect } from 'bun:test';
import { StatuslineFormatter } from '../src/lib/statusline-formatter';
import type { MergedQuotaSlot } from '../src/types/session-health';

// Cast for accessing private static methods in tests
const Fmt = StatuslineFormatter as any;

// Minimal slot fixture with enough fields for all three fmt functions
function makeSlot(overrides: Partial<MergedQuotaSlot> = {}): MergedQuotaSlot {
  return {
    email: 'test@example.com',
    status: 'active',
    subscription_type: 'max',
    five_hour_util: 45,
    seven_day_util: 65,
    five_hour_resets_at: new Date(Date.now() + 2 * 3600 * 1000).toISOString(),
    seven_day_resets_at: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
    weekly_budget_remaining_hours: 120,
    weekly_reset_day: 'Thu',
    daily_reset_time: '00:00',
    last_fetched: Date.now(),
    is_fresh: true,
    config_dir: '/tmp/test-config',
    keychain_hash: 'abcd1234',
    urgency: 50,
    rank: 1,
    reason: 'available',
    burn_rate_1h_avg_5h: 8,
    burn_rate_1h_min_5h: 5,
    burn_rate_1h_max_5h: 12,
    burn_sample_count_5h: 5,
    seven_day_burn_rate_per_day: 10,
    weekly_projected_util: 114,
    ...overrides,
  };
}

// ── staleTier() ──────────────────────────────────────────────────────────────

describe('staleTier', () => {
  it('returns fresh for age < 30 min', () => {
    const mergedAt = Date.now() - 5 * 60_000;
    expect(StatuslineFormatter.staleTier(mergedAt)).toBe('fresh');
  });

  it('returns fresh for mergedAt = 0', () => {
    expect(StatuslineFormatter.staleTier(0)).toBe('fresh');
  });

  it('returns warn for age exactly 30 min', () => {
    const mergedAt = Date.now() - 30 * 60_000;
    expect(StatuslineFormatter.staleTier(mergedAt)).toBe('warn');
  });

  it('returns warn for age 45 min', () => {
    const mergedAt = Date.now() - 45 * 60_000;
    expect(StatuslineFormatter.staleTier(mergedAt)).toBe('warn');
  });

  it('returns warn for age just under 120 min', () => {
    const mergedAt = Date.now() - 119 * 60_000;
    expect(StatuslineFormatter.staleTier(mergedAt)).toBe('warn');
  });

  it('returns severe for age exactly 120 min', () => {
    const mergedAt = Date.now() - 120 * 60_000;
    expect(StatuslineFormatter.staleTier(mergedAt)).toBe('severe');
  });

  it('returns severe for age 6 h', () => {
    const mergedAt = Date.now() - 6 * 60 * 60_000;
    expect(StatuslineFormatter.staleTier(mergedAt)).toBe('severe');
  });
});

// ── fmtStaleWarning() — must always return '' ────────────────────────────────

describe('fmtStaleWarning (deprecated)', () => {
  it('returns empty string regardless of age', () => {
    expect(StatuslineFormatter.fmtStaleWarning(0)).toBe('');
    expect(StatuslineFormatter.fmtStaleWarning(Date.now() - 5 * 60_000)).toBe('');
    expect(StatuslineFormatter.fmtStaleWarning(Date.now() - 60 * 60_000)).toBe('');
    expect(StatuslineFormatter.fmtStaleWarning(Date.now() - 6 * 60 * 60_000)).toBe('');
  });
});

// ── fmtSlotDailyBudget (⌛) ──────────────────────────────────────────────────

describe('fmtSlotDailyBudget staleness decoration', () => {
  const slot = makeSlot();

  it('fresh — returns numeric content, no ⚠', () => {
    const result = Fmt.fmtSlotDailyBudget(slot, 'fresh');
    expect(result).toMatch(/\d/);          // has numbers
    expect(result).not.toContain('⚠');
  });

  it('warn — appends " ⚠", numbers still present', () => {
    const result = Fmt.fmtSlotDailyBudget(slot, 'warn');
    expect(result).toMatch(/\d/);          // numbers preserved
    expect(result).toMatch(/ ⚠$/);         // ends with ' ⚠'
  });

  it('severe — returns exactly "⚠"', () => {
    const result = Fmt.fmtSlotDailyBudget(slot, 'severe');
    expect(result).toBe('⚠');
  });
});

// ── fmtSlotWeeklyQuotaColored (📅) ──────────────────────────────────────────

describe('fmtSlotWeeklyQuotaColored staleness decoration', () => {
  const slot = makeSlot();

  it('fresh — text has numeric content, no ⚠', () => {
    const { text } = Fmt.fmtSlotWeeklyQuotaColored(slot, 'fresh');
    expect(text).toMatch(/\d/);
    expect(text).not.toContain('⚠');
  });

  it('fresh — uses space format "Nh X%→Y%" (not parentheses)', () => {
    const { text } = Fmt.fmtSlotWeeklyQuotaColored(slot, 'fresh');
    // Must contain space-separated format: "120h 65%→114%"
    expect(text).toMatch(/\d+h \d+%/);
    // Must NOT use old parentheses format "120h(65%→114%)"
    expect(text).not.toMatch(/\d+h\(\d+%/);
  });

  it('warn — appends " ⚠", numbers still present', () => {
    const { text } = Fmt.fmtSlotWeeklyQuotaColored(slot, 'warn');
    expect(text).toMatch(/\d/);
    expect(text).toMatch(/ ⚠$/);
  });

  it('severe — text is "⚠", color is ""', () => {
    const { text, color } = Fmt.fmtSlotWeeklyQuotaColored(slot, 'severe');
    expect(text).toBe('⚠');
    expect(color).toBe('');
  });
});

// ── fmtBurnRate (🔥) ─────────────────────────────────────────────────────────

describe('fmtBurnRate staleness decoration', () => {
  const slot = makeSlot();

  it('fresh — starts with 🔥:, contains rate numbers, no ⚠', () => {
    const result = Fmt.fmtBurnRate(slot, null, undefined, true, 'fresh');
    expect(result).toMatch(/^🔥:/);
    expect(result).toMatch(/\d/);
    expect(result).not.toContain('⚠');
  });

  it('fresh — never contains "~live" (Edit 1 regression guard)', () => {
    const result = Fmt.fmtBurnRate(slot, null, undefined, true, 'fresh');
    expect(result).not.toContain('~live');
  });

  it('warn — appends " ⚠" at end', () => {
    const result = Fmt.fmtBurnRate(slot, null, undefined, true, 'warn');
    expect(result).toMatch(/^🔥:/);
    expect(result).toMatch(/ ⚠$/);
  });

  it('severe — returns "🔥:⚠" exactly (no color in NO_COLOR mode)', () => {
    // Use a slot with data so early-return (no part5h/part7d) doesn't happen
    const result = Fmt.fmtBurnRate(slot, null, undefined, true, 'severe');
    // In colored mode the result may have ANSI; strip them to check structure
    const stripped = result.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toBe('🔥:⚠');
  });
});

// ── Regression guards ────────────────────────────────────────────────────────

describe('regression guards', () => {
  const slot = makeSlot();

  it('no "~live" anywhere in any tier of fmtBurnRate', () => {
    for (const tier of ['fresh', 'warn', 'severe'] as const) {
      const result = Fmt.fmtBurnRate(slot, null, undefined, true, tier);
      expect(result).not.toContain('~live');
    }
  });

  it('no "STALE" text in fmtStaleWarning output', () => {
    const result = StatuslineFormatter.fmtStaleWarning(Date.now() - 10 * 60 * 60_000);
    expect(result).not.toContain('STALE');
  });

  it('no "~live" in fmtBurnRate with liveEstimate present (fresh data scenario)', () => {
    const liveEstimate = {
      tokens_per_hour: 5057000,
      session_count: 1,
      sample_count: 3,
    };
    // ageS <= 30 was the old condition that triggered the ~live suffix
    const result = Fmt.fmtBurnRate(slot, liveEstimate, 10, true, 'fresh');
    expect(result).not.toContain('~live');
  });
});
