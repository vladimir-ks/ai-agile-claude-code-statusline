/**
 * heartbeat.ts — Unit tests
 * Covers: write, rotation, tail, filterRecent, error absorption
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Path override ──────────────────────────────────────────────────────────────
// We monkey-patch homedir BEFORE importing heartbeat so the path resolves to tmpdir.
let testDir = '';
let heartbeatPath = '';

let writeHeartbeatFn: typeof import('../../src/lib/heartbeat').writeHeartbeat;
let tailHeartbeatFn: typeof import('../../src/lib/heartbeat').tailHeartbeat;
let filterRecentFn: typeof import('../../src/lib/heartbeat').filterRecent;

// Bun supports module mocking via mock.module
// We intercept homedir so all path resolution in heartbeat.ts uses our tmpdir

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'hb-test-'));
  const sessionHealth = join(testDir, '.claude', 'session-health');
  mkdirSync(sessionHealth, { recursive: true });
  heartbeatPath = join(sessionHealth, 'pipeline-heartbeat.jsonl');

  mock.module('os', () => ({
    homedir: () => join(testDir, '.claude', '..'),
    tmpdir,
  }));

  // Re-import with patched homedir
  // Bun caches modules; use dynamic import with cache bust via query string
  const mod = await import(`../../src/lib/heartbeat.ts?t=${Date.now()}`);
  writeHeartbeatFn = mod.writeHeartbeat;
  tailHeartbeatFn = mod.tailHeartbeat;
  filterRecentFn = mod.filterRecent;
});

afterEach(() => {
  mock.restore();
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function readLines(): string[] {
  if (!existsSync(heartbeatPath)) return [];
  return readFileSync(heartbeatPath, 'utf-8').split('\n').filter(Boolean);
}

function parseLine(line: string) {
  return JSON.parse(line);
}

// ── writeHeartbeat ────────────────────────────────────────────────────────────

describe('writeHeartbeat — basic output', () => {
  test('writes exactly one line', () => {
    writeHeartbeatFn('fetch-quotas', 'fetch_success');
    expect(readLines().length).toBe(1);
  });

  test('line contains correct component', () => {
    writeHeartbeatFn('fetch-quotas', 'fetch_success');
    const obj = parseLine(readLines()[0]);
    expect(obj.component).toBe('fetch-quotas');
  });

  test('line contains correct event', () => {
    writeHeartbeatFn('fetch-quotas', 'fetch_success');
    const obj = parseLine(readLines()[0]);
    expect(obj.event).toBe('fetch_success');
  });

  test('ts field is ISO8601', () => {
    writeHeartbeatFn('quota-broker', 'merge');
    const obj = parseLine(readLines()[0]);
    expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  test('default status is ok', () => {
    writeHeartbeatFn('quota-broker', 'merge');
    const obj = parseLine(readLines()[0]);
    expect(obj.status).toBe('ok');
  });

  test('default extra is empty object', () => {
    writeHeartbeatFn('quota-broker', 'merge');
    const obj = parseLine(readLines()[0]);
    expect(obj.extra).toEqual({});
  });

  test('latency_ms present when provided', () => {
    writeHeartbeatFn('fetch-quotas', 'fetch_success', { latencyMs: 234 });
    const obj = parseLine(readLines()[0]);
    expect(obj.latency_ms).toBe(234);
  });

  test('latency_ms absent when not provided', () => {
    writeHeartbeatFn('quota-broker', 'merge');
    const obj = parseLine(readLines()[0]);
    expect('latency_ms' in obj).toBe(false);
  });

  test('custom status passes through', () => {
    writeHeartbeatFn('quota-broker', 'validation_fail', { status: 'error' });
    const obj = parseLine(readLines()[0]);
    expect(obj.status).toBe('error');
  });

  test('extra object passes through', () => {
    writeHeartbeatFn('quota-broker', 'merge', { extra: { slot: 'slot-1', count: 3 } });
    const obj = parseLine(readLines()[0]);
    expect(obj.extra).toEqual({ slot: 'slot-1', count: 3 });
  });

  test('multiple writes accumulate lines', () => {
    writeHeartbeatFn('a', 'ev1');
    writeHeartbeatFn('b', 'ev2');
    writeHeartbeatFn('c', 'ev3');
    expect(readLines().length).toBe(3);
  });
});

// ── rotation ──────────────────────────────────────────────────────────────────

describe('writeHeartbeat — log rotation', () => {
  test('rotation fires when file exceeds 10MB', () => {
    const big = 'x'.repeat(1024);
    let content = '';
    for (let i = 0; i < 10241; i++) content += big;
    writeFileSync(heartbeatPath, content);

    writeHeartbeatFn('fetch-quotas', 'after_rotate');

    expect(existsSync(heartbeatPath + '.1')).toBe(true);
    const newLines = readLines();
    expect(newLines.length).toBe(1);
  });

  test('no rotation when file is small', () => {
    writeHeartbeatFn('a', 'ev1');
    writeHeartbeatFn('a', 'ev2');
    expect(existsSync(heartbeatPath + '.1')).toBe(false);
  });
});

// ── tailHeartbeat ─────────────────────────────────────────────────────────────

describe('tailHeartbeat', () => {
  test('returns last N lines', () => {
    for (let i = 0; i < 5; i++) writeHeartbeatFn(`comp-${i}`, 'ev');
    const result = tailHeartbeatFn(3);
    expect(result.length).toBe(3);
  });

  test('last component is in result', () => {
    for (let i = 0; i < 5; i++) writeHeartbeatFn(`comp-${i}`, 'ev');
    const result = tailHeartbeatFn(3);
    expect(result.some(l => l.component === 'comp-4')).toBe(true);
  });

  test('returns empty array when file missing', () => {
    const result = tailHeartbeatFn(10);
    expect(result).toEqual([]);
  });

  test('returns parsed HeartbeatLine objects', () => {
    writeHeartbeatFn('quota-broker', 'merge', { latencyMs: 10, status: 'ok' });
    const [line] = tailHeartbeatFn(1);
    expect(typeof line.ts).toBe('string');
    expect(line.status).toBe('ok');
  });
});

// ── filterRecent ──────────────────────────────────────────────────────────────

describe('filterRecent', () => {
  test('excludes old entries', () => {
    const oldLine = JSON.stringify({
      ts: '2020-01-01T00:00:00Z',
      component: 'fetch-quotas',
      event: 'ancient',
      status: 'ok',
      extra: {},
    });
    writeFileSync(heartbeatPath, oldLine + '\n');
    writeHeartbeatFn('fetch-quotas', 'current_event');

    const result = filterRecentFn('fetch-quotas', 60);
    expect(result.some(l => l.event === 'ancient')).toBe(false);
  });

  test('includes current entries', () => {
    writeHeartbeatFn('fetch-quotas', 'current_event');
    const result = filterRecentFn('fetch-quotas', 300);
    expect(result.some(l => l.event === 'current_event')).toBe(true);
  });

  test('filters by component', () => {
    writeHeartbeatFn('comp-A', 'ev1');
    writeHeartbeatFn('comp-B', 'ev2');
    const result = filterRecentFn('comp-A', 300);
    expect(result.every(l => l.component === 'comp-A')).toBe(true);
    expect(result.some(l => l.component === 'comp-B')).toBe(false);
  });

  test('returns empty when file missing', () => {
    expect(filterRecentFn('fetch-quotas', 300)).toEqual([]);
  });
});

// ── error absorption ──────────────────────────────────────────────────────────

describe('writeHeartbeat — error absorption', () => {
  test('does not throw when write fails due to unwritable dir', () => {
    // Override homedir to a path where mkdir will fail
    mock.module('os', () => ({
      homedir: () => '/proc/1/does-not-exist-for-write',
      tmpdir,
    }));
    expect(() => writeHeartbeatFn('fetch-quotas', 'test')).not.toThrow();
  });
});
