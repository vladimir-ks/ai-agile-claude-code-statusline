/**
 * Tests for QuotaBrokerClient - Merged quota cache consumer
 *
 * Verifies:
 * - File read + JSON parsing
 * - Memory cache (10s TTL)
 * - Freshness computation (age_seconds, is_fresh)
 * - Active slot resolution (4 strategies)
 * - Switch message generation
 * - Slot status lookup
 * - Lock file PID liveness check
 * - Background broker spawn logic
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { QuotaBrokerClient } from '../src/lib/quota-broker-client';
import type { MergedQuotaData, MergedQuotaSlot } from '../src/types/session-health';

const TEST_DIR = join(tmpdir(), `broker-client-test-${Date.now()}`);
const CACHE_FILE = join(TEST_DIR, 'merged-quota-cache.json');
const LOCK_FILE = join(TEST_DIR, '.quota-fetch.lock');

// Helper: create a valid MergedQuotaSlot
function makeSlot(overrides: Partial<MergedQuotaSlot> = {}): MergedQuotaSlot {
  return {
    email: 'test@example.com',
    status: 'active',
    subscription_type: 'max',
    five_hour_util: 25,
    seven_day_util: 50,
    five_hour_resets_at: '2026-02-07T00:00:00Z',
    seven_day_resets_at: '2026-02-12T00:00:00Z',
    weekly_budget_remaining_hours: 100,
    weekly_reset_day: 'Thu',
    daily_reset_time: '00:00',
    last_fetched: Date.now(),
    is_fresh: true,
    config_dir: '/tmp/test-config',
    keychain_hash: 'abcd1234',
    urgency: 100,
    rank: 1,
    reason: 'available',
    ...overrides
  };
}

// Helper: create a valid MergedQuotaData
function makeCache(overrides: Partial<MergedQuotaData> = {}): MergedQuotaData {
  return {
    ts: Math.floor(Date.now() / 1000), // fresh (now)
    active_slot: 'slot-1',
    recommended_slot: 'slot-1',
    failover_needed: false,
    all_exhausted: false,
    slots: {
      'slot-1': makeSlot({ email: 'vlad@example.com', rank: 1 }),
      'slot-2': makeSlot({
        email: 'other@example.com',
        config_dir: '/tmp/other-config',
        rank: 2,
        seven_day_util: 80,
        weekly_budget_remaining_hours: 40
      })
    },
    ...overrides
  };
}

describe('QuotaBrokerClient', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Override paths for testing
    (QuotaBrokerClient as any).CACHE_PATH = CACHE_FILE;
    (QuotaBrokerClient as any).LOCK_PATH = LOCK_FILE;
    (QuotaBrokerClient as any).BROKER_SCRIPT = '/nonexistent/broker.sh'; // Prevent real spawns
    QuotaBrokerClient.clearCache();
  });

  afterEach(() => {
    QuotaBrokerClient.clearCache();
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // --- read() ---

  describe('read', () => {
    test('returns null when cache file missing', () => {
      const result = QuotaBrokerClient.read();
      expect(result).toBeNull();
    });

    test('returns null for corrupted JSON', () => {
      writeFileSync(CACHE_FILE, 'NOT VALID JSON {{{', 'utf-8');
      const result = QuotaBrokerClient.read();
      expect(result).toBeNull();
    });

    test('returns null for empty file', () => {
      writeFileSync(CACHE_FILE, '', 'utf-8');
      const result = QuotaBrokerClient.read();
      expect(result).toBeNull();
    });

    test('returns null for missing ts field', () => {
      writeFileSync(CACHE_FILE, JSON.stringify({ slots: {} }), 'utf-8');
      const result = QuotaBrokerClient.read();
      expect(result).toBeNull();
    });

    test('returns null for missing slots field', () => {
      writeFileSync(CACHE_FILE, JSON.stringify({ ts: 123 }), 'utf-8');
      const result = QuotaBrokerClient.read();
      expect(result).toBeNull();
    });

    test('parses valid cache file', () => {
      const data = makeCache();
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const result = QuotaBrokerClient.read();
      expect(result).not.toBeNull();
      expect(result!.active_slot).toBe('slot-1');
      expect(result!.slots['slot-1'].email).toBe('vlad@example.com');
    });

    test('computes age_seconds correctly', () => {
      const tenSecondsAgo = Math.floor(Date.now() / 1000) - 10;
      const data = makeCache({ ts: tenSecondsAgo });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const result = QuotaBrokerClient.read();
      expect(result).not.toBeNull();
      expect(result!.age_seconds).toBeGreaterThanOrEqual(9);
      expect(result!.age_seconds).toBeLessThan(15);
    });

    test('is_fresh=true when data recent', () => {
      const data = makeCache({ ts: Math.floor(Date.now() / 1000) });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const result = QuotaBrokerClient.read();
      expect(result!.is_fresh).toBe(true);
    });

    test('is_fresh=false when data older than 5 minutes', () => {
      const sixMinutesAgo = Math.floor(Date.now() / 1000) - 360;
      const data = makeCache({ ts: sixMinutesAgo });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const result = QuotaBrokerClient.read();
      expect(result!.is_fresh).toBe(false);
    });

    test('memory cache returns same object within TTL', () => {
      const data = makeCache();
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const first = QuotaBrokerClient.read();
      // Modify file
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache({ active_slot: 'slot-2' })), 'utf-8');
      const second = QuotaBrokerClient.read();

      // Should return cached version (slot-1), not new version (slot-2)
      expect(second!.active_slot).toBe('slot-1');
    });

    test('clearCache forces re-read from file', () => {
      const data = makeCache();
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const first = QuotaBrokerClient.read();
      expect(first!.active_slot).toBe('slot-1');

      // Modify and clear cache
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache({ active_slot: 'slot-2' })), 'utf-8');
      QuotaBrokerClient.clearCache();

      const second = QuotaBrokerClient.read();
      expect(second!.active_slot).toBe('slot-2');
    });
  });

  // --- isAvailable() ---

  describe('isAvailable', () => {
    test('returns false when cache file missing', () => {
      expect(QuotaBrokerClient.isAvailable()).toBe(false);
    });

    test('returns true when cache file exists', () => {
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache()), 'utf-8');
      expect(QuotaBrokerClient.isAvailable()).toBe(true);
    });
  });

  // --- getActiveQuota() ---

  describe('getActiveQuota', () => {
    test('returns null when no cache file', () => {
      const result = QuotaBrokerClient.getActiveQuota();
      expect(result).toBeNull();
    });

    test('returns null for empty slots', () => {
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache({ slots: {} })), 'utf-8');
      const result = QuotaBrokerClient.getActiveQuota();
      expect(result).toBeNull();
    });

    test('Strategy 1: matches by configDir', () => {
      const data = makeCache();
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const result = QuotaBrokerClient.getActiveQuota('/tmp/other-config');
      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-2');
      expect(result!.email).toBe('other@example.com');
    });

    test('Strategy 0.5: matches by authEmail (hot-swap fix)', () => {
      const data = makeCache({
        active_slot: 'slot-1', // Broker says slot-1 is active
        slots: {
          'slot-1': makeSlot({
            email: 'rimidalvk@gmail.com',
            config_dir: null, // No config_dir set (hot-swap scenario)
            rank: 2
          }),
          'slot-2': makeSlot({
            email: 'vlad@vladks.com',
            config_dir: null, // No config_dir set
            rank: 1
          })
        }
      });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      // Session is using vladks.com account (from auth detection)
      // Without email matching, would fall back to active_slot (slot-1) = WRONG
      // With email matching, should select slot-2 = CORRECT
      const result = QuotaBrokerClient.getActiveQuota(
        undefined, // configDir not available or doesn't match
        undefined, // keychainService not available
        'vlad@vladks.com' // authEmail detected from session
      );

      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-2');
      expect(result!.email).toBe('vlad@vladks.com');
    });

    test('Strategy 0.5: email match is case-insensitive', () => {
      const data = makeCache({
        slots: {
          'slot-1': makeSlot({ email: 'Test@Example.COM', config_dir: null })
        }
      });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const result = QuotaBrokerClient.getActiveQuota(undefined, undefined, 'test@example.com');
      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-1');
    });

    test('Strategy 2: falls back to active_slot', () => {
      const data = makeCache({ active_slot: 'slot-2' });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      // No configDir match
      const result = QuotaBrokerClient.getActiveQuota('/nonexistent');
      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-2');
    });

    test('Strategy 3: single slot fallback', () => {
      const data = makeCache({
        active_slot: 'slot-99', // Non-existent
        slots: {
          'slot-3': makeSlot({ email: 'solo@example.com', config_dir: '/tmp/solo' })
        }
      });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const result = QuotaBrokerClient.getActiveQuota();
      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-3');
      expect(result!.email).toBe('solo@example.com');
    });

    test('Strategy 4: lowest rank fallback (skips inactive)', () => {
      const data = makeCache({
        active_slot: 'slot-99',
        slots: {
          'slot-a': makeSlot({ rank: 3, status: 'active', email: 'a@example.com', config_dir: '/a' }),
          'slot-b': makeSlot({ rank: 1, status: 'inactive', email: 'b@example.com', config_dir: '/b' }),
          'slot-c': makeSlot({ rank: 2, status: 'active', email: 'c@example.com', config_dir: '/c' })
        }
      });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const result = QuotaBrokerClient.getActiveQuota();
      expect(result).not.toBeNull();
      // slot-b has rank=1 but is inactive, so slot-c (rank=2) wins
      expect(result!.slotId).toBe('slot-c');
    });

    test('returns correct output shape', () => {
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache()), 'utf-8');

      const result = QuotaBrokerClient.getActiveQuota();
      expect(result).not.toBeNull();
      expect(typeof result!.dailyPercentUsed).toBe('number');
      expect(typeof result!.weeklyPercentUsed).toBe('number');
      expect(typeof result!.weeklyBudgetRemaining).toBe('number');
      expect(typeof result!.weeklyResetDay).toBe('string');
      expect(typeof result!.dailyResetTime).toBe('string');
      expect(typeof result!.lastFetched).toBe('number');
      expect(typeof result!.isStale).toBe('boolean');
      expect(result!.source).toBe('broker');
    });

    test('isStale=true when cache is stale', () => {
      const staleData = makeCache({ ts: Math.floor(Date.now() / 1000) - 600 });
      writeFileSync(CACHE_FILE, JSON.stringify(staleData), 'utf-8');

      const result = QuotaBrokerClient.getActiveQuota();
      expect(result!.isStale).toBe(true);
    });

    test('isStale=false when cache is fresh', () => {
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache()), 'utf-8');

      const result = QuotaBrokerClient.getActiveQuota();
      expect(result!.isStale).toBe(false);
    });
  });

  // --- getSwitchMessage() ---

  describe('getSwitchMessage', () => {
    test('returns null when no cache', () => {
      expect(QuotaBrokerClient.getSwitchMessage('slot-1')).toBeNull();
    });

    test('returns null when current == recommended', () => {
      const data = makeCache({ recommended_slot: 'slot-1' });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      expect(QuotaBrokerClient.getSwitchMessage('slot-1')).toBeNull();
    });

    test('returns null when recommended is "none"', () => {
      const data = makeCache({ recommended_slot: 'none' });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      expect(QuotaBrokerClient.getSwitchMessage('slot-1')).toBeNull();
    });

    test('returns message when switch recommended', () => {
      const data = makeCache({ recommended_slot: 'slot-2' });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      const msg = QuotaBrokerClient.getSwitchMessage('slot-1');
      expect(msg).not.toBeNull();
      expect(msg).toContain('slot-2');
      expect(msg).toContain('other@example.com');
      expect(msg).toContain('40h budget');
    });

    test('returns null when recommended slot not in slots', () => {
      const data = makeCache({ recommended_slot: 'slot-99' });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');

      expect(QuotaBrokerClient.getSwitchMessage('slot-1')).toBeNull();
    });
  });

  // --- getSlotStatus() ---

  describe('getSlotStatus', () => {
    test('returns "unknown" when no cache', () => {
      expect(QuotaBrokerClient.getSlotStatus('slot-1')).toBe('unknown');
    });

    test('returns "unknown" for missing slot', () => {
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache()), 'utf-8');
      expect(QuotaBrokerClient.getSlotStatus('slot-99')).toBe('unknown');
    });

    test('returns correct status for existing slot', () => {
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache()), 'utf-8');
      expect(QuotaBrokerClient.getSlotStatus('slot-1')).toBe('active');
    });

    test('returns inactive for inactive slot', () => {
      const data = makeCache({
        slots: {
          'slot-1': makeSlot({ status: 'inactive' })
        }
      });
      writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf-8');
      expect(QuotaBrokerClient.getSlotStatus('slot-1')).toBe('inactive');
    });
  });

  // --- getSlotByConfigDir() ---

  describe('getSlotByConfigDir', () => {
    test('returns null when no cache', () => {
      expect(QuotaBrokerClient.getSlotByConfigDir('/tmp/test')).toBeNull();
    });

    test('returns null for non-matching configDir', () => {
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache()), 'utf-8');
      expect(QuotaBrokerClient.getSlotByConfigDir('/nonexistent')).toBeNull();
    });

    test('returns slot data with slotId for matching configDir', () => {
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache()), 'utf-8');

      const result = QuotaBrokerClient.getSlotByConfigDir('/tmp/other-config');
      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-2');
      expect(result!.email).toBe('other@example.com');
    });
  });

  // --- isLockAlive (private, tested indirectly via read) ---

  describe('lock and refresh behavior', () => {
    test('no broker spawn when data is fresh', () => {
      // Fresh data (ts = now) → should NOT attempt broker spawn
      writeFileSync(CACHE_FILE, JSON.stringify(makeCache()), 'utf-8');

      // read() with fresh data should work without errors
      // (broker script doesn't exist, so if it tried to spawn, it would silently fail)
      const result = QuotaBrokerClient.read();
      expect(result).not.toBeNull();
      expect(result!.is_fresh).toBe(true);
    });

    test('stale data with no lock file does not crash', () => {
      // Stale data + no lock file → would try to spawn broker (which doesn't exist, but shouldn't crash)
      const staleData = makeCache({ ts: Math.floor(Date.now() / 1000) - 600 });
      writeFileSync(CACHE_FILE, JSON.stringify(staleData), 'utf-8');

      const result = QuotaBrokerClient.read();
      expect(result).not.toBeNull();
      expect(result!.is_fresh).toBe(false);
    });

    test('stale data with alive lock file does not crash', () => {
      const staleData = makeCache({ ts: Math.floor(Date.now() / 1000) - 600 });
      writeFileSync(CACHE_FILE, JSON.stringify(staleData), 'utf-8');
      // Write our own PID as the lock (alive process)
      writeFileSync(LOCK_FILE, String(process.pid), 'utf-8');

      const result = QuotaBrokerClient.read();
      expect(result).not.toBeNull();
    });

    test('stale data with dead PID in lock file does not crash', () => {
      const staleData = makeCache({ ts: Math.floor(Date.now() / 1000) - 600 });
      writeFileSync(CACHE_FILE, JSON.stringify(staleData), 'utf-8');
      // Write a definitely-dead PID
      writeFileSync(LOCK_FILE, '999999999', 'utf-8');

      const result = QuotaBrokerClient.read();
      expect(result).not.toBeNull();
    });

    test('lock file with invalid content handled gracefully', () => {
      const staleData = makeCache({ ts: Math.floor(Date.now() / 1000) - 600 });
      writeFileSync(CACHE_FILE, JSON.stringify(staleData), 'utf-8');
      writeFileSync(LOCK_FILE, 'not-a-number', 'utf-8');

      const result = QuotaBrokerClient.read();
      expect(result).not.toBeNull();
    });
  });
});
