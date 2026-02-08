/**
 * Incremental Reader - Read new bytes from transcript since last scan
 *
 * Performance: O(new_bytes), not O(file_size)
 * Strategy: Byte-level offset tracking with mtime validation
 */

import { existsSync, statSync, openSync, readSync, closeSync } from 'fs';
import type { ReadResult } from './types';

export class IncrementalReader {
  /**
   * Read new bytes from transcript since last scan
   *
   * @param path - Absolute path to transcript file
   * @param lastOffset - Byte position of last read (0 = full scan)
   * @param lastMtime - File mtime at last read (ms timestamp)
   * @returns ReadResult with new content and metadata
   *
   * Performance:
   * - Cache hit (no changes): <1ms
   * - Incremental read (100KB): <20ms
   *
   * Error handling:
   * - File doesn't exist: throw Error
   * - File not readable: throw Error
   * - Negative offset: throw Error
   *
   * Edge cases:
   * - File shrunk (size < lastOffset): Reset to full scan
   * - File cleared (size = 0): Return empty
   * - Offset beyond EOF: Return empty (cache hit)
   */
  static read(
    path: string,
    lastOffset: number,
    lastMtime: number
  ): ReadResult {
    // Validate inputs
    if (lastOffset < 0) {
      throw new Error(`Invalid offset: ${lastOffset} (must be >= 0)`);
    }

    // Check file exists
    if (!existsSync(path)) {
      throw new Error(`File does not exist: ${path}`);
    }

    // Get current stats
    let stats;
    try {
      stats = statSync(path);
    } catch (error) {
      throw new Error(`Cannot stat file: ${path}`);
    }

    // Check if file is actually a directory
    if (stats.isDirectory()) {
      throw new Error(`Path is a directory: ${path}`);
    }

    const currentSize = stats.size;
    const currentMtime = stats.mtimeMs;

    // FAST PATH: Cache hit (no changes)
    if (currentMtime === lastMtime && currentSize === lastOffset) {
      return {
        newBytes: '',
        newOffset: currentSize,
        mtime: currentMtime,
        size: currentSize,
        cacheHit: true
      };
    }

    // EDGE CASE: File shrunk (cleared/rotated)
    if (currentSize < lastOffset) {
      // Reset to full scan
      lastOffset = 0;
    }

    // EDGE CASE: Offset beyond EOF (shouldn't happen, but handle gracefully)
    if (lastOffset >= currentSize) {
      return {
        newBytes: '',
        newOffset: currentSize,
        mtime: currentMtime,
        size: currentSize,
        cacheHit: true
      };
    }

    // Calculate bytes to read
    const newBytes = currentSize - lastOffset;

    // EDGE CASE: Empty file or no new content
    if (newBytes === 0) {
      return {
        newBytes: '',
        newOffset: currentSize,
        mtime: currentMtime,
        size: currentSize,
        cacheHit: true
      };
    }

    // Read new bytes
    let content: string;
    try {
      const buffer = Buffer.alloc(newBytes);
      const fd = openSync(path, 'r');
      try {
        readSync(fd, buffer, 0, newBytes, lastOffset);
        content = buffer.toString('utf-8');
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      throw new Error(`Failed to read file: ${path}`);
    }

    return {
      newBytes: content,
      newOffset: currentSize,
      mtime: currentMtime,
      size: currentSize,
      cacheHit: false
    };
  }
}

export default IncrementalReader;
