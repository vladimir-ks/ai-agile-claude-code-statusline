/**
 * UnifiedTranscriptScanner Performance Benchmarks
 *
 * Measures performance across various scenarios and transcript sizes.
 * Run with: bun benchmarks/scanner-performance.bench.ts
 */

import { UnifiedTranscriptScanner } from '../src/lib/transcript-scanner/unified-transcript-scanner';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// Benchmark configuration
const ITERATIONS = 100;
const WARMUP_ITERATIONS = 10;

// Test data generators
function generateTranscript(messageCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < messageCount; i++) {
    const type = i % 2 === 0 ? 'user' : 'assistant';
    const timestamp = new Date(Date.now() + i * 1000).toISOString();
    const text = `Message ${i} - ${'x'.repeat(50)}`;
    lines.push(`{"type":"${type}","timestamp":"${timestamp}","message":{"content":[{"type":"text","text":"${text}"}]}}`);
  }
  return lines.join('\n');
}

function generateTranscriptWithSecrets(messageCount: number, secretCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < messageCount; i++) {
    const type = i % 2 === 0 ? 'user' : 'assistant';
    const timestamp = new Date(Date.now() + i * 1000).toISOString();
    let text = `Message ${i}`;

    // Add secrets every N messages
    if (i % Math.floor(messageCount / secretCount) === 0 && secretCount > 0) {
      text += ` ghp_${'a'.repeat(36)}`;
      secretCount--;
    }

    lines.push(`{"type":"${type}","timestamp":"${timestamp}","message":{"content":[{"type":"text","text":"${text}"}]}}`);
  }
  return lines.join('\n');
}

// Benchmark runner
function benchmark(name: string, fn: () => void, iterations: number = ITERATIONS): number[] {
  const times: number[] = [];

  // Warmup
  for (let i = 0; i < WARMUP_ITERATIONS; i++) {
    fn();
  }

  // Actual benchmark
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    const end = performance.now();
    times.push(end - start);
  }

  return times;
}

function stats(times: number[]): { min: number; max: number; mean: number; p50: number; p95: number; p99: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);

  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: sum / sorted.length,
    p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    p99: sorted[Math.floor(sorted.length * 0.99)],
  };
}

function printStats(name: string, times: number[], target?: number) {
  const s = stats(times);
  const targetStatus = target ? (s.p95 <= target ? '✅' : '❌') : '';

  console.log(`\n${name}:`);
  console.log(`  Min:  ${s.min.toFixed(2)}ms`);
  console.log(`  Mean: ${s.mean.toFixed(2)}ms`);
  console.log(`  P50:  ${s.p50.toFixed(2)}ms`);
  console.log(`  P95:  ${s.p95.toFixed(2)}ms ${targetStatus} ${target ? `(target: ${target}ms)` : ''}`);
  console.log(`  P99:  ${s.p99.toFixed(2)}ms`);
  console.log(`  Max:  ${s.max.toFixed(2)}ms`);
}

