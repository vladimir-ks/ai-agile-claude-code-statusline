/**
 * heartbeat.ts - Pipeline observability heartbeat writer
 *
 * Emits structured JSONL events to ~/.claude/session-health/pipeline-heartbeat.jsonl.
 * Sync FS API — used on hot paths. Never throws to caller.
 * Shell mirror: ~/_claude-configs/shell-config/lib/heartbeat.sh
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

export interface HeartbeatLine {
  ts: string;
  component: string;
  event: string;
  latency_ms?: number;
  status: 'ok' | 'warn' | 'error' | 'info';
  extra: Record<string, unknown>;
}

interface WriteOptions {
  latencyMs?: number;
  status?: 'ok' | 'warn' | 'error' | 'info';
  extra?: Record<string, unknown>;
}

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const KEEP_ROTATIONS = 3;

// ---- P1-j: mkdir-lock for rotation -------------------------------------------
// Multiple concurrent bun spawns (one per tmux pane) race at the 10MB boundary.
// We serialise rotation with an atomic mkdir-lock (identical pattern to shell-side P1-j).
//
// Lock constants
const ROTATION_LOCK_STALE_MS = 30_000; // 30 s
const ROTATION_LOCK_RETRY_COUNT = 50;  // 50 × 100ms ≈ 5 s bounded wait
const ROTATION_LOCK_RETRY_MS   = 100;  // ms between retries

// Test-only overrides — never set in production. Allows unit tests to avoid 5s
// busy-wait by injecting low retry counts and zero sleep.
// Use _setTestLockParams() to set; undefined = use production defaults.
let _testLockRetryCount: number | undefined = undefined;
let _testLockRetryMs: number | undefined = undefined;

/** FOR TESTING ONLY — override retry params so tests don't busy-wait 5s. */
export function _setTestLockParams(retryCount?: number, retryMs?: number): void {
  _testLockRetryCount = retryCount;
  _testLockRetryMs = retryMs;
}

function _rotationLockDir(): string {
  return `${homedir()}/.claude/session-health/.heartbeat-ts-rotation.lockdir`;
}

/** Write PID file inside an already-acquired lockdir. Best-effort. */
function _writeLockPid(lockdir: string): void {
  try { writeFileSync(join(lockdir, 'pid'), String(process.pid)); } catch { /* best-effort */ }
}

/** Read PID from lockdir. Returns null if unreadable. */
function _readLockPid(lockdir: string): number | null {
  try {
    const raw = require('fs').readFileSync(join(lockdir, 'pid'), 'utf-8') as string;
    const n = parseInt(raw.trim(), 10);
    return Number.isFinite(n) ? n : null;
  } catch { return null; }
}

/** Returns true if a process with the given PID is alive. */
function _pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Acquire rotation lock. Returns true on success, false if bounded retry exhausted
 * (another writer holds a fresh lock). Never throws.
 */
function _acquireRotationLock(lockdir: string): boolean {
  const retries = _testLockRetryCount ?? ROTATION_LOCK_RETRY_COUNT;
  const retryMs = _testLockRetryMs ?? ROTATION_LOCK_RETRY_MS;
  for (let i = 0; i < retries; i++) {
    try {
      mkdirSync(lockdir, { recursive: false });
      _writeLockPid(lockdir);
      return true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') {
        // Unexpected error — bail out gracefully, skip rotation
        return false;
      }
      // Lock exists — check for stale
      try {
        const st = statSync(lockdir);
        const ageMs = Date.now() - st.mtimeMs;
        if (ageMs > ROTATION_LOCK_STALE_MS) {
          const stalePid = _readLockPid(lockdir);
          if (stalePid === null || !_pidAlive(stalePid)) {
            // Reclaim stale lock
            try { rmSync(lockdir, { recursive: true, force: true }); } catch { /* best-effort */ }
            continue; // retry mkdir immediately
          }
        }
      } catch { /* stat failed — contended, keep retrying */ }
      // Brief busy-wait before retry
      if (retryMs > 0) {
        const deadline = Date.now() + retryMs;
        while (Date.now() < deadline) { /* spin */ }
      }
    }
  }
  return false;
}

/** Release rotation lock. Always called in finally — never throws. */
function _releaseRotationLock(lockdir: string): void {
  try { rmSync(lockdir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

function heartbeatPath(): string {
  return `${homedir()}/.claude/session-health/pipeline-heartbeat.jsonl`;
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return;
    const { size } = statSync(path);
    if (size < MAX_BYTES) return;

    // P1-j: serialise rotation with mkdir-lock to prevent concurrent rename races
    const lockdir = _rotationLockDir();
    const acquired = _acquireRotationLock(lockdir);
    if (!acquired) return; // Another writer is rotating — skip, log will grow slightly past limit

    try {
      // Re-check size after acquiring lock — peer may have rotated already
      try {
        const { size: sizeNow } = statSync(path);
        if (sizeNow < MAX_BYTES) return;
      } catch { return; }

      for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
        const src = i === 1 ? path : `${path}.${i - 1}`;
        const dst = `${path}.${i}`;
        try { if (existsSync(src)) renameSync(src, dst); } catch { /* best-effort */ }
      }
      try { writeFileSync(`${path}.1`, ''); } catch { /* best-effort */ }
    } finally {
      _releaseRotationLock(lockdir);
    }
  } catch { /* rotation is best-effort; never throw */ }
}

export function writeHeartbeat(
  component: string,
  event: string,
  options: WriteOptions = {},
): void {
  try {
    const path = heartbeatPath();
    rotateIfNeeded(path);

    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const line: HeartbeatLine = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      component,
      event,
      status: options.status ?? 'ok',
      extra: options.extra ?? {},
    };
    if (options.latencyMs !== undefined) {
      line.latency_ms = Math.round(options.latencyMs);
    }

    appendFileSync(path, JSON.stringify(line) + '\n', 'utf-8');
  } catch { /* absorb all errors — observability loss > caller disruption */ }
}

export function tailHeartbeat(n: number): HeartbeatLine[] {
  try {
    const path = heartbeatPath();
    if (!existsSync(path)) return [];
    const { readFileSync } = require('fs') as typeof import('fs');
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    return lines
      .slice(-Math.max(0, n))
      .map(l => { try { return JSON.parse(l) as HeartbeatLine; } catch { return null; } })
      .filter((l): l is HeartbeatLine => l !== null);
  } catch { return []; }
}

export function filterRecent(component: string, maxAgeS: number): HeartbeatLine[] {
  try {
    const path = heartbeatPath();
    if (!existsSync(path)) return [];
    const { readFileSync } = require('fs') as typeof import('fs');
    const raw = readFileSync(path, 'utf-8');
    const cutoff = Date.now() - maxAgeS * 1000;
    return raw
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l) as HeartbeatLine; } catch { return null; } })
      .filter((l): l is HeartbeatLine => l !== null)
      .filter(l => l.component === component && new Date(l.ts).getTime() >= cutoff);
  } catch { return []; }
}
