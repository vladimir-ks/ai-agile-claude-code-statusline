/**
 * Formatter Unit Tests
 *
 * Direct tests for formatting functions to validate edge cases
 * that aren't covered by integration tests.
 */

import { describe, test, expect } from 'bun:test';
import { execSync } from 'child_process';
import { join } from 'path';
import { withFormattedOutput } from './helpers/with-formatted-output';

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

  // Add formattedOutput to health data
  // Use start_directory from stdin as projectPath if provided
  const projectPath = stdinOverrides.start_directory || '';
  const healthWithFormatted = withFormattedOutput({
    sessionId: 'formatter-test',
    projectPath,
    ...healthData
  });

  fs.writeFileSync(
    path.join(testDir, 'formatter-test.json'),
    JSON.stringify(healthWithFormatted)
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
    expect(output).toContain('🧠:0-free[');
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
    expect(output).toContain('🧠:999-free[');
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
    expect(output).toContain('🧠:1k-free[');
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
    expect(output).toContain('🧠:999k-free[');
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
    expect(output).toContain('🧠:1.0M-free[');
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
    expect(output).toContain('🧠:1.5M-free[');
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
    expect(output).toContain('🧠:0-free[');
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
    expect(output).toContain('🧠:0-free[');
  });
});

// formatMoney tests removed — cost moved from line 2 to account context notification line.
// formatMoney helper is still correct (private, unchanged); exercised via notification rendering.

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
  // Note: ~ substitution only works when path actually starts with real homedir

  test('short path shown in full', () => {
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
    // HOME=/tmp/formatter-test-home → path becomes ~/short
    expect(output).toContain('📁:~/short');
  });

  test('long path shown in full (no truncation)', () => {
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
    // Full path shown (spec: NEVER truncate directory) — ~ replaces HOME prefix
    expect(output).toContain('📁:~/very/long/nested/path/to/project');
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
      billing: { budgetRemaining: -60, isFresh: true, lastFetched: Date.now() },
      alerts: {}
    });
    // Budget moved to notification line — just verify no crash, no NaN
    expect(output).not.toContain('NaN');
    expect(output).not.toContain('undefined');
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
    // Should NOT crash with null secretTypes (filters gracefully)
    expect(output).not.toContain('undefined');
    expect(output).not.toContain('null');
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
    // Empty secretTypes array = no actual secrets (filters gracefully)
    expect(output).not.toContain('undefined');
  });
});
