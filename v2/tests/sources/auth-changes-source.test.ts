/**
 * Auth Changes Source Tests
 *
 * Tests integration of auth change detection with session locking.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { authChangesSource } from '../../src/lib/sources/auth-changes-source';
import { SessionLockManager } from '../../src/lib/session-lock-manager';
import type { GatherContext } from '../../src/lib/sources/types';
import type { SessionLock } from '../../src/types/session-health';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('AuthChangesSource', () => {
  let tempFiles: string[] = [];
  let tempStateDir: string;
  let lockDir: string;

  beforeEach(() => {
    // Create temp state directory
    tempStateDir = join(homedir(), '.claude/session-health/scanners-auth-test');
    lockDir = join(homedir(), '.claude/session-health');

    if (!existsSync(tempStateDir)) {
      mkdirSync(tempStateDir, { recursive: true });
    }
    if (!existsSync(lockDir)) {
      mkdirSync(lockDir, { recursive: true });
    }

    process.env.TEST_STATE_DIR = tempStateDir;

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
      const { readdirSync } = require('fs');
      const files = readdirSync(tempStateDir);
      for (const file of files) {
        try {
          unlinkSync(join(tempStateDir, file));
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    delete process.env.TEST_STATE_DIR;
  });

  function createTempTranscript(content: string, sessionId: string): string {
    const path = join(tempStateDir, `${sessionId}.jsonl`);
    writeFileSync(path, content, 'utf-8');
    tempFiles.push(path);
    return path;
  }

  function createSessionLock(sessionId: string, email: string): SessionLock {
    const lock: SessionLock = {
      sessionId,
      slotId: 'test-slot',
      configDir: '/test/config',
      keychainService: 'test-keychain',
      email,
      transcriptPath: '/test/transcript.jsonl',
      launchedAt: Date.now(),
      claudeVersion: '1.0.0',
      updatedAt: Date.now(),
    };
    SessionLockManager.write(lock);
    tempFiles.push(SessionLockManager['getLockPath'](sessionId));
    return lock;
  }

  test('fetch() detects no auth changes in empty transcript', async () => {
    const transcript = '';
    const sessionId = 'test-auth-1';
    const path = createTempTranscript(transcript, sessionId);

    const ctx: GatherContext = {
      sessionId,
      transcriptPath: path,
      jsonInput: null,
      configDir: null,
      keychainService: null,
      deadline: Date.now() + 10000,
    };

    const result = await authChangesSource.fetch(ctx);

    expect(result.hasAuthChanges).toBe(false);
    expect(result.latestEmail).toBe(null);
    expect(result.changeCount).toBe(0);
    expect(result.sessionEmailUpdated).toBe(false);
  });

  test('fetch() detects auth change from /login', async () => {
    const transcript = [
      '{"type":"user","message":{"content":[{"type":"text","text":"/login"}]}}',
      '{"type":"assistant","timestamp":"2026-02-08T10:00:00Z","message":{"content":[{"type":"text","text":"Login successful for newuser@example.com"}]}}'
    ].join('\n');

    const sessionId = 'test-auth-2';
    const path = createTempTranscript(transcript, sessionId);

    const ctx: GatherContext = {
      sessionId,
      transcriptPath: path,
      jsonInput: null,
      configDir: null,
      keychainService: null,
      deadline: Date.now() + 10000,
    };

    const result = await authChangesSource.fetch(ctx);

    expect(result.hasAuthChanges).toBe(true);
    expect(result.latestEmail).toBe('newuser@example.com');
    expect(result.changeCount).toBe(1);
  });

  test('fetch() updates session lock when email changes', async () => {
    const transcript = [
      '{"type":"user","message":{"content":[{"type":"text","text":"/swap-auth"}]}}',
      '{"type":"assistant","timestamp":"2026-02-08T10:00:00Z","message":{"content":[{"type":"text","text":"Switched to account newuser@example.com"}]}}'
    ].join('\n');

    const sessionId = 'test-auth-3';
    const path = createTempTranscript(transcript, sessionId);

    // Create initial lock with different email
    createSessionLock(sessionId, 'olduser@example.com');

    const ctx: GatherContext = {
      sessionId,
      transcriptPath: path,
      jsonInput: null,
      configDir: null,
      keychainService: null,
      deadline: Date.now() + 10000,
    };

    const result = await authChangesSource.fetch(ctx);

    expect(result.hasAuthChanges).toBe(true);
    expect(result.latestEmail).toBe('newuser@example.com');
    expect(result.sessionEmailUpdated).toBe(true);

    // Verify session lock was updated
    const updatedLock = SessionLockManager.read(sessionId);
    expect(updatedLock).not.toBe(null);
    expect(updatedLock!.email).toBe('newuser@example.com');
  });

  test('fetch() does not update session lock if email unchanged', async () => {
    const transcript = [
      '{"type":"user","message":{"content":[{"type":"text","text":"/login"}]}}',
      '{"type":"assistant","timestamp":"2026-02-08T10:00:00Z","message":{"content":[{"type":"text","text":"Login successful for sameuser@example.com"}]}}'
    ].join('\n');

    const sessionId = 'test-auth-4';
    const path = createTempTranscript(transcript, sessionId);

    // Create initial lock with same email
    const initialLock = createSessionLock(sessionId, 'sameuser@example.com');

    const ctx: GatherContext = {
      sessionId,
      transcriptPath: path,
      jsonInput: null,
      configDir: null,
      keychainService: null,
      deadline: Date.now() + 10000,
    };

    const result = await authChangesSource.fetch(ctx);

    expect(result.hasAuthChanges).toBe(true);
    expect(result.latestEmail).toBe('sameuser@example.com');
    expect(result.sessionEmailUpdated).toBe(false); // No update needed

    // Verify session lock unchanged
    const updatedLock = SessionLockManager.read(sessionId);
    expect(updatedLock!.updatedAt).toBe(initialLock.updatedAt);
  });

  test('fetch() handles multiple auth changes', async () => {
    const transcript = [
      '{"type":"user","message":{"content":[{"type":"text","text":"/login"}]}}',
      '{"type":"assistant","timestamp":"2026-02-08T10:00:00Z","message":{"content":[{"type":"text","text":"Login successful for user1@example.com"}]}}',
      '{"type":"user","message":{"content":[{"type":"text","text":"/swap-auth"}]}}',
      '{"type":"assistant","timestamp":"2026-02-08T10:05:00Z","message":{"content":[{"type":"text","text":"Switched to account user2@example.com"}]}}'
    ].join('\n');

    const sessionId = 'test-auth-5';
    const path = createTempTranscript(transcript, sessionId);

    const ctx: GatherContext = {
      sessionId,
      transcriptPath: path,
      jsonInput: null,
      configDir: null,
      keychainService: null,
      deadline: Date.now() + 10000,
    };

    const result = await authChangesSource.fetch(ctx);

    expect(result.hasAuthChanges).toBe(true);
    expect(result.latestEmail).toBe('user2@example.com'); // Latest auth change
    expect(result.changeCount).toBe(2);
  });

  test('fetch() handles missing transcript path', async () => {
    const ctx: GatherContext = {
      sessionId: 'test-auth-6',
      transcriptPath: null,
      jsonInput: null,
      configDir: null,
      keychainService: null,
      deadline: Date.now() + 10000,
    };

    const result = await authChangesSource.fetch(ctx);

    expect(result.hasAuthChanges).toBe(false);
    expect(result.sessionEmailUpdated).toBe(false);
  });

  test('merge() updates health with auth profile', () => {
    const target: any = {
      sessionId: 'test',
      launch: {
        authProfile: 'default',
      },
    };

    const data = {
      hasAuthChanges: true,
      latestEmail: 'newuser@example.com',
      changeCount: 1,
      lastChangeTimestamp: Date.now(),
      sessionEmailUpdated: false,
    };

    authChangesSource.merge(target, data);

    expect(target.launch.authProfile).toBe('newuser@example.com');
  });
});
