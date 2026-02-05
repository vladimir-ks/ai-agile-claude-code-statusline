/**
 * Sanitize - Security utilities for input sanitization
 *
 * Prevents: path traversal, PII leakage, sensitive data in debug files.
 */

// ---------------------------------------------------------------------------
// Session ID sanitization (prevents path traversal)
// ---------------------------------------------------------------------------

/** Max allowed sessionId length */
const MAX_SESSION_ID_LENGTH = 128;

/** Allowed characters: alphanumeric, hyphens, underscores, dots */
const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

/**
 * Sanitize a sessionId for use in file paths.
 * Strips path separators, enforces character whitelist, caps length.
 *
 * Returns sanitized ID, or 'unknown-session' if input is invalid/empty.
 */
export function sanitizeSessionId(sessionId: string | null | undefined): string {
  if (!sessionId || typeof sessionId !== 'string') {
    return 'unknown-session';
  }

  // Strip any path separators first (defense in depth)
  let cleaned = sessionId.replace(/[\/\\]/g, '_');

  // Collapse consecutive dots (prevents .. traversal with join())
  cleaned = cleaned.replace(/\.{2,}/g, '.');

  // Remove any leading dots (prevents hidden files / relative paths)
  cleaned = cleaned.replace(/^\.+/, '');

  // Only allow safe characters
  if (!SESSION_ID_PATTERN.test(cleaned)) {
    // Strip disallowed characters
    cleaned = cleaned.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  // Cap length
  if (cleaned.length > MAX_SESSION_ID_LENGTH) {
    cleaned = cleaned.substring(0, MAX_SESSION_ID_LENGTH);
  }

  // If nothing useful remains, use fallback
  if (!cleaned || cleaned.length === 0) {
    return 'unknown-session';
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Error string sanitization (prevents credential leakage in debug files)
// ---------------------------------------------------------------------------

const MAX_ERROR_LENGTH = 120;

/** Patterns that may contain credentials */
const SENSITIVE_PATTERNS = [
  /https?:\/\/[^\s]+/gi,       // URLs (may contain tokens in query strings)
  /Bearer\s+[a-zA-Z0-9._-]+/gi, // Bearer tokens
  /sk-[a-zA-Z0-9]{10,}/gi,     // API keys
  /token[=:]\s*["']?[a-zA-Z0-9._-]{10,}/gi, // Generic tokens
];

/**
 * Sanitize an error message for storage in debug state files.
 * Removes URLs, tokens, and other potentially sensitive data.
 * Truncates to first line, caps at MAX_ERROR_LENGTH chars.
 */
export function sanitizeError(error: unknown): string {
  if (!error) return '';

  let msg = String(error);

  // Take only first line
  const newlineIdx = msg.indexOf('\n');
  if (newlineIdx > 0) {
    msg = msg.substring(0, newlineIdx);
  }

  // Strip sensitive patterns
  for (const pattern of SENSITIVE_PATTERNS) {
    msg = msg.replace(pattern, '[REDACTED]');
  }

  // Cap length
  if (msg.length > MAX_ERROR_LENGTH) {
    msg = msg.substring(0, MAX_ERROR_LENGTH) + '...';
  }

  return msg;
}

// ---------------------------------------------------------------------------
// PII redaction (for log output)
// ---------------------------------------------------------------------------

/**
 * Redact an email address for log output.
 * "user@example.com" -> "us***@example.com"
 */
export function redactEmail(email: string | null | undefined): string {
  if (!email || typeof email !== 'string') return '(none)';

  const atIdx = email.indexOf('@');
  if (atIdx < 0) {
    // Not an email — redact most of it
    if (email.length <= 3) return '***';
    return email.substring(0, 3) + '***';
  }

  const local = email.substring(0, atIdx);
  const domain = email.substring(atIdx);

  if (local.length <= 2) {
    return '***' + domain;
  }

  return local.substring(0, 2) + '***' + domain;
}

/**
 * Truncate a session ID for log output.
 * Shows first 8 chars + "..."
 */
export function truncateForLog(value: string, maxLen: number = 12): string {
  if (!value) return '(empty)';
  if (value.length <= maxLen) return value;
  return value.substring(0, maxLen) + '...';
}
