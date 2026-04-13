/**
 * lkg-bad-read-counts.test.ts — P1-h: file-backed BAD_READ_COUNTS
 *
 * Tests for the file-persisted 3-strike quarantine counter in quota-schema.ts.
 * Validates: ENOENT default, increment, quarantine trigger, clear-on-success,
 * atomic-tmp-path, and corrupt-file fallback.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// ── Path override ──────────────────────────────────────────────────────────────
// We must patch homedir BEFORE each import so quota-schema resolves paths to tmpdir.

let testDir: string;
let sessionHealthDir: string;
let countsPath: string;

// We re-import quota-schema fresh on each test (cache-bust query) to get a
// clean module-level Map. The file on disk is the source of truth, but the
// in-process cache would otherwise carry state across tests in the same file.

type ReadWithLkg = typeof import('../../src/lib/quota-schema').readWithLkg;
type ValidateHotSwap = typeof import('../../src/lib/quota-schema').validateHotSwapQuota;

let readWithLkgFn: ReadWithLkg;
let validateHotSwapFn: ValidateHotSwap;

async function loadFreshModule() {
  const mod = await import(`../../src/lib/quota-schema.ts?t=${Date.now()}`);
  readWithLkgFn = mod.readWithLkg;
  validateHotSwapFn = mod.validateHotSwapQuota;
}

// Minimal valid hot-swap-quota fixture
function validQuota() {
  return { 'slot-1': { five_hour_util: 50, seven_day_util: 60 } };
}

beforeEach(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'lkg-counts-test-'));
  sessionHealthDir = join(testDir, '.claude', 'session-health');
  mkdirSync(sessionHealthDir, { recursive: true });
  countsPath = join(sessionHealthDir, '.lkg-bad-read-counts.json');

  mock.module('os', () => ({
    homedir: () => join(testDir, '.claude', '..'),
    tmpdir,
  }));

  await loadFreshModule();
});

afterEach(() => {
  mock.restore();
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* cleanup */ }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function badSourcePath() {
  return join(sessionHealthDir, 'hot-swap-quota.json');
}

function lkgPath() {
  return join(sessionHealthDir, 'hot-swap-quota.lkg.json');
}

function writeValidSource() {
  writeFileSync(badSourcePath(), JSON.stringify(validQuota()));
}

function writeBadSource() {
  writeFileSync(badSourcePath(), '{ not valid json !!!');
}

function readCountsFile(): Record<string, { count: number; first_bad_at: number; last_bad_at: number }> {
  if (!existsSync(countsPath)) return {};
  return JSON.parse(readFileSync(countsPath, 'utf-8'));
}

// ── T1: ENOENT → first bad read writes count=1 ───────────────────────────────

