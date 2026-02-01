/**
 * Cooldown Manager - Filesystem-based deduplication of expensive operations
 *
 * Purpose: Prevent redundant work across multiple concurrent sessions
 *
 * How it works:
 * - Each operation has a cooldown period (git: 30s, billing: 2min, secrets: 5min)
 * - First session to run operation writes timestamp to cooldown file
 * - Subsequent sessions check cooldown and skip if fresh
 * - Shared across all sessions (repo-level or system-level)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface CooldownSpec {
  name: string;
  ttlMs: number;
  sharedAcrossSessions: boolean;
}

export interface CooldownData {
  lastChecked: number;
  [key: string]: any;  // Allow additional metadata
}

export const COOLDOWN_SPECS: Record<string, CooldownSpec> = {
  'git-status': { name: 'git-status', ttlMs: 30000, sharedAcrossSessions: true },      // 30s
  'billing': { name: 'billing', ttlMs: 120000, sharedAcrossSessions: true },           // 2min (matches ccusage-shared-module constructor)
  'secrets-scan': { name: 'secrets-scan', ttlMs: 300000, sharedAcrossSessions: false }, // 5min per session
  'cleanup': { name: 'cleanup', ttlMs: 86400000, sharedAcrossSessions: true },         // 24h
};

class CooldownManager {
  private cooldownDir: string;

  constructor(cooldownDir?: string) {
    this.cooldownDir = cooldownDir || join(homedir(), '.claude/session-health/cooldowns');
    if (!existsSync(this.cooldownDir)) {
      mkdirSync(this.cooldownDir, { recursive: true });
    }
  }

  /**
   * Check if operation should run (cooldown expired or doesn't exist)
   * @param name - Cooldown name (e.g., 'git-status', 'billing')
   * @param sessionId - Optional session ID for per-session cooldowns
   * @param contextKey - Optional context key for scoping (e.g., repoPath for git)
   */
  shouldRun(name: string, sessionId?: string, contextKey?: string): boolean {
    const spec = COOLDOWN_SPECS[name];
    if (!spec) {
      // Unknown operation - allow it to run
      return true;
    }

    const path = this.getCooldownPath(name, sessionId, contextKey);
    if (!existsSync(path)) {
      return true;  // No cooldown file - run
    }

    try {
      const data: CooldownData = JSON.parse(readFileSync(path, 'utf-8'));
      const age = Date.now() - data.lastChecked;
      return age > spec.ttlMs;
    } catch {
      // Corrupted file - treat as missing
      return true;
    }
  }

  /**
   * Mark operation as complete, preventing duplicate work during cooldown period
   * @param name - Cooldown name (e.g., 'git-status', 'billing')
   * @param data - Additional data to store with cooldown
   * @param sessionId - Optional session ID for per-session cooldowns
   * @param contextKey - Optional context key for scoping (e.g., repoPath for git)
   */
  markComplete(name: string, data: Partial<CooldownData>, sessionId?: string, contextKey?: string): void {
    const path = this.getCooldownPath(name, sessionId, contextKey);
    const cooldownData: CooldownData = {
      ...data,
      lastChecked: Date.now()
    };

    // Atomic write (temp + rename)
    const tempPath = `${path}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(cooldownData), { encoding: 'utf-8', mode: 0o600 });
      // Rename is atomic on POSIX systems
      try {
        statSync(path);  // Check if target exists
        // Target exists, use fs.rename (overwrites)
        require('fs').renameSync(tempPath, path);
      } catch {
        // Target doesn't exist, safe to rename
        require('fs').renameSync(tempPath, path);
      }
    } catch (err) {
      // Atomic write failed - clean up temp file
      try {
        require('fs').unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Read cooldown data (for debugging/inspection)
   * @param name - Cooldown name
   * @param sessionId - Optional session ID
   * @param contextKey - Optional context key for scoping
   */
  read(name: string, sessionId?: string, contextKey?: string): CooldownData | null {
    const path = this.getCooldownPath(name, sessionId, contextKey);
    if (!existsSync(path)) {
      return null;
    }

    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Force expire a cooldown (for testing or manual refresh)
   * @param name - Cooldown name
   * @param sessionId - Optional session ID
   * @param contextKey - Optional context key for scoping
   */
  expire(name: string, sessionId?: string, contextKey?: string): void {
    const path = this.getCooldownPath(name, sessionId, contextKey);
    try {
      require('fs').unlinkSync(path);
    } catch {
      // File doesn't exist or can't be deleted - ignore
    }
  }

  /**
   * Get cooldown file path
   * @param name - Cooldown name
   * @param sessionId - Optional session ID for per-session cooldowns
   * @param contextKey - Optional context key for scoping (e.g., repoPath for git)
   */
  private getCooldownPath(name: string, sessionId?: string, contextKey?: string): string {
    const spec = COOLDOWN_SPECS[name];
    if (!spec) {
      throw new Error(`Unknown cooldown: ${name}`);
    }

    // Build filename based on scope
    let filename: string;
    if (spec.sharedAcrossSessions) {
      // Shared cooldown - use context key if provided (e.g., per-repo git status)
      if (contextKey) {
        // Hash context key to avoid filesystem issues with long paths
        const crypto = require('crypto');
        const hash = crypto.createHash('md5').update(contextKey).digest('hex').substring(0, 8);
        filename = `${name}-${hash}.cooldown`;
      } else {
        filename = `${name}.cooldown`;
      }
    } else {
      // Per-session cooldown
      filename = `${sessionId}-${name}.cooldown`;
    }

    return join(this.cooldownDir, filename);
  }
}

export default CooldownManager;
