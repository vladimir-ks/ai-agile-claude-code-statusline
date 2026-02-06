/**
 * Tests for Tier 3 (global) source descriptors
 *
 * Tests descriptor shape, merge logic, and helper functions.
 * Fetch tests are limited to what can run without network/CLI.
 */

import { describe, test, expect } from 'bun:test';
import { createDefaultHealth } from '../src/types/session-health';
import type { GatherContext } from '../src/lib/sources/types';

// Import source descriptors
import { gitSource } from '../src/lib/sources/git-source';
import { versionSource } from '../src/lib/sources/version-source';
import { notificationSource } from '../src/lib/sources/notification-source';
import { slotRecommendationSource } from '../src/lib/sources/slot-recommendation-source';
import { billingSource, createBillingFromCcusage } from '../src/lib/sources/billing-source';
import { quotaSource } from '../src/lib/sources/quota-source';
import { sessionCostSource } from '../src/lib/sources/session-cost-source';

function makeCtx(overrides: Partial<GatherContext> = {}): GatherContext {
  return {
    sessionId: 'test-session',
    transcriptPath: null,
    jsonInput: null,
    configDir: null,
    keychainService: null,
    deadline: Date.now() + 20000,
    existingHealth: null,
    projectPath: '/tmp/test',
    ...overrides,
  };
}

// =========================================================================
// Git Source
// =========================================================================

describe('gitSource', () => {
  describe('descriptor', () => {
    test('has correct id', () => expect(gitSource.id).toBe('git_status'));
    test('is tier 3', () => expect(gitSource.tier).toBe(3));
    test('has git_status category', () => expect(gitSource.freshnessCategory).toBe('git_status'));
    test('has reasonable timeout', () => expect(gitSource.timeoutMs).toBeLessThanOrEqual(10000));
  });

  describe('merge', () => {
    test('writes git info to health', () => {
      const health = createDefaultHealth('test');
      gitSource.merge(health, {
        branch: 'main',
        ahead: 2,
        behind: 0,
        dirty: 5,
        fetchedAt: Date.now(),
      });
      expect(health.git.branch).toBe('main');
      expect(health.git.ahead).toBe(2);
      expect(health.git.behind).toBe(0);
      expect(health.git.dirty).toBe(5);
    });

    test('sets lastChecked to fetchedAt', () => {
      const health = createDefaultHealth('test');
      const fetchedAt = Date.now() - 1000;
      gitSource.merge(health, {
        branch: 'dev',
        ahead: 0,
        behind: 3,
        dirty: 0,
        fetchedAt,
      });
      expect(health.git.lastChecked).toBe(fetchedAt);
    });
  });
});

// =========================================================================
// Version Source
// =========================================================================

describe('versionSource', () => {
  describe('descriptor', () => {
    test('has correct id', () => expect(versionSource.id).toBe('version_check'));
    test('is tier 3', () => expect(versionSource.tier).toBe(3));
    test('has version_check category', () => expect(versionSource.freshnessCategory).toBe('version_check'));
    test('has network-appropriate timeout', () => expect(versionSource.timeoutMs).toBeLessThanOrEqual(15000));
  });

  describe('merge', () => {
    test('does not throw with no update data', () => {
      const health = createDefaultHealth('test');
      expect(() => {
        versionSource.merge(health, {
          currentVersion: '1.0.0',
          latestVersion: null,
          needsUpdate: false,
          checkedAt: Date.now(),
        });
      }).not.toThrow();
    });
  });
});

// =========================================================================
// Notification Source
// =========================================================================

describe('notificationSource', () => {
  describe('descriptor', () => {
    test('has correct id', () => expect(notificationSource.id).toBe('notifications'));
    test('is tier 3', () => expect(notificationSource.tier).toBe(3));
    test('has notifications category', () => expect(notificationSource.freshnessCategory).toBe('notifications'));
    test('has low timeout', () => expect(notificationSource.timeoutMs).toBeLessThanOrEqual(1000));
  });

  describe('merge', () => {
    test('is a no-op (does not mutate health)', () => {
      const health = createDefaultHealth('test');
      const before = JSON.stringify(health);
      notificationSource.merge(health, { cleanedAt: Date.now() });
      expect(JSON.stringify(health)).toBe(before);
    });
  });
});

// =========================================================================
// Slot Recommendation Source
// =========================================================================

