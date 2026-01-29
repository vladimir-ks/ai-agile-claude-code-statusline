#!/usr/bin/env node
/**
 * Runtime Comparison Benchmark: Bun vs Node.js
 *
 * Tests:
 * 1. Cold start time (script startup to first output)
 * 2. Memory footprint (heap usage)
 * 3. JSON parsing performance
 * 4. Subprocess execution (ccusage, git)
 *
 * Usage:
 *   node v2/benchmarks/runtime-comparison.ts
 *   bun v2/benchmarks/runtime-comparison.ts
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';

const execAsync = promisify(exec);

interface BenchmarkResult {
  runtime: string;
  version: string;
  coldStartMs: number;
  memoryMB: number;
  jsonParseMs: number;
  subprocessMs: number;
  timestamp: string;
}

const TEST_JSON = JSON.stringify({
  context_window: {
    context_window_size: 200000,
    current_usage: {
      input_tokens: 50000,
      output_tokens: 5000,
      cache_read_input_tokens: 100000,
      cache_creation_input_tokens: 10000
    }
  },
  model: { display_name: 'Claude Sonnet 4.5' },
  session_id: 'test-session-id'
});

// Benchmark 1: Memory footprint
function getMemoryUsage(): number {
  const mem = process.memoryUsage();
  return Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100; // MB
}

// Benchmark 2: JSON parsing
async function benchmarkJsonParsing(): Promise<number> {
  const iterations = 10000;
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    JSON.parse(TEST_JSON);
  }

  const end = performance.now();
  return Math.round((end - start) * 100) / 100;
}

// Benchmark 3: Subprocess execution
async function benchmarkSubprocess(): Promise<number> {
  const start = performance.now();

  try {
    // Test with a fast command (echo)
    await execAsync('echo "test"');
  } catch (error) {
    console.error('Subprocess benchmark failed:', error);
    return -1;
  }

  const end = performance.now();
  return Math.round((end - start) * 100) / 100;
}

// Detect runtime
function getRuntime(): string {
  // Check if Bun global is available
  if (typeof (globalThis as any).Bun !== 'undefined') {
    return 'bun';
  }
  return 'nodejs';
}

// Get runtime version
function getVersion(): string {
  const runtime = getRuntime();

  if (runtime === 'bun') {
    return (globalThis as any).Bun.version || 'unknown';
  }

  return process.version;
}

async function runBenchmarks(): Promise<BenchmarkResult> {
  const runtime = getRuntime();
  const version = getVersion();

  console.log(`Running benchmarks on ${runtime} ${version}...\n`);

  // Cold start time (measured externally, placeholder here)
  const coldStartMs = 0; // Will be measured by wrapper script

  // Memory footprint
  console.log('Testing memory footprint...');
  const memoryMB = getMemoryUsage();
  console.log(`  Memory: ${memoryMB} MB`);

  // JSON parsing
  console.log('Testing JSON parsing (10k iterations)...');
  const jsonParseMs = await benchmarkJsonParsing();
  console.log(`  JSON parse: ${jsonParseMs} ms`);

  // Subprocess execution
  console.log('Testing subprocess execution...');
  const subprocessMs = await benchmarkSubprocess();
  console.log(`  Subprocess: ${subprocessMs} ms`);

  return {
    runtime,
    version,
    coldStartMs,
    memoryMB,
    jsonParseMs,
    subprocessMs,
    timestamp: new Date().toISOString()
  };
}

async function main() {
  const result = await runBenchmarks();

  console.log('\n--- Benchmark Results ---');
  console.log(JSON.stringify(result, null, 2));

  // Save to file
  const outputPath = `v2/benchmarks/results-${result.runtime}.json`;
  await fs.writeFile(outputPath, JSON.stringify(result, null, 2));
  console.log(`\nResults saved to: ${outputPath}`);
}

main().catch(console.error);
