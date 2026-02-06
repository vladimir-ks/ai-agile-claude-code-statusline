/**
 * Cleanup Manager - Prevent file bloat in session-health directory
 *
 * Responsibilities:
 * - Remove old session files (>7 days inactive)
 * - Clean up orphaned cooldown files
 * - Rotate daemon.log (keep last 100KB)
 * - Archive old data to compressed format
 *
 * Runs periodically (once per day max via cooldown)
 */

import { existsSync, readdirSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import CooldownManager from './cooldown-manager';
import { RefreshIntentManager } from './refresh-intent-manager';

interface CleanupStats {
  sessionsRemoved: number;
  cooldownsRemoved: number;
  bytesFreed: number;
  lastCleanup: number;
}

class CleanupManager {
  private healthDir: string;
  private cooldownDir: string;
  private cooldownManager: CooldownManager;

  constructor(healthDir?: string) {
    this.healthDir = healthDir || join(homedir(), '.claude/session-health');
    this.cooldownDir = join(this.healthDir, 'cooldowns');
    this.cooldownManager = new CooldownManager();
  }

  /**
   * Run cleanup if needed (max once per day)
   */
  async cleanupIfNeeded(): Promise<CleanupStats | null> {
    // Check cleanup cooldown (24 hours)
    const cooldownPath = join(this.cooldownDir, 'cleanup.cooldown');
    if (existsSync(cooldownPath)) {
      try {
        const data = JSON.parse(readFileSync(cooldownPath, 'utf-8'));
        const age = Date.now() - data.lastChecked;
        if (age < 24 * 60 * 60 * 1000) {
          // Cleanup ran within last 24h - skip
          return null;
        }
      } catch {
        // Corrupted cooldown - run cleanup
      }
    }

    return this.cleanup();
  }

  /**
   * Force cleanup (ignore cooldown)
   */
  async cleanup(): Promise<CleanupStats> {
    const stats: CleanupStats = {
      sessionsRemoved: 0,
      cooldownsRemoved: 0,
      bytesFreed: 0,
      lastCleanup: Date.now()
    };

    try {
      // 1. Remove old session files (>7 days inactive)
      stats.sessionsRemoved = this.removeOldSessions(7);

      // 2. Remove orphaned cooldown files
      stats.cooldownsRemoved = this.removeOrphanedCooldowns();

      // 3. Rotate daemon log
      this.rotateDaemonLog();

      // 4. Clean up temp files
      this.cleanupTempFiles();

      // 5. Clean stale refresh intents (>10min = stuck)
      RefreshIntentManager.cleanStale(600_000);

      // Mark cleanup cooldown
      this.cooldownManager.markComplete('cleanup', { stats });

    } catch (error) {
      // Cleanup failed - log but don't throw
      console.error('[CleanupManager] Cleanup failed:', error);
    }

    return stats;
  }

  /**
   * Remove session files older than N days
   */
  private removeOldSessions(daysOld: number): number {
    if (!existsSync(this.healthDir)) {
      return 0;
    }

    const now = Date.now();
    const cutoff = now - (daysOld * 24 * 60 * 60 * 1000);
    let removed = 0;

    try {
      const files = readdirSync(this.healthDir);
      for (const file of files) {
        // Only process session JSON files (UUID pattern)
        if (!file.match(/^[a-f0-9-]{36}\.json$/)) {
          continue;
        }

        const path = join(this.healthDir, file);
        try {
          const stats = statSync(path);
          if (stats.mtimeMs < cutoff) {
            unlinkSync(path);
            removed++;
          }
        } catch {
          // File doesn't exist or can't be accessed - skip
        }
      }
    } catch (error) {
      console.error('[CleanupManager] Failed to remove old sessions:', error);
    }

    return removed;
  }

  /**
   * Remove cooldown files for sessions that no longer exist
   */
  private removeOrphanedCooldowns(): number {
    if (!existsSync(this.cooldownDir)) {
      return 0;
    }

    let removed = 0;

    try {
      // Get list of active session IDs
      const activeSessions = new Set<string>();
      if (existsSync(this.healthDir)) {
        const files = readdirSync(this.healthDir);
        for (const file of files) {
          if (file.match(/^([a-f0-9-]{36})\.json$/)) {
            const sessionId = file.replace('.json', '');
            activeSessions.add(sessionId);
          }
        }
      }

      // Remove cooldowns for inactive sessions
      const cooldownFiles = readdirSync(this.cooldownDir);
      for (const file of cooldownFiles) {
        // Match session-specific cooldowns: {sessionId}-{type}.cooldown
        const match = file.match(/^([a-f0-9-]{36})-.*\.(?:cooldown|state)$/);
        if (match) {
          const sessionId = match[1];
          if (!activeSessions.has(sessionId)) {
            const path = join(this.cooldownDir, file);
            try {
              unlinkSync(path);
              removed++;
            } catch {
              // Can't delete - skip
            }
          }
        }
      }
    } catch (error) {
      console.error('[CleanupManager] Failed to remove orphaned cooldowns:', error);
    }

    return removed;
  }

  /**
   * Rotate daemon.log if > 200KB (keep last 100KB)
   */
  private rotateDaemonLog(): void {
    const logPath = join(this.healthDir, 'daemon.log');
    if (!existsSync(logPath)) {
      return;
    }

    try {
      const stats = statSync(logPath);
      if (stats.size > 200_000) {
        // Read last 100KB
        const content = readFileSync(logPath, 'utf-8');
        const lines = content.split('\n');
        const keepLines = lines.slice(-500);  // Keep last 500 lines
        writeFileSync(logPath, keepLines.join('\n'), 'utf-8');
      }
    } catch (error) {
      // Log rotation failed - not critical
    }
  }

  /**
   * Clean up temp files (.tmp files left behind)
   */
  private cleanupTempFiles(): void {
    if (!existsSync(this.healthDir)) {
      return;
    }

    try {
      const files = readdirSync(this.healthDir);
      for (const file of files) {
        if (file.endsWith('.tmp')) {
          const path = join(this.healthDir, file);
          try {
            // Only remove if older than 1 hour (stale temp file)
            const stats = statSync(path);
            if (Date.now() - stats.mtimeMs > 3600000) {
              unlinkSync(path);
            }
          } catch {
            // Can't delete - skip
          }
        }
      }
    } catch (error) {
      // Cleanup failed - not critical
    }
  }

  /**
   * Get cleanup stats (for monitoring)
   */
  getStats(): {
    totalSessions: number;
    totalCooldowns: number;
    totalSize: number;
    oldestSession: number;
  } {
    const stats = {
      totalSessions: 0,
      totalCooldowns: 0,
      totalSize: 0,
      oldestSession: Date.now()
    };

    try {
      // Count sessions
      if (existsSync(this.healthDir)) {
        const files = readdirSync(this.healthDir);
        for (const file of files) {
          const path = join(this.healthDir, file);
          try {
            const fileStat = statSync(path);
            stats.totalSize += fileStat.size;

            if (file.match(/^[a-f0-9-]{36}\.json$/)) {
              stats.totalSessions++;
              if (fileStat.mtimeMs < stats.oldestSession) {
                stats.oldestSession = fileStat.mtimeMs;
              }
            }
          } catch {
            // Skip
          }
        }
      }

      // Count cooldowns
      if (existsSync(this.cooldownDir)) {
        const files = readdirSync(this.cooldownDir);
        stats.totalCooldowns = files.length;
      }
    } catch (error) {
      // Stats failed - return partial
    }

    return stats;
  }
}

export default CleanupManager;
