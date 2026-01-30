/**
 * Transcript Monitor - Monitor transcript file for data loss risk
 *
 * Checks:
 * - File existence
 * - File size
 * - Last modified time (mtime)
 * - Message count
 * - Last message timestamp
 *
 * Purpose: Detect when transcript hasn't been updated during active session
 * (indicates potential data loss risk)
 */

import { existsSync, statSync, readFileSync } from 'fs';
import { TranscriptHealth } from '../types/session-health';

class TranscriptMonitor {
  /**
   * Check transcript file health
   */
  checkHealth(transcriptPath: string): TranscriptHealth {
    const result: TranscriptHealth = {
      exists: false,
      sizeBytes: 0,
      lastModified: 0,
      lastModifiedAgo: 'unknown',
      messageCount: 0,
      lastMessageTime: 0,
      isSynced: false
    };

    if (!transcriptPath || !existsSync(transcriptPath)) {
      return result;
    }

    try {
      // Get file stats
      const stats = statSync(transcriptPath);
      result.exists = true;
      result.sizeBytes = stats.size;
      result.lastModified = stats.mtimeMs;
      result.lastModifiedAgo = this.formatAgo(stats.mtimeMs);

      // Check if synced (modified within last 60 seconds)
      const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
      result.isSynced = ageSeconds < 60;

      // If file is empty, return early
      if (stats.size === 0) {
        return result;
      }

      // For large files (>1MB), use estimation and tail reading
      if (stats.size > 1_000_000) {
        result.messageCount = this.estimateMessageCount(stats.size);
        result.lastMessageTime = this.getLastTimestampFromTail(transcriptPath);
      } else {
        // Small file: read and parse fully
        const { messageCount, lastTimestamp } = this.parseTranscript(transcriptPath);
        result.messageCount = messageCount;
        result.lastMessageTime = lastTimestamp;
      }

      return result;

    } catch (error) {
      // File read error - return what we have
      return result;
    }
  }

  /**
   * Estimate message count from file size
   * Average JSONL line is ~1KB for Claude Code transcripts
   */
  private estimateMessageCount(sizeBytes: number): number {
    return Math.floor(sizeBytes / 1000);
  }

  /**
   * Read last ~10KB of file to find most recent timestamp
   */
  private getLastTimestampFromTail(path: string): number {
    try {
      const stats = statSync(path);
      const readSize = Math.min(10000, stats.size);
      const fd = Bun.file(path);

      // Read last 10KB
      const buffer = new Uint8Array(readSize);
      const file = Bun.file(path);

      // Use sync read for simplicity
      const content = readFileSync(path, 'utf-8');
      const lastChunk = content.slice(-readSize);

      return this.extractLastTimestamp(lastChunk);
    } catch {
      return 0;
    }
  }

  /**
   * Parse full transcript file
   */
  private parseTranscript(path: string): { messageCount: number; lastTimestamp: number } {
    try {
      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim() !== '');

      let lastTimestamp = 0;

      // Find last valid timestamp
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.timestamp) {
            lastTimestamp = new Date(obj.timestamp).getTime();
            break;
          }
        } catch {
          // Invalid JSON line, continue to previous
        }
      }

      return {
        messageCount: lines.length,
        lastTimestamp
      };
    } catch {
      return { messageCount: 0, lastTimestamp: 0 };
    }
  }

  /**
   * Extract last timestamp from a chunk of text (tail of file)
   */
  private extractLastTimestamp(chunk: string): number {
    const lines = chunk.split('\n').filter(line => line.trim() !== '');

    // Search from end to find valid JSON with timestamp
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        if (obj.timestamp) {
          return new Date(obj.timestamp).getTime();
        }
      } catch {
        // Not valid JSON or partial line, continue
      }
    }

    return 0;
  }

  /**
   * Format timestamp as human-readable "Xm", "Xh", "Xd"
   */
  private formatAgo(timestamp: number): string {
    if (!timestamp || timestamp === 0) {
      return 'unknown';
    }

    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 0) {
      return '<1m'; // Future timestamp (clock skew)
    } else if (seconds < 60) {
      return '<1m';
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)}m`;
    } else if (seconds < 86400) {
      return `${Math.floor(seconds / 3600)}h`;
    } else {
      return `${Math.floor(seconds / 86400)}d`;
    }
  }

  /**
   * Check if transcript is stale (older than threshold)
   */
  isTranscriptStale(health: TranscriptHealth, thresholdMinutes: number): boolean {
    if (!health.exists) {
      return true;
    }

    const ageMinutes = (Date.now() - health.lastModified) / (1000 * 60);
    return ageMinutes > thresholdMinutes;
  }

  /**
   * Determine data loss risk
   * Risk exists if transcript is stale AND session appears active
   */
  hasDataLossRisk(health: TranscriptHealth, isSessionActive: boolean, thresholdMinutes: number): boolean {
    return this.isTranscriptStale(health, thresholdMinutes) && isSessionActive;
  }
}

export default TranscriptMonitor;