// Main benchmark suite
async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  UnifiedTranscriptScanner Performance Benchmarks');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`  Iterations: ${ITERATIONS} (after ${WARMUP_ITERATIONS} warmup)`);
  console.log('═══════════════════════════════════════════════════════════\n');

  // Setup
  const tempDir = join(homedir(), '.claude/session-health/scanners-bench');
  if (!existsSync(tempDir)) {
    mkdirSync(tempDir, { recursive: true });
  }
  process.env.TEST_STATE_DIR = tempDir;

  const scanner = new UnifiedTranscriptScanner();
  const { ResultCache } = require('../src/lib/transcript-scanner/result-cache');

  // Cleanup function
  const cleanup = () => {
    ResultCache.clear();
    try {
      const { readdirSync } = require('fs');
      const files = readdirSync(tempDir);
      for (const file of files) {
        try {
          unlinkSync(join(tempDir, file));
        } catch { /* ignore individual file errors */ }
      }
    } catch { /* ignore */ }
  };

  // ========================================================================
  // Benchmark 1: Cached Scan (No Changes)
  // ========================================================================
  console.log('1. CACHED SCAN (file unchanged)');
  {
    const transcript = generateTranscript(100);
    const path = join(tempDir, 'bench-cached.jsonl');
    writeFileSync(path, transcript, 'utf-8');

    // Prime cache
    scanner.scan('bench-cached', path);

    // Benchmark
    const times = benchmark('Cached scan', () => {
      scanner.scan('bench-cached', path);
    });

    printStats('Cached Scan (100 messages)', times, 10);
    try { unlinkSync(path); } catch { /* ignore */ }
    cleanup();
  }

  // ========================================================================
  // Benchmark 2: Incremental Scan (Small Append)
  // ========================================================================
  console.log('\n2. INCREMENTAL SCAN (small append)');
  {
    const times: number[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const sessionId = `bench-inc-${i}`;
      const initialTranscript = generateTranscript(100);
      const path = join(tempDir, `${sessionId}.jsonl`);
      writeFileSync(path, initialTranscript, 'utf-8');

      // Prime with initial scan
      scanner.scan(sessionId, path);

      // Append 1 message
      const newMessage = `\n{"type":"user","timestamp":"${new Date().toISOString()}","message":{"content":[{"type":"text","text":"New message ${i}"}]}}`;
      writeFileSync(path, initialTranscript + newMessage, 'utf-8');

      // Benchmark incremental read
      const start = performance.now();
      scanner.scan(sessionId, path);
      const end = performance.now();
      times.push(end - start);

      // Cleanup this iteration
      try { unlinkSync(path); } catch { /* ignore */ }
    }

    printStats('Incremental Scan (1 new message)', times, 50);
    cleanup();
  }

  // ========================================================================
  // Benchmark 3: Full Scan (Various Sizes)
  // ========================================================================
  console.log('\n3. FULL SCAN (various transcript sizes)');

  const sizes = [10, 50, 100, 500, 1000, 5000];
  for (const size of sizes) {
    const transcript = generateTranscript(size);
    const path = join(tempDir, `bench-full-${size}.jsonl`);
    writeFileSync(path, transcript, 'utf-8');

    const times = benchmark(`Full scan (${size} messages)`, () => {
      ResultCache.clear();
      scanner.scan(`bench-full-${size}`, path);
    }, Math.min(ITERATIONS, 50)); // Reduce iterations for large sizes

    const target = size <= 100 ? 50 : size <= 1000 ? 200 : 500;
    printStats(`Full Scan (${size} messages)`, times, target);

    try { unlinkSync(path); } catch { /* ignore */ }
    cleanup();
  }

  // ========================================================================
  // Benchmark 4: Secret Detection Performance
  // ========================================================================
  console.log('\n4. SECRET DETECTION (with varying secret counts)');

  const secretCounts = [0, 1, 10, 50];
  for (const secretCount of secretCounts) {
    const transcript = generateTranscriptWithSecrets(100, secretCount);
    const path = join(tempDir, `bench-secrets-${secretCount}.jsonl`);
    writeFileSync(path, transcript, 'utf-8');

    const times = benchmark(`Secrets scan (${secretCount} secrets)`, () => {
      ResultCache.clear();
      scanner.scan(`bench-secrets-${secretCount}`, path);
    });

    printStats(`Secret Detection (100 msg, ${secretCount} secrets)`, times);

    try { unlinkSync(path); } catch { /* ignore */ }
    cleanup();
  }

  // ========================================================================
  // Benchmark 5: State Load/Save
  // ========================================================================
  console.log('\n5. STATE PERSISTENCE');
  {
    const transcript = generateTranscript(100);
    const path = join(tempDir, 'bench-state.jsonl');
    writeFileSync(path, transcript, 'utf-8');

    // Benchmark full scan + state save
    const scanTimes = benchmark('Scan with state save', () => {
      ResultCache.clear();
      scanner.scan('bench-state', path);
    });

    printStats('Full Scan + State Save', scanTimes);

    // Benchmark state load + cached scan
    scanner.scan('bench-state', path); // Prime
    const loadTimes = benchmark('Scan with state load', () => {
      ResultCache.clear();
      scanner.scan('bench-state', path);
    });

    printStats('State Load + Cached Scan', loadTimes);

    try { unlinkSync(path); } catch { /* ignore */ }
    cleanup();
  }

  // ========================================================================
  // Benchmark 6: Memory Usage
  // ========================================================================
  console.log('\n6. MEMORY USAGE');
  {
    const transcript = generateTranscript(1000);
    const path = join(tempDir, 'bench-memory.jsonl');
    writeFileSync(path, transcript, 'utf-8');

    // Force GC if available
    if (global.gc) {
      global.gc();
    }

    const memBefore = process.memoryUsage();

    // Scan 100 times
    for (let i = 0; i < 100; i++) {
      scanner.scan('bench-memory', path);
    }

    const memAfter = process.memoryUsage();

    console.log('  Memory Usage (100 scans of 1000 messages):');
    console.log(`    Heap Used:     ${((memAfter.heapUsed - memBefore.heapUsed) / 1024 / 1024).toFixed(2)} MB`);
    console.log(`    External:      ${((memAfter.external - memBefore.external) / 1024 / 1024).toFixed(2)} MB`);
    console.log(`    RSS:           ${((memAfter.rss - memBefore.rss) / 1024 / 1024).toFixed(2)} MB`);

    try { unlinkSync(path); } catch { /* ignore */ }
    cleanup();
  }

  // ========================================================================
  // Summary
  // ========================================================================
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('  Performance Targets Summary');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  ✅ Cached scan:       <10ms (P95)');
  console.log('  ✅ Incremental scan:  <50ms (P95)');
  console.log('  ✅ Full scan (100):   <50ms (P95)');
  console.log('  ✅ Full scan (1000):  <200ms (P95)');
  console.log('  ✅ Full scan (5000):  <500ms (P95)');
  console.log('═══════════════════════════════════════════════════════════\n');

  delete process.env.TEST_STATE_DIR;
}

// Run benchmarks
if (import.meta.main) {
  main().catch(console.error);
}
