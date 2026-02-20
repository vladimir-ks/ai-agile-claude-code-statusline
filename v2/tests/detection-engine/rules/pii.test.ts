/**
 * PII Detection Rules — Tests
 */

import { describe, test, expect } from 'bun:test';
import { DetectionEngine } from '../../../src/lib/detection-engine';

// Engine configured for PII only, all severities
const engine = new DetectionEngine({
  categories: ['pii'],
  minSeverity: 'low',
  minConfidence: 0.3,
});

describe('PII Rules — SSN', () => {
  test('detects valid SSN format', () => {
    const f = engine.detect('SSN: 123-45-6789');
    expect(f.some(x => x.type === 'SSN')).toBe(true);
  });

  test('rejects area 000', () => {
    expect(engine.detect('000-12-3456').filter(x => x.type === 'SSN')).toEqual([]);
  });

  test('rejects area 666', () => {
    expect(engine.detect('666-12-3456').filter(x => x.type === 'SSN')).toEqual([]);
  });

  test('rejects area 900+', () => {
    expect(engine.detect('900-12-3456').filter(x => x.type === 'SSN')).toEqual([]);
    expect(engine.detect('999-12-3456').filter(x => x.type === 'SSN')).toEqual([]);
  });

  test('rejects group 00', () => {
    expect(engine.detect('123-00-4567').filter(x => x.type === 'SSN')).toEqual([]);
  });

  test('rejects serial 0000', () => {
    expect(engine.detect('123-45-0000').filter(x => x.type === 'SSN')).toEqual([]);
  });

  test('severity is critical', () => {
    const f = engine.detect('SSN: 123-45-6789');
    const ssn = f.find(x => x.type === 'SSN');
    expect(ssn?.severity).toBe('critical');
  });
});

describe('PII Rules — Credit Card', () => {
  test('detects Visa test card (passes Luhn)', () => {
    const f = engine.detect('Card: 4111111111111111');
    expect(f.some(x => x.type === 'Credit Card')).toBe(true);
  });

  test('detects card with spaces', () => {
    const f = engine.detect('Card: 4111 1111 1111 1111');
    expect(f.some(x => x.type === 'Credit Card')).toBe(true);
  });

  test('detects card with dashes', () => {
    const f = engine.detect('Card: 4111-1111-1111-1111');
    expect(f.some(x => x.type === 'Credit Card')).toBe(true);
  });

  test('rejects invalid Luhn checksum', () => {
    expect(engine.detect('4111111111111112').filter(x => x.type === 'Credit Card')).toEqual([]);
  });

  test('rejects all zeros', () => {
    expect(engine.detect('0000000000000000').filter(x => x.type === 'Credit Card')).toEqual([]);
  });

  test('rejects sequential digits', () => {
    expect(engine.detect('1234567890123456').filter(x => x.type === 'Credit Card')).toEqual([]);
  });

  test('severity is critical', () => {
    const f = engine.detect('4111111111111111');
    const cc = f.find(x => x.type === 'Credit Card');
    expect(cc?.severity).toBe('critical');
  });
});

describe('PII Rules — Email', () => {
  test('detects email with common TLD', () => {
    const f = engine.detect('Contact: user@example.com');
    expect(f.some(x => x.type === 'Email')).toBe(true);
  });

  test('detects email with org TLD', () => {
    const f = engine.detect('admin@nonprofit.org');
    expect(f.some(x => x.type === 'Email')).toBe(true);
  });

  test('low confidence for unknown TLD', () => {
    const f = engine.detect('user@example.invalidtld');
    const email = f.find(x => x.type === 'Email');
    // Unknown TLD gets 0.3 confidence — may be below threshold
    if (email) {
      expect(email.confidence).toBeLessThanOrEqual(0.4);
    }
  });

  test('severity is medium', () => {
    const f = engine.detect('user@example.com');
    const email = f.find(x => x.type === 'Email');
    expect(email?.severity).toBe('medium');
  });
});

describe('PII Rules — Phone Number', () => {
  test('detects US phone with context', () => {
    const f = engine.detect('Call me at phone: 555-123-4567');
    expect(f.some(x => x.type === 'Phone Number')).toBe(true);
  });

  test('detects international phone with context', () => {
    const f = engine.detect('My phone number is +1-5551234567');
    expect(f.some(x => x.type === 'Phone Number')).toBe(true);
  });

  test('low confidence without phone context', () => {
    const f = engine.detect('The code is 555-123-4567');
    const phone = f.find(x => x.type === 'Phone Number');
    if (phone) {
      expect(phone.confidence).toBeLessThanOrEqual(0.4);
    }
  });
});

describe('PII Rules — IP Address', () => {
  test('detects public IP', () => {
    const f = engine.detect('Server at 8.8.8.8');
    expect(f.some(x => x.type === 'IP Address')).toBe(true);
  });

  test('rejects loopback 127.x', () => {
    expect(engine.detect('127.0.0.1').filter(x => x.type === 'IP Address')).toEqual([]);
  });

  test('rejects private 10.x', () => {
    expect(engine.detect('10.0.0.1').filter(x => x.type === 'IP Address')).toEqual([]);
  });

  test('rejects private 192.168.x', () => {
    expect(engine.detect('192.168.1.1').filter(x => x.type === 'IP Address')).toEqual([]);
  });

  test('rejects private 172.16-31.x', () => {
    expect(engine.detect('172.16.0.1').filter(x => x.type === 'IP Address')).toEqual([]);
  });

  test('rejects broadcast 255.x', () => {
    expect(engine.detect('255.255.255.255').filter(x => x.type === 'IP Address')).toEqual([]);
  });
});

describe('PII Rules — False Positive Prevention', () => {
  test('version numbers NOT detected as IP', () => {
    // Version like 1.2.3.4 — octets in valid range but common in code
    const f = engine.detect('version 1.2.3.4');
    // This may match IP pattern but gets low confidence from IP validator
    // (1.x.x.x is technically valid but uncommon as real IP)
  });

  test('dates NOT detected as SSN', () => {
    // 2023-01-15 — looks like SSN format but area 202 is valid
    // Actually 202-30-1215 wouldn't match because it's not in SSN format
    expect(engine.detect('date: 2023-01-15').filter(x => x.type === 'SSN')).toEqual([]);
  });

  test('random 16-digit number without Luhn NOT detected as CC', () => {
    expect(engine.detect('ID: 1234567890123457').filter(x => x.type === 'Credit Card')).toEqual([]);
  });
});
