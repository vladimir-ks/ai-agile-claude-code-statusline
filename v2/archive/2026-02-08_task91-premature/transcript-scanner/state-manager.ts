/**
 * State Manager - Persistent state tracking for transcript scanner
 *
 * Manages scanner state files (offset, mtime, extractor data).
 * Handles migration from old state file formats.
 *
 * State file location: ~/.claude/session-health/scanners/{sessionId}.state
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';
import type { ScannerState } from './types';

export class StateManager {
  private static readonly STATE_DIR = `${homedir()}/.claude/session-health/scanners`;

  /**
   * Get state file path for session
   *
   * @param sessionId - Session identifier
   * @returns Full path to state file
   */
  static getStatePath(sessionId: string): string {
    return `${this.STATE_DIR}/${sessionId}.state`;
  }

  /**
   * Load scanner state for session
   *
   * @param sessionId - Session identifier
   * @returns Scanner state or null if doesn't exist
   */
  static load(sessionId: string): ScannerState | null {
    const path = this.getStatePath(sessionId);

    if (!existsSync(path)) {
      // Try migration from old format
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

      return state;
    } catch (error) {
      console.error(`[StateManager] Failed to load state for ${sessionId}:`, error);
      return null;
    }
  }

  /**
   * Save scanner state for session
   *
   * @param sessionId - Session identifier
   * @param state - Scanner state to save
   */
  static save(sessionId: string, state: ScannerState): void {
    const path = this.getStatePath(sessionId);

    try {
      // Ensure directory exists
      const dir = dirname(path);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // Write state (atomic via temp file)
      const tempPath = `${path}.tmp`;
      writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');

      // Atomic rename
      try {
        const { renameSync } = require('fs');
        renameSync(tempPath, path);
      } catch {
        // Fallback: direct write (not atomic but works)
        writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
      }
    } catch (error) {
      console.error(`[StateManager] Failed to save state for ${sessionId}:`, error);
    }
  }

  /**
   * Create initial state for new session
   *
   * @param sessionId - Session identifier
   * @returns New scanner state
   */
  static createInitial(sessionId: string): ScannerState {
    return {
      version: 2,
      lastOffset: 0,
      lastMtime: 0,
      lastScanAt: Date.now(),
      extractorData: {},
    };
  }

  /**
   * Update state with new scan results
   *
   * @param state - Current state
   * @param offset - New offset
   * @param mtime - New mtime
   * @param extractorData - Updated extractor data
   * @returns Updated state
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
        ...extractorData,
      },
    };
  }

  /**
   * Migrate from old state file formats (IncrementalTranscriptScanner, GitLeaksScanner)
   *
   * @param sessionId - Session identifier
   * @returns Migrated state or null
   */
  private static migrateFromOld(sessionId: string): ScannerState | null {
    // Try IncrementalTranscriptScanner state
    const oldTranscriptPath = `${homedir()}/.claude/session-health/cooldowns/${sessionId}-transcript.state`;
    if (existsSync(oldTranscriptPath)) {
      try {
        const content = readFileSync(oldTranscriptPath, 'utf-8');
        const oldState = JSON.parse(content);

        console.log(`[StateManager] Migrating old transcript state for ${sessionId}`);

        return {
          version: 2,
          lastOffset: oldState.lastReadOffset || 0,
          lastMtime: oldState.lastReadMtime || 0,
          lastScanAt: Date.now(),
          extractorData: {
            last_message: {
              timestamp: oldState.lastUserMessage?.timestamp || 0,
              preview: oldState.lastUserMessage?.preview || '',
              sender: 'human',
              turnNumber: oldState.messageCount || 0,
            },
          },
        };
      } catch (error) {
        console.error(`[StateManager] Failed to migrate old transcript state:`, error);
      }
    }

    // Try GitLeaksScanner state
    const oldGitleaksPath = `${homedir()}/.claude/session-health/cooldowns/${sessionId}-gitleaks.state`;
    if (existsSync(oldGitleaksPath)) {
      try {
        const content = readFileSync(oldGitleaksPath, 'utf-8');
        const oldState = JSON.parse(content);

        console.log(`[StateManager] Migrating old gitleaks state for ${sessionId}`);

        return {
          version: 2,
          lastOffset: oldState.lastScannedOffset || 0,
          lastMtime: oldState.lastScannedMtime || 0,
          lastScanAt: Date.now(),
          extractorData: {
            secrets: oldState.knownFindings || [],
          },
        };
      } catch (error) {
        console.error(`[StateManager] Failed to migrate old gitleaks state:`, error);
      }
    }

    return null;
  }

  /**
   * Delete state file for session
   *
   * @param sessionId - Session identifier
   */
  static delete(sessionId: string): void {
    const path = this.getStatePath(sessionId);
    if (existsSync(path)) {
      try {
        const { unlinkSync } = require('fs');
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
   */
  static listSessions(): string[] {
    if (!existsSync(this.STATE_DIR)) {
      return [];
    }

    try {
      const { readdirSync } = require('fs');
      const files = readdirSync(this.STATE_DIR);
      return files
        .filter((f: string) => f.endsWith('.state'))
        .map((f: string) => f.replace('.state', ''));
    } catch {
      return [];
    }
  }
}

export default StateManager;
