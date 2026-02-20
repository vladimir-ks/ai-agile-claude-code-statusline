/**
 * PII Detection Rules
 *
 * Personally Identifiable Information detection patterns.
 * All rules include validators to minimize false positives.
 *
 * Severity mapping:
 * - critical: SSN, credit card (financial/identity damage)
 * - medium: email (common, lower risk)
 * - low: phone, IP (context-dependent)
 */

import type { Rule } from '../types';
import { creditCardValidator } from '../validators/luhn';

// ── SSN Validation ────────────────────────────────────────────────────

/**
 * Validate SSN format: area-group-serial.
 * Rejects invalid area numbers (000, 666, 900-999).
 * Rejects invalid group (00) and serial (0000).
 */
function ssnValidator(match: string, _context: string): number {
  const parts = match.split('-');
  if (parts.length !== 3) return 0.0;

  const area = parseInt(parts[0], 10);
  const group = parseInt(parts[1], 10);
  const serial = parseInt(parts[2], 10);

  // Invalid area numbers
  if (area === 0 || area === 666 || area >= 900) return 0.0;
  // Invalid group/serial
  if (group === 0 || serial === 0) return 0.0;

  return 1.0;
}

// ── Phone Validation ──────────────────────────────────────────────────

/** US phone validator: require nearby context keywords */
const PHONE_CONTEXT_WORDS = [
  'phone', 'tel', 'call', 'mobile', 'cell', 'fax', 'sms', 'text',
  'contact', 'dial', 'ring', 'number',
];

function phoneContextValidator(match: string, context: string): number {
  const lowerCtx = context.toLowerCase();
  for (const word of PHONE_CONTEXT_WORDS) {
    if (lowerCtx.includes(word)) return 0.9;
  }
  // No phone context → low confidence (could be any number sequence)
  return 0.3;
}

// ── Email Validation ──────────────────────────────────────────────────

/** Common valid TLDs (top 50 by registration volume + common ccTLDs) */
const VALID_TLDS = new Set([
  'com', 'org', 'net', 'edu', 'gov', 'io', 'co', 'dev', 'app',
  'ai', 'me', 'info', 'biz', 'us', 'uk', 'de', 'fr', 'jp', 'cn',
  'ru', 'br', 'in', 'au', 'ca', 'nl', 'it', 'es', 'se', 'no',
  'fi', 'pl', 'cz', 'ch', 'at', 'be', 'dk', 'pt', 'ie', 'nz',
  'xyz', 'online', 'site', 'tech', 'store', 'cloud', 'live',
]);

function emailValidator(match: string, _context: string): number {
  const tld = match.split('.').pop()?.toLowerCase();
  if (!tld) return 0.0;
  if (!VALID_TLDS.has(tld)) return 0.3; // Unknown TLD — low confidence
  return 0.9;
}

// ── IP Address Validation ─────────────────────────────────────────────

function ipValidator(match: string, _context: string): number {
  const octets = match.split('.').map(Number);

  // All octets must be 0-255
  if (octets.some(o => isNaN(o) || o < 0 || o > 255)) return 0.0;

  // Reject private/reserved ranges
  const [a, b] = octets;
  if (a === 127) return 0.0;                         // Loopback
  if (a === 0) return 0.0;                           // Invalid source
  if (a === 255) return 0.0;                         // Broadcast
  if (a === 10) return 0.0;                          // Private Class A
  if (a === 172 && b >= 16 && b <= 31) return 0.0;  // Private Class B
  if (a === 192 && b === 168) return 0.0;            // Private Class C
  if (a === 169 && b === 254) return 0.0;            // Link-local

  return 0.8;
}

// ── Rules ─────────────────────────────────────────────────────────────

export const PII_RULES: Rule[] = [
  // SSN
  {
    id: 'ssn',
    type: 'SSN',
    category: 'pii',
    severity: 'critical',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    description: 'US Social Security Number (XXX-XX-XXXX)',
    validate: ssnValidator,
  },

  // Credit Card
  {
    id: 'credit_card',
    type: 'Credit Card',
    category: 'pii',
    severity: 'critical',
    pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g,
    description: 'Credit card number (16 digits, with optional separators)',
    validate: creditCardValidator,
  },

  // Email
  {
    id: 'email',
    type: 'Email',
    category: 'pii',
    severity: 'medium',
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    description: 'Email address (RFC 5322 simplified)',
    validate: emailValidator,
  },

  // US Phone
  {
    id: 'phone_us',
    type: 'Phone Number',
    category: 'pii',
    severity: 'low',
    pattern: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
    description: 'US phone number (10 digits)',
    validate: phoneContextValidator,
  },

  // International Phone
  {
    id: 'phone_intl',
    type: 'Phone Number',
    category: 'pii',
    severity: 'low',
    pattern: /\+\d{1,3}[-.\s]?\d{4,14}\b/g,
    description: 'International phone number (+country code)',
    validate: phoneContextValidator,
  },

  // IP Address
  {
    id: 'ip_address',
    type: 'IP Address',
    category: 'pii',
    severity: 'low',
    pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    description: 'IPv4 address (public only)',
    validate: ipValidator,
  },
];
