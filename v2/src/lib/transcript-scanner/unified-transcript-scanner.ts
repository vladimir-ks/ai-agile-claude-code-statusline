/**
 * Unified Transcript Scanner - Main orchestrator
 *
 * Coordinates all modules into a unified scanning pipeline:
 * 1. Load state (StateManager)
 * 2. Check cache (ResultCache)
 * 3. Read new bytes (IncrementalReader)
 * 4. Parse lines (LineParser)
 * 5. Run extractors (parallel)
 * 6. Aggregate results
 * 7. Save state
 * 8. Cache results
 *
 * Performance: <10ms cached, <50ms incremental, <200ms full scan
 */

import { IncrementalReader } from './incremental-reader';
import { LineParser } from './line-parser';
import { StateManager } from './state-manager';
import { ResultCache } from './result-cache';
import { LastMessageExtractor } from './extractors/last-message-extractor';
import { SecretDetector } from './extractors/secret-detector';
import { CommandDetector } from './extractors/command-detector';
import { AuthChangeDetector } from './extractors/auth-change-detector';

import type {
  ScanResult,
  ParsedLine,
  DataExtractor,
  MessageInfo,
  Secret,
  Command,
  AuthChange,
  TranscriptHealth,
  ScanMetrics
} from './types';

export class UnifiedTranscriptScanner {
  private extractors: Map<string, DataExtractor<any>> = new Map();

  constructor() {
    // Register default extractors
    this.registerExtractor(new LastMessageExtractor());
    this.registerExtractor(new SecretDetector());
    this.registerExtractor(new CommandDetector());
    this.registerExtractor(new AuthChangeDetector());
  }

  /**
   * Scan transcript file and extract all data
   *
   * @param sessionId - Session identifier
   * @param transcriptPath - Path to transcript JSONL file
   * @returns Complete scan results
   *
   * Pipeline:
   * 1. Load previous state
   * 2. Check cache (if unchanged)
   * 3. Incremental read (new bytes only)
   * 4. Parse new lines
   * 5. Run all extractors
   * 6. Aggregate results
   * 7. Save state
   * 8. Cache results
   *
   * Performance:
   * - Cached (no changes): <10ms
   * - Incremental (small): <50ms
   * - Full scan (1MB): <200ms
   *
   * Error Handling:
   * - Non-existent file: throw error
   * - Malformed JSON: skip line, continue
   * - Extractor failure: log error, continue with other extractors
   */
  scan(sessionId: string, transcriptPath: string): ScanResult {
    const startTime = Date.now();

    // 1. Load previous state
    let state = StateManager.load(sessionId);
    if (!state) {
      state = StateManager.createInitial(sessionId);
    }

    // 2. Check cache (ResultCache)
    const cached = ResultCache.get(sessionId);
    if (cached) {
      // Verify file hasn't changed
      const readResult = IncrementalReader.read(
        transcriptPath,
        state.lastOffset,
        state.lastMtime
      );

      if (readResult.cacheHit) {
        // Return cached result with updated metrics
        return {
          ...cached,
          metrics: {
            ...cached.metrics,
            cacheHit: true,
            scanTimeMs: Date.now() - startTime
          }
        };
      }
    }

    // 3. Incremental read
    const readResult = IncrementalReader.read(
      transcriptPath,
      state.lastOffset,
      state.lastMtime
    );

    // 4. Parse new lines
    const newLines = LineParser.parse(readResult.newBytes, state.lastOffset);

    // If no new content and we had state, this is effectively a cache hit
    // Exception: Empty file (offset=0, size=0) should return empty results
    if (newLines.length === 0 && state.lastOffset > 0 && readResult.size > 0) {
      // Build result from state
      const result = this.buildResultFromState(sessionId, state, readResult, startTime);
      return result;
    }

    // Handle empty transcript (size=0)
    if (readResult.size === 0) {
      return this.buildEmptyResult(sessionId, startTime);
    }

    // 5. Run extractors (with error recovery)
    const extractorResults = this.runExtractors(newLines);

    // 6. Merge with previous extractor data (for incremental scans)
    const mergedData = this.mergeExtractorData(state.extractorData, extractorResults);

    // 7. Build final result
    const result: ScanResult = {
      sessionId,
      lastMessage: mergedData.last_message || this.getDefaultMessageInfo(),
      secrets: mergedData.secrets || [],
      commands: mergedData.commands || [],
      authChanges: mergedData.auth_changes || [],
      health: this.calculateHealth(mergedData),
      metrics: {
        scanTimeMs: Date.now() - startTime,
        linesProcessed: newLines.length,
        bytesProcessed: readResult.newBytes.length,
        cacheHit: false
      }
    };

    // 8. Save state
    const newState = StateManager.update(
      state,
      readResult.newOffset,
      readResult.mtime,
      mergedData
    );
    StateManager.save(sessionId, newState);

    // 9. Cache results
    ResultCache.set(sessionId, result);

    return result;
  }

  /**
   * Register a custom extractor
   *
   * @param extractor - DataExtractor implementation
   * @throws Error if extractor ID already registered
   */
  registerExtractor(extractor: DataExtractor<any>): void {
    if (this.extractors.has(extractor.id)) {
      throw new Error(`Extractor '${extractor.id}' is already registered`);
    }

    this.extractors.set(extractor.id, extractor);
  }

  /**
   * Get list of registered extractor IDs
   *
   * @returns Array of extractor IDs
   */
  getRegisteredExtractors(): string[] {
    return Array.from(this.extractors.keys());
  }

