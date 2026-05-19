/**
 * LastMessageModule format() Tests
 *
 * Updated for W4 change: preview removed, replaced with idle/cache-warmth timer.
 *
 * New display format:
 *   < 24h, warm → 💬:HH:MM(<1m)🔥
 *   < 24h, cold → 💬:HH:MM(Xm)❄️
 *   >= 24h      → 💬:Mon DD HH:MM ❄️   (date replaces elapsed)
 *   no data     → ''
 *
 * CACHE_TTL_SECONDS = 300 (5 min)
 */

import { describe, test, expect } from 'bun:test';
import LastMessageModule, { CACHE_TTL_SECONDS } from '../src/modules/last-message-module';
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

  const cacheWarmth: 'warm' | 'cold' = elapsedSec < CACHE_TTL_SECONDS ? 'warm' : 'cold';

  return {
    timestamp,
    displayTime,
    elapsed,
    cacheWarmth,
    color: '245',
    ...overrides,
  };
}

describe('LastMessageModule.format() — idle/cache-warmth timer (W4)', () => {
  const mod = new LastMessageModule();

  // ── < 60s (warm) ──
  test('< 60s → <1m with 🔥 (warm)', () => {
    const d = makeData(30);
    const out = mod.format(d);
    expect(out).toMatch(/^💬:\d{2}:\d{2}\(<1m\)🔥$/);
    expect(out).not.toContain(' ');  // no trailing preview text
  });

  // ── 5m (border: CACHE_TTL_SECONDS = 300s) ──
  test('exactly 5m (300s) → cold ❄️', () => {
    const d = makeData(300);
    expect(d.cacheWarmth).toBe('cold');
    const out = mod.format(d);
    expect(out).toContain('❄️');
    expect(out).not.toContain('🔥');
  });

  test('4m59s (299s) → warm 🔥', () => {
    const d = makeData(299);
    expect(d.cacheWarmth).toBe('warm');
    const out = mod.format(d);
    expect(out).toContain('🔥');
    expect(out).not.toContain('❄️');
  });

  // ── 1–59m ──
  test('5m → Xm with ❄️ (cold)', () => {
    const d = makeData(5 * 60);
    const out = mod.format(d);
    expect(out).toContain('(5m)');
    expect(out).toMatch(/^💬:\d{2}:\d{2}\(\d+m\)❄️$/);
  });

  // ── 1–23h ──
  test('2h43m → XhYm with ❄️', () => {
    const d = makeData(2 * 3600 + 43 * 60);
    const out = mod.format(d);
    expect(out).toContain('(2h43m)');
    expect(out).toMatch(/^💬:\d{2}:\d{2}\(\d+h\d+m\)❄️$/);
  });

  // ── >= 24h ──
  test('>= 24h → "Mon DD HH:MM ❄️" — no elapsed parens', () => {
    const d = makeData(2 * 86400);
    const out = mod.format(d);
    expect(out).not.toMatch(/\(\d/);  // no parenthesised elapsed
    expect(out).toMatch(/^💬:[A-Z][a-z]+ \d{1,2} \d{2}:\d{2} ❄️$/);
  });

  test('exactly 24h boundary triggers calendar date', () => {
    const d = makeData(86400);
    const out = mod.format(d);
    expect(out).toMatch(/^💬:[A-Z][a-z]+ \d{1,2} \d{2}:\d{2} ❄️$/);
  });

  // ── no data / missing displayTime ──
  test('returns empty string when displayTime is missing', () => {
    const d = makeData(60, { displayTime: '' });
    expect(mod.format(d)).toBe('');
  });

  test('returns empty string when timestamp is null', () => {
    const d = makeData(60, { timestamp: null });
    expect(mod.format(d)).toBe('');
  });

  // ── no preview text in output ──
  test('output never contains preview text — only timer + warmth', () => {
    const d = makeData(30);
    const out = mod.format(d);
    // Format must be 💬:HH:MM(elapsed)glyph — no space+text after glyph
    expect(out).toMatch(/^💬:\d{2}:\d{2}\([^)]+\)[🔥❄️]+$/);
  });

  // ── unknown warmth ──
  test('unknown cacheWarmth → no glyph appended (< 24h)', () => {
    const d = makeData(60, { cacheWarmth: 'unknown' });
    const out = mod.format(d);
    expect(out).not.toContain('🔥');
    expect(out).not.toContain('❄️');
    expect(out).toMatch(/^💬:\d{2}:\d{2}\(\d+m\)$/);
  });
});

describe('CACHE_TTL_SECONDS constant', () => {
  test('default is 300 (5 minutes)', () => {
    expect(CACHE_TTL_SECONDS).toBe(300);
  });
});

describe('LastMessageModule config', () => {
  test('cacheTTL is 5s', () => {
    const mod = new LastMessageModule();
    expect(mod.config.cacheTTL).toBe(5000);
  });
});
