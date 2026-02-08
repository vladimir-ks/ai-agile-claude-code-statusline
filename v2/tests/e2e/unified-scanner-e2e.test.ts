/**
 * UnifiedTranscriptScanner E2E Test
 *
 * End-to-end validation of the complete scanner pipeline with real-world
 * scenarios. Tests integration of all extractors, state persistence,
 * caching, and performance.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { UnifiedTranscriptScanner } from '../../src/lib/transcript-scanner/unified-transcript-scanner';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('UnifiedTranscriptScanner - E2E', () => {
  let scanner: UnifiedTranscriptScanner;
  let tempFiles: string[] = [];
  let tempStateDir: string;

  beforeEach(() => {
    // Create temp state directory
    tempStateDir = join(homedir(), '.claude/session-health/scanners-e2e-test');
    if (!existsSync(tempStateDir)) {
      mkdirSync(tempStateDir, { recursive: true });
    }
    process.env.TEST_STATE_DIR = tempStateDir;

    scanner = new UnifiedTranscriptScanner();

    // Clear result cache
    const { ResultCache } = require('../../src/lib/transcript-scanner/result-cache');
    ResultCache.clear();
  });

  afterEach(() => {
    // Cleanup temp files
    for (const file of tempFiles) {
      try {
        unlinkSync(file);
      } catch { /* ignore */ }
    }
    tempFiles = [];

    // Cleanup state files
    try {
      const files = readdirSync(tempStateDir);
      for (const file of files) {
        unlinkSync(join(tempStateDir, file));
      }
    } catch { /* ignore */ }

    delete process.env.TEST_STATE_DIR;
  });

  function createTempTranscript(content: string): string {
    const path = join(tempStateDir, `transcript-${Date.now()}-${Math.random()}.jsonl`);
    writeFileSync(path, content, 'utf-8');
    tempFiles.push(path);
    return path;
  }

  test('E2E: Real-world session with user messages, secrets, commands', () => {
    const transcript = [
      `{"type":"user","timestamp":"2026-02-08T10:00:00Z","message":{"content":[{"type":"text","text":"/login"}]}}`,
      `{"type":"assistant","timestamp":"2026-02-08T10:00:05Z","message":{"content":[{"type":"text","text":"Login successful for test@example.com"}]}}`,
      `{"type":"user","timestamp":"2026-02-08T10:01:00Z","message":{"content":[{"type":"text","text":"What is my GitHub token?"}]}}`,
      `{"type":"assistant","message":{"content":[{"type":"text","text":"Your token is ghp_${'a'.repeat(36)}"}]}}`,
      `{"type":"user","timestamp":"2026-02-08T10:02:00Z","message":{"content":[{"type":"text","text":"Please /commit these changes"}]}}`
    ].join('\n');

    const path = createTempTranscript(transcript);
    const result = scanner.scan('e2e-session-1', path);

    // Last message extraction
    expect(result.lastMessage.preview).toBe('Please /commit these changes');
    expect(result.lastMessage.sender).toBe('human');
    expect(result.lastMessage.turnNumber).toBe(5);

    // Secret detection
    expect(result.secrets.length).toBeGreaterThan(0);
    expect(result.secrets[0].type).toBe('GitHub Token');
    expect(result.secrets[0].match).toMatch(/^ghp_\.\.\..+$/);

    // Command detection
    expect(result.commands.length).toBe(2); // /login and /commit
    expect(result.commands.map(c => c.command)).toContain('/login');
    expect(result.commands.map(c => c.command)).toContain('/commit');

    // Auth change detection
    expect(result.authChanges.length).toBeGreaterThan(0);
    expect(result.authChanges[0].email).toBe('test@example.com');

    // Health metrics
    expect(result.health.hasSecrets).toBe(true);
    expect(result.health.hasAuthChanges).toBe(true);
    expect(result.health.messageCount).toBe(5);
    expect(result.health.commandCount).toBe(2);

    // Performance metrics
    expect(result.metrics.scanTimeMs).toBeLessThan(200); // Full scan <200ms
    expect(result.metrics.linesProcessed).toBe(5);
    expect(result.metrics.cacheHit).toBe(false);
  });

  test('E2E: Incremental scanning over multiple invocations', () => {
    // Initial transcript
    const initial = `{"type":"user","timestamp":"2026-02-08T10:00:00Z","message":{"content":[{"type":"text","text":"First message"}]}}`;
    const path = createTempTranscript(initial);

    // First scan
    const result1 = scanner.scan('e2e-session-2', path);
    expect(result1.lastMessage.preview).toBe('First message');
    expect(result1.metrics.cacheHit).toBe(false);

    // Second scan (no changes) - should hit cache
    const result2 = scanner.scan('e2e-session-2', path);
    expect(result2.metrics.cacheHit).toBe(true);
    expect(result2.metrics.scanTimeMs).toBeLessThan(10); // Cached <10ms

    // Wait to ensure mtime changes
    const start = Date.now();
    while (Date.now() - start < 10) { /* spin */ }

    // Append new content
    const newLine = '\n{"type":"user","timestamp":"2026-02-08T10:01:00Z","message":{"content":[{"type":"text","text":"Second message"}]}}';
    writeFileSync(path, initial + newLine, 'utf-8');

    // Clear cache to test incremental from state
    const { ResultCache } = require('../../src/lib/transcript-scanner/result-cache');
    ResultCache.clear();

    // Third scan (incremental from state)
    const result3 = scanner.scan('e2e-session-2', path);
    expect(result3.lastMessage.preview).toBe('Second message');
    expect(result3.metrics.cacheHit).toBe(false);
    expect(result3.metrics.linesProcessed).toBe(1); // Only new line
    expect(result3.metrics.scanTimeMs).toBeLessThan(50); // Incremental <50ms
  });

  test('E2E: State persistence across scanner instances', () => {
    const transcript = `{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}`;
    const path = createTempTranscript(transcript);

    // Scan with first instance
    const scanner1 = new UnifiedTranscriptScanner();
    const result1 = scanner1.scan('e2e-session-3', path);
    expect(result1.lastMessage.preview).toBe('Test');

    // Create new instance (simulates process restart)
    const scanner2 = new UnifiedTranscriptScanner();

    // Scan with second instance - should load previous state
    const result2 = scanner2.scan('e2e-session-3', path);
    expect(result2.metrics.cacheHit).toBe(true); // Loaded from state
    expect(result2.lastMessage.preview).toBe('Test');
  });

  test('E2E: Large transcript performance (1000 messages)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 1000; i++) {
      lines.push(`{"type":"user","message":{"content":[{"type":"text","text":"Message ${i}"}]}}`);
    }
    const transcript = lines.join('\n');
    const path = createTempTranscript(transcript);

    const startTime = Date.now();
    const result = scanner.scan('e2e-session-large', path);
    const duration = Date.now() - startTime;

    // Performance requirements
    expect(duration).toBeLessThan(500); // <500ms for 1000 messages
    expect(result.lastMessage.preview).toBe('Message 999');
    expect(result.lastMessage.turnNumber).toBe(1000);
    expect(result.metrics.linesProcessed).toBe(1000);
  });

  test('E2E: Malformed JSON recovery', () => {
    const transcript = [
      '{"type":"user","message":{"content":[{"type":"text","text":"Valid message 1"}]}}',
      '{invalid json line}',
      'not even json',
      '{"type":"user","message":{"content":[{"type":"text","text":"Valid message 2"}]}}'
    ].join('\n');

    const path = createTempTranscript(transcript);
    const result = scanner.scan('e2e-session-4', path);

    // Should recover from malformed lines
    expect(result.lastMessage.preview).toBe('Valid message 2');
    expect(result.health.messageCount).toBe(2); // Only counts valid messages
    expect(result.metrics.linesProcessed).toBe(4); // Processed all lines
  });

  test('E2E: Empty transcript graceful handling', () => {
    const path = createTempTranscript('');
    const result = scanner.scan('e2e-session-5', path);

    expect(result.lastMessage.preview).toBe('');
    expect(result.lastMessage.timestamp).toBe(0);
    expect(result.secrets).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(result.authChanges).toEqual([]);
    expect(result.health.messageCount).toBe(0);
  });

  test('E2E: Custom extractor registration', () => {
    const customExtractor = {
      id: 'word_count',
      shouldCache: true,
      cacheTTL: 60000,
      extract: (lines: any[]) => {
        let totalWords = 0;
        for (const line of lines) {
          if (line.data?.message?.content) {
            const content = Array.isArray(line.data.message.content)
              ? line.data.message.content
              : [{ text: line.data.message.content }];
            for (const block of content) {
              if (block.text) {
                totalWords += block.text.split(/\s+/).length;
              }
            }
          }
        }
        return { totalWords };
      }
    };

    const customScanner = new UnifiedTranscriptScanner();
    customScanner.registerExtractor(customExtractor);

    const transcript = `{"type":"user","message":{"content":[{"type":"text","text":"Hello world this is a test"}]}}`;
    const path = createTempTranscript(transcript);

    const result = customScanner.scan('e2e-session-6', path);

    // Custom extractor should be registered
    const extractors = customScanner.getRegisteredExtractors();
    expect(extractors).toContain('word_count');
  });

  test('E2E: Performance - Cached scan <10ms', () => {
    const transcript = `{"type":"user","message":{"content":[{"type":"text","text":"Test"}]}}`;
    const path = createTempTranscript(transcript);

    // Prime cache
    scanner.scan('e2e-session-perf', path);

    // Measure cached scan
    const startTime = Date.now();
    const result = scanner.scan('e2e-session-perf', path);
    const duration = Date.now() - startTime;

    expect(result.metrics.cacheHit).toBe(true);
    expect(duration).toBeLessThan(10);
  });

  test('E2E: Multiple secrets of different types', () => {
    const transcript = [
      `{"type":"user","message":{"content":[{"type":"text","text":"GitHub: ghp_${'a'.repeat(36)}"}]}}`,
      `{"type":"user","message":{"content":[{"type":"text","text":"AWS: AKIAIOSFODNN7EXAMPLE"}]}}`,
      `{"type":"user","message":{"content":[{"type":"text","text":"Stripe: sk_live_${'a'.repeat(24)}"}]}}`
    ].join('\n');

    const path = createTempTranscript(transcript);
    const result = scanner.scan('e2e-session-7', path);

    // Should detect multiple secret types
    expect(result.secrets.length).toBeGreaterThanOrEqual(2);
    const types = result.secrets.map(s => s.type);
    expect(types).toContain('GitHub Token');
    expect(types.some(t => t.includes('AWS') || t.includes('Key'))).toBe(true);
  });
});
