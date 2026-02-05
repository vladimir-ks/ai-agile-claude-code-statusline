/**
 * FreshnessManager Tests
 *
 * Verifies unified freshness model:
 * - Category-based threshold enforcement
 * - Staleness status computation
 * - Cooldown cross-process persistence
 * - isBillingFresh computed from timestamp (not stored boolean)
 * - Report generation
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { FreshnessManager, CATEGORIES } from '../src/lib/freshness-manager';

describe('FreshnessManager: isFresh', () => {
  test('returns false for null/undefined/0 timestamp', () => {
    expect(FreshnessManager.isFresh(null, 'billing_ccusage')).toBe(false);
    expect(FreshnessManager.isFresh(undefined, 'billing_ccusage')).toBe(false);
    expect(FreshnessManager.isFresh(0, 'billing_ccusage')).toBe(false);
  });

  test('returns false for unknown category', () => {
    expect(FreshnessManager.isFresh(Date.now(), 'nonexistent')).toBe(false);
  });

  test('returns true for recent timestamp within freshMs', () => {
    const now = Date.now();
    expect(FreshnessManager.isFresh(now - 1000, 'billing_ccusage')).toBe(true);  // 1s ago, threshold 2min
    expect(FreshnessManager.isFresh(now - 10000, 'git_status')).toBe(true);       // 10s ago, threshold 30s
  });

  test('returns false for timestamp beyond freshMs', () => {
    const now = Date.now();
    expect(FreshnessManager.isFresh(now - 130_000, 'billing_ccusage')).toBe(false);  // 130s > 120s threshold
    expect(FreshnessManager.isFresh(now - 35_000, 'git_status')).toBe(false);        // 35s > 30s threshold
  });

  test('CRITICAL: 4-day-old billing is NOT fresh', () => {
    const fourDaysAgo = Date.now() - (4 * 24 * 60 * 60 * 1000);
    expect(FreshnessManager.isFresh(fourDaysAgo, 'billing_ccusage')).toBe(false);
    expect(FreshnessManager.isFresh(fourDaysAgo, 'billing_oauth')).toBe(false);
  });
});

describe('FreshnessManager: getStatus', () => {
  test('returns unknown for missing timestamp', () => {
    expect(FreshnessManager.getStatus(null, 'billing_ccusage')).toBe('unknown');
    expect(FreshnessManager.getStatus(0, 'billing_ccusage')).toBe('unknown');
  });

  test('returns fresh for recent data', () => {
    expect(FreshnessManager.getStatus(Date.now() - 1000, 'billing_ccusage')).toBe('fresh');
  });

  test('returns stale for data beyond freshMs', () => {
    const now = Date.now();
    expect(FreshnessManager.getStatus(now - 130_000, 'billing_ccusage')).toBe('stale');  // 130s > 120s fresh, < 600s critical
  });

  test('returns critical for data beyond staleMs', () => {
    const now = Date.now();
    expect(FreshnessManager.getStatus(now - 700_000, 'billing_ccusage')).toBe('critical');  // 700s > 600s
  });

  test('returns stale (not critical) for categories without staleMs', () => {
    const now = Date.now();
    // model has no staleMs defined
    expect(FreshnessManager.getStatus(now - 400_000, 'model')).toBe('stale');  // 400s > 300s fresh, no critical
  });
});

describe('FreshnessManager: getIndicator', () => {
  test('fresh data has no indicator', () => {
    expect(FreshnessManager.getIndicator(Date.now() - 1000, 'billing_ccusage')).toBe('');
  });

  test('stale data shows warning', () => {
    expect(FreshnessManager.getIndicator(Date.now() - 130_000, 'billing_ccusage')).toBe('⚠');
  });

  test('critical data shows red triangle', () => {
    expect(FreshnessManager.getIndicator(Date.now() - 700_000, 'billing_ccusage')).toBe('🔺');
  });

  test('unknown data shows warning', () => {
    expect(FreshnessManager.getIndicator(0, 'billing_ccusage')).toBe('⚠');
  });
});

describe('FreshnessManager: isBillingFresh', () => {
  test('CRITICAL: computed from timestamp, not stored boolean', () => {
    // This is the key fix — billing.isFresh was a stored boolean that could lie
    expect(FreshnessManager.isBillingFresh(Date.now() - 1000)).toBe(true);
    expect(FreshnessManager.isBillingFresh(Date.now() - 130_000)).toBe(false);

    // The bug: 4-day-old data had isFresh=true in the stored JSON
    const fourDaysAgo = Date.now() - (4 * 24 * 60 * 60 * 1000);
    expect(FreshnessManager.isBillingFresh(fourDaysAgo)).toBe(false);
  });

  test('returns false for missing timestamp', () => {
    expect(FreshnessManager.isBillingFresh(null)).toBe(false);
    expect(FreshnessManager.isBillingFresh(undefined)).toBe(false);
    expect(FreshnessManager.isBillingFresh(0)).toBe(false);
  });
});

describe('FreshnessManager: getAge', () => {
  test('returns Infinity for missing timestamp', () => {
    expect(FreshnessManager.getAge(null)).toBe(Infinity);
    expect(FreshnessManager.getAge(undefined)).toBe(Infinity);
    expect(FreshnessManager.getAge(0)).toBe(Infinity);
  });

  test('returns correct age in ms', () => {
    const age = FreshnessManager.getAge(Date.now() - 5000);
    expect(age).toBeGreaterThanOrEqual(4900);
    expect(age).toBeLessThanOrEqual(5200);
  });

  test('never returns negative', () => {
    // Future timestamp should return 0
    expect(FreshnessManager.getAge(Date.now() + 10000)).toBe(0);
  });
});

describe('FreshnessManager: shouldRefetch', () => {
  beforeEach(() => {
    FreshnessManager.clearAllCooldowns();
  });

  test('returns true when no cooldown active', () => {
    expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(true);
    expect(FreshnessManager.shouldRefetch('billing_oauth')).toBe(true);
  });

  test('returns true for categories with no cooldown', () => {
    // git_status has cooldownMs=0
    expect(FreshnessManager.shouldRefetch('git_status')).toBe(true);
    expect(FreshnessManager.shouldRefetch('quota_hotswap')).toBe(true);
  });

  test('returns false after recording failure', () => {
    FreshnessManager.recordFetch('billing_ccusage', false);
    expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(false);
  });

  test('returns true after recording success (clears cooldown)', () => {
    FreshnessManager.recordFetch('billing_ccusage', false);
    expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(false);

    FreshnessManager.recordFetch('billing_ccusage', true);
    expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(true);
  });

  afterEach(() => {
    FreshnessManager.clearAllCooldowns();
  });
});

describe('FreshnessManager: getReport', () => {
  test('generates report for all provided categories', () => {
    const timestamps = {
      billing_ccusage: Date.now() - 1000,
      git_status: Date.now() - 50_000,
      model: 0,
    };

    const report = FreshnessManager.getReport(timestamps);

    expect(report.generatedAt).toBeGreaterThan(0);
    expect(report.fields.billing_ccusage.status).toBe('fresh');
    expect(report.fields.git_status.status).toBe('stale');  // 50s > 30s
    expect(report.fields.model.status).toBe('unknown');      // timestamp=0
  });

  test('ignores unknown categories', () => {
    const timestamps = {
      nonexistent: Date.now(),
      billing_ccusage: Date.now(),
    };

    const report = FreshnessManager.getReport(timestamps);
    expect(report.fields.nonexistent).toBeUndefined();
    expect(report.fields.billing_ccusage).toBeDefined();
  });
});

describe('FreshnessManager: CATEGORIES', () => {
  test('all expected categories defined', () => {
    const expected = [
      'billing_oauth', 'billing_ccusage', 'quota_hotswap',
      'quota_subscription', 'git_status', 'transcript',
      'model', 'context', 'weekly_quota'
    ];

    for (const cat of expected) {
      expect(CATEGORIES[cat]).toBeDefined();
      expect(CATEGORIES[cat].freshMs).toBeGreaterThan(0);
    }
  });

  test('billing categories have cooldowns', () => {
    expect(CATEGORIES.billing_oauth.cooldownMs).toBeGreaterThan(0);
    expect(CATEGORIES.billing_ccusage.cooldownMs).toBeGreaterThan(0);
  });

  test('non-billing categories have no cooldowns', () => {
    expect(CATEGORIES.git_status.cooldownMs).toBe(0);
    expect(CATEGORIES.quota_hotswap.cooldownMs).toBe(0);
    expect(CATEGORIES.quota_subscription.cooldownMs).toBe(0);
  });
});
