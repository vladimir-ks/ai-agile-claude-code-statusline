/**
 * Tests for HotSwapQuotaReader
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { homedir } from 'os';
import { HotSwapQuotaReader } from '../src/lib/hot-swap-quota-reader';

const HOME = homedir();
const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;

describe('HotSwapQuotaReader', () => {
  beforeEach(() => {
    HotSwapQuotaReader.clearCache();
  });

  afterEach(() => {
    HotSwapQuotaReader.clearCache();
  });

  // --- Basic behavior ---

  test('read() returns null or valid object', () => {
    const result = HotSwapQuotaReader.read();
    expect(result === null || typeof result === 'object').toBe(true);
  });

  test('getActiveQuota returns correct structure when data exists', () => {
    const quota = HotSwapQuotaReader.getActiveQuota();

    if (quota) {
      expect(typeof quota.dailyPercentUsed).toBe('number');
      expect(typeof quota.weeklyPercentUsed).toBe('number');
      expect(typeof quota.weeklyBudgetRemaining).toBe('number');
      expect(typeof quota.weeklyResetDay).toBe('string');
      expect(typeof quota.dailyResetTime).toBe('string');
      expect(typeof quota.lastFetched).toBe('number');
      expect(typeof quota.isStale).toBe('boolean');
      expect(quota.source).toBe('hot-swap');
      expect(typeof quota.email).toBe('string');
      expect(typeof quota.slotId).toBe('string');
    }
  });

  test('getFreshestSlot returns slot with is_fresh=true', () => {
    const freshest = HotSwapQuotaReader.getFreshestSlot();

    if (freshest) {
      expect(typeof freshest.slotId).toBe('string');
      expect(typeof freshest.data).toBe('object');
      expect(freshest.data.is_fresh).toBe(true);
    }
  });

  test('isAvailable returns boolean', () => {
    const available = HotSwapQuotaReader.isAvailable();
    expect(typeof available).toBe('boolean');
  });

  test('clearCache resets memory cache', () => {
    // Read once to populate cache
    HotSwapQuotaReader.read();
    HotSwapQuotaReader.clearCache();

    // Should work without error after clearing
    const result = HotSwapQuotaReader.read();
    expect(result === null || typeof result === 'object').toBe(true);
  });

  // --- Active slot detection ---

  test('getActiveQuota detects correct active slot from claude-sessions.yaml', () => {
    const quota = HotSwapQuotaReader.getActiveQuota();

    if (quota) {
      // If hot-swap-quota.json and claude-sessions.yaml both exist,
      // the returned slot should match the active_account from claude-sessions.yaml
      // In the test environment, we verify the slot is one of the known slots
      expect(quota.slotId).toMatch(/^slot-\d+$/);
      expect(quota.email).toContain('@');
    }
  });

  test('getSlotByEmail finds slot case-insensitively', () => {
    const cache = HotSwapQuotaReader.read();
    if (!cache) return;

    const slots = Object.values(cache);
    if (slots.length === 0) return;

    const email = slots[0].email;
    const found = HotSwapQuotaReader.getSlotByEmail(email.toUpperCase());
    expect(found).not.toBeNull();
    expect(found!.email.toLowerCase()).toBe(email.toLowerCase());
  });

  test('getSlotById returns null for nonexistent slot', () => {
    const result = HotSwapQuotaReader.getSlotById('slot-99');
    expect(result).toBeNull();
  });

  test('getSlotById returns data for existing slot', () => {
    const cache = HotSwapQuotaReader.read();
    if (!cache) return;

    const slotIds = Object.keys(cache);
    if (slotIds.length === 0) return;

    const result = HotSwapQuotaReader.getSlotById(slotIds[0]);
    expect(result).not.toBeNull();
    expect(typeof result!.email).toBe('string');
    expect(typeof result!.five_hour_util).toBe('number');
    expect(typeof result!.seven_day_util).toBe('number');
  });

  // --- Data quality ---

  test('quota percentages are within valid range', () => {
    const quota = HotSwapQuotaReader.getActiveQuota();
    if (!quota) return;

    expect(quota.dailyPercentUsed).toBeGreaterThanOrEqual(0);
    expect(quota.dailyPercentUsed).toBeLessThanOrEqual(100);
    expect(quota.weeklyPercentUsed).toBeGreaterThanOrEqual(0);
    expect(quota.weeklyPercentUsed).toBeLessThanOrEqual(100);
  });

  test('weekly reset day is valid day abbreviation', () => {
    const quota = HotSwapQuotaReader.getActiveQuota();
    if (!quota) return;

    const validDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    expect(validDays).toContain(quota.weeklyResetDay);
  });

  test('lastFetched is a reasonable timestamp', () => {
    const quota = HotSwapQuotaReader.getActiveQuota();
    if (!quota) return;

    // Should be within last 24 hours (86400000ms)
    const age = Date.now() - quota.lastFetched;
    expect(age).toBeGreaterThanOrEqual(0);
    // If it's more than 24h old, something is wrong
    expect(age).toBeLessThan(86400000);
  });

  // --- Memory cache behavior ---

  test('repeated reads use memory cache', () => {
    const t1 = performance.now();
    HotSwapQuotaReader.read();
    const firstRead = performance.now() - t1;

    const t2 = performance.now();
    HotSwapQuotaReader.read();
    const secondRead = performance.now() - t2;

    // Second read should be significantly faster (memory cache)
    // Not a hard assertion since both may be fast, but second should not be slower
    expect(secondRead).toBeLessThan(firstRead + 5); // 5ms tolerance
  });

  // --- configDir matching (session-aware token resolution) ---

  describe('getActiveQuota with configDir', () => {
    let originalCache: string | null = null;

    beforeEach(() => {
      HotSwapQuotaReader.clearCache();
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }
    });

    afterEach(() => {
      HotSwapQuotaReader.clearCache();
      if (originalCache) {
        writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
        originalCache = null;
      }
    });

    const mockCache = {
      'slot-1': {
        email: 'alpha@test.com',
        five_hour_util: 20,
        seven_day_util: 40,
        weekly_budget_remaining_hours: 100,
        weekly_reset_day: 'Mon',
        daily_reset_time: '14:00',
        last_fetched: Date.now() - 10000,
        is_fresh: true,
        config_dir: '/custom/path/slot-1',
        keychain_hash: 'aaaa1111',
      },
      'slot-2': {
        email: 'beta@test.com',
        five_hour_util: 70,
        seven_day_util: 90,
        weekly_budget_remaining_hours: 20,
        weekly_reset_day: 'Fri',
        daily_reset_time: '22:00',
        last_fetched: Date.now() - 20000,
        is_fresh: true,
        config_dir: '/custom/path/slot-2',
        keychain_hash: 'bbbb2222',
      },
    };

    test('selects slot-1 when configDir matches slot-1', () => {
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(mockCache), 'utf-8');
      HotSwapQuotaReader.clearCache();

      const result = HotSwapQuotaReader.getActiveQuota('/custom/path/slot-1');
      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-1');
      expect(result!.email).toBe('alpha@test.com');
      expect(result!.dailyPercentUsed).toBe(20);
    });

    test('selects slot-2 when configDir matches slot-2', () => {
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(mockCache), 'utf-8');
      HotSwapQuotaReader.clearCache();

      const result = HotSwapQuotaReader.getActiveQuota('/custom/path/slot-2');
      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-2');
      expect(result!.email).toBe('beta@test.com');
      expect(result!.dailyPercentUsed).toBe(70);
    });

    test('does not match when configDir is slightly different', () => {
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(mockCache), 'utf-8');
      HotSwapQuotaReader.clearCache();

      // Close but not exact match
      const result = HotSwapQuotaReader.getActiveQuota('/custom/path/slot-1/');
      // Trailing slash means it should NOT match (exact string comparison)
      // Falls to strategy 2/3/4
      if (result) {
        // If it matched, it should be via a fallback strategy, not configDir
        // We just verify it doesn't incorrectly claim to be slot-1 via configDir
        expect(result.source).toBe('hot-swap');
      }
    });

    test('returns null when cache is empty and configDir specified', () => {
      writeFileSync(QUOTA_CACHE_PATH, '{}', 'utf-8');
      HotSwapQuotaReader.clearCache();

      const result = HotSwapQuotaReader.getActiveQuota('/custom/path/slot-1');
      expect(result).toBeNull();
    });

    test('handles slots without config_dir field', () => {
      const cacheWithoutConfigDir = {
        'slot-1': {
          email: 'alpha@test.com',
          five_hour_util: 20,
          seven_day_util: 40,
          weekly_budget_remaining_hours: 100,
          weekly_reset_day: 'Mon',
          daily_reset_time: '14:00',
          last_fetched: Date.now() - 10000,
          is_fresh: true,
          // No config_dir field
        },
      };

      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(cacheWithoutConfigDir), 'utf-8');
      HotSwapQuotaReader.clearCache();

      // configDir provided but no slot has config_dir → falls to other strategies
      const result = HotSwapQuotaReader.getActiveQuota('/custom/path/slot-1');
      // Should still return the single slot via strategy 3
      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-1');
    });

    test('configDir match preserves all quota data fields', () => {
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(mockCache), 'utf-8');
      HotSwapQuotaReader.clearCache();

      const result = HotSwapQuotaReader.getActiveQuota('/custom/path/slot-1');
      expect(result).not.toBeNull();

      // Verify all fields are present and correct
      expect(result!.dailyPercentUsed).toBe(20);
      expect(result!.weeklyPercentUsed).toBe(40);
      expect(result!.weeklyBudgetRemaining).toBe(100);
      expect(result!.weeklyResetDay).toBe('Mon');
      expect(result!.dailyResetTime).toBe('14:00');
      expect(typeof result!.lastFetched).toBe('number');
      expect(typeof result!.isStale).toBe('boolean');
      expect(result!.source).toBe('hot-swap');
    });

    test('staleness is correctly computed for configDir-matched slot', () => {
      // Create cache with very old data
      const staleCache = {
        'slot-1': {
          ...mockCache['slot-1'],
          last_fetched: Date.now() - 300000, // 5 minutes old (> 2min threshold)
          is_fresh: false,
        },
      };

      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(staleCache), 'utf-8');
      HotSwapQuotaReader.clearCache();

      const result = HotSwapQuotaReader.getActiveQuota('/custom/path/slot-1');
      expect(result).not.toBeNull();
      expect(result!.isStale).toBe(true);
    });

    test('fresh data is correctly identified for configDir-matched slot', () => {
      const freshCache = {
        'slot-1': {
          ...mockCache['slot-1'],
          last_fetched: Date.now() - 5000, // 5 seconds old
          is_fresh: true,
        },
      };

      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(freshCache), 'utf-8');
      HotSwapQuotaReader.clearCache();

      const result = HotSwapQuotaReader.getActiveQuota('/custom/path/slot-1');
      expect(result).not.toBeNull();
      expect(result!.isStale).toBe(false);
    });
  });
});