describe('slotRecommendationSource', () => {
  describe('descriptor', () => {
    test('has correct id', () => expect(slotRecommendationSource.id).toBe('slot_recommendation'));
    test('is tier 3', () => expect(slotRecommendationSource.tier).toBe(3));
    test('has low timeout', () => expect(slotRecommendationSource.timeoutMs).toBeLessThanOrEqual(1000));
  });

  describe('merge', () => {
    test('does not throw with null switch message', () => {
      const health = createDefaultHealth('test');
      expect(() => {
        slotRecommendationSource.merge(health, {
          currentSlot: 'slot-1',
          switchMessage: null,
          checkedAt: Date.now(),
        });
      }).not.toThrow();
    });

    test('does not throw with no slot', () => {
      const health = createDefaultHealth('test');
      expect(() => {
        slotRecommendationSource.merge(health, {
          currentSlot: null,
          switchMessage: null,
          checkedAt: Date.now(),
        });
      }).not.toThrow();
    });
  });
});

// =========================================================================
// Billing Source
// =========================================================================

describe('billingSource', () => {
  describe('descriptor', () => {
    test('has correct id', () => expect(billingSource.id).toBe('billing'));
    test('is tier 3', () => expect(billingSource.tier).toBe(3));
    test('has billing_oauth category', () => expect(billingSource.freshnessCategory).toBe('billing_oauth'));
    test('has generous timeout for network calls', () => expect(billingSource.timeoutMs).toBeGreaterThanOrEqual(10000));
  });

  describe('merge', () => {
    test('writes billing data to health', () => {
      const health = createDefaultHealth('test');
      billingSource.merge(health, {
        billing: {
          costToday: 40.3,
          burnRatePerHour: 15.1,
          budgetRemaining: 120,
          budgetPercentUsed: 62,
          resetTime: '14:00',
          totalTokens: 83400000,
          tokensPerMinute: 521000,
          isFresh: true,
          lastFetched: Date.now(),
        },
        source: 'oauth',
        fetchedAt: Date.now(),
      });
      expect(health.billing.costToday).toBe(40.3);
      expect(health.billing.burnRatePerHour).toBe(15.1);
      expect(health.billing.isFresh).toBe(true);
    });

    test('preserves existing billing fields not in data', () => {
      const health = createDefaultHealth('test');
      health.billing.weeklyBudgetRemaining = 42;
      health.billing.sessionCost = 5.5;

      billingSource.merge(health, {
        billing: {
          costToday: 10,
          burnRatePerHour: 5,
          budgetRemaining: 60,
          budgetPercentUsed: 30,
          resetTime: '14:00',
          isFresh: true,
          lastFetched: Date.now(),
        },
        source: 'ccusage',
        fetchedAt: Date.now(),
      });

      // Preserved
      expect(health.billing.sessionCost).toBe(5.5);
      // Overwritten
      expect(health.billing.costToday).toBe(10);
    });
  });

  describe('createBillingFromCcusage', () => {
    test('creates BillingInfo from ccusage data', () => {
      const result = createBillingFromCcusage({
        costUSD: 40.3,
        costPerHour: 15.1,
        hoursLeft: 2,
        minutesLeft: 30,
        percentageUsed: 62,
        resetTime: '14:00',
        totalTokens: 83400000,
        tokensPerMinute: 521000,
        lastFetched: 1234567890,
      }, true);

      expect(result.costToday).toBe(40.3);
      expect(result.burnRatePerHour).toBe(15.1);
      expect(result.budgetRemaining).toBe(150); // 2h * 60 + 30m
      expect(result.budgetPercentUsed).toBe(62);
      expect(result.resetTime).toBe('14:00');
      expect(result.totalTokens).toBe(83400000);
      expect(result.tokensPerMinute).toBe(521000);
      expect(result.isFresh).toBe(true);
      expect(result.lastFetched).toBe(1234567890);
    });

    test('handles missing fields with defaults', () => {
      const result = createBillingFromCcusage({}, false);
      expect(result.costToday).toBe(0);
      expect(result.burnRatePerHour).toBe(0);
      expect(result.budgetRemaining).toBe(0);
      expect(result.budgetPercentUsed).toBe(0);
      expect(result.resetTime).toBe('');
      expect(result.totalTokens).toBe(0);
      expect(result.tokensPerMinute).toBeNull();
      expect(result.isFresh).toBe(false);
    });

    test('marks stale with isFresh=false', () => {
      const result = createBillingFromCcusage({ costUSD: 10 }, false);
      expect(result.isFresh).toBe(false);
    });
  });
});

// =========================================================================
// Quota Source
// =========================================================================

