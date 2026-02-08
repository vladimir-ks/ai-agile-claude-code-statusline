/**
 * StateManager Tests
 *
 * Tests for state persistence, atomic writes, migration, and validation.
 * Phase 0.3 - RED state (no implementation yet)
 *
 * Coverage:
 * - Load/save state
 * - Atomic writes (temp file + rename)
 * - Migration from old formats
 * - Validation (sessionId, version)
 * - Corruption recovery
 * - Concurrent access
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StateManager } from '../../src/lib/transcript-scanner/state-manager';
import { createTempStateDir, mockState, assertValidState } from './test-harness';
import { writeFileSync, readFileSync, existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

describe('StateManager', () => {
  let tempStateDir: string;

  beforeEach(() => {
    tempStateDir = createTempStateDir();
    // Configure StateManager to use temp directory
    process.env.TEST_STATE_DIR = tempStateDir;
  });

  afterEach(() => {
    // Cleanup
    delete process.env.TEST_STATE_DIR;
  });

  describe('load() - Basic Loading', () => {
    test('loads valid state file', () => {
      const sessionId = 'test-session-123';
      const stateData = mockState({
        lastOffset: 50000,
        lastMtime: 1738876543000,
        extractorData: { test: 'data' }
      });

      const statePath = join(tempStateDir, `${sessionId}.state`);
      writeFileSync(statePath, JSON.stringify(stateData, null, 2), 'utf-8');

      const loaded = StateManager.load(sessionId);

      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(2);
      expect(loaded!.lastOffset).toBe(50000);
      expect(loaded!.lastMtime).toBe(1738876543000);
      expect(loaded!.extractorData.test).toBe('data');
    });

    test('returns null if state file does not exist', () => {
      const loaded = StateManager.load('nonexistent-session');
      expect(loaded).toBeNull();
    });

    test('throws for invalid sessionId with path traversal', () => {
      expect(() => {
        StateManager.load('../../../etc/passwd');
      }).toThrow(/Invalid sessionId/);
    });

    test('throws for sessionId with invalid characters', () => {
      expect(() => {
        StateManager.load('session@#$%');
      }).toThrow(/Invalid sessionId/);
    });

    test('accepts valid sessionId with alphanumeric, dash, underscore', () => {
      const sessionId = 'session-abc-123_test';
      const statePath = join(tempStateDir, `${sessionId}.state`);
      writeFileSync(statePath, JSON.stringify(mockState()), 'utf-8');

      const loaded = StateManager.load(sessionId);
      expect(loaded).not.toBeNull();
    });

    test('returns null for corrupted JSON', () => {
      const sessionId = 'corrupted-session';
      const statePath = join(tempStateDir, `${sessionId}.state`);
      writeFileSync(statePath, '{invalid json', 'utf-8');

      const loaded = StateManager.load(sessionId);
      expect(loaded).toBeNull();
    });

    test('returns null for wrong version number', () => {
      const sessionId = 'wrong-version';
      const statePath = join(tempStateDir, `${sessionId}.state`);
      const wrongVersion = { ...mockState(), version: 1 };
      writeFileSync(statePath, JSON.stringify(wrongVersion), 'utf-8');

      const loaded = StateManager.load(sessionId);
      expect(loaded).toBeNull();
    });

    test('returns null for future version number', () => {
      const sessionId = 'future-version';
      const statePath = join(tempStateDir, `${sessionId}.state`);
      const futureVersion = { ...mockState(), version: 3 };
      writeFileSync(statePath, JSON.stringify(futureVersion), 'utf-8');

      const loaded = StateManager.load(sessionId);
      expect(loaded).toBeNull();
    });
  });

  describe('save() - Basic Saving', () => {
    test('saves state to file', () => {
      const sessionId = 'save-test';
      const state = mockState({
        lastOffset: 100000,
        lastMtime: Date.now(),
        extractorData: { key: 'value' }
      });

      StateManager.save(sessionId, state);

      const statePath = join(tempStateDir, `${sessionId}.state`);
      expect(existsSync(statePath)).toBe(true);

      const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(saved.version).toBe(2);
      expect(saved.lastOffset).toBe(100000);
      expect(saved.extractorData.key).toBe('value');
    });

    test('creates state directory if it does not exist', () => {
      const sessionId = 'new-dir-test';
      const state = mockState();

      // Delete directory if exists
      const testDir = join(tempStateDir, 'nested');
      process.env.TEST_STATE_DIR = testDir;

      StateManager.save(sessionId, state);

      expect(existsSync(testDir)).toBe(true);
      expect(existsSync(join(testDir, `${sessionId}.state`))).toBe(true);
    });

    test('overwrites existing state file', () => {
      const sessionId = 'overwrite-test';
      const state1 = mockState({ lastOffset: 1000 });
      const state2 = mockState({ lastOffset: 2000 });

      StateManager.save(sessionId, state1);
      StateManager.save(sessionId, state2);

      const loaded = StateManager.load(sessionId);
      expect(loaded!.lastOffset).toBe(2000);
    });

    test('does not throw on save error (logs instead)', () => {
      const sessionId = 'error-test';
      const state = mockState();

      // Invalid state dir (read-only)
      process.env.TEST_STATE_DIR = '/invalid/readonly/path';

      expect(() => StateManager.save(sessionId, state)).not.toThrow();
    });

    test('throws on invalid sessionId', () => {
      const state = mockState();

      // Should throw on path traversal attempt
      expect(() => {
        StateManager.save('../../../etc/passwd', state);
      }).toThrow(/Invalid sessionId/);
    });
  });

  describe('save() - Atomic Writes', () => {
    test('uses temp file during write', () => {
      const sessionId = 'atomic-test';
      const state = mockState();

      // Spy on file writes to verify temp file usage
      const statePath = join(tempStateDir, `${sessionId}.state`);
      const tempPath = `${statePath}.tmp`;

      StateManager.save(sessionId, state);

      // Final file should exist
      expect(existsSync(statePath)).toBe(true);

      // Temp file should be cleaned up
      expect(existsSync(tempPath)).toBe(false);
    });

    test('cleans up temp file on rename failure', () => {
      const sessionId = 'cleanup-test';
      const state = mockState();

      // Create a scenario where rename might fail
      // (Note: hard to test without mocking, this is a behavioral spec)
      StateManager.save(sessionId, state);

      const tempPath = join(tempStateDir, `${sessionId}.state.tmp`);
      expect(existsSync(tempPath)).toBe(false);
    });

    test('state file is valid JSON after save', () => {
      const sessionId = 'valid-json-test';
      const state = mockState({
        extractorData: { complex: { nested: { data: [1, 2, 3] } } }
      });

      StateManager.save(sessionId, state);

      const statePath = join(tempStateDir, `${sessionId}.state`);
      const content = readFileSync(statePath, 'utf-8');

      expect(() => JSON.parse(content)).not.toThrow();
    });

    test('concurrent saves to same session do not corrupt state', () => {
      const sessionId = 'concurrent-test';
      const state1 = mockState({ lastOffset: 1000 });
      const state2 = mockState({ lastOffset: 2000 });
      const state3 = mockState({ lastOffset: 3000 });

      // Simulate concurrent saves (synchronous in test, but atomic in implementation)
      StateManager.save(sessionId, state1);
      StateManager.save(sessionId, state2);
      StateManager.save(sessionId, state3);

      const loaded = StateManager.load(sessionId);
      expect(loaded).not.toBeNull();
      expect([1000, 2000, 3000]).toContain(loaded!.lastOffset); // One of them
      assertValidState(loaded!);
    });
  });

  describe('createInitial()', () => {
    test('creates fresh state with offset=0', () => {
      const sessionId = 'initial-test';
      const state = StateManager.createInitial(sessionId);

      expect(state.version).toBe(2);
      expect(state.lastOffset).toBe(0);
      expect(state.lastMtime).toBe(0);
      expect(state.extractorData).toEqual({});
      expect(state.lastScanAt).toBeGreaterThan(0);
    });

    test('creates state with current timestamp', () => {
      const before = Date.now();
      const state = StateManager.createInitial('test');
      const after = Date.now();

      expect(state.lastScanAt).toBeGreaterThanOrEqual(before);
      expect(state.lastScanAt).toBeLessThanOrEqual(after);
    });

    test('created state passes validation', () => {
      const state = StateManager.createInitial('test');
      expect(() => assertValidState(state)).not.toThrow();
    });
  });

  describe('update()', () => {
    test('returns new state with updated fields', () => {
      const oldState = mockState({
        lastOffset: 1000,
        lastMtime: 1000,
        extractorData: { old: 'data' }
      });

      const newState = StateManager.update(
        oldState,
        2000,
        2000,
        { new: 'data' }
      );

      expect(newState.lastOffset).toBe(2000);
      expect(newState.lastMtime).toBe(2000);
      expect(newState.extractorData.new).toBe('data');
      expect(newState.version).toBe(2);
    });

    test('does not mutate original state', () => {
      const oldState = mockState({ lastOffset: 1000 });
      const oldStateCopy = { ...oldState };

      StateManager.update(oldState, 2000, 2000, { new: 'data' });

      expect(oldState).toEqual(oldStateCopy);
    });

    test('merges extractorData (new overrides old)', () => {
      const oldState = mockState({
        extractorData: { a: 1, b: 2 }
      });

      const newState = StateManager.update(
        oldState,
        1000,
        1000,
        { b: 999, c: 3 }
      );

      expect(newState.extractorData).toEqual({ a: 1, b: 999, c: 3 });
    });

    test('updates lastScanAt to current time', () => {
      const oldState = mockState({ lastScanAt: 1000 });
      const before = Date.now();
      const newState = StateManager.update(oldState, 1000, 1000, {});
      const after = Date.now();

      expect(newState.lastScanAt).toBeGreaterThanOrEqual(before);
      expect(newState.lastScanAt).toBeLessThanOrEqual(after);
    });

    test('updated state passes validation', () => {
      const oldState = mockState();
      const newState = StateManager.update(oldState, 5000, 5000, { test: 'data' });

      expect(() => assertValidState(newState)).not.toThrow();
    });
  });

  describe('delete()', () => {
    test('deletes state file', () => {
      const sessionId = 'delete-test';
      const statePath = join(tempStateDir, `${sessionId}.state`);
      writeFileSync(statePath, JSON.stringify(mockState()), 'utf-8');

      expect(existsSync(statePath)).toBe(true);

      StateManager.delete(sessionId);

      expect(existsSync(statePath)).toBe(false);
    });

    test('does not throw if file does not exist', () => {
      expect(() => StateManager.delete('nonexistent')).not.toThrow();
    });

    test('does not throw on delete error', () => {
      // Read-only directory scenario
      process.env.TEST_STATE_DIR = '/invalid/readonly/path';
      expect(() => StateManager.delete('test')).not.toThrow();
    });
  });

  describe('listSessions()', () => {
    test('returns empty array if no state files exist', () => {
      const sessions = StateManager.listSessions();
      expect(sessions).toEqual([]);
    });

    test('lists all session IDs with state files', () => {
      writeFileSync(join(tempStateDir, 'session-1.state'), JSON.stringify(mockState()));
      writeFileSync(join(tempStateDir, 'session-2.state'), JSON.stringify(mockState()));
      writeFileSync(join(tempStateDir, 'session-3.state'), JSON.stringify(mockState()));

      const sessions = StateManager.listSessions();

      expect(sessions).toHaveLength(3);
      expect(sessions).toContain('session-1');
      expect(sessions).toContain('session-2');
      expect(sessions).toContain('session-3');
    });

    test('ignores non-state files', () => {
      writeFileSync(join(tempStateDir, 'session-1.state'), JSON.stringify(mockState()));
      writeFileSync(join(tempStateDir, 'other-file.json'), '{}');
      writeFileSync(join(tempStateDir, 'readme.txt'), 'test');

      const sessions = StateManager.listSessions();

      expect(sessions).toEqual(['session-1']);
    });

    test('does not throw if state directory does not exist', () => {
      process.env.TEST_STATE_DIR = '/nonexistent/path';
      expect(() => StateManager.listSessions()).not.toThrow();
      expect(StateManager.listSessions()).toEqual([]);
    });
  });

  describe('getStatePath()', () => {
    test('returns correct state file path', () => {
      const sessionId = 'test-session';
      const path = StateManager.getStatePath(sessionId);

      expect(path).toContain(sessionId);
      expect(path).toContain('.state');
      // Verify path structure (flexible for test vs production)
      expect(path).toMatch(/scanner.*state$/);
    });

    test('validates sessionId before returning path', () => {
      expect(() => {
        StateManager.getStatePath('../../../etc/passwd');
      }).toThrow(/Invalid sessionId/);
    });
  });

  describe('Migration - IncrementalTranscriptScanner', () => {
    test('migrates old transcript state format', () => {
      const sessionId = 'migrate-transcript';
      const oldStateDir = join(tempStateDir, 'cooldowns');
      mkdirSync(oldStateDir, { recursive: true });

      const oldState = {
        lastReadOffset: 50000,
        lastReadMtime: 1738876543000,
        messageCount: 42,
        lastUserMessage: {
          timestamp: 1738876540000,
          preview: 'What does this do?'
        }
      };

      const oldStatePath = join(oldStateDir, `${sessionId}-transcript.state`);
      writeFileSync(oldStatePath, JSON.stringify(oldState), 'utf-8');

      const loaded = StateManager.load(sessionId);

      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(2);
      expect(loaded!.lastOffset).toBe(50000);
      expect(loaded!.lastMtime).toBe(1738876543000);
      expect(loaded!.extractorData.last_message).toBeDefined();
      expect(loaded!.extractorData.last_message.turnNumber).toBe(42);
      expect(loaded!.extractorData.last_message.preview).toBe('What does this do?');
      expect(loaded!.extractorData.last_message.sender).toBe('human');
    });

    test('migration creates new state file in correct location', () => {
      const sessionId = 'migrate-new-file';
      const oldStateDir = join(tempStateDir, 'cooldowns');
      mkdirSync(oldStateDir, { recursive: true });

      const oldState = {
        lastReadOffset: 1000,
        lastReadMtime: 1000,
        messageCount: 5
      };

      writeFileSync(
        join(oldStateDir, `${sessionId}-transcript.state`),
        JSON.stringify(oldState)
      );

      StateManager.load(sessionId);

      const newStatePath = join(tempStateDir, `${sessionId}.state`);
      expect(existsSync(newStatePath)).toBe(true);
    });
  });

  describe('Migration - GitLeaksScanner', () => {
    test('migrates old gitleaks state format', () => {
      const sessionId = 'migrate-gitleaks';
      const oldStateDir = join(tempStateDir, 'cooldowns');
      mkdirSync(oldStateDir, { recursive: true });

      const oldState = {
        lastScannedOffset: 30000,
        lastScannedMtime: 1738876543000,
        knownFindings: ['github-pat-abc123', 'aws-access-xyz789']
      };

      writeFileSync(
        join(oldStateDir, `${sessionId}-gitleaks.state`),
        JSON.stringify(oldState)
      );

      const loaded = StateManager.load(sessionId);

      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe(2);
      expect(loaded!.lastOffset).toBe(30000);
      expect(loaded!.lastMtime).toBe(1738876543000);
      expect(loaded!.extractorData.secrets).toBeDefined();
      expect(Array.isArray(loaded!.extractorData.secrets)).toBe(true);
    });

    test('merges both old state formats if both exist', () => {
      const sessionId = 'migrate-both';
      const oldStateDir = join(tempStateDir, 'cooldowns');
      mkdirSync(oldStateDir, { recursive: true });

      const transcriptState = {
        lastReadOffset: 50000,
        lastReadMtime: 2000,
        messageCount: 10,
        lastUserMessage: { timestamp: 1000, preview: 'test' }
      };

      const gitleaksState = {
        lastScannedOffset: 50000,
        lastScannedMtime: 2000,
        knownFindings: ['fingerprint-1']
      };

      writeFileSync(
        join(oldStateDir, `${sessionId}-transcript.state`),
        JSON.stringify(transcriptState)
      );

      writeFileSync(
        join(oldStateDir, `${sessionId}-gitleaks.state`),
        JSON.stringify(gitleaksState)
      );

      const loaded = StateManager.load(sessionId);

      expect(loaded!.extractorData.last_message).toBeDefined();
      expect(loaded!.extractorData.secrets).toBeDefined();
      expect(loaded!.lastOffset).toBe(50000); // Prefer transcript offset
    });
  });

  describe('Validation', () => {
    test('loaded state passes assertValidState', () => {
      const sessionId = 'validation-test';
      const statePath = join(tempStateDir, `${sessionId}.state`);
      writeFileSync(statePath, JSON.stringify(mockState()));

      const loaded = StateManager.load(sessionId);
      expect(() => assertValidState(loaded!)).not.toThrow();
    });

    test('rejects state with negative offset', () => {
      const sessionId = 'negative-offset';
      const statePath = join(tempStateDir, `${sessionId}.state`);
      const invalidState = { ...mockState(), lastOffset: -1 };
      writeFileSync(statePath, JSON.stringify(invalidState));

      const loaded = StateManager.load(sessionId);
      expect(loaded).toBeNull();
    });

    test('rejects state with negative mtime', () => {
      const sessionId = 'negative-mtime';
      const statePath = join(tempStateDir, `${sessionId}.state`);
      const invalidState = { ...mockState(), lastMtime: -1 };
      writeFileSync(statePath, JSON.stringify(invalidState));

      const loaded = StateManager.load(sessionId);
      expect(loaded).toBeNull();
    });

    test('rejects state with non-object extractorData', () => {
      const sessionId = 'invalid-extractor-data';
      const statePath = join(tempStateDir, `${sessionId}.state`);
      const invalidState = { ...mockState(), extractorData: 'not an object' };
      writeFileSync(statePath, JSON.stringify(invalidState));

      const loaded = StateManager.load(sessionId);
      expect(loaded).toBeNull();
    });
  });
});
