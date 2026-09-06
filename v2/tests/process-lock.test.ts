/**
 * Tests for v2/src/lib/process-lock.ts — ProcessLock
 *
 * The daemon singleton depends on this lock. A lock whose holder is ALIVE is not
 * force-released before the hard cap.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import ProcessLock from '../src/lib/process-lock';

const TEST_DIR = join(tmpdir(), `process-lock-test-${process.pid}-${Date.now()}`);
const LOCK_PATH = join(TEST_DIR, 'test.lock');

const DEAD_PID = 999_999_999;

function ageLock(ms: number): void {
  const past = new Date(Date.now() - ms);
  utimesSync(LOCK_PATH, past, past);
}

function makeLock(timeout = 1000) {
  return new ProcessLock({ lockPath: LOCK_PATH, timeout, retryInterval: 1, maxRetries: 1 });
}

describe('ProcessLock', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    try { rmSync(LOCK_PATH, { force: true }); } catch { /* ignore */ }
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('acquires a free lock and writes our PID', async () => {
    const result = await makeLock().acquire();
    expect(result.acquired).toBe(true);
    expect(readFileSync(LOCK_PATH, 'utf-8').trim()).toBe(String(process.pid));
  });

  test('does NOT acquire when a fresh lock is held by a live process', async () => {
    writeFileSync(LOCK_PATH, String(process.pid));
    const result = await makeLock().acquire();
    expect(result.acquired).toBe(false);
    expect(existsSync(LOCK_PATH)).toBe(true);
  });

  test('a lock older than timeout whose holder is ALIVE is not force-released', async () => {
    writeFileSync(LOCK_PATH, String(process.pid));
    ageLock(60_000);

    const result = (makeLock(1000) as any).tryAcquire();

    expect(result.acquired).toBe(false);
    expect(result.lockHolder).toBe(process.pid);
    // The live holder still owns the file — the singleton is intact.
    expect(existsSync(LOCK_PATH)).toBe(true);
    expect(readFileSync(LOCK_PATH, 'utf-8').trim()).toBe(String(process.pid));
  });

  test('an ALIVE holder past the hard cap is reaped', async () => {
    writeFileSync(LOCK_PATH, String(process.pid));
    ageLock(60_000);

    const result = (new ProcessLock({
      lockPath: LOCK_PATH,
      timeout: 1000,
      hardTimeout: 10_000,
      retryInterval: 1,
      maxRetries: 1,
    }) as any).tryAcquire();

    expect(result.acquired).toBe(true);
  });

  test('a lock held by a DEAD process is released and re-acquired', async () => {
    writeFileSync(LOCK_PATH, String(DEAD_PID));
    const result = await makeLock(1000).acquire();
    expect(result.acquired).toBe(true);
    expect(readFileSync(LOCK_PATH, 'utf-8').trim()).toBe(String(process.pid));
  });

  test('a stale lock with an unreadable PID is released', async () => {
    writeFileSync(LOCK_PATH, 'not-a-pid');
    ageLock(60_000);
    const result = await makeLock(1000).acquire();
    expect(result.acquired).toBe(true);
  });

  test('release() removes only our own lock', () => {
    const lock = makeLock();
    writeFileSync(LOCK_PATH, String(DEAD_PID));
    lock.release();
    expect(existsSync(LOCK_PATH)).toBe(true);

    writeFileSync(LOCK_PATH, String(process.pid));
    lock.release();
    expect(existsSync(LOCK_PATH)).toBe(false);
  });
});
