/**
 * Detection Engine — Utilities
 *
 * Helpers for redaction and text extraction.
 * Zero external dependencies — works in any JS runtime.
 */

/**
 * Redact a secret for safe display.
 * Format: first4...last4 (or *** for very short values).
 */
export function redact(value: string): string {
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Extract surrounding context from input text at given offset.
 * Returns `windowSize` chars before and after the match.
 */
export function extractContext(
  input: string,
  offset: number,
  length: number,
  windowSize: number = 40,
): string {
  const start = Math.max(0, offset - windowSize);
  const end = Math.min(input.length, offset + length + windowSize);
  return input.slice(start, end);
}
