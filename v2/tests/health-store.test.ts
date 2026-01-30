/**
 * Health Store Tests - TDD First
 *
 * Tests for reading/writing session health JSON files
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import HealthStore from '../src/lib/health-store';
import {
  SessionHealth,
  StatuslineConfig,
  createDefaultHealth,
  createDefaultConfig
} from '../src/types/session-health';

// Test directory (isolated from real data)
const TEST_BASE = '/tmp/statusline-test-health-store';

describe('HealthStore', () => {
  let store: HealthStore;

  beforeEach(() => {
    // Clean slate for each test
    if (existsSync(TEST_BASE)) {
      rmSync(TEST_BASE, { recursive: true });
    }
    store = new HealthStore(TEST_BASE);
  });

  afterEach(() => {
    // Cleanup
    if (existsSync(TEST_BASE)) {
      rmSync(TEST_BASE, { recursive: true });
    }
  });

  // =========================================================================
  // UT-1.1: Directory Creation
  // =========================================================================
  describe('ensureDirectory', () => {
    test('creates directory if not exists', () => {
      expect(existsSync(TEST_BASE)).toBe(false);

      store.ensureDirectory();

      expect(existsSync(TEST_BASE)).toBe(true);
    });

    test('does not error if directory already exists', () => {
      mkdirSync(TEST_BASE, { recursive: true });

      expect(() => store.ensureDirectory()).not.toThrow();
    });
  });

  // =========================================================================
  // UT-1.2: Write Session Health
  // =========================================================================
  describe('writeSessionHealth', () => {
    test('writes valid JSON file', () => {
      const health = createDefaultHealth('test-session-123');
      health.projectPath = '/test/project';
      health.model.value = 'Opus4.5';

      store.writeSessionHealth('test-session-123', health);

      const filePath = join(TEST_BASE, 'test-session-123.json');
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(content.sessionId).toBe('test-session-123');
      expect(content.projectPath).toBe('/test/project');
      expect(content.model.value).toBe('Opus4.5');
    });

    test('creates directory if needed', () => {
      const health = createDefaultHealth('new-session');

      store.writeSessionHealth('new-session', health);

      expect(existsSync(TEST_BASE)).toBe(true);
      expect(existsSync(join(TEST_BASE, 'new-session.json'))).toBe(true);
    });

    test('overwrites existing file', () => {
      const health1 = createDefaultHealth('session-1');
      health1.model.value = 'First';
      store.writeSessionHealth('session-1', health1);

      const health2 = createDefaultHealth('session-1');
      health2.model.value = 'Second';
      store.writeSessionHealth('session-1', health2);

      const content = JSON.parse(readFileSync(join(TEST_BASE, 'session-1.json'), 'utf-8'));
      expect(content.model.value).toBe('Second');
    });
  });

  // =========================================================================
  // UT-1.3: Atomic Write Safety (partial test - simulating is complex)
  // =========================================================================
  describe('atomic write', () => {
    test('temp file is cleaned up after successful write', () => {
      const health = createDefaultHealth('atomic-test');

      store.writeSessionHealth('atomic-test', health);

      // Temp file should not exist
      const tempPath = join(TEST_BASE, 'atomic-test.json.tmp');
      expect(existsSync(tempPath)).toBe(false);

      // Real file should exist
      expect(existsSync(join(TEST_BASE, 'atomic-test.json'))).toBe(true);
    });
  });

  // =========================================================================
  // UT-1.4: Read Non-Existent Session
  // =========================================================================
  describe('readSessionHealth', () => {
    test('returns null for non-existent session', () => {
      const result = store.readSessionHealth('does-not-exist');

      expect(result).toBeNull();
    });

    test('reads valid session health', () => {
      const health = createDefaultHealth('readable-session');
      health.model.value = 'TestModel';
      health.transcript.messageCount = 42;
      store.writeSessionHealth('readable-session', health);

      const result = store.readSessionHealth('readable-session');

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('readable-session');
      expect(result!.model.value).toBe('TestModel');
      expect(result!.transcript.messageCount).toBe(42);
    });
  });

  // =========================================================================
  // UT-1.5: Read Corrupt JSON
  // =========================================================================
  describe('corrupt data handling', () => {
    test('returns null for corrupt JSON', () => {
      store.ensureDirectory();
      writeFileSync(join(TEST_BASE, 'corrupt.json'), 'not valid json {{{');

      const result = store.readSessionHealth('corrupt');

      expect(result).toBeNull();
    });

    test('returns null for empty file', () => {
      store.ensureDirectory();
      writeFileSync(join(TEST_BASE, 'empty.json'), '');

      const result = store.readSessionHealth('empty');

      expect(result).toBeNull();
    });
  });

  // =========================================================================
  // UT-1.6: Update Sessions Summary
  // =========================================================================
  describe('updateSessionsSummary', () => {
    test('creates summary with multiple sessions', () => {
      // Create 3 sessions
      for (let i = 1; i <= 3; i++) {
        const health = createDefaultHealth(`session-${i}`);
        health.projectPath = `/project-${i}`;
        health.model.value = `Model${i}`;
        health.health.status = i === 1 ? 'healthy' : 'warning';
        health.transcript.lastModified = Date.now() - (i * 60000); // 1, 2, 3 min ago
        store.writeSessionHealth(`session-${i}`, health);
      }

      store.updateSessionsSummary();

      const summaryPath = join(TEST_BASE, 'sessions.json');
      expect(existsSync(summaryPath)).toBe(true);

      const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
      expect(summary.totalSessions).toBe(3);
      expect(summary.sessions.length).toBe(3);
    });

    test('excludes config and sessions.json from session list', () => {
      // Create session + config
      const health = createDefaultHealth('real-session');
      store.writeSessionHealth('real-session', health);
      store.writeConfig(createDefaultConfig());

      store.updateSessionsSummary();

      const summary = JSON.parse(readFileSync(join(TEST_BASE, 'sessions.json'), 'utf-8'));
      expect(summary.totalSessions).toBe(1);
      expect(summary.sessions[0].sessionId).toBe('real-session');
    });
  });

  // =========================================================================
  // UT-1.7: Default Config
  // =========================================================================
  describe('readConfig', () => {
    test('returns default config when no file exists', () => {
      const config = store.readConfig();

      expect(config).not.toBeNull();
      expect(config.components.directory).toBe(true);
      expect(config.components.git).toBe(true);
      expect(config.components.transcriptSync).toBe(true);
      expect(config.thresholds.transcriptStaleMinutes).toBe(5);
    });

    test('reads existing config', () => {
      const customConfig = createDefaultConfig();
      customConfig.components.git = false;
      customConfig.thresholds.transcriptStaleMinutes = 10;
      store.writeConfig(customConfig);

      const result = store.readConfig();

      expect(result.components.git).toBe(false);
      expect(result.thresholds.transcriptStaleMinutes).toBe(10);
    });
  });

  // =========================================================================
  // UT-1.8: Config Persistence
  // =========================================================================
  describe('writeConfig', () => {
    test('persists config correctly', () => {
      const config = createDefaultConfig();
      config.components.model = false;
      config.display.useColor = true;

      store.writeConfig(config);

      const filePath = join(TEST_BASE, 'config.json');
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(content.components.model).toBe(false);
      expect(content.display.useColor).toBe(true);
    });

    test('config survives read/write cycle', () => {
      const original = createDefaultConfig();
      original.components.budget = false;
      original.thresholds.contextWarningPercent = 80;

      store.writeConfig(original);
      const loaded = store.readConfig();

      expect(loaded.components.budget).toBe(false);
      expect(loaded.thresholds.contextWarningPercent).toBe(80);
    });
  });

  // =========================================================================
  // Additional: Session listing
  // =========================================================================
  describe('listSessionIds', () => {
    test('lists all session IDs', () => {
      store.writeSessionHealth('aaa-111', createDefaultHealth('aaa-111'));
      store.writeSessionHealth('bbb-222', createDefaultHealth('bbb-222'));
      store.writeSessionHealth('ccc-333', createDefaultHealth('ccc-333'));

      const ids = store.listSessionIds();

      expect(ids.length).toBe(3);
      expect(ids).toContain('aaa-111');
      expect(ids).toContain('bbb-222');
      expect(ids).toContain('ccc-333');
    });

    test('returns empty array when no sessions', () => {
      store.ensureDirectory();

      const ids = store.listSessionIds();

      expect(ids).toEqual([]);
    });
  });
});
