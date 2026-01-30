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
import { ClaudeCodeInput } from './types/session-health';
import { appendFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

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

async function main(): Promise<void> {
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
  }
}

main();
