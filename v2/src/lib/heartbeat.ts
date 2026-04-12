/**
 * heartbeat.ts - Pipeline observability heartbeat writer
 *
 * Emits structured JSONL events to ~/.claude/session-health/pipeline-heartbeat.jsonl.
 * Sync FS API — used on hot paths. Never throws to caller.
 * Shell mirror: ~/_claude-configs/shell-config/lib/heartbeat.sh
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';

export interface HeartbeatLine {
  ts: string;
  component: string;
  event: string;
  latency_ms?: number;
  status: 'ok' | 'warn' | 'error' | 'info';
  extra: Record<string, unknown>;
}

interface WriteOptions {
  latencyMs?: number;
  status?: 'ok' | 'warn' | 'error' | 'info';
  extra?: Record<string, unknown>;
}

const MAX_BYTES = 10 * 1024 * 1024; // 10MB
const KEEP_ROTATIONS = 3;

function heartbeatPath(): string {
  return `${homedir()}/.claude/session-health/pipeline-heartbeat.jsonl`;
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path)) return;
    const { size } = statSync(path);
    if (size < MAX_BYTES) return;

    for (let i = KEEP_ROTATIONS - 1; i >= 1; i--) {
      const src = i === 1 ? path : `${path}.${i - 1}`;
      const dst = `${path}.${i}`;
      try { if (existsSync(src)) renameSync(src, dst); } catch { /* best-effort */ }
    }
    try { writeFileSync(`${path}.1`, ''); } catch { /* best-effort */ }
  } catch { /* rotation is best-effort; never throw */ }
}

export function writeHeartbeat(
  component: string,
  event: string,
  options: WriteOptions = {},
): void {
  try {
    const path = heartbeatPath();
    rotateIfNeeded(path);

    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

    const line: HeartbeatLine = {
      ts: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      component,
      event,
      status: options.status ?? 'ok',
      extra: options.extra ?? {},
    };
    if (options.latencyMs !== undefined) {
      line.latency_ms = Math.round(options.latencyMs);
    }

    appendFileSync(path, JSON.stringify(line) + '\n', 'utf-8');
  } catch { /* absorb all errors — observability loss > caller disruption */ }
}

export function tailHeartbeat(n: number): HeartbeatLine[] {
  try {
    const path = heartbeatPath();
    if (!existsSync(path)) return [];
    const { readFileSync } = require('fs') as typeof import('fs');
    const raw = readFileSync(path, 'utf-8');
    const lines = raw.split('\n').filter(Boolean);
    return lines
      .slice(-Math.max(0, n))
      .map(l => { try { return JSON.parse(l) as HeartbeatLine; } catch { return null; } })
      .filter((l): l is HeartbeatLine => l !== null);
  } catch { return []; }
}

export function filterRecent(component: string, maxAgeS: number): HeartbeatLine[] {
  try {
    const path = heartbeatPath();
    if (!existsSync(path)) return [];
    const { readFileSync } = require('fs') as typeof import('fs');
    const raw = readFileSync(path, 'utf-8');
    const cutoff = Date.now() - maxAgeS * 1000;
    return raw
      .split('\n')
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l) as HeartbeatLine; } catch { return null; } })
      .filter((l): l is HeartbeatLine => l !== null)
      .filter(l => l.component === component && new Date(l.ts).getTime() >= cutoff);
  } catch { return []; }
}
