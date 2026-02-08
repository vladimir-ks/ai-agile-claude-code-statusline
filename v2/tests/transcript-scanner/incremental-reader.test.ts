/**
 * Tests for IncrementalReader
 *
 * Status: RED (no implementation yet)
 * Coverage target: 100%
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { IncrementalReader } from '../../src/lib/transcript-scanner/incremental-reader';
import {
  createTempTranscript,
  FIXTURE_SMALL_TRANSCRIPT,
  FIXTURE_LARGE_TRANSCRIPT,
  FIXTURE_EMPTY_TRANSCRIPT,
  cleanupTempFiles,
  assertUnderTime
} from './test-harness';
import { writeFileSync, statSync, utimesSync } from 'fs';

let tempFiles: string[] = [];

afterEach(() => {
  cleanupTempFiles(tempFiles);
  tempFiles = [];
});

// ============================================================================
// Cache Hit Detection
// ============================================================================

describe('IncrementalReader - Cache Hit Detection', () => {
  test('Cache hit: mtime and size unchanged → cacheHit=true', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const stats = statSync(path);
    const result = IncrementalReader.read(path, stats.size, stats.mtimeMs);

    expect(result.cacheHit).toBe(true);
    expect(result.newBytes).toBe('');
    expect(result.newOffset).toBe(stats.size);
    expect(result.mtime).toBe(stats.mtimeMs);
  });

  test('Cache miss: mtime changed → cacheHit=false', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const stats = statSync(path);
    const oldMtime = stats.mtimeMs - 60000; // 1 minute ago
    const oldOffset = stats.size - 100; // 100 bytes before EOF

    const result = IncrementalReader.read(path, oldOffset, oldMtime);

    expect(result.cacheHit).toBe(false);
    expect(result.newBytes.length).toBe(100);
  });

  test('Cache miss: size changed → cacheHit=false', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const stats = statSync(path);
    const smallerSize = stats.size - 100;

    const result = IncrementalReader.read(path, smallerSize, stats.mtimeMs);

    expect(result.cacheHit).toBe(false);
    expect(result.newBytes.length).toBe(100);
  });

  test('Cache miss: offset=0 (first scan) → cacheHit=false', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const result = IncrementalReader.read(path, 0, 0);

    expect(result.cacheHit).toBe(false);
    expect(result.newBytes).toBe(FIXTURE_SMALL_TRANSCRIPT);
  });
});

// ============================================================================
// Incremental Reading
// ============================================================================

describe('IncrementalReader - Incremental Reading', () => {
  test('Read only new bytes from middle of file', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const halfSize = Math.floor(FIXTURE_SMALL_TRANSCRIPT.length / 2);
    const expectedNewBytes = FIXTURE_SMALL_TRANSCRIPT.slice(halfSize);

    const result = IncrementalReader.read(path, halfSize, 0);

    expect(result.newBytes).toBe(expectedNewBytes);
    expect(result.newOffset).toBe(FIXTURE_SMALL_TRANSCRIPT.length);
  });

  test('Read 100 new bytes from end', () => {
    const content = FIXTURE_SMALL_TRANSCRIPT;
    const path = createTempTranscript(content);
    tempFiles.push(path);

    const offset = content.length - 100;
    const expectedNewBytes = content.slice(-100);

    const result = IncrementalReader.read(path, offset, 0);

    expect(result.newBytes).toBe(expectedNewBytes);
    expect(result.newBytes.length).toBe(100);
  });

  test('Read entire file when offset=0', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const result = IncrementalReader.read(path, 0, 0);

    expect(result.newBytes).toBe(FIXTURE_SMALL_TRANSCRIPT);
    expect(result.newOffset).toBe(FIXTURE_SMALL_TRANSCRIPT.length);
  });

  test('Handle empty file', () => {
    const path = createTempTranscript(FIXTURE_EMPTY_TRANSCRIPT);
    tempFiles.push(path);

    const result = IncrementalReader.read(path, 0, 0);

    expect(result.newBytes).toBe('');
    expect(result.newOffset).toBe(0);
    expect(result.size).toBe(0);
  });
});

// ============================================================================
// File Reset Detection
// ============================================================================

describe('IncrementalReader - File Reset Detection', () => {
  test('File shrunk: size < lastOffset → reset to full scan', () => {
    const initialContent = FIXTURE_SMALL_TRANSCRIPT;
    const path = createTempTranscript(initialContent);
    tempFiles.push(path);

    const oldOffset = initialContent.length;

    // Shrink file
    const newContent = initialContent.slice(0, Math.floor(initialContent.length / 2));
    writeFileSync(path, newContent);

    const result = IncrementalReader.read(path, oldOffset, 0);

    // Should read entire new file (not just new bytes)
    expect(result.newBytes).toBe(newContent);
    expect(result.newOffset).toBe(newContent.length);
  });

  test('File cleared: size=0 after content → reset to offset=0', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const oldOffset = FIXTURE_SMALL_TRANSCRIPT.length;

    // Clear file
    writeFileSync(path, '');

    const result = IncrementalReader.read(path, oldOffset, 0);

    expect(result.newBytes).toBe('');
    expect(result.newOffset).toBe(0);
    expect(result.size).toBe(0);
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('IncrementalReader - Edge Cases', () => {
  test('Non-existent file → throw error', () => {
    expect(() => {
      IncrementalReader.read('/nonexistent/file.jsonl', 0, 0);
    }).toThrow();
  });

  test('File path is directory → throw error', () => {
    const dirPath = createTempTranscript('');
    tempFiles.push(dirPath);
    const dir = dirPath.replace(/\/[^/]+$/, '');

    expect(() => {
      IncrementalReader.read(dir, 0, 0);
    }).toThrow();
  });

  test('Negative offset → throw error', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    expect(() => {
      IncrementalReader.read(path, -100, 0);
    }).toThrow();
  });

  test('Offset beyond EOF → reset to full scan', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const stats = statSync(path);
    const beyondEOF = stats.size + 1000; // Use actual file size, not string length

    const result = IncrementalReader.read(path, beyondEOF, 0);

    // When offset > file size, treat as file shrunk → reset to full scan
    expect(result.newBytes).toBe(FIXTURE_SMALL_TRANSCRIPT);
    expect(result.cacheHit).toBe(false);
    expect(result.newOffset).toBe(stats.size);
  });

  test('Large file (10000 lines) → read only new portion', async () => {
    const path = createTempTranscript(FIXTURE_LARGE_TRANSCRIPT);
    tempFiles.push(path);

    const halfSize = Math.floor(FIXTURE_LARGE_TRANSCRIPT.length / 2);

    const result = await assertUnderTime(
      () => IncrementalReader.read(path, halfSize, 0),
      20, // 20ms max
      'Large file incremental read'
    );

    expect(result.newBytes.length).toBe(FIXTURE_LARGE_TRANSCRIPT.length - halfSize);
  });
});

// ============================================================================
// UTF-8 Handling
// ============================================================================

describe('IncrementalReader - UTF-8 Handling', () => {
  test('UTF-8 characters decoded correctly', () => {
    const content = '{"text":"Hello 世界 🌍"}\n';
    const path = createTempTranscript(content);
    tempFiles.push(path);

    const result = IncrementalReader.read(path, 0, 0);

    expect(result.newBytes).toBe(content);
    expect(result.newBytes).toContain('世界');
    expect(result.newBytes).toContain('🌍');
  });

  test('Partial UTF-8 sequence at boundary → handle gracefully', () => {
    // Multi-byte UTF-8 character: 世 = 0xE4 0xB8 0x96 (3 bytes)
    const content = 'Hello 世界';
    const path = createTempTranscript(content);
    tempFiles.push(path);

    // Get byte offset of '世' character
    const bytesBefore = Buffer.from('Hello ').length; // 6 bytes
    // Read from middle of multi-byte sequence (bytesBefore + 1 = middle of 世)
    const offset = bytesBefore + 1;

    const result = IncrementalReader.read(path, offset, 0);

    // Should handle partial UTF-8 (may include replacement char �)
    expect(result.newBytes.length).toBeGreaterThan(0);
    // Just verify it doesn't crash - UTF-8 decoding is tolerant
  });
});

// ============================================================================
// Performance Tests
// ============================================================================

describe('IncrementalReader - Performance', () => {
  test('Cache hit completes in <1ms', async () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const stats = statSync(path);

    await assertUnderTime(
      () => IncrementalReader.read(path, stats.size, stats.mtimeMs),
      1, // 1ms max
      'Cache hit'
    );
  });

  test('Incremental read (1KB) completes in <5ms', async () => {
    const content = 'x'.repeat(1024); // 1KB
    const path = createTempTranscript(content);
    tempFiles.push(path);

    await assertUnderTime(
      () => IncrementalReader.read(path, 0, 0),
      5, // 5ms max
      'Incremental read 1KB'
    );
  });

  test('Incremental read (100KB) completes in <20ms', async () => {
    const content = 'x'.repeat(100 * 1024); // 100KB
    const path = createTempTranscript(content);
    tempFiles.push(path);

    await assertUnderTime(
      () => IncrementalReader.read(path, 0, 0),
      20, // 20ms max
      'Incremental read 100KB'
    );
  });
});

// ============================================================================
// Return Value Validation
// ============================================================================

describe('IncrementalReader - Return Value Validation', () => {
  test('ReadResult has all required fields', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const result = IncrementalReader.read(path, 0, 0);

    expect(result).toHaveProperty('newBytes');
    expect(result).toHaveProperty('newOffset');
    expect(result).toHaveProperty('mtime');
    expect(result).toHaveProperty('size');
    expect(result).toHaveProperty('cacheHit');
  });

  test('newOffset always equals current file size', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const result = IncrementalReader.read(path, 0, 0);
    const stats = statSync(path);

    expect(result.newOffset).toBe(stats.size);
    expect(result.size).toBe(stats.size);
  });

  test('mtime matches current file mtime', () => {
    const path = createTempTranscript(FIXTURE_SMALL_TRANSCRIPT);
    tempFiles.push(path);

    const stats = statSync(path);
    const result = IncrementalReader.read(path, 0, 0);

    expect(result.mtime).toBe(stats.mtimeMs);
  });
});
