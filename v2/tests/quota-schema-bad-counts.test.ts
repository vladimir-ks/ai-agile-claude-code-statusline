/**
 * Tests for v2/src/lib/quota-schema.ts — file-backed bad-read counter
 *
 * The counter file lives under os.homedir(), which bun resolves once per
 * process, so each case runs in a child process with its own HOME.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const SCHEMA_MODULE = join(__dirname, '../src/lib/quota-schema.ts');

let home: string;
let countsPath: string;

function run(script: string): string {
  return execFileSync('bun', ['-e', script], {
    encoding: 'utf-8',
    timeout: 20_000,
    env: { ...process.env, HOME: home },
  });
}

function readCounts(): Record<string, { count: number }> {
  if (!existsSync(countsPath)) return {};
  return JSON.parse(readFileSync(countsPath, 'utf-8'));
}

describe('quota-schema bad-read counter', () => {
  beforeEach(() => {
    home = join(tmpdir(), `qs-badcount-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    countsPath = join(home, '.claude/session-health/.lkg-bad-read-counts.json');
    mkdirSync(join(home, '.claude/session-health'), { recursive: true });
  });

  afterEach(() => {
    try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('a path that never resolves has its counter cleared at 3 strikes', () => {
    const missing = join(home, 'never-exists.json');
    run(`
      const { readWithLkg } = await import(${JSON.stringify(SCHEMA_MODULE)});
      for (let i = 0; i < 9; i++) {
        readWithLkg(${JSON.stringify(missing)}, () => ({ ok: false, errors: ['x'] }), ${JSON.stringify(missing + '.lkg')});
      }
    `);

    const counts = readCounts();
    // 9 bad reads = 3 full 3-strike cycles, each ending in a clear.
    expect(counts[missing]).toBeUndefined();
  });

  test('the counter still reaches 3 before clearing (quarantine contract intact)', () => {
    const missing = join(home, 'never-exists.json');
    const out = run(`
      const { readWithLkg } = await import(${JSON.stringify(SCHEMA_MODULE)});
      const { readFileSync, existsSync } = await import('fs');
      const p = ${JSON.stringify(countsPath)};
      const seen = [];
      for (let i = 0; i < 3; i++) {
        readWithLkg(${JSON.stringify(missing)}, () => ({ ok: false, errors: ['x'] }), ${JSON.stringify(missing + '.lkg')});
        seen.push(existsSync(p) ? (JSON.parse(readFileSync(p, 'utf-8'))[${JSON.stringify(missing)}]?.count ?? 0) : 0);
      }
      console.log(JSON.stringify(seen));
    `);
    expect(JSON.parse(out.trim())).toEqual([1, 2, 0]);
  });

  test('a corrupt file that EXISTS is still quarantined at 3 strikes', () => {
    const bad = join(home, 'corrupt.json');
    writeFileSync(bad, 'NOT JSON {{{');
    run(`
      const { readWithLkg } = await import(${JSON.stringify(SCHEMA_MODULE)});
      for (let i = 0; i < 3; i++) {
        readWithLkg(${JSON.stringify(bad)}, () => ({ ok: false, errors: ['x'] }), ${JSON.stringify(bad + '.lkg')});
      }
    `);

    expect(existsSync(bad)).toBe(false);
    const { readdirSync } = require('fs');
    const quarantined = readdirSync(home).filter((f: string) => f.startsWith('corrupt.json.corrupt-'));
    expect(quarantined.length).toBe(1);
    expect(readCounts()[bad]).toBeUndefined();
  });

  test('dead keys are pruned from the counts file on write', () => {
    const seed: Record<string, unknown> = {};
    const old = Date.now() - 7200_000;
    for (let i = 0; i < 40; i++) {
      seed[`/var/folders/zz/broker-client-test-${i}/merged-quota-cache.json`] =
        { count: 122419, first_bad_at: old, last_bad_at: old };
    }
    const live = join(home, 'live.json');
    writeFileSync(live, 'NOT JSON {{{');
    seed[live] = { count: 1, first_bad_at: old, last_bad_at: old };
    writeFileSync(countsPath, JSON.stringify(seed));

    run(`
      const { readWithLkg } = await import(${JSON.stringify(SCHEMA_MODULE)});
      readWithLkg(${JSON.stringify(live)}, () => ({ ok: false, errors: ['x'] }), ${JSON.stringify(live + '.lkg')});
    `);

    const counts = readCounts();
    const deadKeys = Object.keys(counts).filter(k => k.includes('broker-client-test-'));
    expect(deadKeys).toEqual([]);
  });

  test('a successful read clears the counter and writes the LKG', () => {
    const good = join(home, 'good.json');
    writeFileSync(good, JSON.stringify({ ok: 1 }));
    writeFileSync(countsPath, JSON.stringify({
      [good]: { count: 2, first_bad_at: Date.now(), last_bad_at: Date.now() },
    }));

    run(`
      const { readWithLkg } = await import(${JSON.stringify(SCHEMA_MODULE)});
      readWithLkg(${JSON.stringify(good)}, () => ({ ok: true, errors: [] }), ${JSON.stringify(good + '.lkg')});
    `);

    expect(readCounts()[good]).toBeUndefined();
    expect(existsSync(good + '.lkg')).toBe(true);
  });

  test('repeated LKG writes leave no temp-file litter', () => {
    const good = join(home, 'good.json');
    writeFileSync(good, JSON.stringify({ ok: 1 }));
    run(`
      const { readWithLkg } = await import(${JSON.stringify(SCHEMA_MODULE)});
      for (let i = 0; i < 3; i++) {
        readWithLkg(${JSON.stringify(good)}, () => ({ ok: true, errors: [] }), ${JSON.stringify(good + '.lkg')});
      }
    `);

    const { readdirSync } = require('fs');
    expect(readdirSync(home).filter((f: string) => f.includes('.tmp'))).toEqual([]);
    expect(existsSync(good + '.lkg')).toBe(true);
  });
});
