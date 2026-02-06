/**
 * Tests for SessionLockManager - Session identity persistence
 *
 * Verifies:
 * - Lock file creation (first invocation)
 * - Immutable field preservation across updates
 * - Mutable field updates
 * - Atomic writes (temp + rename)
 * - Missing file handling
 * - Corrupted JSON handling
 * - Permission safety (0600)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { SessionLockManager } from '../src/lib/session-lock-manager';

const TEST_DIR = join(tmpdir(), `session-lock-test-${Date.now()}`);
const LOCK_DIR = join(TEST_DIR, 'session-health');

describe('SessionLockManager', () => {
  beforeEach(() => {
    mkdirSync(LOCK_DIR, { recursive: true });
    // Override LOCK_DIR for testing
    (SessionLockManager as any).LOCK_DIR = LOCK_DIR;
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('create', () => {
    test('creates lock file with all required fields', () => {
      const lock = SessionLockManager.create(
        'test-session-1',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials-abc123',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      expect(lock.sessionId).toBe('test-session-1');
      expect(lock.slotId).toBe('slot-1');
      expect(lock.configDir).toBe('/home/user/.claude');
      expect(lock.keychainService).toBe('Claude Code-credentials-abc123');
      expect(lock.email).toBe('user@example.com');
      expect(lock.transcriptPath).toBe('/home/user/.claude/projects/-test/session.jsonl');
      expect(lock.lockFileVersion).toBe(1);
      expect(lock.launchedAt).toBeGreaterThan(0);
      expect(lock.updatedAt).toBeGreaterThan(0);
      expect(lock.claudeVersion).toBeTruthy(); // May be "unknown" in test env
    });

    test('creates lock file with tmux context', () => {
      const lock = SessionLockManager.create(
        'test-session-2',
        'slot-2',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl',
        { session: 'main', window: '1', pane: '0' }
      );

      expect(lock.tmux).toBeDefined();
      expect(lock.tmux?.session).toBe('main');
      expect(lock.tmux?.window).toBe('1');
      expect(lock.tmux?.pane).toBe('0');
    });

    test('creates lock file without tmux context', () => {
      const lock = SessionLockManager.create(
        'test-session-3',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      expect(lock.tmux).toBeUndefined();
    });

    test('writes lock file to disk', () => {
      SessionLockManager.create(
        'test-session-4',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const lockPath = join(LOCK_DIR, 'test-session-4.lock');
      expect(existsSync(lockPath)).toBe(true);
    });

    test('lock file has correct permissions (0600)', () => {
      SessionLockManager.create(
        'test-session-5',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const lockPath = join(LOCK_DIR, 'test-session-5.lock');
      const stats = statSync(lockPath);
      const mode = stats.mode & 0o777;

      // On macOS/Linux, should be 0600 (owner read/write only)
      expect(mode).toBe(0o600);
    });

    test('creates lock directory if missing', () => {
      rmSync(LOCK_DIR, { recursive: true, force: true });
      expect(existsSync(LOCK_DIR)).toBe(false);

      SessionLockManager.create(
        'test-session-6',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      expect(existsSync(LOCK_DIR)).toBe(true);
    });
  });

  describe('read', () => {
    test('reads existing lock file', () => {
      SessionLockManager.create(
        'test-session-7',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const lock = SessionLockManager.read('test-session-7');
      expect(lock).not.toBeNull();
      expect(lock!.sessionId).toBe('test-session-7');
      expect(lock!.slotId).toBe('slot-1');
    });

    test('returns null for missing lock file', () => {
      const lock = SessionLockManager.read('nonexistent-session');
      expect(lock).toBeNull();
    });

    test('returns null for corrupted JSON', () => {
      const lockPath = join(LOCK_DIR, 'corrupted-session.lock');
      writeFileSync(lockPath, 'NOT VALID JSON {{{', 'utf-8');

      const lock = SessionLockManager.read('corrupted-session');
      expect(lock).toBeNull();
    });

    test('returns null for invalid schema (missing sessionId)', () => {
      const lockPath = join(LOCK_DIR, 'invalid-session.lock');
      writeFileSync(lockPath, JSON.stringify({ slotId: 'slot-1' }), 'utf-8');

      const lock = SessionLockManager.read('invalid-session');
      expect(lock).toBeNull();
    });

    test('returns null for invalid schema (missing slotId)', () => {
      const lockPath = join(LOCK_DIR, 'invalid2-session.lock');
      writeFileSync(lockPath, JSON.stringify({ sessionId: 'invalid2-session' }), 'utf-8');

      const lock = SessionLockManager.read('invalid2-session');
      expect(lock).toBeNull();
    });
  });

  describe('exists', () => {
    test('returns true for existing lock', () => {
      SessionLockManager.create(
        'test-session-8',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      expect(SessionLockManager.exists('test-session-8')).toBe(true);
    });

    test('returns false for missing lock', () => {
      expect(SessionLockManager.exists('nonexistent-session')).toBe(false);
    });
  });

  describe('update', () => {
    test('updates mutable fields', () => {
      SessionLockManager.create(
        'test-session-9',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const before = SessionLockManager.read('test-session-9')!;
      const beforeUpdatedAt = before.updatedAt;

      // Wait 1ms to ensure updatedAt changes
      const start = Date.now();
      while (Date.now() - start < 2) { /* wait */ }

      const success = SessionLockManager.update('test-session-9', {
        claudeVersion: '2.1.32',
        lastVersionCheck: Date.now()
      });

      expect(success).toBe(true);

      const after = SessionLockManager.read('test-session-9')!;
      expect(after.claudeVersion).toBe('2.1.32');
      expect(after.lastVersionCheck).toBeDefined();
      expect(after.updatedAt).toBeGreaterThan(beforeUpdatedAt);
    });

    test('preserves immutable fields', () => {
      SessionLockManager.create(
        'test-session-10',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const before = SessionLockManager.read('test-session-10')!;

      SessionLockManager.update('test-session-10', {
        claudeVersion: '2.1.32'
      });

      const after = SessionLockManager.read('test-session-10')!;
      expect(after.sessionId).toBe(before.sessionId);
      expect(after.slotId).toBe(before.slotId);
      expect(after.configDir).toBe(before.configDir);
      expect(after.keychainService).toBe(before.keychainService);
      expect(after.email).toBe(before.email);
      expect(after.transcriptPath).toBe(before.transcriptPath);
      expect(after.launchedAt).toBe(before.launchedAt);
    });

    test('returns false for nonexistent session', () => {
      const success = SessionLockManager.update('nonexistent-session', {
        claudeVersion: '2.1.32'
      });

      expect(success).toBe(false);
    });
  });

  describe('getOrCreate', () => {
    test('returns existing lock if present', () => {
      const created = SessionLockManager.create(
        'test-session-11',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const retrieved = SessionLockManager.getOrCreate(
        'test-session-11',
        'slot-2', // Different slot — should be ignored
        '/different/path',
        'Different-service',
        'different@example.com',
        '/different/transcript.jsonl'
      );

      // Should return original, not create new
      expect(retrieved.slotId).toBe('slot-1');
      expect(retrieved.configDir).toBe('/home/user/.claude');
      expect(retrieved.launchedAt).toBe(created.launchedAt);
    });

    test('creates new lock if missing', () => {
      const lock = SessionLockManager.getOrCreate(
        'test-session-12',
        'slot-2',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      expect(lock.sessionId).toBe('test-session-12');
      expect(lock.slotId).toBe('slot-2');
      expect(SessionLockManager.exists('test-session-12')).toBe(true);
    });
  });

  describe('delete', () => {
    test('deletes existing lock file', () => {
      SessionLockManager.create(
        'test-session-13',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      expect(SessionLockManager.exists('test-session-13')).toBe(true);

      const success = SessionLockManager.delete('test-session-13');
      expect(success).toBe(true);
      expect(SessionLockManager.exists('test-session-13')).toBe(false);
    });

    test('returns false for already missing lock', () => {
      const success = SessionLockManager.delete('nonexistent-session');
      expect(success).toBe(false);
    });
  });

  describe('getSlotId', () => {
    test('returns slot ID from lock', () => {
      SessionLockManager.create(
        'test-session-14',
        'slot-3',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const slotId = SessionLockManager.getSlotId('test-session-14');
      expect(slotId).toBe('slot-3');
    });

    test('returns null for missing lock', () => {
      const slotId = SessionLockManager.getSlotId('nonexistent-session');
      expect(slotId).toBeNull();
    });
  });

  describe('getConfigDir', () => {
    test('returns config dir from lock', () => {
      SessionLockManager.create(
        'test-session-15',
        'slot-1',
        '/custom/config/path',
        'Claude Code-credentials',
        'user@example.com',
        '/custom/config/path/projects/-test/session.jsonl'
      );

      const configDir = SessionLockManager.getConfigDir('test-session-15');
      expect(configDir).toBe('/custom/config/path');
    });

    test('returns null for missing lock', () => {
      const configDir = SessionLockManager.getConfigDir('nonexistent-session');
      expect(configDir).toBeNull();
    });
  });

  describe('isStale', () => {
    test('returns false for recently updated lock', () => {
      SessionLockManager.create(
        'test-session-16',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const isStale = SessionLockManager.isStale('test-session-16', 1000); // 1s threshold
      expect(isStale).toBe(false);
    });

    test('returns true for old lock file', () => {
      // Create lock with old updatedAt
      const lock = SessionLockManager.create(
        'test-session-17',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      // Manually write with old timestamp
      const lockPath = join(LOCK_DIR, 'test-session-17.lock');
      const oldLock = {
        ...lock,
        updatedAt: Date.now() - 2000 // 2s ago
      };
      writeFileSync(lockPath, JSON.stringify(oldLock), 'utf-8');

      const isStale = SessionLockManager.isStale('test-session-17', 1000); // 1s threshold
      expect(isStale).toBe(true);
    });

    test('returns false for missing lock', () => {
      const isStale = SessionLockManager.isStale('nonexistent-session');
      expect(isStale).toBe(false); // Missing is not "stale", just absent
    });
  });

  describe('security: sessionId validation', () => {
    test('rejects path traversal in sessionId', () => {
      expect(() => SessionLockManager.read('../../../etc/passwd')).not.toThrow();
      const result = SessionLockManager.read('../../../etc/passwd');
      expect(result).toBeNull();
    });

    test('rejects sessionId with slashes', () => {
      const result = SessionLockManager.read('malicious/../../config');
      expect(result).toBeNull();
    });

    test('rejects sessionId with dots', () => {
      const result = SessionLockManager.read('..');
      expect(result).toBeNull();
    });

    test('accepts valid sessionId with alphanumeric + hyphens + underscores', () => {
      SessionLockManager.create(
        'valid-session_123',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );
      const lock = SessionLockManager.read('valid-session_123');
      expect(lock).not.toBeNull();
      expect(lock!.sessionId).toBe('valid-session_123');
    });
  });

  describe('edge cases', () => {
    test('corrupted JSON returns null', () => {
      const lockPath = join(LOCK_DIR, 'corrupted-test.lock');
      writeFileSync(lockPath, 'NOT VALID JSON {{{', 'utf-8');
      const result = SessionLockManager.read('corrupted-test');
      expect(result).toBeNull();
    });

    test('empty file returns null', () => {
      const lockPath = join(LOCK_DIR, 'empty-test.lock');
      writeFileSync(lockPath, '', 'utf-8');
      const result = SessionLockManager.read('empty-test');
      expect(result).toBeNull();
    });

    test('missing required fields returns null', () => {
      const lockPath = join(LOCK_DIR, 'partial-test.lock');
      writeFileSync(lockPath, JSON.stringify({ foo: 'bar' }), 'utf-8');
      const result = SessionLockManager.read('partial-test');
      expect(result).toBeNull();
    });

    test('isStale with updatedAt=0 returns true', () => {
      const lock = SessionLockManager.create(
        'stale-zero-test',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      // Manually set updatedAt to 0
      const lockPath = join(LOCK_DIR, 'stale-zero-test.lock');
      const modified = { ...lock, updatedAt: 0 };
      writeFileSync(lockPath, JSON.stringify(modified), 'utf-8');

      const isStale = SessionLockManager.isStale('stale-zero-test', 1000);
      expect(isStale).toBe(true); // 0 is very old
    });
  });

  describe('atomic writes', () => {
    test('uses temp file + rename pattern', () => {
      // We can't easily verify atomic writes without complex process coordination
      // But we can verify the result is correct and no temp files remain
      SessionLockManager.create(
        'test-session-18',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const lockPath = join(LOCK_DIR, 'test-session-18.lock');
      expect(existsSync(lockPath)).toBe(true);

      // Verify no temp files left behind
      const files = require('fs').readdirSync(LOCK_DIR);
      const tempFiles = files.filter((f: string) => f.includes('.tmp'));
      expect(tempFiles.length).toBe(0);
    });
  });
});
