/**
 * UnifiedTranscriptScanner Tests
 *
 * Tests for the main orchestrator that coordinates all modules.
 * Phase 1 - Integration testing
 *
 * Coverage:
 * - Full pipeline: Reader → Parser → Extractors
 * - Cache behavior (hit/miss)
 * - State persistence
 * - Error recovery
 * - Performance benchmarks
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { UnifiedTranscriptScanner } from '../../src/lib/transcript-scanner/unified-transcript-scanner';
import { createTempTranscript, createTempStateDir, cleanupTempFiles, assertUnderTime } from './test-harness';
import { existsSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';

describe('UnifiedTranscriptScanner', () => {
  let scanner: UnifiedTranscriptScanner;
  let tempFiles: string[] = [];
  let tempStateDir: string;

  beforeEach(() => {
    tempStateDir = createTempStateDir();
    process.env.TEST_STATE_DIR = tempStateDir;
    scanner = new UnifiedTranscriptScanner();

    // Clear shared caches for test isolation
    const { ResultCache } = require('../../src/lib/transcript-scanner/result-cache');
    ResultCache.clear();
  });

  afterEach(() => {
    cleanupTempFiles(tempFiles);
    tempFiles = [];
    delete process.env.TEST_STATE_DIR;
  });

  describe('Constructor & Configuration', () => {
    test('creates scanner instance', () => {
      expect(scanner).toBeDefined();
      expect(typeof scanner.scan).toBe('function');
    });

    test('registers default extractors', () => {
      const extractors = scanner.getRegisteredExtractors();

      expect(extractors).toContain('last_message');
      expect(extractors).toContain('secrets');
      expect(extractors).toContain('commands');
      expect(extractors).toContain('auth_changes');
    });

    test('allows custom extractor registration', () => {
      const customExtractor = {
        id: 'custom',
        shouldCache: true,
        cacheTTL: 60000,
        extract: () => ({ custom: 'data' })
      };

      scanner.registerExtractor(customExtractor);

      const extractors = scanner.getRegisteredExtractors();
      expect(extractors).toContain('custom');
    });
  });

  describe('scan() - Full Pipeline', () => {
    test('scans transcript and returns ScanResult', () => {
      const transcript = [
        '{"type":"user","message":{"content":[{"type":"text","text":"What does this do?"}]}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"This code implements..."}]}}'
      ].join('\n');

      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      const result = scanner.scan('test-session', path);

      expect(result.sessionId).toBe('test-session');
      expect(result.lastMessage).toBeDefined();
      expect(result.lastMessage.preview).toContain('What does this do?');
      expect(result.metrics.linesProcessed).toBe(2);
      expect(result.metrics.bytesProcessed).toBeGreaterThan(0);
    });

    test('extracts last message correctly', () => {
      const transcript = [
        '{"type":"user","timestamp":"2026-02-08T10:00:00Z","message":{"content":[{"type":"text","text":"First message"}]}}',
        '{"type":"assistant","message":{"content":[{"type":"text","text":"Response"}]}}',
        '{"type":"user","timestamp":"2026-02-08T10:05:00Z","message":{"content":[{"type":"text","text":"Second message"}]}}'
      ].join('\n');

      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      const result = scanner.scan('test-session', path);

      expect(result.lastMessage.preview).toBe('Second message');
      expect(result.lastMessage.turnNumber).toBe(3);
      expect(result.lastMessage.sender).toBe('human');
    });

    test('detects secrets in transcript', () => {
      const transcript = [
        `{"type":"user","message":{"content":[{"type":"text","text":"My token is ghp_${'a'.repeat(36)}"}]}}`
      ].join('\n');

      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      const result = scanner.scan('test-session', path);

      expect(result.secrets.length).toBeGreaterThan(0);
      expect(result.secrets[0].type).toBe('GitHub Token');
      expect(result.secrets[0].match).toMatch(/^ghp_\.\.\..+$/);
    });

    test('detects commands in transcript', () => {
      const transcript = [
        '{"type":"user","message":{"content":[{"type":"text","text":"/login"}]}}'
      ].join('\n');

      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      const result = scanner.scan('test-session', path);

      expect(result.commands.length).toBeGreaterThan(0);
      expect(result.commands[0].command).toBe('/login');
      expect(result.commands[0].line).toBe(1);
    });

    test('detects auth changes in transcript', () => {
      const transcript = [
        '{"type":"user","message":{"content":[{"type":"text","text":"/login"}]}}',
        '{"type":"assistant","timestamp":"2026-02-08T10:00:00Z","message":{"content":[{"type":"text","text":"Login successful for test@example.com"}]}}'
      ].join('\n');

      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      const result = scanner.scan('test-session', path);

      expect(result.authChanges.length).toBeGreaterThan(0);
      expect(result.authChanges[0].email).toBe('test@example.com');
    });

    test('includes transcript health metrics', () => {
      const transcript = [
        '{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}'
      ].join('\n');

      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      const result = scanner.scan('test-session', path);

      expect(result.health).toBeDefined();
      expect(result.health.hasSecrets).toBe(false);
      expect(result.health.hasAuthChanges).toBe(false);
      expect(result.health.messageCount).toBeGreaterThan(0);
    });

    test('includes scan metrics', () => {
      const transcript = '{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}';
      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      const result = scanner.scan('test-session', path);

      expect(result.metrics).toBeDefined();
      expect(result.metrics.scanTimeMs).toBeGreaterThan(0);
      expect(result.metrics.linesProcessed).toBe(1);
      expect(result.metrics.bytesProcessed).toBeGreaterThan(0);
      expect(result.metrics.cacheHit).toBe(false); // First scan
    });
  });

  describe('scan() - Incremental Scanning', () => {
    test('returns cached result if file unchanged', () => {
      const transcript = '{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}';
      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      // First scan
      const result1 = scanner.scan('test-session', path);
      expect(result1.metrics.cacheHit).toBe(false);

      // Second scan (no changes)
      const result2 = scanner.scan('test-session', path);
      expect(result2.metrics.cacheHit).toBe(true);
      expect(result2.lastMessage.preview).toBe(result1.lastMessage.preview);
    });

    test('scans only new lines incrementally', () => {
      const initialTranscript = '{"type":"user","message":{"content":[{"type":"text","text":"Line 1"}]}}';
      const path = createTempTranscript(initialTranscript);
      tempFiles.push(path);

      // First scan
      const result1 = scanner.scan('test-session', path);
      expect(result1.metrics.linesProcessed).toBe(1);

      // Append new line
      const newLine = '\n{"type":"user","message":{"content":[{"type":"text","text":"Line 2"}]}}';
      writeFileSync(path, initialTranscript + newLine, 'utf-8');

      // Second scan (incremental)
      const result2 = scanner.scan('test-session', path);
      expect(result2.metrics.cacheHit).toBe(false);
      expect(result2.lastMessage.preview).toBe('Line 2');
      expect(result2.metrics.linesProcessed).toBe(1); // Only new line
    });

    test('performs full scan if file shrunk', () => {
      const initialTranscript = [
        '{"type":"user","message":{"content":[{"type":"text","text":"Line 1"}]}}',
        '{"type":"user","message":{"content":[{"type":"text","text":"Line 2"}]}}'
      ].join('\n');
      const path = createTempTranscript(initialTranscript);
      tempFiles.push(path);

      // First scan
      scanner.scan('test-session', path);

      // Truncate file
      const newTranscript = '{"type":"user","message":{"content":[{"type":"text","text":"New content"}]}}';
      writeFileSync(path, newTranscript, 'utf-8');

      // Second scan (full scan due to shrinkage)
      const result = scanner.scan('test-session', path);
      expect(result.lastMessage.preview).toBe('New content');
      expect(result.metrics.linesProcessed).toBe(1);
    });
  });

  describe('scan() - State Persistence', () => {
    test('saves state after successful scan', () => {
      const transcript = '{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}';
      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      scanner.scan('test-session', path);

      const statePath = join(tempStateDir, 'test-session.state');
      expect(existsSync(statePath)).toBe(true);

      const stateContent = require('fs').readFileSync(statePath, 'utf-8');
      const state = JSON.parse(stateContent);

      expect(state.version).toBe(2);
      expect(state.lastOffset).toBeGreaterThan(0);
      expect(state.lastMtime).toBeGreaterThan(0);
    });

    test('loads previous state on subsequent scans', () => {
      const transcript = '{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}';
      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      // First scan
      const result1 = scanner.scan('test-session', path);
      const offset1 = result1.metrics.bytesProcessed;

      // Create new scanner instance (simulates restart)
      const scanner2 = new UnifiedTranscriptScanner();

      // Second scan should load previous state
      const result2 = scanner2.scan('test-session', path);
      expect(result2.metrics.cacheHit).toBe(true);
    });

    test('handles missing state file gracefully', () => {
      const transcript = '{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}';
      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      // Scan with no previous state
      const result = scanner.scan('new-session', path);

      expect(result.sessionId).toBe('new-session');
      expect(result.metrics.cacheHit).toBe(false);
    });
  });

  describe('scan() - Error Recovery', () => {
    test('handles malformed JSON gracefully', () => {
      const transcript = [
        '{"type":"user","message":{"content":[{"type":"text","text":"Valid"}]}}',
        '{invalid json}',
        '{"type":"user","message":{"content":[{"type":"text","text":"Also valid"}]}}'
      ].join('\n');

      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      const result = scanner.scan('test-session', path);

      expect(result.lastMessage.preview).toBe('Also valid');
      expect(result.metrics.linesProcessed).toBe(3);
    });

    test('continues if extractor fails', () => {
      const failingExtractor = {
        id: 'failing',
        shouldCache: true,
        cacheTTL: 60000,
        extract: () => {
          throw new Error('Extractor error');
        }
      };

      scanner.registerExtractor(failingExtractor);

      const transcript = '{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}';
      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      // Should not throw, should return partial results
      const result = scanner.scan('test-session', path);

      expect(result.lastMessage).toBeDefined(); // Other extractors still work
      expect(result.metrics.linesProcessed).toBe(1);
    });

    test('throws on non-existent file', () => {
      expect(() => {
        scanner.scan('test-session', '/nonexistent/file.jsonl');
      }).toThrow();
    });

    test('handles empty transcript', () => {
      const path = createTempTranscript('');
      tempFiles.push(path);

      const result = scanner.scan('test-session', path);

      expect(result.lastMessage.preview).toBe('');
      expect(result.secrets).toEqual([]);
      expect(result.commands).toEqual([]);
      expect(result.metrics.linesProcessed).toBe(0);
    });
  });

  describe('scan() - Performance', () => {
    test('cached scan completes in <10ms', async () => {
      const transcript = '{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}';
      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      // Prime cache
      scanner.scan('test-session', path);

      // Measure cached scan
      await assertUnderTime(
        () => scanner.scan('test-session', path),
        10,
        'Cached scan'
      );
    });

    test('small incremental scan completes in <50ms', async () => {
      const transcript = '{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}';
      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      await assertUnderTime(
        () => scanner.scan('test-session', path),
        50,
        'Small incremental scan'
      );
    });

    test('large transcript (1000 lines) completes in <500ms', async () => {
      const lines: string[] = [];
      for (let i = 0; i < 1000; i++) {
        lines.push(`{"type":"user","message":{"content":[{"type":"text","text":"Message ${i}"}]}}`);
      }
      const transcript = lines.join('\n');
      const path = createTempTranscript(transcript);
      tempFiles.push(path);

      await assertUnderTime(
        () => scanner.scan('test-session', path),
        500,
        'Large transcript scan'
      );
    });
  });

  describe('getRegisteredExtractors()', () => {
    test('returns list of extractor IDs', () => {
      const extractors = scanner.getRegisteredExtractors();

      expect(Array.isArray(extractors)).toBe(true);
      expect(extractors.length).toBeGreaterThan(0);
    });
  });

  describe('registerExtractor()', () => {
    test('adds new extractor to pipeline', () => {
      const customExtractor = {
        id: 'test_extractor',
        shouldCache: true,
        cacheTTL: 60000,
        extract: () => ({ test: true })
      };

      scanner.registerExtractor(customExtractor);

      const extractors = scanner.getRegisteredExtractors();
      expect(extractors).toContain('test_extractor');
    });

    test('prevents duplicate extractor IDs', () => {
      const extractor1 = {
        id: 'duplicate',
        shouldCache: true,
        cacheTTL: 60000,
        extract: () => ({})
      };

      const extractor2 = {
        id: 'duplicate',
        shouldCache: true,
        cacheTTL: 60000,
        extract: () => ({})
      };

      scanner.registerExtractor(extractor1);

      expect(() => {
        scanner.registerExtractor(extractor2);
      }).toThrow(/already registered/);
    });
  });
});
