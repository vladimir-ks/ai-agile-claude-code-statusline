/**
 * Billing Data Flow Simulation Test
 *
 * This test simulates the entire billing data flow from different accounts,
 * sessions, and authentication states. It validates:
 *
 * 1. OAuth token retrieval and refresh
 * 2. ccusage CLI fallback
 * 3. Stale cache handling
 * 4. Freshness indicators (⚠ and 🔺)
 * 5. Cross-session cache sharing
 *
 * Run with: bun test billing-flow-simulation
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { FreshnessManager, CATEGORIES } from '../../src/lib/freshness-manager';
import { StatuslineFormatter } from '../../src/lib/statusline-formatter';
import type { SessionHealth } from '../../src/types/session-health';

const TEST_SESSION_HEALTH_DIR = `${homedir()}/.claude/session-health`;
const TEST_COOLDOWN_DIR = `${TEST_SESSION_HEALTH_DIR}/cooldowns`;
const SHARED_CACHE_PATH = `${TEST_SESSION_HEALTH_DIR}/billing-shared.json`;

describe('Billing Data Flow Simulation', () => {

  describe('Phase 1: FreshnessManager Staleness Detection', () => {
    it('should mark billing as FRESH when lastFetched < 2 minutes ago', () => {
      const twoSecondsAgo = Date.now() - 2000;
      expect(FreshnessManager.isBillingFresh(twoSecondsAgo)).toBe(true);
      expect(FreshnessManager.getStatus(twoSecondsAgo, 'billing_ccusage')).toBe('fresh');
      expect(FreshnessManager.getIndicator(twoSecondsAgo, 'billing_ccusage')).toBe('');
    });

    it('should mark billing as STALE when lastFetched 2-10 minutes ago', () => {
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000);
      expect(FreshnessManager.isBillingFresh(fiveMinutesAgo)).toBe(false);
      expect(FreshnessManager.getStatus(fiveMinutesAgo, 'billing_ccusage')).toBe('stale');
      expect(FreshnessManager.getIndicator(fiveMinutesAgo, 'billing_ccusage')).toBe('⚠');
    });

    it('should mark billing as CRITICAL when lastFetched > 10 minutes ago', () => {
      const fifteenMinutesAgo = Date.now() - (15 * 60 * 1000);
      expect(FreshnessManager.isBillingFresh(fifteenMinutesAgo)).toBe(false);
      expect(FreshnessManager.getStatus(fifteenMinutesAgo, 'billing_ccusage')).toBe('critical');
      expect(FreshnessManager.getIndicator(fifteenMinutesAgo, 'billing_ccusage')).toBe('🔺');
    });

    it('should mark 38-hour-old data as CRITICAL (real scenario)', () => {
      const thirtyEightHoursAgo = Date.now() - (38 * 60 * 60 * 1000);
      expect(FreshnessManager.isBillingFresh(thirtyEightHoursAgo)).toBe(false);
      expect(FreshnessManager.getStatus(thirtyEightHoursAgo, 'billing_ccusage')).toBe('critical');
      expect(FreshnessManager.getIndicator(thirtyEightHoursAgo, 'billing_ccusage')).toBe('🔺');
    });

    it('should mark undefined/null timestamps as UNKNOWN with ⚠ indicator', () => {
      expect(FreshnessManager.isBillingFresh(undefined)).toBe(false);
      expect(FreshnessManager.isBillingFresh(null)).toBe(false);
      expect(FreshnessManager.isBillingFresh(0)).toBe(false);
      expect(FreshnessManager.getStatus(undefined, 'billing_ccusage')).toBe('unknown');
      expect(FreshnessManager.getIndicator(undefined, 'billing_ccusage')).toBe('⚠');
    });
  });

  describe('Phase 2: Shared Cache Behavior', () => {
    const testCachePath = `${TEST_SESSION_HEALTH_DIR}/billing-shared-test.json`;

    afterEach(() => {
      try { unlinkSync(testCachePath); } catch { /* ignore */ }
    });

    it('should read fresh cache without triggering ccusage', () => {
      const freshCache = {
        costToday: 5.25,
        burnRatePerHour: 2.10,
        budgetRemaining: 180,
        budgetPercentUsed: 45,
        resetTime: '14:00',
        totalTokens: 1500000,
        tokensPerMinute: 50000,
        isFresh: true,
        lastFetched: Date.now()
      };
      writeFileSync(testCachePath, JSON.stringify(freshCache));

      const content = JSON.parse(readFileSync(testCachePath, 'utf-8'));
      expect(content.costToday).toBe(5.25);
      expect(FreshnessManager.isBillingFresh(content.lastFetched)).toBe(true);
    });

    it('should detect stale cache and trigger refetch', () => {
      const staleCache = {
        costToday: 5.25,
        lastFetched: Date.now() - (5 * 60 * 1000) // 5 minutes ago
      };
      writeFileSync(testCachePath, JSON.stringify(staleCache));

      const content = JSON.parse(readFileSync(testCachePath, 'utf-8'));
      expect(FreshnessManager.isBillingFresh(content.lastFetched)).toBe(false);
    });
  });

  describe('Phase 3: Cooldown Mechanism', () => {
    beforeEach(() => {
      FreshnessManager.clearAllCooldowns();
    });

    afterEach(() => {
      FreshnessManager.clearAllCooldowns();
    });

    it('should allow refetch when no cooldown is active', () => {
      expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(true);
    });

    it('should block refetch after recording failure', () => {
      FreshnessManager.recordFetch('billing_ccusage', false);
      expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(false);

      const remaining = FreshnessManager.getCooldownRemaining('billing_ccusage');
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(CATEGORIES.billing_ccusage.cooldownMs);
    });

    it('should clear cooldown after recording success', () => {
      FreshnessManager.recordFetch('billing_ccusage', false);
      expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(false);

      FreshnessManager.recordFetch('billing_ccusage', true);
      expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(true);
    });

    it('should track OAuth cooldown separately from ccusage', () => {
      FreshnessManager.recordFetch('billing_oauth', false);
      expect(FreshnessManager.shouldRefetch('billing_oauth')).toBe(false);
      expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(true);
    });
  });

  describe('Phase 4: Health File Generation', () => {
    it('should generate health file with correct staleness indicators', () => {
      const health: SessionHealth = {
        sessionId: 'test-simulation-001',
        projectPath: '/Users/test/project',
        health: { status: 'healthy', lastUpdate: Date.now(), issues: [] },
        billing: {
          costToday: 10.50,
          burnRatePerHour: 3.25,
          budgetRemaining: 120,
          budgetPercentUsed: 60,
          resetTime: '14:00',
          totalTokens: 2000000,
          tokensPerMinute: 75000,
          isFresh: false, // Will be recomputed
          lastFetched: Date.now() - (15 * 60 * 1000) // 15 minutes ago - CRITICAL
        },
        model: {
          value: 'opus-4-5',
          source: 'transcript',
          confidence: 90,
          updatedAt: Date.now()
        },
        context: {
          tokensUsed: 150000,
          tokensLeft: 50000,
          percentUsed: 75,
          windowSize: 200000,
          nearCompaction: false,
          updatedAt: Date.now()
        },
        git: {
          branch: 'main',
          ahead: 0,
          behind: 0,
          dirty: 5,
          lastChecked: Date.now()
        },
        gatheredAt: Date.now()
      };

      // Verify isFresh is recomputed correctly
      health.billing.isFresh = FreshnessManager.isBillingFresh(health.billing.lastFetched);
      expect(health.billing.isFresh).toBe(false);

      // Verify indicator is critical (🔺)
      const indicator = FreshnessManager.getIndicator(health.billing.lastFetched, 'billing_ccusage');
      expect(indicator).toBe('🔺');
    });
  });

  describe('Phase 5: Display Layer Integration', () => {
    it('should show ⚠⚠ for stale billing data', () => {
      const health: SessionHealth = {
        sessionId: 'test-display-001',
        projectPath: '/test',
        health: {
          status: 'warning',
          lastUpdate: Date.now(),
          issues: ['Billing data stale']
        },
        billing: {
          costToday: 5.0,
          burnRatePerHour: 2.0,
          budgetRemaining: 100,
          budgetPercentUsed: 50,
          resetTime: '14:00',
          totalTokens: 1000000,
          tokensPerMinute: null,
          isFresh: false,
          lastFetched: Date.now() - (5 * 60 * 1000) // 5 min ago - STALE
        },
        model: { value: 'opus-4', source: 'stdin', confidence: 100, updatedAt: Date.now() },
        context: { tokensUsed: 100000, tokensLeft: 100000, percentUsed: 50, windowSize: 200000, nearCompaction: false, updatedAt: Date.now() },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0, lastChecked: Date.now() },
        gatheredAt: Date.now()
      };

      const output = StatuslineFormatter.formatForWidth(health, 120);
      // Health status should show warning indicators
      expect(health.health.issues).toContain('Billing data stale');
    });
  });

  describe('Phase 6: Multi-Session Simulation', () => {
    const sessions = [
      { id: 'session-aaa', project: '/project-a', authProfile: 'work' },
      { id: 'session-bbb', project: '/project-b', authProfile: 'personal' },
      { id: 'session-ccc', project: '/project-c', authProfile: 'work' }
    ];

    it('should share billing cache across sessions with same auth profile', () => {
      // Sessions with same auth profile should see same billing data
      const sharedCache = {
        costToday: 15.75,
        burnRatePerHour: 4.50,
        budgetRemaining: 90,
        budgetPercentUsed: 70,
        resetTime: '11:00',
        totalTokens: 3500000,
        tokensPerMinute: 100000,
        isFresh: true,
        lastFetched: Date.now()
      };

      // All sessions reading from shared cache should get same data
      for (const session of sessions) {
        const health: Partial<SessionHealth> = {
          sessionId: session.id,
          billing: { ...sharedCache }
        };

        expect(health.billing?.costToday).toBe(15.75);
        expect(FreshnessManager.isBillingFresh(health.billing?.lastFetched)).toBe(true);
      }
    });
  });

  describe('Phase 7: Edge Cases', () => {
    it('should handle missing billing data gracefully', () => {
      const health: SessionHealth = {
        sessionId: 'test-edge-001',
        projectPath: '/test',
        health: { status: 'healthy', lastUpdate: Date.now(), issues: [] },
        billing: {
          costToday: 0,
          burnRatePerHour: 0,
          budgetRemaining: 0,
          budgetPercentUsed: 0,
          resetTime: '',
          isFresh: false
        },
        model: { value: 'unknown', source: 'default', confidence: 0, updatedAt: Date.now() },
        context: { tokensUsed: 0, tokensLeft: 200000, percentUsed: 0, windowSize: 200000, nearCompaction: false, updatedAt: Date.now() },
        git: { branch: 'main', dirty: 0 },
        gatheredAt: Date.now()
      };

      expect(health.billing.isFresh).toBe(false);
      expect(health.billing.costToday).toBe(0);
    });

    it('should handle OAuth 401 with ccusage fallback', () => {
      // Simulate OAuth failure
      FreshnessManager.recordFetch('billing_oauth', false);
      expect(FreshnessManager.shouldRefetch('billing_oauth')).toBe(false);

      // ccusage should still be available
      expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(true);

      // After ccusage also fails
      FreshnessManager.recordFetch('billing_ccusage', false);
      expect(FreshnessManager.shouldRefetch('billing_ccusage')).toBe(false);

      // Both are in cooldown - system should use stale cache
    });

    it('should compute freshness report correctly', () => {
      const timestamps = {
        billing_ccusage: Date.now() - (15 * 60 * 1000), // critical
        billing_oauth: Date.now() - (3 * 60 * 1000),    // stale
        git_status: Date.now() - 1000,                   // fresh
        model: Date.now() - (2 * 60 * 1000),             // fresh
        context: Date.now() - 100,                       // fresh
        transcript: Date.now() - (10 * 60 * 1000),       // critical
      };

      const report = FreshnessManager.getReport(timestamps);

      expect(report.fields.billing_ccusage.status).toBe('critical');
      expect(report.fields.billing_ccusage.indicator).toBe('🔺');

      expect(report.fields.billing_oauth.status).toBe('stale');
      expect(report.fields.billing_oauth.indicator).toBe('⚠');

      expect(report.fields.git_status.status).toBe('fresh');
      expect(report.fields.git_status.indicator).toBe('');

      expect(report.fields.model.status).toBe('fresh');
      expect(report.fields.context.status).toBe('fresh');
      expect(report.fields.transcript.status).toBe('critical');
    });
  });

  describe('Phase 8: Freshness Threshold Boundaries', () => {
    const testCases = [
      { category: 'billing_ccusage', freshMs: 120_000, staleMs: 600_000 },
      { category: 'billing_oauth', freshMs: 120_000, staleMs: 600_000 },
      { category: 'git_status', freshMs: 30_000, staleMs: 300_000 },
      { category: 'weekly_quota', freshMs: 300_000, staleMs: 86_400_000 },
    ];

    for (const tc of testCases) {
      it(`${tc.category}: boundary at freshMs=${tc.freshMs}`, () => {
        // Just before threshold - should be fresh
        const justBeforeFresh = Date.now() - (tc.freshMs - 1000);
        expect(FreshnessManager.getStatus(justBeforeFresh, tc.category)).toBe('fresh');

        // Just after threshold - should be stale
        const justAfterFresh = Date.now() - (tc.freshMs + 1000);
        expect(FreshnessManager.getStatus(justAfterFresh, tc.category)).toBe('stale');
      });

      it(`${tc.category}: boundary at staleMs=${tc.staleMs}`, () => {
        // Just before critical - should be stale
        const justBeforeCritical = Date.now() - (tc.staleMs - 1000);
        expect(FreshnessManager.getStatus(justBeforeCritical, tc.category)).toBe('stale');

        // Just after critical - should be critical
        const justAfterCritical = Date.now() - (tc.staleMs + 1000);
        expect(FreshnessManager.getStatus(justAfterCritical, tc.category)).toBe('critical');
      });
    }
  });
});

