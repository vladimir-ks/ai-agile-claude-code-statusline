/**
 * Formatter Unit Tests
 *
 * Direct tests for formatting functions to validate edge cases
 * that aren't covered by integration tests.
 */

import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';
import { join } from 'path';

// Since formatters are private functions in display-only.ts,
// we test them indirectly through a test harness
const DISPLAY_SCRIPT = join(__dirname, '../src/display-only.ts');

// Helper to extract formatted values from output
function getDisplayOutput(healthData: object, stdinOverrides: object = {}): string {
  const stdin = JSON.stringify({
    session_id: 'formatter-test',
    ...stdinOverrides
  });

  const fs = require('fs');
  const path = require('path');
  const testDir = '/tmp/formatter-test-home/.claude/session-health';

  // Ensure directory exists
  fs.mkdirSync(testDir, { recursive: true });
  fs.writeFileSync(
    path.join(testDir, 'formatter-test.json'),
    JSON.stringify({ sessionId: 'formatter-test', ...healthData })
  );

  try {
    return execSync(
      `echo '${stdin.replace(/'/g, "'\\''")}' | bun ${DISPLAY_SCRIPT}`,
      {
        encoding: 'utf-8',
        timeout: 1000,
        env: { ...process.env, HOME: '/tmp/formatter-test-home', NO_COLOR: '1' }
      }
    );
  } catch (error: any) {
    return error.stdout || '';
  }
}

describe('formatTokens', () => {
  // Test via context component which uses formatTokens

  test('0 tokens shows as 0', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 0, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    expect(output).toContain('🧠:0left[');
  });

  test('999 tokens shows as 999', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 999, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    expect(output).toContain('🧠:999left[');
  });

  test('1000 tokens shows as 1k', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 1000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    expect(output).toContain('🧠:1kleft[');
  });

  test('999999 tokens shows as 999k', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 999999, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    expect(output).toContain('🧠:999kleft[');
  });

  test('1000000 tokens shows as 1.0M', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 1000000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    expect(output).toContain('🧠:1.0Mleft[');
  });

  test('1500000 tokens shows as 1.5M', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 1500000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    expect(output).toContain('🧠:1.5Mleft[');
  });

  test('negative tokens shows as 0', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: -100, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    expect(output).toContain('🧠:0left[');
  });

  test('null tokens shows as 0', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: null, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    expect(output).toContain('🧠:0left[');
  });
});

describe('formatMoney', () => {
  // Test via cost component which uses formatMoney

  test('$0.01 shows with 2 decimals', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: { costToday: 0.01, burnRatePerHour: 0, isFresh: true },
      alerts: {}
    });
    expect(output).toContain('💰:$0.01');
  });

  test('$9.99 shows with 2 decimals', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: { costToday: 9.99, burnRatePerHour: 0, isFresh: true },
      alerts: {}
    });
    expect(output).toContain('💰:$9.99');
  });

  test('$10 shows without decimals', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: { costToday: 10, burnRatePerHour: 0, isFresh: true },
      alerts: {}
    });
    expect(output).toContain('💰:$10');
  });

  test('$10.5 shows with 1 decimal', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: { costToday: 10.5, burnRatePerHour: 0, isFresh: true },
      alerts: {}
    });
    expect(output).toContain('💰:$10.5');
  });

  test('$100 shows without decimals', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: { costToday: 100, burnRatePerHour: 0, isFresh: true },
      alerts: {}
    });
    expect(output).toContain('💰:$100');
  });

  test('$186.75 shows as $186 (rounded)', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: { costToday: 186.75, burnRatePerHour: 0, isFresh: true },
      alerts: {}
    });
    expect(output).toContain('💰:$186');
  });
});

describe('generateProgressBar', () => {
  // Test progress bar rendering

  test('0% shows empty bar', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    // Bar should be [---------|-­-] at 0% (12 chars, threshold at pos 9)
    expect(output).toMatch(/\[---------\|--\]/);
  });

  test('50% shows half filled', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 50 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    // At 50% of 12 chars = 6 filled (threshold at pos 9)
    expect(output).toMatch(/\[======---\|--\]/);
  });

  test('100% shows full bar', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 0, percentUsed: 100 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    // At 100%, all 12 chars filled
    expect(output).toMatch(/\[=========\|==\]/);
  });

  test('threshold marker at position 9', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 25 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: {}
    });
    // | should always be at position 9 (12-char bar, 78% threshold)
    const match = output.match(/\[(.{9})\|(.+)\]/);
    expect(match).not.toBeNull();
  });
});

describe('shortenPath', () => {
  // Test path shortening

  test('short path shown as-is', () => {
    const output = getDisplayOutput(
      {
        context: { tokensLeft: 100000, percentUsed: 0 },
        model: { value: 'Claude' },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        git: {},
        billing: {},
        alerts: {}
      },
      { start_directory: '/tmp/formatter-test-home/short' }
    );
    expect(output).toContain('📁:~/short');
  });

  test('long home path preserves tilde', () => {
    const output = getDisplayOutput(
      {
        context: { tokensLeft: 100000, percentUsed: 0 },
        model: { value: 'Claude' },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        git: {},
        billing: {},
        alerts: {}
      },
      { start_directory: '/tmp/formatter-test-home/very/long/nested/path/to/project' }
    );
    // Should start with ~
    expect(output).toContain('📁:~');
    expect(output).toContain('project');
  });

  test('non-home path works', () => {
    const output = getDisplayOutput(
      {
        context: { tokensLeft: 100000, percentUsed: 0 },
        model: { value: 'Claude' },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        git: {},
        billing: {},
        alerts: {}
      },
      { start_directory: '/var/log/myapp' }
    );
    expect(output).toContain('📁:');
    expect(output).toContain('myapp');
  });
});

describe('fmtBudget edge cases', () => {
  test('handles null billing gracefully', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: null,
      alerts: {}
    });
    // Should not crash, should not show budget
    expect(output).not.toContain('undefined');
    expect(output).not.toContain('NaN');
  });

  test('handles negative budget gracefully', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: { budgetRemaining: -60, isFresh: true },
      alerts: {}
    });
    // Should show 0h0m (clamped to 0)
    expect(output).toContain('⌛:0h0m');
  });
});

describe('fmtSecrets edge cases', () => {
  test('handles null secretTypes gracefully', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: { secretsDetected: true, secretTypes: null }
    });
    // Should show warning without crashing (new format: 🔐0types instead of 🔐SECRETS!)
    expect(output).toContain('🔐');
    expect(output).not.toContain('undefined');
  });

  test('handles empty secretTypes array', () => {
    const output = getDisplayOutput({
      context: { tokensLeft: 100000, percentUsed: 0 },
      model: { value: 'Claude' },
      transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
      git: {},
      billing: {},
      alerts: { secretsDetected: true, secretTypes: [] }
    });
    expect(output).toContain('🔐'); // New format: 🔐0types
  });
});