describe('quotaSource', () => {
  describe('descriptor', () => {
    test('has correct id', () => expect(quotaSource.id).toBe('quota'));
    test('is tier 3', () => expect(quotaSource.tier).toBe(3));
    test('has quota_broker category', () => expect(quotaSource.freshnessCategory).toBe('quota_broker'));
    test('has low timeout (file reads)', () => expect(quotaSource.timeoutMs).toBeLessThanOrEqual(5000));
  });

  describe('merge', () => {
    test('writes quota data to health.billing', () => {
      const health = createDefaultHealth('test');
      quotaSource.merge(health, {
        weeklyBudgetRemaining: 42,
        weeklyBudgetPercentUsed: 16,
        weeklyResetDay: 'Thu',
        weeklyDataStale: false,
        weeklyLastModified: Date.now(),
        dailyPercentUsed: 83,
        source: 'broker',
        fetchedAt: Date.now(),
      });
      expect(health.billing.weeklyBudgetRemaining).toBe(42);
      expect(health.billing.weeklyBudgetPercentUsed).toBe(16);
      expect(health.billing.weeklyResetDay).toBe('Thu');
      expect(health.billing.weeklyDataStale).toBe(false);
      expect(health.billing.budgetPercentUsed).toBe(83);
    });

    test('does nothing for source=none', () => {
      const health = createDefaultHealth('test');
      health.billing.weeklyBudgetRemaining = 99;
      quotaSource.merge(health, { source: 'none', fetchedAt: Date.now() });
      expect(health.billing.weeklyBudgetRemaining).toBe(99);
    });

    test('does not overwrite daily percent when not provided', () => {
      const health = createDefaultHealth('test');
      health.billing.budgetPercentUsed = 50;
      quotaSource.merge(health, {
        weeklyBudgetRemaining: 10,
        weeklyBudgetPercentUsed: 80,
        weeklyResetDay: 'Mon',
        source: 'hotswap',
        fetchedAt: Date.now(),
      });
      // dailyPercentUsed not in data → budgetPercentUsed preserved
      expect(health.billing.budgetPercentUsed).toBe(50);
    });
  });

  describe('fetch', () => {
    test('returns data with source indicator', async () => {
      const data = await quotaSource.fetch(makeCtx());
      expect(data).toHaveProperty('source');
      expect(data).toHaveProperty('fetchedAt');
      expect(typeof data.fetchedAt).toBe('number');
    });
  });
});

// =========================================================================
// Session Cost Source
// =========================================================================

describe('sessionCostSource', () => {
  describe('descriptor', () => {
    test('has correct id', () => expect(sessionCostSource.id).toBe('session_cost'));
    test('is tier 2', () => expect(sessionCostSource.tier).toBe(2));
    test('has transcript category', () => expect(sessionCostSource.freshnessCategory).toBe('transcript'));
  });

  describe('fetch with no transcript', () => {
    test('returns zeros when no transcript', async () => {
      const result = await sessionCostSource.fetch(makeCtx({ transcriptPath: null }));
      expect(result.sessionCost).toBe(0);
      expect(result.sessionTokens).toBe(0);
      expect(result.sessionBurnRate).toBe(0);
      expect(result.calculated).toBe(false);
    });

    test('returns zeros for non-existent transcript', async () => {
      const result = await sessionCostSource.fetch(makeCtx({
        transcriptPath: '/tmp/nonexistent-transcript.jsonl',
      }));
      expect(result.calculated).toBe(false);
    });
  });

  describe('merge', () => {
    test('writes session cost to health.billing', () => {
      const health = createDefaultHealth('test');
      sessionCostSource.merge(health, {
        sessionCost: 5.5,
        sessionTokens: 100000,
        sessionBurnRate: 11.0,
        calculated: true,
      });
      expect(health.billing.sessionCost).toBe(5.5);
      expect(health.billing.sessionTokens).toBe(100000);
      expect(health.billing.sessionBurnRate).toBe(11.0);
    });

    test('does not write when not calculated', () => {
      const health = createDefaultHealth('test');
      health.billing.sessionCost = 3.0;
      sessionCostSource.merge(health, {
        sessionCost: 0,
        sessionTokens: 0,
        sessionBurnRate: 0,
        calculated: false,
      });
      expect(health.billing.sessionCost).toBe(3.0); // Preserved
    });
  });
});

// =========================================================================
// Cross-source: all descriptors have required fields
// =========================================================================

describe('all Tier 3 source descriptors', () => {
  const sources = [
    gitSource,
    versionSource,
    notificationSource,
    slotRecommendationSource,
    billingSource,
    quotaSource,
  ];

  test('all have unique IDs', () => {
    const ids = sources.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('all have fetch and merge functions', () => {
    for (const src of sources) {
      expect(typeof src.fetch).toBe('function');
      expect(typeof src.merge).toBe('function');
    }
  });

  test('all are tier 3', () => {
    for (const src of sources) {
      expect(src.tier).toBe(3);
    }
  });

  test('all have freshnessCategory', () => {
    for (const src of sources) {
      expect(typeof src.freshnessCategory).toBe('string');
      expect(src.freshnessCategory.length).toBeGreaterThan(0);
    }
  });

  test('all have positive timeoutMs', () => {
    for (const src of sources) {
      expect(src.timeoutMs).toBeGreaterThan(0);
    }
  });
});
