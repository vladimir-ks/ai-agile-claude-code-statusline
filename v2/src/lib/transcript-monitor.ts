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

import { existsSync, statSync, readFileSync, openSync, closeSync, readSync, fstatSync } from 'fs';
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
      lastMessagePreview: '',
      lastMessageAgo: '',
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
        const lastMsg = this.getLastUserMessageFromTail(transcriptPath);
        result.lastMessageTime = lastMsg.timestamp;
        result.lastMessagePreview = lastMsg.preview;
        result.lastMessageAgo = lastMsg.timestamp ? this.formatAgo(lastMsg.timestamp) : '';
      } else {
        // Small file: read and parse fully
        const parsed = this.parseTranscript(transcriptPath);
        result.messageCount = parsed.messageCount;
        result.lastMessageTime = parsed.lastTimestamp;
        result.lastMessagePreview = parsed.lastUserMessagePreview;
        result.lastMessageAgo = parsed.lastTimestamp ? this.formatAgo(parsed.lastTimestamp) : '';
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
   * Read last ~2MB of file to find last user message
   * (Large size needed for sessions with heavy tool activity)
   * Uses seeked read to avoid loading entire file into memory
   */
  private getLastUserMessageFromTail(path: string): { timestamp: number; preview: string } {
    try {
      const fd = openSync(path, 'r');
      const stats = fstatSync(fd);
      const readSize = Math.min(2_000_000, stats.size);
      const buffer = Buffer.alloc(readSize);
      const startPos = Math.max(0, stats.size - readSize);
      readSync(fd, buffer, 0, readSize, startPos);
      closeSync(fd);

      const content = buffer.toString('utf-8');
      return this.extractLastUserMessage(content);
    } catch {
      return { timestamp: 0, preview: '' };
    }
  }

  /**
   * Parse full transcript file
   */
  private parseTranscript(path: string): {
    messageCount: number;
    lastTimestamp: number;
    lastUserMessagePreview: string;
  } {
    try {
      const content = readFileSync(path, 'utf-8');
      const lines = content.split('\n').filter(line => line.trim() !== '');

      let lastTimestamp = 0;
      let lastUserMessagePreview = '';

      // Find last valid timestamp and last user message
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);

          // Get timestamp from any message type
          if (obj.timestamp && !lastTimestamp) {
            lastTimestamp = new Date(obj.timestamp).getTime();
          }

          // Get last user message preview (human-readable text only, skip tool_results)
          if (!lastUserMessagePreview && obj.type === 'user' && obj.message?.content) {
            const text = this.extractUserText(obj.message.content);
            // Only use if we found actual text (not empty from tool_result-only messages)
            if (text) {
              lastUserMessagePreview = this.truncatePreview(text, 80);
            }
            // Continue searching if this was a tool_result-only message
          }

          // Once we have both, stop searching
          if (lastTimestamp && lastUserMessagePreview) {
            break;
          }
        } catch {
          // Invalid JSON line, continue to previous
        }
      }

      return {
        messageCount: lines.length,
        lastTimestamp,
        lastUserMessagePreview
      };
    } catch {
      return { messageCount: 0, lastTimestamp: 0, lastUserMessagePreview: '' };
    }
  }

  /**
   * Extract last user message from a chunk of text (tail of file)
   */
  private extractLastUserMessage(chunk: string): { timestamp: number; preview: string } {
    const lines = chunk.split('\n').filter(line => line.trim() !== '');
    let timestamp = 0;
    let preview = '';

    // Search from end to find user message
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);

        if (!timestamp && obj.timestamp) {
          timestamp = new Date(obj.timestamp).getTime();
        }

        if (!preview && obj.type === 'user' && obj.message?.content) {
          const text = this.extractUserText(obj.message.content);
          // Only use if we found actual text (not empty from tool_result-only messages)
          if (text) {
            preview = this.truncatePreview(text, 80);
          }
          // Continue searching if this was a tool_result-only message
        }

        if (timestamp && preview) break;
      } catch {
        // Not valid JSON or partial line, continue
      }
    }

    return { timestamp, preview };
  }

  /**
   * Extract human-readable text from user message content
   * Content can be: string | array of content blocks
   *
   * Content block types:
   * - { type: 'text', text: '...' } - actual user text (what we want)
   * - { type: 'tool_result', ... } - tool output (skip these)
   * - { type: 'image', ... } - image data (skip)
   */
  private extractUserText(content: unknown): string {
    // Simple string content
    if (typeof content === 'string') {
      return content;
    }

    // Array of content blocks (Claude API format)
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          // Only accept explicit text blocks, skip tool_result
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
        }
      }
    }

    return '';
  }

  /**
   * Check if user message contains actual human text (not just tool results)
   */
  private hasUserText(content: unknown): boolean {
    return this.extractUserText(content) !== '';
  }

  /**
   * Truncate message to preview length
   */
  private truncatePreview(text: string, maxLen: number): string {
    // Clean up the text
    const cleaned = text.replace(/\s+/g, ' ').trim();
    if (cleaned.length <= maxLen) {
      return cleaned;
    }
    return cleaned.slice(0, maxLen - 2) + '..';
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
