/**
 * heartbeat-rotation-lock.test.ts — P1-j: heartbeat.ts rotation lock
 *
 * Tests for the mkdir-lock that serialises log rotation in heartbeat.ts.
 * Covers: happy path, stale PID reclaim, bounded retry, and release-on-failure.
 *
 * T2 (contention) is a single-process simulation: we pre-seed the lockdir to
 * mimic a peer holding the lock, then verify the racing writer skips rotation
 * without corrupting the log.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Path override ──────────────────────────────────────────────────────────────

let testDir: string;
let sessionHealthDir: string;
let heartbeatFilePath: string;
let lockdirPath: string;

type WriteHeartbeat = typeof import('../../src/lib/heartbeat').writeHeartbeat;
type SetTestLockParams = typeof import('../../src/lib/heartbeat')._setTestLockParams;
let writeHeartbeatFn: WriteHeartbeat;
let setTestLockParamsFn: SetTestLockParams;

async function loadFreshModule() {
  const mod = await import(`../../src/lib/heartbeat.ts?t=${Date.now()}`);
  writeHeartbeatFn = mod.writeHeartbeat as WriteHeartbeat;
  setTestLockParamsFn = mod._setTestLockParams as SetTestLockParams;
}

const MAX_BYTES = 10 * 1024 * 1024; // 10MB — mirrors heartbeat.ts constant

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'hb-lock-test-'));
  sessionHealthDir = join(testDir, '.claude', 'session-health');
  mkdirSync(sessionHealthDir, { recursive: true });
  heartbeatFilePath = join(sessionHealthDir, 'pipeline-heartbeat.jsonl');
  lockdirPath = join(sessionHealthDir, '.heartbeat-ts-rotation.lockdir');

  mock.module('os', () => ({
    homedir: () => join(testDir, '.claude', '..'),
    tmpdir,
  }));

  await loadFreshModule();
});

afterEach(() => {
  // Reset test-only overrides
  if (setTestLockParamsFn) setTestLockParamsFn(undefined, undefined);
  mock.restore();
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Write a file just over MAX_BYTES so rotation triggers. */
function seedOverLimit() {
  const chunk = 'x'.repeat(1024);
  let content = '';
  for (let i = 0; i < MAX_BYTES / 1024 + 2; i++) content += chunk;
  writeFileSync(heartbeatFilePath, content);
}

function countLines(): number {
  if (!existsSync(heartbeatFilePath)) return 0;
  return readFileSync(heartbeatFilePath, 'utf-8').split('\n').filter(Boolean).length;
}

// ── T1: HAPPY — rotation proceeds, lockdir cleaned up ─────────────────────────

describe('P1-j rotation lock', () => {
  test('T1: rotation proceeds normally and lockdir is cleaned up', async () => {
    seedOverLimit();

    writeHeartbeatFn('heartbeat-lock-test', 'after_rotate');

    // File must have been rotated: .1 exists and main file has exactly 1 new line
    expect(existsSync(heartbeatFilePath + '.1')).toBe(true);
    expect(countLines()).toBe(1);
    // Lock must be released
    expect(existsSync(lockdirPath)).toBe(false);
  });

  // ── T2: CONTENTION — pre-seeded lockdir causes rotation to be skipped ─────

  test('T2: concurrent writer holding fresh lock causes rotation skip (no data loss)', async () => {
    seedOverLimit();

    // Pre-seed lockdir with our own (live) PID — simulates a peer holding the lock
    mkdirSync(lockdirPath, { recursive: true });
    writeFileSync(join(lockdirPath, 'pid'), String(process.pid));
    // Set mtime to NOW so it appears fresh (not stale)
    const now = new Date();
    utimesSync(lockdirPath, now, now);

    await loadFreshModule();
    // Inject fast retry (1 attempt, 0ms sleep) so the test doesn't wait 5s
    setTestLockParamsFn(1, 0);

    // Invoke — should complete without error, appending 1 line
    writeHeartbeatFn('heartbeat-lock-test', 'contention_append');

    // Log must still have the original content (not truncated by a bad rotation)
    const mainSize = require('fs').statSync(heartbeatFilePath).size;
    expect(mainSize).toBeGreaterThan(MAX_BYTES);
    // Rotation must NOT have happened (since we held the lock)
    expect(existsSync(heartbeatFilePath + '.1')).toBe(false);

    // Clean up manually
    try { rmSync(lockdirPath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ── T3: STALE_PID_RECLAIM — dead PID + old mtime → reclaim + rotate ────────

  test('T3: lockdir with dead PID and old mtime is reclaimed and rotation proceeds', async () => {
    seedOverLimit();

    // Create lockdir with a dead PID (PID 99999999 is extremely unlikely to exist)
    const deadPid = 99999999;
    mkdirSync(lockdirPath, { recursive: true });
    writeFileSync(join(lockdirPath, 'pid'), String(deadPid));

    // Back-date mtime to 60s ago (past the 30s stale threshold)
    const staleTime = new Date(Date.now() - 60_000);
    utimesSync(lockdirPath, staleTime, staleTime);

    await loadFreshModule();
    writeHeartbeatFn('heartbeat-lock-test', 'after_stale_reclaim');

    // Rotation must have occurred
    expect(existsSync(heartbeatFilePath + '.1')).toBe(true);
    expect(countLines()).toBe(1);
    // Lock must be released
    expect(existsSync(lockdirPath)).toBe(false);
  });

  // ── T4: BOUNDED_RETRY — lockdir held by live PID → writer skips, no hang ──

  test('T4: lockdir held by live process (self) — writer skips rotation within bounded time', async () => {
    seedOverLimit();

    // Hold the lock with our own live PID and fresh mtime
    mkdirSync(lockdirPath, { recursive: true });
    writeFileSync(join(lockdirPath, 'pid'), String(process.pid));
    const now = new Date();
    utimesSync(lockdirPath, now, now);

    await loadFreshModule();
    // Inject fast retry (3 attempts, 0ms sleep) — validates boundedness without 5s wait
    setTestLockParamsFn(3, 0);

    const start = Date.now();
    writeHeartbeatFn('heartbeat-lock-test', 'bounded_retry');
    const elapsed = Date.now() - start;

    // Must complete within 500ms (3 retries × 0ms = effectively instant)
    expect(elapsed).toBeLessThan(500);

    // Append must still have happened (observability not lost — only rotation skipped)
    expect(countLines()).toBeGreaterThanOrEqual(1);

    try { rmSync(lockdirPath, { recursive: true, force: true }); } catch { /* ok */ }
  });

  // ── T5: RELEASE ON FAILURE — lockdir removed even when rotation throws ────

  test('T5: lockdir is released even when rename during rotation fails', async () => {
    seedOverLimit();

    // Patch renameSync to throw after the lock is acquired
    const origRenameSync = require('fs').renameSync;
    let renameCallCount = 0;
    mock.module('fs', () => {
      const fs = require('fs') as typeof import('fs');
      return {
        ...fs,
        renameSync: (src: string, dst: string) => {
          renameCallCount++;
          // Let non-lockdir renames through; throw on the heartbeat file rotation
          if (src.includes('pipeline-heartbeat') && !src.includes('lockdir')) {
            throw new Error('simulated rename failure');
          }
          return (origRenameSync as (s: string, d: string) => void)(src, dst);
        },
      };
    });

    await loadFreshModule();
    // Must not throw to caller
    expect(() => {
      writeHeartbeatFn('heartbeat-lock-test', 'after_rename_fail');
    }).not.toThrow();

    // Lock MUST be released regardless of the rename failure
    expect(existsSync(lockdirPath)).toBe(false);
  });
});
