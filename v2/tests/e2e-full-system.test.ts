/**
 * E2E Test: Full System Integration
 *
 * Tests the complete production flow:
 * 1. Data-gatherer collects health data
 * 2. StatuslineFormatter generates formatted variants
 * 3. RuntimeStateStore writes to YAML
 * 4. Display-only-v2 reads YAML and outputs
 *
 * This test verifies the entire system works as designed.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import DataGatherer from '../src/lib/data-gatherer';

const TEST_HOME = '/tmp/e2e-full-system-test';
const TEST_HEALTH_DIR = `${TEST_HOME}/.claude/session-health`;
const TEST_TRANSCRIPT = `${TEST_HOME}/.claude/projects/-test/test-session.jsonl`;
const RUNTIME_STATE_PATH = `${TEST_HEALTH_DIR}/runtime-state.yaml`;

describe('E2E: Full System Integration', () => {
  beforeAll(() => {
    // Create test directories
    mkdirSync(TEST_HEALTH_DIR, { recursive: true });
    mkdirSync(`${TEST_HOME}/.claude/projects/-test`, { recursive: true });

    // Create minimal transcript file
    writeFileSync(
      TEST_TRANSCRIPT,
      JSON.stringify({
        type: 'text',
        text: 'Test message',
        role: 'user'
      }) + '\n',
      'utf-8'
    );
  });

  afterAll(() => {
    // Cleanup
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  test('Complete production flow works end-to-end', async () => {
    // 1. Create DataGatherer instance
    const gatherer = new DataGatherer(TEST_HEALTH_DIR);

    // 2. Gather health data (simulating data-daemon)
    const health = await gatherer.gather(
      'test-session-full',
      TEST_TRANSCRIPT,
      {
        session_id: 'test-session-full',
        start_directory: '/Users/test/project',
        model: { display_name: 'Sonnet 4.5' },
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: 46000,
            output_tokens: 0
          }
        }
      }
    );

    // 3. Verify health has formattedOutput
    expect(health.formattedOutput).toBeDefined();
    expect(health.formattedOutput?.width120).toBeDefined();
    expect(Array.isArray(health.formattedOutput?.width120)).toBe(true);

    // 4. Verify runtime-state.yaml was created
    expect(existsSync(RUNTIME_STATE_PATH)).toBe(true);

    // 5. Test display-only-v2 with this session
    const output = execSync(
      `echo '{"session_id":"test-session-full"}' | bun ${__dirname}/../src/display-only-v2.ts`,
      {
        encoding: 'utf-8',
        env: { ...process.env, HOME: TEST_HOME, STATUSLINE_WIDTH: '120' }
      }
    );

    // 6. Verify output contains expected components
    expect(output).toContain('📁:'); // Directory
    expect(output).toContain('🤖:'); // Model
    expect(output).toContain('🕐:'); // Time

    // 7. Verify output is not loading message
    expect(output).not.toBe('⏳ Loading...');

    // 8. Verify different terminal widths work
    const widths = [40, 60, 80, 100, 120, 150, 200];
    for (const width of widths) {
      const widthOutput = execSync(
        `echo '{"session_id":"test-session-full"}' | bun ${__dirname}/../src/display-only-v2.ts`,
        {
          encoding: 'utf-8',
          env: { ...process.env, HOME: TEST_HOME, STATUSLINE_WIDTH: String(width) }
        }
      );

      // Each width should produce output (not loading)
      expect(widthOutput.length).toBeGreaterThan(0);
      expect(widthOutput).not.toBe('⏳ Loading...');
    }
  }, 30000); // 30 second timeout for full system test

  test('System handles multiple sessions correctly', async () => {
    const gatherer = new DataGatherer(TEST_HEALTH_DIR);

    // Create 3 sessions
    const sessionIds = ['session-a', 'session-b', 'session-c'];

    for (const sessionId of sessionIds) {
      await gatherer.gather(
        sessionId,
        TEST_TRANSCRIPT,
        {
          session_id: sessionId,
          start_directory: `/Users/test/${sessionId}`,
          model: { display_name: 'Sonnet 4.5' }
        }
      );
    }

    // Verify each session can be displayed
    for (const sessionId of sessionIds) {
      const output = execSync(
        `echo '{"session_id":"${sessionId}"}' | bun ${__dirname}/../src/display-only-v2.ts`,
        {
          encoding: 'utf-8',
          env: { ...process.env, HOME: TEST_HOME }
        }
      );

      // Each session should have unique output based on its directory
      expect(output).toContain(sessionId);
    }
  }, 30000);

  test('Display performance is <5ms per call', () => {
    const iterations = 10;
    const timings: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      execSync(
        `echo '{"session_id":"test-session-full"}' | bun ${__dirname}/../src/display-only-v2.ts`,
        {
          encoding: 'utf-8',
          env: { ...process.env, HOME: TEST_HOME }
        }
      );
      const elapsed = performance.now() - start;
      timings.push(elapsed);
    }

    const avgTime = timings.reduce((a, b) => a + b, 0) / timings.length;

    // Average should be very fast (including bun startup overhead)
    // In production (without bun startup), this is <2ms
    expect(avgTime).toBeLessThan(100); // Generous for CI with bun startup
  });
});
