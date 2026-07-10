/**
 * Session Lock Manager - Persists session identity across restarts
 *
 * Lock file path: ~/.claude/session-health/{sessionId}.lock
 * Written: On first invocation (firstSeen not set)
 * Updated: Mutable fields on subsequent invocations
 *
 * Immutable fields: sessionId, launchedAt
 * Rebound on resume-in-different-slot: slotId, configDir, keychainService, email, transcriptPath, tmux
 * Mutable fields: claudeVersion (re-pinned ONLY from stdin `version`), lastVersionCheck, lastIdleCheck, updatedAt
 *
 * why: `claude --version` = installed binary, NOT the running session's binary —
 * contract: "NEVER re-pins from the installed binary" (session-lock-manager.test.ts)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname } from 'path';
import { execSync } from 'child_process';
import type { SessionLock } from '../types/session-health';

export class SessionLockManager {
  private static readonly LOCK_DIR = `${homedir()}/.claude/session-health`;

  /** Validate sessionId to prevent path traversal.
   *  Mirrors `sanitize.ts:SESSION_ID_PATTERN` (which allows dots) so any value
   *  produced by `sanitizeSessionId` round-trips through the lock manager.
   *  Slashes remain forbidden — `..` in a filename is harmless without a path
   *  separator (W23: F-W23-11). */
  private static isValidSessionId(sessionId: string): boolean {
    return /^[a-zA-Z0-9._-]+$/.test(sessionId);
  }

  /**
   * Get lock file path for a session
   */
  private static getLockPath(sessionId: string): string {
    if (!this.isValidSessionId(sessionId)) {
      throw new Error(`Invalid sessionId: ${sessionId}`);
    }
    return `${this.LOCK_DIR}/${sessionId}.lock`;
  }

  /**
   * Check if lock file exists for session
   */
  static exists(sessionId: string): boolean {
    try {
      return existsSync(this.getLockPath(sessionId));
    } catch {
      return false;
    }
  }

  /**
   * Read session lock file
   * Returns null if missing or corrupted
   */
  static read(sessionId: string): SessionLock | null {
    try {
      const path = this.getLockPath(sessionId);
      if (!existsSync(path)) {
        return null;
      }

      const content = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(content);

      // Validate schema (defensive)
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      if (!parsed.sessionId || !parsed.slotId) {
        return null;
      }

      return parsed as SessionLock;
    } catch {
      return null;
    }
  }

  /**
   * Write session lock file (create or update)
   * Uses atomic write (temp + rename)
   * Non-critical operation (errors logged but not thrown)
   */
  static write(lock: SessionLock): boolean {
    try {
      const path = this.getLockPath(lock.sessionId);

      // Ensure directory exists
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Atomic write: temp file + rename
      const tmpPath = `${path}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(lock, null, 2), { mode: 0o600 });
      try {
        renameSync(tmpPath, path);
      } catch {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        return false;
      }

      return true;
    } catch (err) {
      console.error(`[SessionLockManager] Failed to write lock file: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Create new session lock (first invocation)
   *
   * @param sessionId - Session identifier
   * @param slotId - Hot-swap slot ID (slot-1, slot-2, etc.)
   * @param configDir - CLAUDE_CONFIG_DIR path
   * @param keychainService - Keychain service name
   * @param email - Account email
   * @param transcriptPath - Transcript file path
   * @param tmux - Tmux context (optional)
   * @param runningVersion - stdin `version` (running process); `claude --version` fallback only when absent
   */
  static create(
    sessionId: string,
    slotId: string,
    configDir: string,
    keychainService: string,
    email: string,
    transcriptPath: string,
    tmux?: { session: string; window: string; pane: string },
    runningVersion?: string
  ): SessionLock {
    const now = Date.now();
    const version = runningVersion || this.getClaudeVersion();

    const lock: SessionLock = {
      sessionId,
      launchedAt: now,
      slotId,
      configDir,
      keychainService,
      email,
      transcriptPath,
      claudeVersion: version,
      tmux,
      lockFileVersion: 1,
      updatedAt: now
    };

    this.write(lock);
    return lock;
  }

  /**
   * Update mutable fields in existing lock
   */
  static update(sessionId: string, updates: Partial<Pick<SessionLock, 'lastVersionCheck' | 'lastIdleCheck'>>): boolean {
    const existing = this.read(sessionId);
    if (!existing) {
      return false;
    }

    const updated: SessionLock = {
      ...existing,
      ...updates,
      updatedAt: Date.now()
    };

    return this.write(updated);
  }

  /**
   * Get or create session lock. Re-pins claudeVersion ONLY from `runningVersion`
   * (stdin `version` = the live process's own report; handles --resume naturally).
   * contract: session-lock-manager.test.ts "NEVER re-pins from the installed binary"
   */
  static getOrCreate(
    sessionId: string,
    slotId: string,
    configDir: string,
    keychainService: string,
    email: string,
    transcriptPath: string,
    tmux?: { session: string; window: string; pane: string },
    runningVersion?: string
  ): SessionLock {
    const existing = this.read(sessionId);
    if (existing) {
      const repin = Boolean(runningVersion) && runningVersion !== existing.claudeVersion;

      // Rebind slot identity: `claude --resume` in a DIFFERENT slot starts a new OS
      // process with a different CLAUDE_CONFIG_DIR — the caller's detection IS the
      // live binding, so the lock must follow it (same argument as the version re-pin).
      // Guard: only when the incoming detection is non-degraded (both slotId and
      // configDir present) and actually differs. Truly immutable: sessionId, launchedAt.
      const rebind = Boolean(slotId) && Boolean(configDir) &&
        (existing.slotId !== slotId || existing.configDir !== configDir);

      if (repin || rebind) {
        const updated: SessionLock = {
          ...existing,
          ...(rebind ? {
            slotId,
            configDir,
            keychainService: keychainService || existing.keychainService,
            email: email || existing.email,
            transcriptPath: transcriptPath || existing.transcriptPath,
            ...(tmux ? { tmux } : {})
          } : {}),
          ...(repin ? { claudeVersion: runningVersion as string } : {}),
          updatedAt: Date.now()
        };
        this.write(updated);
        return updated;
      }
      return existing;
    }

    return this.create(sessionId, slotId, configDir, keychainService, email, transcriptPath, tmux, runningVersion);
  }

  /**
   * Get INSTALLED Claude Code version (`claude --version` = binary on disk).
   * NOT the running session's version — create-time fallback only.
   * Returns "unknown" if detection fails
   */
  private static getClaudeVersion(): string {
    try {
      const output = execSync('claude --version 2>&1', {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Parse version from output (e.g., "claude 2.1.31" or "2.1.31")
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Delete session lock file
   * Returns true if deleted, false if already missing or error
   */
  static delete(sessionId: string): boolean {
    try {
      const path = this.getLockPath(sessionId);
      if (!existsSync(path)) {
        return false;
      }

      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get session's slot ID from lock file
   * Returns null if lock missing
   */
  static getSlotId(sessionId: string): string | null {
    const lock = this.read(sessionId);
    return lock?.slotId || null;
  }

  /**
   * Get session's config directory from lock file
   * Returns null if lock missing
   */
  static getConfigDir(sessionId: string): string | null {
    const lock = this.read(sessionId);
    return lock?.configDir || null;
  }

  /**
   * Check if session lock is stale (>24h old without update)
   * Used for cleanup of abandoned sessions
   */
  static isStale(sessionId: string, thresholdMs: number = 24 * 60 * 60 * 1000): boolean {
    const lock = this.read(sessionId);
    if (!lock) {
      return false; // Missing lock is not "stale", just absent
    }

    const ageMs = Date.now() - lock.updatedAt;
    return ageMs > thresholdMs;
  }
}

export default SessionLockManager;
