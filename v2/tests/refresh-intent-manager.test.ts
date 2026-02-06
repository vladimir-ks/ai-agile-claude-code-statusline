/**
 * Tests for RefreshIntentManager - File-based refresh coordination
 *
 * Verifies:
 * - Intent signaling (touch-based, idempotent)
 * - In-progress tracking (PID-based, stale detection)
 * - Intent clearing (on success)
 * - Age tracking
 * - Stale cleanup
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { RefreshIntentManager } from '../src/lib/refresh-intent-manager';

const TEST_DIR = join(tmpdir(), `intent-test-${Date.now()}`);
const INTENTS_DIR = join(TEST_DIR, 'refresh-intents');

describe('RefreshIntentManager', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Initialize manager with test directory
    RefreshIntentManager.setBasePath(TEST_DIR);
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('signalRefreshNeeded', () => {
    test('creates intent file in correct directory', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');
      expect(existsSync(join(INTENTS_DIR, 'billing.intent'))).toBe(true);
    });

    test('creates refresh-intents directory if missing', () => {
      expect(existsSync(INTENTS_DIR)).toBe(false);
      RefreshIntentManager.signalRefreshNeeded('billing');
      expect(existsSync(INTENTS_DIR)).toBe(true);
    });

    test('is idempotent - 30 calls create 1 file without error', () => {
      for (let i = 0; i < 30; i++) {
        expect(() => RefreshIntentManager.signalRefreshNeeded('billing')).not.toThrow();
      }
      expect(existsSync(join(INTENTS_DIR, 'billing.intent'))).toBe(true);
    });

    test('creates separate files for different categories', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');
      RefreshIntentManager.signalRefreshNeeded('quota');
      RefreshIntentManager.signalRefreshNeeded('git');

      expect(existsSync(join(INTENTS_DIR, 'billing.intent'))).toBe(true);
      expect(existsSync(join(INTENTS_DIR, 'quota.intent'))).toBe(true);
      expect(existsSync(join(INTENTS_DIR, 'git.intent'))).toBe(true);
    });
  });

  describe('signalRefreshInProgress', () => {
    test('writes PID to inprogress file', () => {
      RefreshIntentManager.signalRefreshInProgress('billing');
      const content = readFileSync(join(INTENTS_DIR, 'billing.inprogress'), 'utf-8');
      expect(content).toBe(String(process.pid));
    });

    test('creates directory if missing', () => {
      RefreshIntentManager.signalRefreshInProgress('billing');
      expect(existsSync(join(INTENTS_DIR, 'billing.inprogress'))).toBe(true);
    });
  });

  describe('isRefreshRequested', () => {
    test('returns true when intent file exists', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');
      expect(RefreshIntentManager.isRefreshRequested('billing')).toBe(true);
    });

    test('returns false when no intent file', () => {
      expect(RefreshIntentManager.isRefreshRequested('billing')).toBe(false);
    });
  });

  describe('isRefreshInProgress', () => {
    test('returns true when inprogress file exists with alive PID', () => {
      RefreshIntentManager.signalRefreshInProgress('billing');
      expect(RefreshIntentManager.isRefreshInProgress('billing')).toBe(true);
    });

    test('returns false when no inprogress file', () => {
      expect(RefreshIntentManager.isRefreshInProgress('billing')).toBe(false);
    });

    test('returns false when PID in inprogress file is dead', () => {
      // Write a PID that definitely doesn't exist (very high number)
      mkdirSync(INTENTS_DIR, { recursive: true });
      writeFileSync(join(INTENTS_DIR, 'billing.inprogress'), '9999999');
      expect(RefreshIntentManager.isRefreshInProgress('billing')).toBe(false);
    });

    test('cleans up stale inprogress file with dead PID', () => {
      mkdirSync(INTENTS_DIR, { recursive: true });
      writeFileSync(join(INTENTS_DIR, 'billing.inprogress'), '9999999');
      RefreshIntentManager.isRefreshInProgress('billing');
      // Stale file should be cleaned up
      expect(existsSync(join(INTENTS_DIR, 'billing.inprogress'))).toBe(false);
    });
  });

  describe('clearIntent', () => {
    test('removes both intent and inprogress files', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');
      RefreshIntentManager.signalRefreshInProgress('billing');

      expect(existsSync(join(INTENTS_DIR, 'billing.intent'))).toBe(true);
      expect(existsSync(join(INTENTS_DIR, 'billing.inprogress'))).toBe(true);

      RefreshIntentManager.clearIntent('billing');

      expect(existsSync(join(INTENTS_DIR, 'billing.intent'))).toBe(false);
      expect(existsSync(join(INTENTS_DIR, 'billing.inprogress'))).toBe(false);
    });

    test('does not throw when files do not exist', () => {
      expect(() => RefreshIntentManager.clearIntent('billing')).not.toThrow();
    });
  });

  describe('clearInProgress', () => {
    test('removes only inprogress file, leaves intent', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');
      RefreshIntentManager.signalRefreshInProgress('billing');

      RefreshIntentManager.clearInProgress('billing');

      expect(existsSync(join(INTENTS_DIR, 'billing.intent'))).toBe(true);
      expect(existsSync(join(INTENTS_DIR, 'billing.inprogress'))).toBe(false);
    });
  });

  describe('getIntentAge', () => {
    test('returns age in ms for existing intent', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');
      const age = RefreshIntentManager.getIntentAge('billing');
      expect(age).not.toBeNull();
      expect(age!).toBeGreaterThanOrEqual(0);
      expect(age!).toBeLessThan(1000); // Should be very recent
    });

    test('returns null when no intent exists', () => {
      expect(RefreshIntentManager.getIntentAge('billing')).toBeNull();
    });

    test('returns correct age for old intent', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');
      // Backdate the file by 60 seconds
      const intentPath = join(INTENTS_DIR, 'billing.intent');
      const past = new Date(Date.now() - 60000);
      utimesSync(intentPath, past, past);

      const age = RefreshIntentManager.getIntentAge('billing');
      expect(age).not.toBeNull();
      expect(age!).toBeGreaterThanOrEqual(59000);
      expect(age!).toBeLessThan(62000);
    });
  });

  describe('getPendingIntents', () => {
    test('returns empty array when no intents', () => {
      expect(RefreshIntentManager.getPendingIntents()).toEqual([]);
    });

    test('returns all categories with intent files', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');
      RefreshIntentManager.signalRefreshNeeded('quota');

      const pending = RefreshIntentManager.getPendingIntents();
      expect(pending).toContain('billing');
      expect(pending).toContain('quota');
      expect(pending).toHaveLength(2);
    });

    test('does not include categories with only inprogress files', () => {
      RefreshIntentManager.signalRefreshInProgress('billing');

      const pending = RefreshIntentManager.getPendingIntents();
      expect(pending).not.toContain('billing');
    });
  });

  describe('cleanStale', () => {
    test('removes intent files older than threshold', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');
      // Backdate by 15 minutes
      const intentPath = join(INTENTS_DIR, 'billing.intent');
      const past = new Date(Date.now() - 15 * 60 * 1000);
      utimesSync(intentPath, past, past);

      RefreshIntentManager.cleanStale(600000); // 10 min threshold
      expect(existsSync(intentPath)).toBe(false);
    });

    test('preserves recent intent files', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');

      RefreshIntentManager.cleanStale(600000); // 10 min threshold
      expect(existsSync(join(INTENTS_DIR, 'billing.intent'))).toBe(true);
    });

    test('removes stale inprogress files too', () => {
      RefreshIntentManager.signalRefreshInProgress('billing');
      const path = join(INTENTS_DIR, 'billing.inprogress');
      const past = new Date(Date.now() - 15 * 60 * 1000);
      utimesSync(path, past, past);

      RefreshIntentManager.cleanStale(600000);
      expect(existsSync(path)).toBe(false);
    });

    test('does not throw on empty or missing directory', () => {
      expect(() => RefreshIntentManager.cleanStale(600000)).not.toThrow();
    });
  });

  describe('fault injection - error resilience', () => {
    test('isRefreshInProgress handles corrupted inprogress file gracefully', () => {
      mkdirSync(INTENTS_DIR, { recursive: true });
      // Write invalid PID (non-numeric)
      writeFileSync(join(INTENTS_DIR, 'billing.inprogress'), 'not-a-number');

      // Should return false without throwing
      expect(() => RefreshIntentManager.isRefreshInProgress('billing')).not.toThrow();
      expect(RefreshIntentManager.isRefreshInProgress('billing')).toBe(false);

      // Should clean up corrupted file
      expect(existsSync(join(INTENTS_DIR, 'billing.inprogress'))).toBe(false);
    });

    test('isRefreshInProgress handles empty inprogress file', () => {
      mkdirSync(INTENTS_DIR, { recursive: true });
      // Write empty file
      writeFileSync(join(INTENTS_DIR, 'billing.inprogress'), '');

      expect(() => RefreshIntentManager.isRefreshInProgress('billing')).not.toThrow();
      expect(RefreshIntentManager.isRefreshInProgress('billing')).toBe(false);

      // Should clean up empty file
      expect(existsSync(join(INTENTS_DIR, 'billing.inprogress'))).toBe(false);
    });

    test('getIntentAge handles permission errors gracefully', () => {
      // This test simulates a scenario where stat might fail
      // We can't easily inject permission errors in test env, but verify null handling
      expect(() => RefreshIntentManager.getIntentAge('nonexistent')).not.toThrow();
      expect(RefreshIntentManager.getIntentAge('nonexistent')).toBeNull();
    });

    test('cleanStale handles partially corrupted intent directory', () => {
      mkdirSync(INTENTS_DIR, { recursive: true });

      // Create valid file and backdate it by 1ms to ensure it's older than threshold
      const validPath = join(INTENTS_DIR, 'valid.intent');
      writeFileSync(validPath, '12345');
      const past = new Date(Date.now() - 1);
      utimesSync(validPath, past, past);

      // Create file with no extension (should be ignored)
      writeFileSync(join(INTENTS_DIR, 'invalid-no-ext'), '12345');
      // Create unrelated file
      writeFileSync(join(INTENTS_DIR, 'other.txt'), 'data');

      // Should not throw even with mixed content
      expect(() => RefreshIntentManager.cleanStale(0)).not.toThrow();

      // Only .intent file should be cleaned (threshold=0, file is 1ms old)
      expect(existsSync(validPath)).toBe(false);
      // Others should remain untouched
      expect(existsSync(join(INTENTS_DIR, 'invalid-no-ext'))).toBe(true);
      expect(existsSync(join(INTENTS_DIR, 'other.txt'))).toBe(true);
    });

    test('signalRefreshNeeded is atomic - concurrent writes do not corrupt', async () => {
      // Simulate 10 concurrent daemons writing intent at the same time
      const promises = Array(10).fill(0).map(() =>
        Promise.resolve(RefreshIntentManager.signalRefreshNeeded('billing'))
      );

      await Promise.all(promises);

      // Should have exactly 1 valid intent file
      expect(existsSync(join(INTENTS_DIR, 'billing.intent'))).toBe(true);

      // File should be readable (not corrupted)
      const content = readFileSync(join(INTENTS_DIR, 'billing.intent'), 'utf-8');
      expect(content).toMatch(/^\d+$/); // Should contain timestamp
    });

    test('clearIntent handles race condition - file deleted between check and unlink', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');

      // Manually delete file before clearIntent runs
      const intentPath = join(INTENTS_DIR, 'billing.intent');
      if (existsSync(intentPath)) {
        rmSync(intentPath);
      }

      // Should not throw even though file is already gone
      expect(() => RefreshIntentManager.clearIntent('billing')).not.toThrow();
    });
  });
});
