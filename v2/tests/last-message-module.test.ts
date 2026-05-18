/**
 * LastMessageModule format() Tests
 *
 * Focused on FIX-5b/5c: elapsed format spec + >=24h calendar-date branch.
 *
 * Spec (C-report Display Format Spec):
 *   < 60s   → 💬:HH:MM(<1m) preview
 *   1–59m   → 💬:HH:MM(Xm) preview
 *   1–23h   → 💬:HH:MM(Xh Ym) preview    [module renders e.g. "2h43m"]
 *   >= 24h  → 💬:Mon DD HH:MM preview     (date replaces elapsed entirely)
 */

import { describe, test, expect } from 'bun:test';
import LastMessageModule from '../src/modules/last-message-module';
import type { LastMessageData } from '../src/modules/last-message-module';

function makeData(elapsedSec: number, overrides: Partial<LastMessageData> = {}): LastMessageData {
  const now = Date.now();
  const timestamp = new Date(now - elapsedSec * 1000);
  const hh = String(timestamp.getHours()).padStart(2, '0');
  const mm = String(timestamp.getMinutes()).padStart(2, '0');
  const displayTime = `${hh}:${mm}`;

  // Replicate elapsed logic from the module
  let elapsed = '';
  if (elapsedSec < 86400) {
    if (elapsedSec < 60) {
      elapsed = '<1m';
    } else if (elapsedSec < 3600) {
      elapsed = `${Math.floor(elapsedSec / 60)}m`;
    } else {
      const hours = Math.floor(elapsedSec / 3600);
      const mins = Math.floor((elapsedSec % 3600) / 60);
      elapsed = `${hours}h${mins}m`;
    }
  }
  // >= 24h: elapsed stays '' — triggers calendar-date branch

  return {
    text: 'hello world',
    timestamp,
    displayTime,
    elapsed,
    color: '245',
    ...overrides,
  };
}

describe('LastMessageModule.format() — elapsed format spec (FIX-5b/5c)', () => {
  const mod = new LastMessageModule();

  test('< 60s → <1m', () => {
    const d = makeData(30);
    const out = mod.format(d);
    expect(out).toContain('(<1m)');
    expect(out).toMatch(/^💬:\d{2}:\d{2}\(<1m\) /);
  });

  test('1–59m → Xm', () => {
    const d = makeData(5 * 60); // 5 min
    const out = mod.format(d);
    expect(out).toContain('(5m)');
    expect(out).toMatch(/^💬:\d{2}:\d{2}\(\d+m\) /);
  });

  test('1–23h → XhYm', () => {
    const d = makeData(2 * 3600 + 43 * 60); // 2h43m
    const out = mod.format(d);
    expect(out).toContain('(2h43m)');
    expect(out).toMatch(/^💬:\d{2}:\d{2}\(\d+h\d+m\) /);
  });

  test('>= 24h → "Mon DD HH:MM preview" (date replaces elapsed)', () => {
    const d = makeData(2 * 86400); // 2 days
    const out = mod.format(d);
    // Must NOT have parenthesised elapsed
    expect(out).not.toMatch(/\(\d/);
    // Must match "💬:Mon DD HH:MM preview" pattern
    expect(out).toMatch(/^💬:[A-Z][a-z]+ \d{1,2} \d{2}:\d{2} /);
  });

  test('>= 24h — exactly 24h boundary triggers calendar date', () => {
    const d = makeData(86400); // exactly 24h
    const out = mod.format(d);
    expect(out).toMatch(/^💬:[A-Z][a-z]+ \d{1,2} \d{2}:\d{2} /);
  });

  test('returns empty string when text is missing', () => {
    const d = makeData(60, { text: '', displayTime: '14:30' });
    expect(mod.format(d)).toBe('');
  });

  test('returns empty string when displayTime is missing', () => {
    const d = makeData(60, { displayTime: '' });
    expect(mod.format(d)).toBe('');
  });
});

describe('LastMessageModule cacheTTL and extractor TTL', () => {
  test('module cacheTTL is 5s', () => {
    const mod = new LastMessageModule();
    expect(mod.config.cacheTTL).toBe(5000);
  });
});
