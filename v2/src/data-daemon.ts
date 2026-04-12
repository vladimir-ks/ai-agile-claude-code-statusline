#!/usr/bin/env bun
/**
 * DATA DAEMON - Background data gathering (decoupled from display)
 *
 * ARCHITECTURAL ROLE:
 * - Gathers all data asynchronously
 * - Writes to health store JSON files
 * - NEVER blocks the display layer
 * - Can be slow, can fail - display still works with cached data
 *
 * SINGLETON GUARANTEE:
 * - Uses ProcessLock to ensure exactly ONE daemon runs at a time
 * - If another daemon holds the lock → exit(0) immediately (expected, not error)
 * - Lock released on exit, SIGTERM, SIGKILL timeout (stale detection at 35s)
 *
 * INVOCATION:
 * - Called by thin wrapper AFTER display-only has output
 * - Runs in background (fire and forget)
 * - Updates health files for NEXT invocation
 *
 * FAILURE MODE:
 * - If daemon fails → display shows stale data (acceptable)
 * - If daemon is slow → display still shows cached data
 * - Display is NEVER blocked by daemon
 *
 * OBSERVABILITY:
 * - All errors logged to ~/.claude/session-health/daemon.log
 * - Log rotation: keeps last 100KB
 * - Check with: tail ~/.claude/session-health/daemon.log
 */

import DataGatherer from './lib/data-gatherer';
import ProcessLock from './lib/process-lock';
import { ClaudeCodeInput } from './types/session-health';
import { VersionChecker } from './lib/version-checker';
import { appendFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

// ============================================================================
// LAZY MODE GATE (Phase 5 — daemon-optional fallback)
// ============================================================================
// STATUSLINE_LAZY_MODE=1 → hook renders inline; daemon must not run (no-op exit).
// Purpose: let user disable daemon without uninstalling (e.g. when bun is absent,
// or for performance-sensitive environments).
if (process.env.STATUSLINE_LAZY_MODE === '1') {
  // Ensure log dir exists before writing
  try {
    const dir = `${homedir()}/.claude/session-health`;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(
      `${dir}/daemon.log`,
      `[${new Date().toISOString()}] [PID:${process.pid}] [WARN] STATUSLINE_LAZY_MODE=1 — daemon disabled, exiting (hook renders inline)\n`,
      { mode: 0o600 }
    );
  } catch { /* best-effort logging — never block exit */ }
  process.exit(0);
}

const LOG_PATH = `${homedir()}/.claude/session-health/daemon.log`;
const MAX_LOG_SIZE = 100 * 1024; // 100KB max log size

/**
 * Log message to daemon log file (for user observability)
 */
function log(level: 'INFO' | 'WARN' | 'ERROR', message: string): void {
  try {
    // Ensure directory exists
    const dir = `${homedir()}/.claude/session-health`;
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Rotate log if too large
    try {
      const stats = statSync(LOG_PATH);
      if (stats.size > MAX_LOG_SIZE) {
        // Truncate by keeping last 50KB
        writeFileSync(LOG_PATH, `[LOG ROTATED at ${new Date().toISOString()}]\n`);
      }
    } catch {
      // File doesn't exist, will be created
    }

    const timestamp = new Date().toISOString();
    const pid = process.pid;
    const logLine = `[${timestamp}] [PID:${pid}] [${level}] ${message}\n`;
    appendFileSync(LOG_PATH, logLine, { mode: 0o600 });
  } catch {
    // Can't log - give up silently (display still works)
  }
}

// Process-level safety nets — prevent crashes from propagating
process.on('uncaughtException', (err) => {
  log('ERROR', `Uncaught exception: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  process.exit(1);
});

// Singleton lock — guarantees exactly ONE daemon process globally
const DAEMON_LOCK_PATH = `${homedir()}/.claude/session-health/.data-daemon.lock`;
const daemonLock = new ProcessLock({
  lockPath: DAEMON_LOCK_PATH,
  timeout: 35000,       // 35s stale detection (slightly > 30s kill timeout from bulletproof.sh)
  retryInterval: 0,     // No retry — fail immediately
  maxRetries: 1         // Single attempt only (acquire calls tryAcquire once with maxRetries=1)
});

async function main(): Promise<void> {
  // CRITICAL: Acquire singleton lock BEFORE any work
  const lockResult = await daemonLock.acquire();

  if (!lockResult.acquired) {
    // Another daemon is running — this is EXPECTED behavior (not an error)
    // With tmux calling bulletproof.sh every 1-5s, most invocations will hit this path
    process.exit(0);
  }

  // Ensure lock is released on ALL exit paths (normal, error, signal, timeout SIGKILL)
  const releaseLock = () => {
    try { daemonLock.release(); } catch { /* best effort */ }
  };
  process.on('exit', releaseLock);
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });

  const startTime = Date.now();

  try {
    // Parse JSON from stdin
    const stdin = await Bun.stdin.text();
    let jsonInput: ClaudeCodeInput | null = null;

    try {
      jsonInput = JSON.parse(stdin) as ClaudeCodeInput;
    } catch {
      log('WARN', 'Invalid JSON input - skipping');
      return;
    }

    const sessionId = jsonInput?.session_id;
    if (!sessionId) {
      log('WARN', 'No session_id in input - skipping');
      return;
    }

    // Gather data and write to health store
    const gatherer = new DataGatherer();
    await gatherer.gather(
      sessionId,
      jsonInput?.transcript_path || null,
      jsonInput
    );

    // Cache installed CLI version for display-layer mismatch detection
    // Rate-gated internally (skips if cache <5min old), non-critical
    try { VersionChecker.cacheInstalledVersion(); } catch { /* non-critical */ }

    const duration = Date.now() - startTime;
    log('INFO', `Session ${sessionId} updated in ${duration}ms`);

  } catch (error) {
    const duration = Date.now() - startTime;
    const msg = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : '';
    log('ERROR', `Daemon failed after ${duration}ms: ${msg}`);
    if (stack) {
      log('ERROR', `Stack: ${stack}`);
    }
  } finally {
    releaseLock();
  }
}

main();
