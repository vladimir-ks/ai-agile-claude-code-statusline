/**
 * Tests for KeychainResolver
 *
 * Validates the pure-logic functions that derive CLAUDE_CONFIG_DIR
 * and keychain service names from transcript paths.
 *
 * NOTE: readKeychainEntry() tests require macOS keychain access
 * and will skip gracefully on systems without it.
 */

import { describe, test, expect } from 'bun:test';
import { createHash } from 'crypto';
import { resolve } from 'path';
import { homedir } from 'os';
import { KeychainResolver } from '../src/modules/keychain-resolver';

const HOME = homedir();
const DEFAULT_CONFIG_DIR = resolve(HOME, '.claude');

describe('KeychainResolver', () => {

  // ==========================================================================
  // deriveConfigDir()
  // ==========================================================================

  describe('deriveConfigDir', () => {
    test('returns null for null input', () => {
      expect(KeychainResolver.deriveConfigDir(null)).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(KeychainResolver.deriveConfigDir('')).toBeNull();
    });

    test('returns null when /projects/ segment missing', () => {
      expect(KeychainResolver.deriveConfigDir('/some/random/path')).toBeNull();
      expect(KeychainResolver.deriveConfigDir(`${HOME}/.claude/settings.json`)).toBeNull();
    });

    test('extracts default config dir from standard transcript path', () => {
      const path = `${HOME}/.claude/projects/-Users-test-myproject/abc123.jsonl`;
      expect(KeychainResolver.deriveConfigDir(path)).toBe(DEFAULT_CONFIG_DIR);
    });

    test('extracts custom config dir from slot-1 registration path', () => {
      const configDir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const path = `${configDir}/projects/-Users-test-myproject/session.jsonl`;
      expect(KeychainResolver.deriveConfigDir(path)).toBe(resolve(configDir));
    });

    test('extracts custom config dir from slot-2 registration path', () => {
      const configDir = `${HOME}/_claude-configs/hot-swap/registration/slot-2`;
      const path = `${configDir}/projects/-Users-test-myproject/session.jsonl`;
      expect(KeychainResolver.deriveConfigDir(path)).toBe(resolve(configDir));
    });

    test('handles deeply nested project paths', () => {
      const path = `${HOME}/.claude/projects/-Users-test-deep-nested-project/sess.jsonl`;
      expect(KeychainResolver.deriveConfigDir(path)).toBe(DEFAULT_CONFIG_DIR);
    });

    test('handles path with multiple /projects/ occurrences (takes first)', () => {
      // Edge case: config dir itself contains "projects" in name
      const path = `/data/projects-config/projects/-test/session.jsonl`;
      expect(KeychainResolver.deriveConfigDir(path)).toBe(resolve('/data/projects-config'));
    });

    test('normalizes trailing slashes', () => {
      // resolve() should handle normalization
      const path = `${HOME}/.claude///projects/-test/session.jsonl`;
      const result = KeychainResolver.deriveConfigDir(path);
      expect(result).toBe(DEFAULT_CONFIG_DIR);
    });

    test('handles paths with spaces', () => {
      const configDir = `${HOME}/My Config Dir`;
      const path = `${configDir}/projects/-test/session.jsonl`;
      expect(KeychainResolver.deriveConfigDir(path)).toBe(resolve(configDir));
    });

    test('handles paths with special characters', () => {
      const configDir = `${HOME}/.claude-test_v2`;
      const path = `${configDir}/projects/-test/session.jsonl`;
      expect(KeychainResolver.deriveConfigDir(path)).toBe(resolve(configDir));
    });

    test('handles path where /projects/ is at the very start', () => {
      const path = `/projects/-test/session.jsonl`;
      // Everything before /projects/ is empty string → resolve('') = cwd
      const result = KeychainResolver.deriveConfigDir(path);
      expect(result).toBe(resolve(''));
    });
  });

  // ==========================================================================
  // computeKeychainService()
  // ==========================================================================

  describe('computeKeychainService', () => {
    test('returns bare service name for default ~/.claude', () => {
      expect(KeychainResolver.computeKeychainService(DEFAULT_CONFIG_DIR))
        .toBe('Claude Code-credentials');
    });

    test('returns bare service for ~/.claude with trailing slash normalization', () => {
      expect(KeychainResolver.computeKeychainService(`${HOME}/.claude/`))
        .toBe('Claude Code-credentials');
    });

    test('returns hashed service for custom config dir', () => {
      const customDir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const result = KeychainResolver.computeKeychainService(customDir);

      // Verify format: "Claude Code-credentials-{8 hex chars}"
      expect(result).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    });

    test('hash matches independent SHA256 computation', () => {
      const customDir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const normalized = resolve(customDir);
      const expectedHash = createHash('sha256')
        .update(normalized)
        .digest('hex')
        .substring(0, 8);

      expect(KeychainResolver.computeKeychainService(customDir))
        .toBe(`Claude Code-credentials-${expectedHash}`);
    });

    test('produces known hash for slot-1 registration dir', () => {
      const slot1Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const result = KeychainResolver.computeKeychainService(slot1Dir);
      // Known hash from keychain inspection
      expect(result).toBe('Claude Code-credentials-4a0e8cbc');
    });

    test('produces known hash for slot-2 registration dir', () => {
      const slot2Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-2`;
      const result = KeychainResolver.computeKeychainService(slot2Dir);
      // Known hash from keychain inspection
      expect(result).toBe('Claude Code-credentials-db267d92');
    });

    test('different directories produce different hashes', () => {
      const dir1 = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const dir2 = `${HOME}/_claude-configs/hot-swap/registration/slot-2`;
      const hash1 = KeychainResolver.computeKeychainService(dir1);
      const hash2 = KeychainResolver.computeKeychainService(dir2);
      expect(hash1).not.toBe(hash2);
    });

    test('same directory always produces same hash (deterministic)', () => {
      const dir = '/tmp/test-claude-config';
      const hash1 = KeychainResolver.computeKeychainService(dir);
      const hash2 = KeychainResolver.computeKeychainService(dir);
      expect(hash1).toBe(hash2);
    });

    test('relative vs absolute path normalization produces consistent result', () => {
      // Both should resolve to the same absolute path
      const abs = resolve('/tmp/test-config');
      const result1 = KeychainResolver.computeKeychainService(abs);
      const result2 = KeychainResolver.computeKeychainService(abs + '/');
      expect(result1).toBe(result2);
    });
  });

  // ==========================================================================
  // resolveFromTranscript()
  // ==========================================================================

  describe('resolveFromTranscript', () => {
    test('returns both nulls for null transcript', () => {
      const result = KeychainResolver.resolveFromTranscript(null);
      expect(result.configDir).toBeNull();
      expect(result.keychainService).toBeNull();
    });

    test('returns both nulls for path without /projects/', () => {
      const result = KeychainResolver.resolveFromTranscript('/some/random/path');
      expect(result.configDir).toBeNull();
      expect(result.keychainService).toBeNull();
    });

    test('resolves default ~/.claude transcript to bare service', () => {
      const path = `${HOME}/.claude/projects/-test/session.jsonl`;
      const result = KeychainResolver.resolveFromTranscript(path);

      expect(result.configDir).toBe(DEFAULT_CONFIG_DIR);
      expect(result.keychainService).toBe('Claude Code-credentials');
    });

    test('resolves slot-1 transcript to hashed service', () => {
      const configDir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const path = `${configDir}/projects/-Users-test-project/session123.jsonl`;
      const result = KeychainResolver.resolveFromTranscript(path);

      expect(result.configDir).toBe(resolve(configDir));
      expect(result.keychainService).toBe('Claude Code-credentials-4a0e8cbc');
    });

    test('resolves slot-2 transcript to hashed service', () => {
      const configDir = `${HOME}/_claude-configs/hot-swap/registration/slot-2`;
      const path = `${configDir}/projects/-Users-test-project/session456.jsonl`;
      const result = KeychainResolver.resolveFromTranscript(path);

      expect(result.configDir).toBe(resolve(configDir));
      expect(result.keychainService).toBe('Claude Code-credentials-db267d92');
    });

    test('configDir and keychainService are both null or both non-null', () => {
      // This property should always hold
      const testPaths = [
        null,
        '',
        '/random/path',
        `${HOME}/.claude/projects/-test/s.jsonl`,
        `${HOME}/_claude-configs/hot-swap/registration/slot-1/projects/-test/s.jsonl`,
      ];

      for (const path of testPaths) {
        const result = KeychainResolver.resolveFromTranscript(path);
        if (result.configDir === null) {
          expect(result.keychainService).toBeNull();
        } else {
          expect(result.keychainService).not.toBeNull();
        }
      }
    });
  });

  // ==========================================================================
  // readKeychainEntry() - requires macOS keychain
  // ==========================================================================

  describe('readKeychainEntry', () => {
    test('returns null for nonexistent service name', () => {
      const result = KeychainResolver.readKeychainEntry('nonexistent-service-12345');
      expect(result).toBeNull();
    });

    test('returns structured entry for known Claude Code service', () => {
      // Try the bare service first
      let entry = KeychainResolver.readKeychainEntry('Claude Code-credentials');

      if (!entry) {
        // Try slot-1
        entry = KeychainResolver.readKeychainEntry('Claude Code-credentials-4a0e8cbc');
      }

      if (!entry) {
        // No keychain entries accessible, skip
        return;
      }

      // Validate structure
      expect(typeof entry.accessToken).toBe('string');
      expect(entry.accessToken!.length).toBeGreaterThan(10);
      expect(typeof entry.isExpired).toBe('boolean');

      // expiresAt should be a number or null
      if (entry.expiresAt !== null) {
        expect(typeof entry.expiresAt).toBe('number');
        expect(entry.expiresAt).toBeGreaterThan(0);
      }

      // refreshToken may or may not exist
      if (entry.refreshToken !== null) {
        expect(typeof entry.refreshToken).toBe('string');
      }
    });

    test('correctly identifies expired tokens', () => {
      // Try reading slot-1 and slot-2 entries, check expiry logic
      const entries = [
        KeychainResolver.readKeychainEntry('Claude Code-credentials-4a0e8cbc'),
        KeychainResolver.readKeychainEntry('Claude Code-credentials-db267d92'),
      ].filter(e => e !== null);

      if (entries.length === 0) return;

      for (const entry of entries) {
        if (entry!.expiresAt !== null) {
          const expectedExpired = entry!.expiresAt! < (Date.now() + 60000);
          expect(entry!.isExpired).toBe(expectedExpired);
        } else {
          // No expiry set → not expired
          expect(entry!.isExpired).toBe(false);
        }
      }
    });

    test('handles malformed keychain data gracefully', () => {
      // Empty service name
      expect(KeychainResolver.readKeychainEntry('')).toBeNull();

      // Service with special characters
      expect(KeychainResolver.readKeychainEntry('test"service')).toBeNull();
    });
  });

  // ==========================================================================
  // End-to-end: real transcript → real keychain
  // ==========================================================================

  describe('end-to-end resolution', () => {
    test('resolves actual slot-1 transcript path to valid keychain entry', () => {
      const configDir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const path = `${configDir}/projects/-test/session.jsonl`;

      const resolution = KeychainResolver.resolveFromTranscript(path);
      expect(resolution.keychainService).toBe('Claude Code-credentials-4a0e8cbc');

      // Try to read the actual keychain entry
      const entry = KeychainResolver.readKeychainEntry(resolution.keychainService!);
      if (!entry) return; // Keychain not accessible

      expect(entry.accessToken).not.toBeNull();
      expect(typeof entry.accessToken).toBe('string');
    });

    test('resolves actual slot-2 transcript path to valid keychain entry', () => {
      const configDir = `${HOME}/_claude-configs/hot-swap/registration/slot-2`;
      const path = `${configDir}/projects/-test/session.jsonl`;

      const resolution = KeychainResolver.resolveFromTranscript(path);
      expect(resolution.keychainService).toBe('Claude Code-credentials-db267d92');

      const entry = KeychainResolver.readKeychainEntry(resolution.keychainService!);
      if (!entry) return;

      expect(entry.accessToken).not.toBeNull();
    });

    test('default ~/.claude transcript resolves to valid keychain entry', () => {
      const path = `${HOME}/.claude/projects/-test/session.jsonl`;

      const resolution = KeychainResolver.resolveFromTranscript(path);
      expect(resolution.keychainService).toBe('Claude Code-credentials');

      const entry = KeychainResolver.readKeychainEntry(resolution.keychainService!);
      if (!entry) return;

      expect(entry.accessToken).not.toBeNull();
    });

    test('different slots resolve to DIFFERENT keychain entries', () => {
      const slot1Path = `${HOME}/_claude-configs/hot-swap/registration/slot-1/projects/-t/s.jsonl`;
      const slot2Path = `${HOME}/_claude-configs/hot-swap/registration/slot-2/projects/-t/s.jsonl`;

      const res1 = KeychainResolver.resolveFromTranscript(slot1Path);
      const res2 = KeychainResolver.resolveFromTranscript(slot2Path);

      // Services should be different
      expect(res1.keychainService).not.toBe(res2.keychainService);

      // Config dirs should be different
      expect(res1.configDir).not.toBe(res2.configDir);

      // Both should be valid
      expect(res1.keychainService).toMatch(/^Claude Code-credentials-/);
      expect(res2.keychainService).toMatch(/^Claude Code-credentials-/);
    });
  });
});
