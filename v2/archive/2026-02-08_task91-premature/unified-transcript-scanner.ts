/**
 * Unified Transcript Scanner - Main entry point
 *
 * Coordinates all transcript scanning operations through a single unified pipeline.
 * Replaces fragmented scanning (IncrementalTranscriptScanner, GitLeaksScanner, TranscriptMonitor)
 * with a coordinated system using pluggable extractors.
 *
 * Architecture:
 * 1. Load state (last offset, mtime)
 * 2. Check cache → hit? Return cached
 * 3. Read new bytes incrementally
 * 4. Parse JSONL once
 * 5. Run all extractors in parallel
 * 6. Update state + cache
 * 7. Return composite result
 *
 * Performance targets:
 * - <10ms incremental scan (100 new lines)
 * - <100ms full scan (1000 lines)
 * - <5MB memory per session
 */

import { existsSync, statSync } from 'fs';
import { IncrementalReader } from './transcript-scanner/incremental-reader';
import { LineParser } from './transcript-scanner/line-parser';
import { StateManager } from './transcript-scanner/state-manager';
import { ResultCache } from './transcript-scanner/result-cache';
import type {
  DataExtractor,
  ScanResult,
  ScannerConfig,
  ParsedLine,
  MessageInfo,
  TranscriptHealth,
} from './transcript-scanner/types';
import { DEFAULT_SCANNER_CONFIG } from './transcript-scanner/types';

export class UnifiedTranscriptScanner {
  private static extractors = new Map<string, DataExtractor<any>>();
  private static config: ScannerConfig = DEFAULT_SCANNER_CONFIG;

  /**
   * Register a data extractor
   *
   * @param extractor - Extractor to register
   */
  static register(extractor: DataExtractor<any>): void {
    this.extractors.set(extractor.id, extractor);
  }