describe('P1-h BAD_READ_COUNTS — file-backed counter', () => {
  test('T1: first bad read on missing counts file writes count=1 with timestamps', async () => {
    writeBadSource();
    const before = Date.now();
    readWithLkgFn(badSourcePath(), validateHotSwapFn, lkgPath());
    const after = Date.now();

    const counts = readCountsFile();
    const key = badSourcePath();
    expect(counts[key]).toBeDefined();
    expect(counts[key].count).toBe(1);
    expect(counts[key].first_bad_at).toBeGreaterThanOrEqual(before);
    expect(counts[key].first_bad_at).toBeLessThanOrEqual(after);
    expect(counts[key].last_bad_at).toBeGreaterThanOrEqual(counts[key].first_bad_at);
  });

  // ── T2: existing count=1 → second bad read → count=2 ─────────────────────

  test('T2: second bad read increments count to 2, preserves first_bad_at', async () => {
    writeBadSource();
    // Seed count=1 in file
    const firstBad = Date.now() - 5000;
    writeFileSync(countsPath, JSON.stringify({
      [badSourcePath()]: { count: 1, first_bad_at: firstBad, last_bad_at: firstBad },
    }));

    // Re-import so module cache matches file state
    await loadFreshModule();
    readWithLkgFn(badSourcePath(), validateHotSwapFn, lkgPath());

    const counts = readCountsFile();
    expect(counts[badSourcePath()].count).toBe(2);
    expect(counts[badSourcePath()].first_bad_at).toBe(firstBad);
    expect(counts[badSourcePath()].last_bad_at).toBeGreaterThan(firstBad);
  });

  // ── T3: count=3 → quarantine triggered ───────────────────────────────────

  test('T3: third bad read triggers quarantine (file renamed to .corrupt-*)', async () => {
    writeBadSource();
    const src = badSourcePath();
    const firstBad = Date.now() - 10000;
    writeFileSync(countsPath, JSON.stringify({
      [src]: { count: 2, first_bad_at: firstBad, last_bad_at: firstBad },
    }));

    await loadFreshModule();
    readWithLkgFn(src, validateHotSwapFn, lkgPath());

    // Original file must be gone
    expect(existsSync(src)).toBe(false);
    // A .corrupt-* file must exist in same dir
    const dir = sessionHealthDir;
    const files = require('fs').readdirSync(dir) as string[];
    const corrupt = files.find((f: string) => f.includes('.corrupt-'));
    expect(corrupt).toBeTruthy();
    // Counter must be cleared after quarantine
    const counts = readCountsFile();
    expect(counts[src]).toBeUndefined();
  });

  // ── T4: successful read → key removed from counts file ───────────────────

  test('T4: successful read removes key from counts file', async () => {
    writeValidSource();
    // Pre-seed a count
    writeFileSync(countsPath, JSON.stringify({
      [badSourcePath()]: { count: 1, first_bad_at: Date.now(), last_bad_at: Date.now() },
    }));

    await loadFreshModule();
    const result = readWithLkgFn(badSourcePath(), validateHotSwapFn, lkgPath());

    expect(result.data).not.toBeNull();
    const counts = readCountsFile();
    expect(counts[badSourcePath()]).toBeUndefined();
  });

  // ── T5: atomic write uses .tmp.{pid} suffix ───────────────────────────────

  test('T5: atomic write uses .tmp.<pid> suffix (PID-qualified tmp path)', async () => {
    writeBadSource();
    const capturedPaths: string[] = [];
    const origWriteFileSync = require('fs').writeFileSync;
    const origRenameSync = require('fs').renameSync;

    // Spy by proxying the fs module (Bun supports mock.module)
    mock.module('fs', () => {
      const fs = require('fs') as typeof import('fs');
      return {
        ...fs,
        writeFileSync: (p: string, ...rest: unknown[]) => {
          capturedPaths.push(p);
          return (origWriteFileSync as (...a: unknown[]) => void)(p, ...rest);
        },
        renameSync: (src: string, dst: string) => {
          capturedPaths.push(`rename:${src}->${dst}`);
          return (origRenameSync as (s: string, d: string) => void)(src, dst);
        },
      };
    });

    await loadFreshModule();
    readWithLkgFn(badSourcePath(), validateHotSwapFn, lkgPath());

    // At minimum one write must use .tmp.<pid>
    const pidSuffix = `.tmp.${process.pid}`;
    const hasPidTmp = capturedPaths.some(p => p.endsWith(pidSuffix));
    expect(hasPidTmp).toBe(true);
  });

  // ── T6: malformed counts file → defaults to {} with warn heartbeat ─────────

  test('T6: malformed counts file treated as empty (defaults to {})', async () => {
    // Write invalid JSON to the counts file
    writeFileSync(countsPath, '{ broken json !!!');
    writeBadSource();

    await loadFreshModule();
    // Should not throw — bad counts file falls back to {}
    expect(() => {
      readWithLkgFn(badSourcePath(), validateHotSwapFn, lkgPath());
    }).not.toThrow();

    // After the call the file should now be a valid JSON with count=1
    const counts = readCountsFile();
    expect(counts[badSourcePath()]).toBeDefined();
    expect(counts[badSourcePath()].count).toBe(1);
  });
});
