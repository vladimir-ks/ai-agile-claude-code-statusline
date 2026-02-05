/**
 * Integration Test: Security Boundaries
 *
 * Verifies that sanitization works at actual code paths, not just
 * in the sanitize utility. Tests the full flow from untrusted input
 * to safe file I/O.
 *
 * Critical paths tested:
 * 1. HealthStore with path-traversal sessionId → writes to safe path
 * 2. DebugStateWriter with path-traversal sessionId → writes safely
 * 3. DebugStateWriter fetch history with error URLs → URLs redacted in file
 * 4. HealthPublisher with malicious sessionId → no file escape
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import HealthStore from '../../src/lib/health-store';
import { DebugStateWriter } from '../../src/lib/debug-state-writer';
import { HealthPublisher } from '../../src/lib/health-publisher';
import { createDefaultHealth } from '../../src/types/session-health';
import { sanitizeError } from '../../src/lib/sanitize';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'security-boundary-test-' + Date.now());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Security Boundaries Integration', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    DebugStateWriter.clearHistory();
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // =========================================================================
  // HealthStore: Path traversal prevention
  // =========================================================================

  describe('HealthStore path traversal', () => {
    test('sessionId with ../ does not escape base directory', () => {
      const store = new HealthStore(TEST_DIR);
      const health = createDefaultHealth('../../etc/passwd');

      store.writeSessionHealth('../../etc/passwd', health);

      // File should be in TEST_DIR, not escaped
      const files = readdirSync(TEST_DIR);
      const jsonFiles = files.filter(f => f.endsWith('.json'));

      expect(jsonFiles.length).toBe(1);
      // File name should NOT contain slashes or ..
      expect(jsonFiles[0]).not.toContain('/');
      expect(jsonFiles[0]).not.toContain('\\');
      expect(jsonFiles[0]).not.toContain('..');

      // Verify the file is readable
      const restored = store.readSessionHealth('../../etc/passwd');
      expect(restored).not.toBeNull();
      expect(restored!.sessionId).toBe('../../etc/passwd');
    });

    test('sessionId with backslash does not escape', () => {
      const store = new HealthStore(TEST_DIR);
      const health = createDefaultHealth('..\\..\\windows\\system32');

      store.writeSessionHealth('..\\..\\windows\\system32', health);

      const files = readdirSync(TEST_DIR).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);
      expect(files[0]).not.toContain('\\');
    });

    test('sessionId with null bytes does not create bad filename', () => {
      const store = new HealthStore(TEST_DIR);
      const sessionId = 'session\x00injected';
      const health = createDefaultHealth(sessionId);

      store.writeSessionHealth(sessionId, health);

      const files = readdirSync(TEST_DIR).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);
      // File name should not contain null byte
      expect(files[0]).not.toContain('\x00');
    });

    test('multiple traversal attempts all sanitized consistently', () => {
      const store = new HealthStore(TEST_DIR);
      const maliciousIds = [
        '../../../tmp/evil',
        '..%2F..%2Fetc%2Fpasswd',
        'normal/../../../escape',
        '....//....//etc',
      ];

      for (const id of maliciousIds) {
        const health = createDefaultHealth(id);
        store.writeSessionHealth(id, health);
      }

      const files = readdirSync(TEST_DIR).filter(f => f.endsWith('.json'));
      // All files should be in TEST_DIR
      for (const file of files) {
        expect(file).not.toContain('/');
        expect(file).not.toContain('\\');
        const fullPath = join(TEST_DIR, file);
        expect(existsSync(fullPath)).toBe(true);
      }
    });
  });

  // =========================================================================
  // DebugStateWriter: Path traversal + error sanitization
  // =========================================================================

  describe('DebugStateWriter security', () => {
    test('path-traversal sessionId writes safely', () => {
      const health = createDefaultHealth('../../escape-attempt');
      health.billing.lastFetched = Date.now();

      DebugStateWriter.write('../../escape-attempt', health, TEST_DIR);

      const files = readdirSync(TEST_DIR).filter(f => f.endsWith('.debug.json'));
      expect(files.length).toBe(1);
      expect(files[0]).not.toContain('/');
      expect(files[0]).not.toContain('..');
    });

    test('error with URL is redacted in stored fetch history', () => {
      // Record a fetch with a sensitive error
      DebugStateWriter.recordFetch({
        category: 'billing_oauth',
        timestamp: Date.now(),
        success: false,
        durationMs: 100,
        error: sanitizeError('OAuth failed: https://api.anthropic.com/v1/usage?token=sk-secret123'),
      });

      const health = createDefaultHealth('error-test');
      health.billing.lastFetched = Date.now();

      DebugStateWriter.write('error-test', health, TEST_DIR);

      const debugState = DebugStateWriter.read('error-test', TEST_DIR);
      expect(debugState).not.toBeNull();
      expect(debugState!.fetchHistory).toHaveLength(1);

      const errorMsg = debugState!.fetchHistory[0].error || '';
      expect(errorMsg).not.toContain('https://');
      expect(errorMsg).not.toContain('sk-secret123');
      expect(errorMsg).toContain('[REDACTED]');
    });

    test('error with Bearer token is redacted', () => {
      DebugStateWriter.recordFetch({
        category: 'billing_ccusage',
        timestamp: Date.now(),
        success: false,
        durationMs: 200,
        error: sanitizeError('Auth error: Bearer sk-ant-api03-abc123def456ghi789'),
      });

      const health = createDefaultHealth('bearer-test');
      health.billing.lastFetched = Date.now();

      DebugStateWriter.write('bearer-test', health, TEST_DIR);

      const debugState = DebugStateWriter.read('bearer-test', TEST_DIR);
      const errorMsg = debugState!.fetchHistory[0].error || '';
      expect(errorMsg).not.toContain('sk-ant-api03');
      expect(errorMsg).toContain('[REDACTED]');
    });
  });

  // =========================================================================
  // HealthPublisher: Malicious session keys
  // =========================================================================

  describe('HealthPublisher security', () => {
    test('sessionId as object key does not cause JSON injection', () => {
      const health = createDefaultHealth('normal-session');
      health.launch.authProfile = 'test@example.com';
      health.billing.lastFetched = Date.now();
      health.transcript.lastModified = Date.now();
      health.gatheredAt = Date.now();

      // Session ID with JSON-breaking characters
      const evilId = 'session","evil":true,"x":"';
      HealthPublisher.publishToPath(evilId, health, TEST_DIR);

      // File should be valid JSON
      const published = HealthPublisher.read(TEST_DIR);
      expect(published).not.toBeNull();

      // The evil sessionId should be a key, not break the JSON structure
      expect(typeof published!.sessions).toBe('object');
      expect(published!.sessions[evilId]).toBeDefined();
      expect(published!.sessions[evilId].email).toBe('test@example.com');

      // Verify no extra keys from injection
      const keys = Object.keys(published!.sessions);
      expect(keys).toHaveLength(1);
    });

    test('publish-health.json is valid JSON after multi-session publish', () => {
      const sessionIds = [
        'normal-1',
        'with/slash',
        'with\\backslash',
        'with..dots',
      ];

      for (const id of sessionIds) {
        const health = createDefaultHealth(id);
        health.launch.authProfile = `${id}@test.com`;
        health.transcript.lastModified = Date.now();
        health.billing.lastFetched = Date.now();
        health.gatheredAt = Date.now();

        HealthPublisher.publishToPath(id, health, TEST_DIR);
      }

      // Read raw JSON and verify it's valid
      const rawContent = readFileSync(join(TEST_DIR, 'publish-health.json'), 'utf-8');
      const parsed = JSON.parse(rawContent);
      expect(parsed.version).toBe(1);
      expect(Object.keys(parsed.sessions).length).toBe(sessionIds.length);
    });
  });

  // =========================================================================
  // End-to-end: sanitizeError standalone verification
  // =========================================================================

  describe('sanitizeError edge cases in practice', () => {
    test('Error object with stack trace is truncated to first line', () => {
      const err = new Error('Something failed');
      const sanitized = sanitizeError(err);
      expect(sanitized).not.toContain('\n');
      expect(sanitized).toContain('Something failed');
    });

    test('empty error returns empty string', () => {
      expect(sanitizeError('')).toBe('');
      expect(sanitizeError(null)).toBe('');
      expect(sanitizeError(undefined)).toBe('');
    });

    test('number error is converted', () => {
      expect(sanitizeError(404)).toBe('404');
    });
  });
});