  /**
   * Configure scanner behavior
   *
   * @param config - Scanner configuration
   */
  static configure(config: Partial<ScannerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Scan transcript for all data types
   *
   * Main entry point for all transcript scanning operations.
   *
   * @param sessionId - Session identifier
   * @param transcriptPath - Path to transcript.jsonl
   * @returns Composite scan result
   */
  static async scan(sessionId: string, transcriptPath: string): Promise<ScanResult> {
    const scanStart = Date.now();

    // 1. Check in-memory cache
    const cached = ResultCache.get(sessionId);
    if (cached) {
      return cached;
    }

    // 2. Check if transcript exists
    if (!existsSync(transcriptPath)) {
      return this.createEmptyResult(scanStart, true);
    }

    // 3. Load state
    let state = StateManager.load(sessionId);
    if (!state) {
      state = StateManager.createInitial(sessionId);
    }

    // 4. Incremental read
    const readResult = IncrementalReader.read(
      transcriptPath,
      state.lastOffset,
      state.lastMtime
    );

    // Cache hit: no new data
    if (readResult.cacheHit) {
      // Return result from state's cached extractor data
      const result = this.createResultFromState(state, scanStart, readResult.size, true);
      ResultCache.set(sessionId, result, this.config.cacheTTL);
      return result;
    }

    // 5. Parse new lines
    const newLines = LineParser.parse(
      readResult.newBytes,
      this.estimateLineNumber(state.lastOffset)
    );

    // 6. If this is an incremental scan, we need full history for some extractors
    // (e.g., last message requires scanning backwards)
    let allLines: ParsedLine[];
    if (state.lastOffset === 0) {
      // First scan: newLines is complete history
      allLines = newLines;
    } else {
      // Incremental: Need to combine with cached state for backward scans
      // For now, just use new lines (extractors handle this)
      allLines = newLines;
    }

    // 7. Run all extractors in parallel
    const extractorStart = Date.now();
    const extractorResults = await this.runExtractors(allLines, state);
    const extractorDuration = Date.now() - extractorStart;

    // 8. Build composite result
    const result: ScanResult = {
      lastMessage: extractorResults.last_message || this.createEmptyMessage(),
      secrets: extractorResults.secrets || [],
      commands: extractorResults.commands || [],
      authChanges: extractorResults.auth_changes || [],
      health: this.buildHealthMetrics(transcriptPath, readResult.size, readResult.mtime),
      metrics: {
        scanDuration: Date.now() - scanStart,
        linesScanned: newLines.length,
        bytesRead: readResult.newBytes.length,
        cacheHit: false,
        extractorDurations: extractorResults._durations || {},
      },
    };

    // 9. Update state
    const updatedState = StateManager.update(
      state,
      readResult.newOffset,
      readResult.mtime,
      extractorResults
    );
    StateManager.save(sessionId, updatedState);

    // 10. Cache result
    ResultCache.set(sessionId, result, this.config.cacheTTL);

    return result;
  }

  /**
   * Run all registered extractors in parallel
   *
   * @param lines - Parsed transcript lines
   * @param state - Current scanner state
   * @returns Extractor results with timing
   */
  private static async runExtractors(
    lines: ParsedLine[],
    state: any
  ): Promise<Record<string, any>> {
    const results: Record<string, any> = {
      _durations: {},
    };

    const extractorPromises = Array.from(this.extractors.entries()).map(
      async ([id, extractor]) => {
        const start = Date.now();
        try {
          const result = await extractor.extract(lines);
          results[id] = result;
          results._durations[id] = Date.now() - start;
        } catch (error) {
          console.error(`[TranscriptScanner] Extractor ${id} failed:`, error);
          // Use cached result from state if available
          results[id] = state.extractorData?.[id] || null;
          results._durations[id] = Date.now() - start;
        }
      }
    );

    await Promise.all(extractorPromises);
    return results;
  }

  /**
   * Build health metrics for transcript
   *
   * @param path - Transcript path
   * @param size - File size
   * @param mtime - Modification time
   * @returns Health metrics
   */
  private static buildHealthMetrics(
    path: string,
    size: number,
    mtime: number
  ): TranscriptHealth {
    const exists = existsSync(path);
    const lastModified = mtime;
    const now = Date.now();
    const ageMs = now - lastModified;

    // Format age
    let lastModifiedAgo: string;
    if (ageMs < 60_000) {
      lastModifiedAgo = '<1m';
    } else if (ageMs < 3600_000) {
      lastModifiedAgo = `${Math.floor(ageMs / 60_000)}m`;
    } else if (ageMs < 86400_000) {
      lastModifiedAgo = `${Math.floor(ageMs / 3600_000)}h`;
    } else {
      lastModifiedAgo = `${Math.floor(ageMs / 86400_000)}d`;
    }

    // Estimate message count from size (rough: 1KB per line)
    const messageCount = Math.floor(size / 1024);

    return {
      exists,
      lastModified,
      sizeBytes: size,
      messageCount,
      lastModifiedAgo,
    };
  }

  /**
   * Create empty result (for missing transcript)
   */
  private static createEmptyResult(scanStart: number, cacheHit: boolean): ScanResult {
    return {
      lastMessage: this.createEmptyMessage(),
      secrets: [],
      commands: [],
      authChanges: [],
      health: {
        exists: false,
        lastModified: 0,
        sizeBytes: 0,
        messageCount: 0,
        lastModifiedAgo: 'never',
      },
      metrics: {
        scanDuration: Date.now() - scanStart,
        linesScanned: 0,
        bytesRead: 0,
        cacheHit,
        extractorDurations: {},
      },
    };
  }

  /**
   * Create empty message info
   */
  private static createEmptyMessage(): MessageInfo {
    return {
      timestamp: 0,
      preview: '',
      sender: 'unknown',
      turnNumber: 0,
    };
  }

  /**
   * Create result from cached state (cache hit)
   */
  private static createResultFromState(
    state: any,
    scanStart: number,
    fileSize: number,
    cacheHit: boolean
  ): ScanResult {
    return {
      lastMessage: state.extractorData?.last_message || this.createEmptyMessage(),
      secrets: state.extractorData?.secrets || [],
      commands: state.extractorData?.commands || [],
      authChanges: state.extractorData?.auth_changes || [],
      health: this.buildHealthMetrics('', fileSize, state.lastMtime),
      metrics: {
        scanDuration: Date.now() - scanStart,
        linesScanned: 0,
        bytesRead: 0,
        cacheHit,
        extractorDurations: {},
      },
    };
  }

  /**
   * Estimate line number from byte offset (rough)
   */
  private static estimateLineNumber(offset: number): number {
    return Math.floor(offset / 150);  // ~150 bytes per line average
  }

  /**
   * Clear all caches (for testing)
   */
  static clearCache(): void {
    ResultCache.clear();
  }

  /**
   * Get cache statistics
   */
  static getCacheStats(): any {
    return ResultCache.getStats();
  }
}

export default UnifiedTranscriptScanner;

// Re-export types for convenience
export type {
  DataExtractor,
  ScanResult,
  ParsedLine,
  MessageInfo,
  Command,
  AuthChange,
  TranscriptHealth,
} from './transcript-scanner/types';
