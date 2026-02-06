/**
 * RefreshIntentManager - File-based refresh coordination across processes
 *
 * PURPOSE:
 * When 30+ statusline daemons detect stale data simultaneously, this prevents
 * all of them from triggering redundant refresh operations.
 *
 * MECHANISM:
 * - .intent files: "Someone wants this data refreshed" (touch, idempotent)
 * - .inprogress files: "Someone is actively refreshing" (PID, stale detection)
 *
 * USAGE BY DATA-GATHERER:
 *   1. Detect stale billing → signalRefreshNeeded('billing')
 *   2. Check isRefreshInProgress('billing')
 *   3. If yes → skip fetch, another daemon is handling it
 *   4. If no → signalRefreshInProgress('billing'), proceed with fetch
 *   5. On success → clearIntent('billing')
 *   6. On failure → clearInProgress('billing') only
 *
 * USAGE BY FRESHNESS-MANAGER (staleness indicators):
 *   getIntentAge('billing') → null (no intent) | ms since intent signaled
 *   Used to decide: no indicator vs ⚠ vs 🔺
 */

import { existsSync, mkdirSync, writeFileSync, unlinkSync, readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Default base path (overridable for testing)
let basePath = join(homedir(), '.claude/session-health');

function intentsDir(): string {
  return join(basePath, 'refresh-intents');
}

function intentPath(category: string): string {
  return join(intentsDir(), `${category}.intent`);
}

function inprogressPath(category: string): string {
  return join(intentsDir(), `${category}.inprogress`);
}

function ensureDir(): void {
  const dir = intentsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

/**
 * Check if a PID is alive (signal 0 = existence check)
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export class RefreshIntentManager {

  /**
   * Override base path (for testing)
   */
  static setBasePath(path: string): void {
    basePath = path;
  }

  /**
   * Signal that a category needs refresh.
   * Atomic touch — 30 concurrent calls = 1 file, no errors.
   */
  static signalRefreshNeeded(category: string): void {
    try {
      ensureDir();
      const path = intentPath(category);
      // Write timestamp — creates or overwrites
      writeFileSync(path, String(Date.now()), { mode: 0o600 });
    } catch { /* non-critical */ }
  }

  /**
   * Signal that this process is actively refreshing a category.
   * Writes PID so other daemons can check if we're still alive.
   */
  static signalRefreshInProgress(category: string): void {
    try {
      ensureDir();
      writeFileSync(inprogressPath(category), String(process.pid), { mode: 0o600 });
    } catch { /* non-critical */ }
  }

  /**
   * Check if a refresh has been requested for a category.
   */
  static isRefreshRequested(category: string): boolean {
    try {
      return existsSync(intentPath(category));
    } catch {
      return false;
    }
  }

  /**
   * Check if another process is currently refreshing this category.
   * Also cleans up stale inprogress files (dead PIDs).
   *
   * OPTIMIZATION: Direct read without existsSync check (1 syscall vs 2)
   */
  static isRefreshInProgress(category: string): boolean {
    try {
      const path = inprogressPath(category);

      // Read PID directly (ENOENT means no file = not in progress)
      const content = readFileSync(path, 'utf-8');
      const pid = parseInt(content.trim(), 10);

      if (isNaN(pid) || !isPidAlive(pid)) {
        // Stale — clean up
        try { unlinkSync(path); } catch { /* ignore */ }
        return false;
      }

      return true;
    } catch (err) {
      // ENOENT = file doesn't exist (not in progress)
      // Log only non-ENOENT critical errors
      if (err instanceof Error && !err.message.includes('ENOENT')) {
        if (err.message.includes('not defined')) {
          console.error(`[RefreshIntentManager] CRITICAL: ${err.message} at isRefreshInProgress('${category}')`);
        }
      }
      return false;
    }
  }

  /**
   * Clear both intent and inprogress files (called after SUCCESSFUL refresh).
   */
  static clearIntent(category: string): void {
    try {
      const ip = intentPath(category);
      if (existsSync(ip)) unlinkSync(ip);
    } catch { /* ignore */ }
    try {
      const ipp = inprogressPath(category);
      if (existsSync(ipp)) unlinkSync(ipp);
    } catch { /* ignore */ }
  }

  /**
   * Clear only the inprogress file (called after FAILED refresh).
   * Leaves the intent so the next daemon retries.
   */
  static clearInProgress(category: string): void {
    try {
      const path = inprogressPath(category);
      if (existsSync(path)) unlinkSync(path);
    } catch { /* ignore */ }
  }

  /**
   * Get age of intent file in ms. Returns null if no intent exists.
   *
   * OPTIMIZATION: Direct stat without existsSync check (1 syscall vs 2)
   */
  static getIntentAge(category: string): number | null {
    try {
      const path = intentPath(category);
      const mtime = statSync(path).mtimeMs; // ENOENT if file doesn't exist
      return Math.max(0, Date.now() - mtime);
    } catch {
      // ENOENT or permission error → treat as no intent
      return null;
    }
  }

  /**
   * List all categories that have pending intent files.
   */
  static getPendingIntents(): string[] {
    try {
      const dir = intentsDir();
      if (!existsSync(dir)) return [];

      return readdirSync(dir)
        .filter(f => f.endsWith('.intent'))
        .map(f => f.replace('.intent', ''));
    } catch {
      return [];
    }
  }

  /**
   * Clean up intent/inprogress files older than maxAgeMs.
   * Called by cleanup-manager periodically.
   */
  static cleanStale(maxAgeMs: number = 600_000): void {
    try {
      const dir = intentsDir();
      if (!existsSync(dir)) return;

      const now = Date.now();
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.intent') && !file.endsWith('.inprogress')) continue;
        try {
          const filePath = join(dir, file);
          const mtime = statSync(filePath).mtimeMs;
          if (now - mtime > maxAgeMs) {
            unlinkSync(filePath);
          }
        } catch { /* ignore individual file errors */ }
      }
    } catch { /* non-critical */ }
  }
}

export default RefreshIntentManager;
