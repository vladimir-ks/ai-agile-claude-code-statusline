/**
 * Line Parser - JSONL parsing with validation and error handling
 *
 * Parses JSONL (JSON Lines) format used by Claude Code transcripts.
 * Handles malformed lines gracefully, provides detailed error context.
 *
 * Performance: Single-pass parsing, minimal allocations.
 */

import type { ParsedLine } from './types';

export class LineParser {
  /**
   * Parse JSONL content into structured lines
   *
   * @param content - Raw JSONL content (Buffer or string)
   * @param startLineNumber - Starting line number (for offset tracking)
   * @returns Array of parsed lines with validation status
   */
  static parse(
    content: Buffer | string,
    startLineNumber: number = 0
  ): ParsedLine[] {
    const text = typeof content === 'string' ? content : content.toString('utf-8');
    const lines = text.split('\n');
    const parsed: ParsedLine[] = [];

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();

      // Skip empty lines
      if (!trimmed) {
        continue;
      }

      try {
        const data = JSON.parse(trimmed);
        parsed.push({
          valid: true,
          data,
          raw,
          lineNumber: startLineNumber + i,
        });
      } catch (error) {
        // Malformed JSON - keep raw line for debugging
        parsed.push({
          valid: false,
          raw,
          lineNumber: startLineNumber + i,
        });
      }
    }

    return parsed;
  }

  /**
   * Parse single JSONL line
   *
   * @param line - Single line of JSONL
   * @param lineNumber - Line number in file
   * @returns Parsed line
   */
  static parseLine(line: string, lineNumber: number = 0): ParsedLine {
    const trimmed = line.trim();
    if (!trimmed) {
      return {
        valid: false,
        raw: line,
        lineNumber,
      };
    }

    try {
      const data = JSON.parse(trimmed);
      return {
        valid: true,
        data,
        raw: line,
        lineNumber,
      };
    } catch {
      return {
        valid: false,
        raw: line,
        lineNumber,
      };
    }
  }

  /**
   * Validate parsed line has expected structure for Claude Code transcript
   *
   * @param line - Parsed line
   * @returns Whether line looks like valid transcript entry
   */
  static isValidTranscriptEntry(line: ParsedLine): boolean {
    if (!line.valid || !line.data) {
      return false;
    }

    const data = line.data;

    // Check for common transcript fields
    const hasType = typeof data.type === 'string';
    const hasSender = typeof data.sender === 'string';
    const hasTimestamp = typeof data.ts === 'number' || typeof data.timestamp === 'number';

    // At minimum, should have type or sender
    return hasType || hasSender || hasTimestamp;
  }

  /**
   * Extract text content from parsed line (handles multiple formats)
   *
   * @param line - Parsed line
   * @returns Text content or empty string
   */
  static extractText(line: ParsedLine): string {
    if (!line.valid || !line.data) {
      return '';
    }

    const data = line.data;

    // Try common text fields
    if (typeof data.text === 'string') {
      return data.text;
    }
    if (typeof data.content === 'string') {
      return data.content;
    }
    if (typeof data.message === 'string') {
      return data.message;
    }

    // Fallback: stringify data
    return line.raw;
  }

  /**
   * Get statistics about parsing result
   *
   * @param lines - Parsed lines
   * @returns Parsing statistics
   */
  static getStats(lines: ParsedLine[]): {
    total: number;
    valid: number;
    invalid: number;
    validPercent: number;
  } {
    const total = lines.length;
    const valid = lines.filter(l => l.valid).length;
    const invalid = total - valid;
    const validPercent = total > 0 ? Math.floor((valid / total) * 100) : 0;

    return { total, valid, invalid, validPercent };
  }
}

export default LineParser;
