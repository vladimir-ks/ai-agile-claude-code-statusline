/**
 * Line Parser - Parse JSONL content into structured lines
 *
 * Performance: O(n) where n = number of lines
 * Error handling: NEVER throws, gracefully handles malformed JSON
 */

import type { ParsedLine } from './types';

export class LineParser {
  /**
   * Parse JSONL content into ParsedLine array
   *
   * @param content - Raw JSONL content (newline-delimited JSON)
   * @param startLine - Starting line number (for error reporting)
   * @returns Array of ParsedLine objects (including failed parses)
   *
   * Error handling:
   * - Invalid JSON → data=null, parseError set
   * - Empty lines → filtered out
   * - Never throws
   */
  static parse(content: string, startLine: number = 0): ParsedLine[] {
    // Edge case: empty content
    if (!content || content.trim() === '') {
      return [];
    }

    // Split by newline, filter empty
    const lines = content.split('\n').filter(line => line.trim() !== '');

    // Parse each line
    const parsed: ParsedLine[] = [];
    for (let i = 0; i < lines.length; i++) {
      const lineNumber = startLine + i; // startLine is already 1-based or 0 if not specified
      const rawLine = lines[i];

      let data: any | null = null;
      let parseError: string | null = null;

      try {
        data = JSON.parse(rawLine);
      } catch (error) {
        // Parse failed - store error
        parseError = error instanceof Error ? error.message : 'JSON parse failed';
      }

      parsed.push({
        lineNumber,
        rawLine,
        data,
        parseError
      });
    }

    return parsed;
  }

  /**
   * Parse single line (utility)
   *
   * @param line - Single JSONL line
   * @param lineNumber - Line number (for error reporting)
   * @returns ParsedLine object
   */
  static parseLine(line: string, lineNumber: number): ParsedLine {
    let data: any | null = null;
    let parseError: string | null = null;

    try {
      data = JSON.parse(line);
    } catch (error) {
      parseError = error instanceof Error ? error.message : 'JSON parse failed';
    }

    return {
      lineNumber,
      rawLine: line,
      data,
      parseError
    };
  }

  /**
   * Count valid lines (successfully parsed)
   *
   * @param lines - Array of ParsedLine objects
   * @returns Count of lines with data !== null
   */
  static countValid(lines: ParsedLine[]): number {
    return lines.filter(line => line.data !== null).length;
  }

  /**
   * Count parse errors
   *
   * @param lines - Array of ParsedLine objects
   * @returns Count of lines with parseError !== null
   */
  static countErrors(lines: ParsedLine[]): number {
    return lines.filter(line => line.parseError !== null).length;
  }

  /**
   * Filter to only valid lines
   *
   * @param lines - Array of ParsedLine objects
   * @returns Only lines with data !== null
   */
  static filterValid(lines: ParsedLine[]): ParsedLine[] {
    return lines.filter(line => line.data !== null);
  }

  /**
   * Filter to only error lines
   *
   * @param lines - Array of ParsedLine objects
   * @returns Only lines with parseError !== null
   */
  static filterErrors(lines: ParsedLine[]): ParsedLine[] {
    return lines.filter(line => line.parseError !== null);
  }
}

export default LineParser;
