/**
 * Tests for v2/src/lib/single-flight-coordinator.ts
 *
 * Wraps RefreshIntentManager for generalized single-flight locking.
 * Uses file-based intent signals with PID liveness checks.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { SingleFlightCoordinator } from '../src/lib/single-flight-coordinator';
import { RefreshIntentManager } from '../src/lib/refresh-intent-manager';

describe('SingleFlightCoordinator', () => {
  let tempDir: string;
  let originalBasePath: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `sfc-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });

    // Override RefreshIntentManager base path for isolation
    originalBasePath = tempDir; // we just record what we set
    RefreshIntentManager.setBasePath(tempDir);
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    // Reset to default (home dir based)
    RefreshIntentManager.setBasePath(join(require('os').homedir(), '.claude/session-health'));
  });

  // -------------------------------------------------------------------------
  // tryAcquire
  // -------------------------------------------------------------------------

  describe('tryAcquire()', () => {
    test('acquires lock when no one else is refreshing', () => {
      const result = SingleFlightCoordinator.tryAcquire('billing_oauth');
      expect(result.acquired).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    test('creates intent file on acquire', () => {
      SingleFlightCoordinator.tryAcquire('billing_oauth');
      const intentPath = join(tempDir, 'refresh-intents', 'billing_oauth.intent');
      expect(existsSync(intentPath)).toBe(true);
    });

    test('creates inprogress file on acquire', () => {
      SingleFlightCoordinator.tryAcquire('billing_oauth');
      const inprogressPath = join(tempDir, 'refresh-intents', 'billing_oauth.inprogress');
      expect(existsSync(inprogressPath)).toBe(true);

      // Should contain our PID
      const content = readFileSync(inprogressPath, 'utf-8').trim();
      expect(parseInt(content, 10)).toBe(process.pid);
    });

    test('fails when another process is already refreshing (alive PID)', () => {
      // Simulate another process holding the lock (use our own PID — it's alive)
      RefreshIntentManager.signalRefreshInProgress('billing_oauth');

      const result = SingleFlightCoordinator.tryAcquire('billing_oauth');
      expect(result.acquired).toBe(false);
      expect(result.reason).toBe('already_in_progress');
    });

    test('succeeds when stale inprogress file has dead PID', () => {
      // Write inprogress with a definitely-dead PID
      const intentsDir = join(tempDir, 'refresh-intents');
      mkdirSync(intentsDir, { recursive: true });
      writeFileSync(join(intentsDir, 'billing_oauth.inprogress'), '99999999');

      const result = SingleFlightCoordinator.tryAcquire('billing_oauth');
      expect(result.acquired).toBe(true);
    });

    test('can acquire different categories independently', () => {
      const r1 = SingleFlightCoordinator.tryAcquire('billing_oauth');
      const r2 = SingleFlightCoordinator.tryAcquire('git_status');
      expect(r1.acquired).toBe(true);
      expect(r2.acquired).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // release
  // -------------------------------------------------------------------------

  describe('release()', () => {
    test('on success: clears both intent and inprogress', () => {
      SingleFlightCoordinator.tryAcquire('billing_oauth');

      const intentPath = join(tempDir, 'refresh-intents', 'billing_oauth.intent');
      const inprogressPath = join(tempDir, 'refresh-intents', 'billing_oauth.inprogress');

      expect(existsSync(intentPath)).toBe(true);
      expect(existsSync(inprogressPath)).toBe(true);

      SingleFlightCoordinator.release('billing_oauth', true);

      expect(existsSync(intentPath)).toBe(false);
      expect(existsSync(inprogressPath)).toBe(false);
    });

    test('on failure: clears only inprogress, leaves intent', () => {
      SingleFlightCoordinator.tryAcquire('billing_oauth');

      const intentPath = join(tempDir, 'refresh-intents', 'billing_oauth.intent');
      const inprogressPath = join(tempDir, 'refresh-intents', 'billing_oauth.inprogress');

      SingleFlightCoordinator.release('billing_oauth', false);

      expect(existsSync(intentPath)).toBe(true);  // Left for retry
      expect(existsSync(inprogressPath)).toBe(false);  // Cleared
    });

    test('is safe to call without prior acquire', () => {
      // Should not throw
      SingleFlightCoordinator.release('nonexistent', true);
      SingleFlightCoordinator.release('nonexistent', false);
    });
  });

  // -------------------------------------------------------------------------
  // tryAcquireMany
  // -------------------------------------------------------------------------

  describe('tryAcquireMany()', () => {
    test('acquires all when none are in progress', () => {
      const acquired = SingleFlightCoordinator.tryAcquireMany([
        'billing_oauth',
        'git_status',
        'version_check',
      ]);
      expect(acquired).toHaveLength(3);
      expect(acquired).toContain('billing_oauth');
      expect(acquired).toContain('git_status');
      expect(acquired).toContain('version_check');
    });

    test('skips categories already in progress', () => {
      // Lock billing_oauth first (simulating another process)
      RefreshIntentManager.signalRefreshInProgress('billing_oauth');

      const acquired = SingleFlightCoordinator.tryAcquireMany([
        'billing_oauth',
        'git_status',
        'version_check',
      ]);

      // billing_oauth is held by us (same PID), so it will be detected as in-progress
      expect(acquired).not.toContain('billing_oauth');
      expect(acquired).toContain('git_status');
      expect(acquired).toContain('version_check');
    });

    test('returns empty array when all are in progress', () => {
      RefreshIntentManager.signalRefreshInProgress('a');
      RefreshIntentManager.signalRefreshInProgress('b');

      const acquired = SingleFlightCoordinator.tryAcquireMany(['a', 'b']);
      expect(acquired).toHaveLength(0);
    });

    test('handles empty input', () => {
      const acquired = SingleFlightCoordinator.tryAcquireMany([]);
      expect(acquired).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // releaseMany
  // -------------------------------------------------------------------------

  describe('releaseMany()', () => {
    test('releases all categories on success', () => {
      SingleFlightCoordinator.tryAcquireMany(['a', 'b', 'c']);
      SingleFlightCoordinator.releaseMany(['a', 'b', 'c'], true);

      // All intent and inprogress files should be gone
      const intentsDir = join(tempDir, 'refresh-intents');
      expect(existsSync(join(intentsDir, 'a.intent'))).toBe(false);
      expect(existsSync(join(intentsDir, 'b.intent'))).toBe(false);
      expect(existsSync(join(intentsDir, 'c.intent'))).toBe(false);
      expect(existsSync(join(intentsDir, 'a.inprogress'))).toBe(false);
      expect(existsSync(join(intentsDir, 'b.inprogress'))).toBe(false);
      expect(existsSync(join(intentsDir, 'c.inprogress'))).toBe(false);
    });

    test('releases all categories on failure (leaves intents)', () => {
      SingleFlightCoordinator.tryAcquireMany(['a', 'b']);
      SingleFlightCoordinator.releaseMany(['a', 'b'], false);

      const intentsDir = join(tempDir, 'refresh-intents');
      // Intents should remain
      expect(existsSync(join(intentsDir, 'a.intent'))).toBe(true);
      expect(existsSync(join(intentsDir, 'b.intent'))).toBe(true);
      // Inprogress should be cleared
      expect(existsSync(join(intentsDir, 'a.inprogress'))).toBe(false);
      expect(existsSync(join(intentsDir, 'b.inprogress'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // isInProgress
  // -------------------------------------------------------------------------

  describe('isInProgress()', () => {
    test('returns false when no lock exists', () => {
      expect(SingleFlightCoordinator.isInProgress('billing_oauth')).toBe(false);
    });

    test('returns true after acquire', () => {
      SingleFlightCoordinator.tryAcquire('billing_oauth');
      expect(SingleFlightCoordinator.isInProgress('billing_oauth')).toBe(true);
    });

    test('returns false after release', () => {
      SingleFlightCoordinator.tryAcquire('billing_oauth');
      SingleFlightCoordinator.release('billing_oauth', true);
      expect(SingleFlightCoordinator.isInProgress('billing_oauth')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getInProgressCategories
  // -------------------------------------------------------------------------

  describe('getInProgressCategories()', () => {
    test('returns empty array when nothing in progress', () => {
      expect(SingleFlightCoordinator.getInProgressCategories(['a', 'b', 'c'])).toEqual([]);
    });

    test('returns only categories that are in progress', () => {
      SingleFlightCoordinator.tryAcquire('billing_oauth');
      SingleFlightCoordinator.tryAcquire('git_status');

      const inProgress = SingleFlightCoordinator.getInProgressCategories([
        'billing_oauth',
        'git_status',
        'version_check',
      ]);
      expect(inProgress).toContain('billing_oauth');
      expect(inProgress).toContain('git_status');
      expect(inProgress).not.toContain('version_check');
    });

    test('handles empty input', () => {
      expect(SingleFlightCoordinator.getInProgressCategories([])).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle test
  // -------------------------------------------------------------------------

  describe('lifecycle integration', () => {
    test('acquire → fetch → release(success) → re-acquire', () => {
      // Step 1: Acquire
      const r1 = SingleFlightCoordinator.tryAcquire('billing_oauth');
      expect(r1.acquired).toBe(true);

      // Step 2: During "fetch", another acquire should fail (same PID = in progress)
      const r2 = SingleFlightCoordinator.tryAcquire('billing_oauth');
      expect(r2.acquired).toBe(false);

      // Step 3: Release with success
      SingleFlightCoordinator.release('billing_oauth', true);
      expect(SingleFlightCoordinator.isInProgress('billing_oauth')).toBe(false);

      // Step 4: Re-acquire should work
      const r3 = SingleFlightCoordinator.tryAcquire('billing_oauth');
      expect(r3.acquired).toBe(true);
    });

    test('acquire → fetch fails → release(failure) → intent remains', () => {
      SingleFlightCoordinator.tryAcquire('billing_oauth');
      SingleFlightCoordinator.release('billing_oauth', false);

      // Intent still exists (for retry by next daemon)
      expect(RefreshIntentManager.isRefreshRequested('billing_oauth')).toBe(true);

      // Can re-acquire
      const r = SingleFlightCoordinator.tryAcquire('billing_oauth');
      expect(r.acquired).toBe(true);
    });
  });
});
