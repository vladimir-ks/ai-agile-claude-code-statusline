/**
 * Transcript Monitor Tests
 *
 * Tests for monitoring transcript file health and detecting data loss risk
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import TranscriptMonitor from '../src/lib/transcript-monitor';

const TEST_DIR = '/tmp/statusline-test-transcript';

describe('TranscriptMonitor', () => {
  let monitor: TranscriptMonitor;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    monitor = new TranscriptMonitor();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // =========================================================================
  // UT-2.1: Missing Transcript
  // =========================================================================
  describe('missing transcript', () => {
    test('returns exists=false for non-existent file', () => {
      const result = monitor.checkHealth('/non/existent/path.jsonl');

      expect(result.exists).toBe(false);
      expect(result.sizeBytes).toBe(0);
      expect(result.messageCount).toBe(0);
      expect(result.isSynced).toBe(false);
    });
  });

  // =========================================================================
  // UT-2.2: Empty Transcript
  // =========================================================================
  describe('empty transcript', () => {
    test('handles empty file correctly', () => {
      const path = join(TEST_DIR, 'empty.jsonl');
      writeFileSync(path, '');

      const result = monitor.checkHealth(path);

      expect(result.exists).toBe(true);
      expect(result.sizeBytes).toBe(0);
      expect(result.messageCount).toBe(0);
    });
  });

  // =========================================================================
  // UT-2.3: Fresh Transcript (<1 min)
  // =========================================================================
  describe('fresh transcript', () => {
    test('shows <1m for recently modified file', () => {
      const path = join(TEST_DIR, 'fresh.jsonl');
      writeFileSync(path, '{"test": true}\n');
      // File just created, so mtime is now

      const result = monitor.checkHealth(path);

      expect(result.exists).toBe(true);
      expect(result.lastModifiedAgo).toBe('<1m');
      expect(result.isSynced).toBe(true);
    });
  });

  // =========================================================================
  // UT-2.4: Stale Transcript (>5 min)
  // =========================================================================
  describe('stale transcript', () => {
    test('shows correct age for stale file', () => {
      const path = join(TEST_DIR, 'stale.jsonl');
      writeFileSync(path, '{"test": true}\n');

      // Set mtime to 6 minutes ago
      const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
      utimesSync(path, sixMinAgo, sixMinAgo);

      const result = monitor.checkHealth(path);

      expect(result.exists).toBe(true);
      expect(result.lastModifiedAgo).toBe('6m');
      expect(result.isSynced).toBe(false);
    });
  });

  // =========================================================================
  // UT-2.5: Very Stale Transcript (hours)
  // =========================================================================
  describe('very stale transcript', () => {
    test('shows hours for old file', () => {
      const path = join(TEST_DIR, 'old.jsonl');
      writeFileSync(path, '{"test": true}\n');

      // Set mtime to 3 hours ago
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
      utimesSync(path, threeHoursAgo, threeHoursAgo);

      const result = monitor.checkHealth(path);

      expect(result.lastModifiedAgo).toBe('3h');
      expect(result.isSynced).toBe(false);
    });

    test('shows days for very old file', () => {
      const path = join(TEST_DIR, 'ancient.jsonl');
      writeFileSync(path, '{"test": true}\n');

      // Set mtime to 5 days ago
      const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      utimesSync(path, fiveDaysAgo, fiveDaysAgo);

      const result = monitor.checkHealth(path);

      expect(result.lastModifiedAgo).toBe('5d');
    });
  });

  // =========================================================================
  // UT-2.6: Message Count (Small File)
  // =========================================================================
  describe('message count', () => {
    test('counts lines correctly for small file', () => {
      const path = join(TEST_DIR, 'messages.jsonl');
      const lines = [];
      for (let i = 0; i < 50; i++) {
        lines.push(JSON.stringify({ id: i, type: 'message' }));
      }
      writeFileSync(path, lines.join('\n') + '\n');

      const result = monitor.checkHealth(path);

      expect(result.messageCount).toBe(50);
    });
  });

  // =========================================================================
  // UT-2.7: Message Count (Large File)
  // =========================================================================
  describe('large file handling', () => {
    test('handles large file without performance issues', () => {
      const path = join(TEST_DIR, 'large.jsonl');

      // Create 2000 lines (~2MB)
      const lines = [];
      for (let i = 0; i < 2000; i++) {
        lines.push(JSON.stringify({
          id: i,
          type: 'message',
          content: 'x'.repeat(500),
          timestamp: new Date().toISOString()
        }));
      }
      writeFileSync(path, lines.join('\n') + '\n');

      const start = Date.now();
      const result = monitor.checkHealth(path);
      const elapsed = Date.now() - start;

      expect(result.exists).toBe(true);
      expect(result.messageCount).toBeGreaterThan(0);
      // Should complete in reasonable time (< 500ms)
      expect(elapsed).toBeLessThan(500);
    });
  });

  // =========================================================================
  // UT-2.8: Last Message Time
  // =========================================================================
  describe('last message time', () => {
    test('extracts timestamp from last message', () => {
      const path = join(TEST_DIR, 'timestamped.jsonl');
      const timestamp = '2026-01-30T10:15:00.000Z';
      const lines = [
        JSON.stringify({ id: 1, timestamp: '2026-01-30T10:00:00.000Z' }),
        JSON.stringify({ id: 2, timestamp: '2026-01-30T10:10:00.000Z' }),
        JSON.stringify({ id: 3, timestamp })
      ];
      writeFileSync(path, lines.join('\n') + '\n');

      const result = monitor.checkHealth(path);

      expect(result.lastMessageTime).toBe(new Date(timestamp).getTime());
    });

    test('handles missing timestamp gracefully', () => {
      const path = join(TEST_DIR, 'no-timestamp.jsonl');
      writeFileSync(path, '{"id": 1}\n{"id": 2}\n');

      const result = monitor.checkHealth(path);

      expect(result.lastMessageTime).toBe(0);
    });
  });

  // =========================================================================
  // Additional: JSONL parsing
  // =========================================================================
  describe('JSONL parsing', () => {
    test('handles real Claude Code transcript format', () => {
      const path = join(TEST_DIR, 'real-format.jsonl');
      const lines = [
        JSON.stringify({
          sessionId: 'abc-123',
          type: 'user',
          message: { content: 'Hello' },
          timestamp: '2026-01-30T10:00:00.000Z'
        }),
        JSON.stringify({
          sessionId: 'abc-123',
          type: 'assistant',
          message: {
            model: 'claude-opus-4-5-20251101',
            content: 'Hi there'
          },
          timestamp: '2026-01-30T10:00:05.000Z'
        })
      ];
      writeFileSync(path, lines.join('\n') + '\n');

      const result = monitor.checkHealth(path);

      expect(result.exists).toBe(true);
      expect(result.messageCount).toBe(2);
      expect(result.lastMessageTime).toBe(new Date('2026-01-30T10:00:05.000Z').getTime());
    });

    test('handles partial/corrupt lines gracefully', () => {
      const path = join(TEST_DIR, 'partial.jsonl');
      const content = [
        '{"id": 1, "timestamp": "2026-01-30T10:00:00.000Z"}',
        'not valid json',
        '{"id": 2, "timestamp": "2026-01-30T10:05:00.000Z"}'
      ].join('\n') + '\n';
      writeFileSync(path, content);

      // Should not throw
      const result = monitor.checkHealth(path);

      expect(result.exists).toBe(true);
      expect(result.messageCount).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // isTranscriptStale helper
  // =========================================================================
  describe('isTranscriptStale', () => {
    test('returns false for fresh transcript', () => {
      const path = join(TEST_DIR, 'fresh-check.jsonl');
      writeFileSync(path, '{"test": true}\n');

      const health = monitor.checkHealth(path);
      const isStale = monitor.isTranscriptStale(health, 5);

      expect(isStale).toBe(false);
    });

    test('returns true for stale transcript', () => {
      const path = join(TEST_DIR, 'stale-check.jsonl');
      writeFileSync(path, '{"test": true}\n');

      const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000);
      utimesSync(path, sixMinAgo, sixMinAgo);

      const health = monitor.checkHealth(path);
      const isStale = monitor.isTranscriptStale(health, 5);

      expect(isStale).toBe(true);
    });

    test('returns true for non-existent transcript', () => {
      const health = monitor.checkHealth('/does/not/exist');
      const isStale = monitor.isTranscriptStale(health, 5);

      expect(isStale).toBe(true);
    });
  });
});