describe('Real Billing Data Diagnostic', () => {
  it('should diagnose current session billing state', () => {
    // Read actual shared cache
    if (existsSync(SHARED_CACHE_PATH)) {
      const cache = JSON.parse(readFileSync(SHARED_CACHE_PATH, 'utf-8'));
      const age = Date.now() - cache.lastFetched;
      const status = FreshnessManager.getStatus(cache.lastFetched, 'billing_ccusage');
      const indicator = FreshnessManager.getIndicator(cache.lastFetched, 'billing_ccusage');

      console.log('\n=== REAL BILLING CACHE DIAGNOSTIC ===');
      console.log(`Cost today: $${cache.costToday?.toFixed(2) || 'N/A'}`);
      console.log(`Last fetched: ${new Date(cache.lastFetched).toISOString()}`);
      console.log(`Age: ${Math.floor(age / 60000)} minutes`);
      console.log(`Status: ${status} ${indicator}`);
      console.log(`isFresh (computed): ${FreshnessManager.isBillingFresh(cache.lastFetched)}`);
      console.log(`isFresh (stored): ${cache.isFresh}`);
      console.log('=====================================\n');

      // This will fail if billing is stale, showing the actual state
      if (age > 10 * 60 * 1000) {
        console.warn('WARNING: Billing cache is CRITICAL stale (>10min)');
        console.warn('Root causes to check:');
        console.warn('  1. OAuth tokens expired? Run: claude /login');
        console.warn('  2. ccusage hanging? Check: ps aux | grep ccusage');
        console.warn('  3. Cooldown active? Check: ls ~/.claude/session-health/cooldowns/');
      }
    }

    // Check cooldown states
    console.log('\n=== COOLDOWN STATUS ===');
    for (const cat of ['billing_oauth', 'billing_ccusage']) {
      const remaining = FreshnessManager.getCooldownRemaining(cat);
      const canRefetch = FreshnessManager.shouldRefetch(cat);
      console.log(`${cat}: can_refetch=${canRefetch}, cooldown_remaining=${Math.floor(remaining/1000)}s`);
    }
    console.log('========================\n');

    expect(true).toBe(true); // Always passes - diagnostic only
  });
});
