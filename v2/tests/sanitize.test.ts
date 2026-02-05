/**
 * Tests for Security Sanitization Utilities
 *
 * Covers: path traversal prevention, error string sanitization,
 * PII redaction, edge cases.
 */

import { describe, test, expect } from 'bun:test';
import {
  sanitizeSessionId,
  sanitizeError,
  redactEmail,
  truncateForLog,
} from '../src/lib/sanitize';

// ---------------------------------------------------------------------------
// sanitizeSessionId
// ---------------------------------------------------------------------------

describe('sanitizeSessionId', () => {

  test('normal session IDs pass through unchanged', () => {
    expect(sanitizeSessionId('session-abc-123')).toBe('session-abc-123');
    expect(sanitizeSessionId('abc_def.ghi')).toBe('abc_def.ghi');
    expect(sanitizeSessionId('a1b2c3')).toBe('a1b2c3');
  });

  test('path traversal with ../ is neutralized', () => {
    const result = sanitizeSessionId('../../etc/passwd');
    expect(result).not.toContain('/');
    expect(result).not.toContain('..');
    expect(result).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  test('path traversal with ..\\ is neutralized', () => {
    const result = sanitizeSessionId('..\\..\\windows\\system32');
    expect(result).not.toContain('\\');
    expect(result).not.toContain('..');
    expect(result).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  test('forward slashes replaced with underscores', () => {
    const result = sanitizeSessionId('path/to/file');
    expect(result).toBe('path_to_file');
  });

  test('backslashes replaced with underscores', () => {
    const result = sanitizeSessionId('path\\to\\file');
    expect(result).toBe('path_to_file');
  });

  test('leading dots stripped', () => {
    expect(sanitizeSessionId('.hidden')).toBe('hidden');
    expect(sanitizeSessionId('..dotdot')).toBe('dotdot');
    expect(sanitizeSessionId('...triple')).toBe('triple');
  });

  test('unicode characters stripped', () => {
    const result = sanitizeSessionId('session-\u0000null');
    expect(result).not.toContain('\u0000');
    expect(result).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  test('special chars stripped', () => {
    const result = sanitizeSessionId('session<>|:*?"');
    expect(result).toMatch(/^[a-zA-Z0-9._-]+$/);
  });

  test('empty string returns fallback', () => {
    expect(sanitizeSessionId('')).toBe('unknown-session');
  });

  test('null returns fallback', () => {
    expect(sanitizeSessionId(null)).toBe('unknown-session');
  });

  test('undefined returns fallback', () => {
    expect(sanitizeSessionId(undefined)).toBe('unknown-session');
  });

  test('only slashes returns fallback', () => {
    // After stripping / and leading dots, nothing remains
    const result = sanitizeSessionId('///');
    expect(result).not.toContain('/');
    // Result should be ___ (three underscores from slash replacement)
    expect(result).toBe('___');
  });

  test('very long IDs are truncated', () => {
    const longId = 'a'.repeat(200);
    const result = sanitizeSessionId(longId);
    expect(result.length).toBeLessThanOrEqual(128);
  });

  test('real-world Claude session IDs work', () => {
    // Actual Claude Code session ID format
    expect(sanitizeSessionId('44be6263-d9b6-44f4-9222-4fc81f160b58')).toBe('44be6263-d9b6-44f4-9222-4fc81f160b58');
  });
});

// ---------------------------------------------------------------------------
// sanitizeError
// ---------------------------------------------------------------------------

describe('sanitizeError', () => {

  test('simple error message passes through', () => {
    expect(sanitizeError('Connection refused')).toBe('Connection refused');
  });

  test('URLs are redacted', () => {
    const result = sanitizeError('Failed to fetch https://api.anthropic.com/v1/usage?token=secret123');
    expect(result).not.toContain('https://');
    expect(result).not.toContain('secret123');
    expect(result).toContain('[REDACTED]');
  });

  test('Bearer tokens are redacted', () => {
    const result = sanitizeError('Auth failed: Bearer sk-ant-abc123def456ghi789');
    expect(result).not.toContain('sk-ant-abc123def456ghi789');
    expect(result).toContain('[REDACTED]');
  });

  test('API keys are redacted', () => {
    const result = sanitizeError('Invalid key: sk-abcdefghijklmnopqrstuvwxyz');
    expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(result).toContain('[REDACTED]');
  });

  test('multiline errors take first line only', () => {
    const result = sanitizeError('Error on line 1\nStack trace here\nMore details');
    expect(result).toBe('Error on line 1');
    expect(result).not.toContain('Stack trace');
  });

  test('very long errors are truncated', () => {
    const longError = 'x'.repeat(500);
    const result = sanitizeError(longError);
    expect(result.length).toBeLessThanOrEqual(124); // 120 + "..."
  });

  test('null/undefined returns empty string', () => {
    expect(sanitizeError(null)).toBe('');
    expect(sanitizeError(undefined)).toBe('');
  });

  test('Error objects are converted to string', () => {
    const err = new Error('Something went wrong');
    const result = sanitizeError(err);
    expect(result).toContain('Something went wrong');
  });

  test('token= patterns are redacted', () => {
    const result = sanitizeError('Config error token=abc123def456xyz');
    expect(result).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// redactEmail
// ---------------------------------------------------------------------------

describe('redactEmail', () => {

  test('standard email is redacted', () => {
    const result = redactEmail('user@example.com');
    expect(result).toBe('us***@example.com');
    expect(result).not.toContain('user');
  });

  test('short local part redacted', () => {
    const result = redactEmail('ab@example.com');
    expect(result).toContain('***');
    expect(result).toContain('@example.com');
  });

  test('very short local part (1 char)', () => {
    const result = redactEmail('a@example.com');
    expect(result).toBe('***@example.com');
  });

  test('null returns (none)', () => {
    expect(redactEmail(null)).toBe('(none)');
  });

  test('undefined returns (none)', () => {
    expect(redactEmail(undefined)).toBe('(none)');
  });

  test('non-email string is redacted', () => {
    const result = redactEmail('not-an-email');
    expect(result).toBe('not***');
  });

  test('domain is preserved', () => {
    const result = redactEmail('longusername@company.org');
    expect(result).toContain('@company.org');
    expect(result).toBe('lo***@company.org');
  });
});

// ---------------------------------------------------------------------------
// truncateForLog
// ---------------------------------------------------------------------------

describe('truncateForLog', () => {

  test('short strings pass through', () => {
    expect(truncateForLog('hello')).toBe('hello');
  });

  test('long strings are truncated', () => {
    const result = truncateForLog('44be6263-d9b6-44f4-9222-4fc81f160b58');
    expect(result).toBe('44be6263-d9b...');
    expect(result.length).toBeLessThanOrEqual(15); // 12 + "..."
  });

  test('custom max length', () => {
    const result = truncateForLog('abcdefghij', 5);
    expect(result).toBe('abcde...');
  });

  test('empty string returns (empty)', () => {
    expect(truncateForLog('')).toBe('(empty)');
  });

  test('exact length passes through', () => {
    expect(truncateForLog('123456789012')).toBe('123456789012');
  });
});
