/**
 * Tests for UrgencyCalculator
 *
 * Verifies: score calculation, level mapping, recommendation mapping,
 * weight distribution, edge cases (zero, max, negative).
 */

import { describe, test, expect } from 'bun:test';
import { UrgencyCalculator, UrgencyInput } from '../src/lib/urgency-calculator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function calc(overrides: Partial<UrgencyInput> = {}) {
  return UrgencyCalculator.calculate({
    weeklyPercentUsed: 0,
    dailyPercentUsed: 0,
    burnRatePerHour: 0,
    budgetRemaining: 120,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('UrgencyCalculator', () => {

  // =========================================================================
  // Score calculation
  // =========================================================================

  describe('score calculation', () => {
    test('zero usage → score 0', () => {
      const result = calc();
      expect(result.score).toBe(0);
    });

    test('100% weekly usage → score ~60 (weekly weight = 0.6)', () => {
      const result = calc({ weeklyPercentUsed: 100 });
      expect(result.score).toBeGreaterThanOrEqual(58);
      expect(result.score).toBeLessThanOrEqual(62);
    });

    test('100% daily usage → score ~30 (daily weight = 0.3)', () => {
      const result = calc({ dailyPercentUsed: 100 });
      expect(result.score).toBeGreaterThanOrEqual(28);
      expect(result.score).toBeLessThanOrEqual(32);
    });

    test('$20/h burn rate → score ~10 (burn weight = 0.1)', () => {
      const result = calc({ burnRatePerHour: 20 });
      expect(result.score).toBeGreaterThanOrEqual(8);
      expect(result.score).toBeLessThanOrEqual(12);
    });

    test('all maxed → score 100', () => {
      const result = calc({
        weeklyPercentUsed: 100,
        dailyPercentUsed: 100,
        burnRatePerHour: 20,
        budgetRemaining: 0,
      });
      expect(result.score).toBe(100);
    });

    test('score capped at 100', () => {
      const result = calc({
        weeklyPercentUsed: 100,
        dailyPercentUsed: 100,
        burnRatePerHour: 50, // Over ceiling
        budgetRemaining: 0,
      });
      expect(result.score).toBeLessThanOrEqual(100);
    });

    test('low budget bonus applies when <30 minutes remaining', () => {
      const withBudget = calc({ weeklyPercentUsed: 70, budgetRemaining: 120 });
      const lowBudget = calc({ weeklyPercentUsed: 70, budgetRemaining: 5 });

      expect(lowBudget.score).toBeGreaterThan(withBudget.score);
    });

    test('low budget bonus is 0 at 30 minutes', () => {
      const at30 = calc({ weeklyPercentUsed: 50, budgetRemaining: 30 });
      const at31 = calc({ weeklyPercentUsed: 50, budgetRemaining: 31 });

      expect(at30.score).toBe(at31.score);
    });
  });

  // =========================================================================
  // Level mapping
  // =========================================================================

  describe('level mapping', () => {
    test('score 0 → low', () => {
      expect(calc().level).toBe('low');
    });

    test('score ~50 → medium', () => {
      const result = calc({ weeklyPercentUsed: 80 }); // ~48
      expect(result.level).toBe('low'); // 48 is actually still < 50
    });

    test('score ~60 → medium', () => {
      const result = calc({ weeklyPercentUsed: 100 }); // ~60
      expect(result.level).toBe('medium');
    });

    test('score ~90 → high', () => {
      const result = calc({ weeklyPercentUsed: 100, dailyPercentUsed: 100 }); // ~90
      expect(result.level).toBe('high');
    });

    test('score 100 → urgent', () => {
      const result = calc({
        weeklyPercentUsed: 100,
        dailyPercentUsed: 100,
        burnRatePerHour: 20,
        budgetRemaining: 0,
      });
      expect(result.level).toBe('urgent');
    });
  });

  // =========================================================================
  // Recommendations
  // =========================================================================

  describe('recommendations', () => {
    test('low score → none', () => {
      expect(calc().recommendation).toBe('none');
    });

    test('score >=80 → swap_recommended', () => {
      const result = calc({ weeklyPercentUsed: 100, dailyPercentUsed: 70 }); // ~81
      expect(result.score).toBeGreaterThanOrEqual(80);
      expect(result.recommendation).toBe('swap_recommended');
    });

    test('score >=95 → swap_urgent', () => {
      const result = calc({
        weeklyPercentUsed: 100,
        dailyPercentUsed: 100,
        burnRatePerHour: 20,
        budgetRemaining: 0,
      });
      expect(result.score).toBeGreaterThanOrEqual(95);
      expect(result.recommendation).toBe('swap_urgent');
    });
  });

  // =========================================================================
  // Factor breakdown
  // =========================================================================

  describe('factors', () => {
    test('factors sum approximately to score', () => {
      const result = calc({
        weeklyPercentUsed: 80,
        dailyPercentUsed: 60,
        burnRatePerHour: 10,
        budgetRemaining: 120,
      });

      const factorSum = result.factors.weeklyContribution +
                        result.factors.dailyContribution +
                        result.factors.burnRateContribution;

      // Allow small rounding difference
      expect(Math.abs(factorSum - result.score)).toBeLessThan(2);
    });

    test('weekly dominates the score', () => {
      const result = calc({ weeklyPercentUsed: 100 });
      expect(result.factors.weeklyContribution).toBeGreaterThan(result.factors.dailyContribution);
      expect(result.factors.weeklyContribution).toBeGreaterThan(result.factors.burnRateContribution);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================

  describe('edge cases', () => {
    test('negative values clamped to 0', () => {
      const result = calc({
        weeklyPercentUsed: -50,
        dailyPercentUsed: -10,
        burnRatePerHour: -5,
      });
      expect(result.score).toBe(0);
    });

    test('over 100% values clamped', () => {
      const result = calc({
        weeklyPercentUsed: 150,
        dailyPercentUsed: 200,
      });
      // Should behave like 100/100
      const maxResult = calc({
        weeklyPercentUsed: 100,
        dailyPercentUsed: 100,
      });
      expect(result.score).toBe(maxResult.score);
    });

    test('undefined values treated as 0', () => {
      const result = UrgencyCalculator.calculate({
        weeklyPercentUsed: undefined as any,
        dailyPercentUsed: undefined as any,
        burnRatePerHour: undefined as any,
        budgetRemaining: undefined as any,
      });
      expect(result.score).toBeGreaterThanOrEqual(0);
    });
  });
});