  /**
   * Run all extractors on parsed lines
   *
   * @param lines - Parsed transcript lines
   * @returns Extractor results keyed by ID
   *
   * Error Handling:
   * - If an extractor throws, log error and continue
   * - Failed extractors return empty/default results
   */
  private runExtractors(lines: ParsedLine[]): Record<string, any> {
    const results: Record<string, any> = {};

    for (const [id, extractor] of this.extractors.entries()) {
      try {
        results[id] = extractor.extract(lines);
      } catch (error) {
        console.error(`[UnifiedTranscriptScanner] Extractor '${id}' failed:`, error);
        // Return empty result for failed extractor
        results[id] = this.getDefaultExtractorResult(id);
      }
    }

    return results;
  }

  /**
   * Merge new extractor results with previous state data
   *
   * Strategy:
   * - last_message: Replace with new (only one message)
   * - secrets: Append new (deduplicated by fingerprint)
   * - commands: Append new
   * - auth_changes: Append new
   *
   * @param previousData - Data from state
   * @param newData - Fresh extractor results
   * @returns Merged data
   */
  private mergeExtractorData(
    previousData: Record<string, any>,
    newData: Record<string, any>
  ): Record<string, any> {
    const merged: Record<string, any> = { ...previousData };

    // last_message: Always use latest
    if (newData.last_message) {
      merged.last_message = newData.last_message;
    }

    // secrets: Append new, deduplicate by fingerprint
    if (newData.secrets && Array.isArray(newData.secrets)) {
      const existingSecrets = (merged.secrets || []) as Secret[];
      const existingFingerprints = new Set(
        existingSecrets.map((s: Secret) => s.fingerprint)
      );

      const newSecrets = newData.secrets.filter(
        (s: Secret) => !existingFingerprints.has(s.fingerprint)
      );

      merged.secrets = [...existingSecrets, ...newSecrets];
    }

    // commands: Append new
    if (newData.commands && Array.isArray(newData.commands)) {
      const existingCommands = (merged.commands || []) as Command[];
      merged.commands = [...existingCommands, ...newData.commands];
    }

    // auth_changes: Append new
    if (newData.auth_changes && Array.isArray(newData.auth_changes)) {
      const existingChanges = (merged.auth_changes || []) as AuthChange[];
      merged.auth_changes = [...existingChanges, ...newData.auth_changes];
    }

    return merged;
  }

  /**
   * Build result from state (when no new content)
   *
   * @param sessionId - Session ID
   * @param state - Saved state
   * @param readResult - Read result (for metrics)
   * @param startTime - Scan start timestamp
   * @returns ScanResult
   */
  private buildResultFromState(
    sessionId: string,
    state: any,
    readResult: any,
    startTime: number
  ): ScanResult {
    return {
      sessionId,
      lastMessage: state.extractorData.last_message || this.getDefaultMessageInfo(),
      secrets: state.extractorData.secrets || [],
      commands: state.extractorData.commands || [],
      authChanges: state.extractorData.auth_changes || [],
      health: this.calculateHealth(state.extractorData),
      metrics: {
        scanTimeMs: Date.now() - startTime,
        linesProcessed: 0,
        bytesProcessed: 0,
        cacheHit: true
      }
    };
  }

  /**
   * Calculate transcript health metrics
   *
   * @param data - Extractor data
   * @returns Health metrics
   */
  private calculateHealth(data: Record<string, any>): TranscriptHealth {
    const secrets = (data.secrets || []) as Secret[];
    const commands = (data.commands || []) as Command[];
    const authChanges = (data.auth_changes || []) as AuthChange[];
    const lastMessage = data.last_message as MessageInfo | undefined;

    return {
      hasSecrets: secrets.length > 0,
      hasAuthChanges: authChanges.length > 0,
      messageCount: lastMessage?.turnNumber || 0,
      commandCount: commands.length,
      lastActivityTimestamp: lastMessage?.timestamp || 0
    };
  }

  /**
   * Get default empty MessageInfo
   */
  private getDefaultMessageInfo(): MessageInfo {
    return {
      timestamp: 0,
      preview: '',
      sender: 'unknown',
      turnNumber: 0
    };
  }

  /**
   * Get default result for failed extractor
   *
   * @param extractorId - Extractor ID
   * @returns Empty result
   */
  private getDefaultExtractorResult(extractorId: string): any {
    switch (extractorId) {
      case 'last_message':
        return this.getDefaultMessageInfo();
      case 'secrets':
      case 'commands':
      case 'auth_changes':
        return [];
      default:
        return null;
    }
  }

  /**
   * Build empty result for empty transcript
   *
   * @param sessionId - Session ID
   * @param startTime - Scan start timestamp
   * @returns Empty ScanResult
   */
  private buildEmptyResult(sessionId: string, startTime: number): ScanResult {
    return {
      sessionId,
      lastMessage: this.getDefaultMessageInfo(),
      secrets: [],
      commands: [],
      authChanges: [],
      health: {
        hasSecrets: false,
        hasAuthChanges: false,
        messageCount: 0,
        commandCount: 0,
        lastActivityTimestamp: 0
      },
      metrics: {
        scanTimeMs: Date.now() - startTime,
        linesProcessed: 0,
        bytesProcessed: 0,
        cacheHit: false
      }
    };
  }
}

export default UnifiedTranscriptScanner;
