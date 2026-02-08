/**
 * State Manager - Persistent state tracking for transcript scanner
 *
 * Manages scanner state files (offset, mtime, extractor data).
 * Handles migration from old state file formats.
 * Uses atomic writes (temp file + rename) for corruption prevention.
 *
 * State file location: ~/.claude/session-health/scanners/{sessionId}.state
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import type { ScannerState } from './types';

export class StateManager {
  private static get STATE_DIR(): string {
    // Allow test override via environment variable
    return process.env.TEST_STATE_DIR || `${homedir()}/.claude/session-health/scanners`;
  }

  /**
   * Get old cooldowns directory (for migration)
   * Respects TEST_STATE_DIR for testing
   */
  private static get OLD_COOLDOWNS_DIR(): string {
    if (process.env.TEST_STATE_DIR) {
      // In test mode, look for old files inside TEST_STATE_DIR/cooldowns
      return `${process.env.TEST_STATE_DIR}/cooldowns`;
    }
    return `${homedir()}/.claude/session-health/cooldowns`;
  }

  /**
   * Get state file path for session
   *
   * @param sessionId - Session identifier (validated for path traversal)
   * @returns Full path to state file
   */
  static getStatePath(sessionId: string): string {
    // SECURITY: Validate sessionId to prevent path traversal
    if (!sessionId || !/^[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw new Error(`Invalid sessionId: ${sessionId} (must be alphanumeric + dash/underscore)`);
    }

    return `${this.STATE_DIR}/${sessionId}.state`;
  }

  /**
   * Load scanner state for session
   *
   * @param sessionId - Session identifier
   * @returns Scanner state or null if doesn't exist
   *
   * Error handling:
   * - File doesn't exist: Try migration from old format
   * - Parse error: Return null (caller creates fresh state)
   * - Invalid version: Return null
   * - Never throws
   */
  static load(sessionId: string): ScannerState | null {
    const path = this.getStatePath(sessionId);

    if (!existsSync(path)) {
      // Try migration from old formats
      return this.migrateFromOld(sessionId);
    }

    try {
      const content = readFileSync(path, 'utf-8');
      const state = JSON.parse(content) as ScannerState;

      // Validate version
      if (state.version !== 2) {
        console.warn(`[StateManager] Unknown state version ${state.version}, ignoring`);
        return null;
      }

      // Validate field types and values
      if (typeof state.lastOffset !== 'number' || state.lastOffset < 0) {
        console.warn(`[StateManager] Invalid lastOffset: ${state.lastOffset}`);
        return null;
      }

      if (typeof state.lastMtime !== 'number' || state.lastMtime < 0) {
        console.warn(`[StateManager] Invalid lastMtime: ${state.lastMtime}`);
        return null;
      }

      if (typeof state.lastScanAt !== 'number') {
        console.warn(`[StateManager] Invalid lastScanAt: ${state.lastScanAt}`);
        return null;
      }

      if (typeof state.extractorData !== 'object' || state.extractorData === null || Array.isArray(state.extractorData)) {
        console.warn(`[StateManager] Invalid extractorData: must be object`);
        return null;
      }

      return state;
    } catch (error) {
      console.error(`[StateManager] Failed to load state for ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Save scanner state for session (atomic)
   *
   * @param sessionId - Session identifier
   * @param state - Scanner state to save
   *
   * Uses atomic write: temp file + rename
   * Error handling: Logs error but doesn't throw (non-critical)
   */
  static save(sessionId: string, state: ScannerState): void {
    const path = this.getStatePath(sessionId);
    const tempPath = `${path}.tmp`;

    try {
      // Ensure directory exists
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Write to temp file
      writeFileSync(tempPath, JSON.stringify(state, null, 2), {
        encoding: 'utf-8',
        mode: 0o600  // Owner read/write only
      });

      // Atomic rename (POSIX guarantee)
      const { renameSync } = require('fs');
      renameSync(tempPath, path);

    } catch (error) {
      console.error(`[StateManager] Failed to save state for ${sessionId}:`, error);

      // Cleanup orphan temp file
      try {
        unlinkSync(tempPath);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Create initial state for new session
   *
   * @param sessionId - Session identifier
   * @returns New scanner state with offset=0
   */
  static createInitial(sessionId: string): ScannerState {
    return {
      version: 2,
      lastOffset: 0,
      lastMtime: 0,
      lastScanAt: Date.now(),
      extractorData: {}
    };
  }

  /**
   * Update state with new scan results (immutable)
   *
   * @param state - Current state
   * @param offset - New offset
   * @param mtime - New mtime
   * @param extractorData - Updated extractor data
   * @returns New state (original unchanged)
   */
  static update(
    state: ScannerState,
    offset: number,
    mtime: number,
    extractorData: Record<string, any>
  ): ScannerState {
    return {
      ...state,
      lastOffset: offset,
      lastMtime: mtime,
      lastScanAt: Date.now(),
      extractorData: {
        ...state.extractorData,
        ...extractorData
      }
    };
  }

  /**
   * Delete state file for session
   *
   * @param sessionId - Session identifier
   *
   * Error handling: Logs error but doesn't throw
   */
  static delete(sessionId: string): void {
    const path = this.getStatePath(sessionId);
    if (existsSync(path)) {
      try {
        unlinkSync(path);
      } catch (error) {
        console.error(`[StateManager] Failed to delete state for ${sessionId}:`, error);
      }
    }
  }

  /**
   * List all session IDs with scanner state
   *
   * @returns Array of session IDs
   *
   * Error handling: Returns [] on error
   */
  static listSessions(): string[] {
    if (!existsSync(this.STATE_DIR)) {
      return [];
    }

    try {
      const files = readdirSync(this.STATE_DIR);
      return files
        .filter((f: string) => f.endsWith('.state'))
        .map((f: string) => f.replace('.state', ''));
    } catch {
      return [];
    }
  }

  /**
   * Migrate from old state file formats
   *
   * @param sessionId - Session identifier
   * @returns Migrated state or null
   *
   * Attempts migration from:
   * 1. IncrementalTranscriptScanner state ({sessionId}-transcript.state)
   * 2. GitLeaksScanner state ({sessionId}-gitleaks.state)
   */
  private static migrateFromOld(sessionId: string): ScannerState | null {
    let newState: ScannerState | null = null;

    // Try IncrementalTranscriptScanner state
    const oldTranscriptPath = `${this.OLD_COOLDOWNS_DIR}/${sessionId}-transcript.state`;
    if (existsSync(oldTranscriptPath)) {
      try {
        const content = readFileSync(oldTranscriptPath, 'utf-8');
        const oldState = JSON.parse(content);

        console.log(`[StateManager] Migrating old transcript state for ${sessionId}`);

        newState = {
          version: 2,
          lastOffset: oldState.lastReadOffset || 0,
          lastMtime: oldState.lastReadMtime || 0,
          lastScanAt: Date.now(),
          extractorData: {
            last_message: {
              timestamp: oldState.lastUserMessage?.timestamp || 0,
              preview: oldState.lastUserMessage?.preview || '',
              sender: 'human',
              turnNumber: oldState.messageCount || 0
            }
          }
        };

      } catch (error) {
        console.error(`[StateManager] Failed to migrate old transcript state:`, error);
      }
    }

    // Try GitLeaksScanner state (merge with transcript if both exist)
    const oldGitleaksPath = `${this.OLD_COOLDOWNS_DIR}/${sessionId}-gitleaks.state`;
    if (existsSync(oldGitleaksPath)) {
      try {
        const content = readFileSync(oldGitleaksPath, 'utf-8');
        const oldState = JSON.parse(content);

        console.log(`[StateManager] Migrating old gitleaks state for ${sessionId}`);

        if (newState) {
          // Merge with existing transcript state
          newState.extractorData.secrets = oldState.knownFindings || [];
          // Prefer gitleaks offset if it's more recent (higher offset)
          if ((oldState.lastScannedOffset || 0) > newState.lastOffset) {
            newState.lastOffset = oldState.lastScannedOffset || 0;
            newState.lastMtime = oldState.lastScannedMtime || 0;
          }
        } else {
          // Only gitleaks state exists
          newState = {
            version: 2,
            lastOffset: oldState.lastScannedOffset || 0,
            lastMtime: oldState.lastScannedMtime || 0,
            lastScanAt: Date.now(),
            extractorData: {
              secrets: oldState.knownFindings || []
            }
          };
        }

      } catch (error) {
        console.error(`[StateManager] Failed to migrate old gitleaks state:`, error);
      }
    }

    // Save merged state if any migration succeeded
    if (newState) {
      this.save(sessionId, newState);
    }

    return newState;
  }
}

export default StateManager;
