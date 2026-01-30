/**
 * Display-Only Tests
 *
 * Tests for the bulletproof display layer that ONLY reads JSON files
 * and NEVER does network/subprocess operations.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const TEST_HEALTH_DIR = '/tmp/test-display-only-health';
const DISPLAY_SCRIPT = join(__dirname, '../src/display-only.ts');

// Helper to run display-only with mocked health dir
function runDisplay(stdin: string, healthDir: string = TEST_HEALTH_DIR): { output: string; time: number } {
  const start = Date.now();
  try {
    // Set HOME to redirect health dir lookups
    // Set NO_COLOR=1 to disable ANSI colors for consistent test output
    const output = execSync(
      `echo '${stdin.replace(/'/g, "'\\''")}' | bun ${DISPLAY_SCRIPT}`,
      {
        encoding: 'utf-8',
        timeout: 1000,  // 1 second max (should be <50ms)
        env: { ...process.env, HOME: '/tmp/test-display-home', NO_COLOR: '1' }
      }
    );
    return { output, time: Date.now() - start };
  } catch (error: any) {
    return { output: error.stdout || '⚠:ERR', time: Date.now() - start };
  }
}

describe('Display-Only Layer', () => {
  beforeEach(() => {
    // Create test health directory
    const testHome = '/tmp/test-display-home/.claude/session-health';
    if (existsSync('/tmp/test-display-home')) {
      rmSync('/tmp/test-display-home', { recursive: true });
    }
    mkdirSync(testHome, { recursive: true });
  });

  afterEach(() => {
    if (existsSync('/tmp/test-display-home')) {
      rmSync('/tmp/test-display-home', { recursive: true });
    }
  });

  // =========================================================================
  // Performance Tests
  // =========================================================================
  describe('performance', () => {
    test('completes in under 100ms with valid health data', () => {
      // Create health file
      const health = {
        sessionId: 'perf-test',
        projectPath: '/test/project',
        model: { value: 'Opus4.5' },
        context: { tokensLeft: 150000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 1 },
        transcript: { exists: true, lastModifiedAgo: '2m', isSynced: true },
        billing: { costToday: 45.5, burnRatePerHour: 20, budgetRemaining: 120, budgetPercentUsed: 30, resetTime: '14:00', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/perf-test.json',
        JSON.stringify(health)
      );

      const { time } = runDisplay('{"session_id":"perf-test"}');

      expect(time).toBeLessThan(100);
    });

    test('completes in under 100ms with missing health data', () => {
      const { time } = runDisplay('{"session_id":"missing-session"}');

      expect(time).toBeLessThan(100);
    });

    test('completes in under 100ms with invalid JSON input', () => {
      const { time } = runDisplay('not json at all');

      expect(time).toBeLessThan(100);
    });
  });

  // =========================================================================
  // Fallback Behavior Tests
  // =========================================================================
  describe('fallback behavior', () => {
    test('outputs minimal statusline when no session_id', () => {
      const { output } = runDisplay('{}');

      expect(output).toContain('🤖:Claude');
      expect(output).toContain('🕐:');
    });

    test('outputs minimal statusline when invalid JSON', () => {
      const { output } = runDisplay('not json');

      expect(output).toContain('🤖:Claude');
    });

    test('outputs warning when health file missing', () => {
      const { output } = runDisplay('{"session_id":"no-health-file"}');

      expect(output).toContain('⚠');
    });

    test('outputs warning when health file is corrupt', () => {
      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/corrupt.json',
        'not valid json {{'
      );

      const { output } = runDisplay('{"session_id":"corrupt"}');

      expect(output).toContain('⚠');
    });

    test('outputs warning when health file is empty', () => {
      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/empty.json',
        ''
      );

      const { output } = runDisplay('{"session_id":"empty"}');

      expect(output).toContain('⚠');
    });
  });

  // =========================================================================
  // Output Format Tests
  // =========================================================================
  describe('output format', () => {
    test('formats high-priority components correctly', () => {
      // Note: Display now uses priority-based width limiting (~80 chars max)
      // HIGH priority (always shown): model, context
      // MEDIUM priority (if space): git, cost, budget
      // LOW priority (if space): directory, time, transcript
      const health = {
        sessionId: 'format-test',
        projectPath: '/Users/test/myproject',
        model: { value: 'Sonnet4.5' },
        context: { tokensLeft: 100000, percentUsed: 50 },
        git: { branch: 'feature', ahead: 2, behind: 1, dirty: 3 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 25.5, burnRatePerHour: 10, budgetRemaining: 180, budgetPercentUsed: 25, resetTime: '14:00', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/format-test.json',
        JSON.stringify(health)
      );

      const { output } = runDisplay('{"session_id":"format-test"}');

      // HIGH priority - always shown
      expect(output).toContain('🤖:Sonnet4.5');
      expect(output).toContain('🧠:100kleft');

      // MEDIUM priority - shown if space (git at least should fit)
      expect(output).toContain('🌿:feature+2-1*3');

      // Verify output is not too long (width limiting working)
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped.length).toBeLessThanOrEqual(100); // Allow some margin for emoji widths
    });

    test('shows secrets warning when detected', () => {
      const health = {
        sessionId: 'secrets-test',
        projectPath: '/test',
        model: { value: 'Claude' },
        context: { tokensLeft: 0, percentUsed: 0 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: true, secretTypes: ['API Key', 'Token'], transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/secrets-test.json',
        JSON.stringify(health)
      );

      const { output } = runDisplay('{"session_id":"secrets-test"}');

      expect(output).toContain('🔐SECRETS!');
    });

    test('shows transcript warning when stale', () => {
      const health = {
        sessionId: 'stale-test',
        projectPath: '/test',
        model: { value: 'Claude' },
        context: { tokensLeft: 0, percentUsed: 0 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '10m', isSynced: false },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, secretTypes: [], transcriptStale: true, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/stale-test.json',
        JSON.stringify(health)
      );

      const { output } = runDisplay('{"session_id":"stale-test"}');

      expect(output).toContain('📝:10m⚠');
    });

    test('shows data loss risk indicator', () => {
      const health = {
        sessionId: 'risk-test',
        projectPath: '/test',
        model: { value: 'Claude' },
        context: { tokensLeft: 0, percentUsed: 0 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '15m', isSynced: false },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, secretTypes: [], transcriptStale: true, dataLossRisk: true }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/risk-test.json',
        JSON.stringify(health)
      );

      const { output } = runDisplay('{"session_id":"risk-test"}');

      expect(output).toContain('📝:15m🔴');
    });

    test('no trailing newline', () => {
      const health = {
        sessionId: 'newline-test',
        projectPath: '/test',
        model: { value: 'Claude' },
        context: { tokensLeft: 0, percentUsed: 0 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/newline-test.json',
        JSON.stringify(health)
      );

      const { output } = runDisplay('{"session_id":"newline-test"}');

      expect(output.endsWith('\n')).toBe(false);
    });
  });

  // =========================================================================
  // Config Respect Tests
  // =========================================================================
  describe('config respect', () => {
    test('hides git when disabled in config', () => {
      const health = {
        sessionId: 'config-test',
        projectPath: '/test',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 1, behind: 2, dirty: 3 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      const config = {
        components: {
          directory: true,
          git: false,  // Disabled
          model: true,
          context: true,
          time: true,
          transcriptSync: true,
          budget: false,
          cost: false,
          secrets: true
        }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/config-test.json',
        JSON.stringify(health)
      );
      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/config.json',
        JSON.stringify(config)
      );

      const { output } = runDisplay('{"session_id":"config-test"}');

      expect(output).not.toContain('🌿:');  // Git disabled
      expect(output).toContain('🤖:');       // Model enabled
    });
  });

  // =========================================================================
  // Robustness Tests
  // =========================================================================
  describe('robustness', () => {
    test('handles missing fields in health data gracefully', () => {
      // Minimal health with missing fields
      const health = {
        sessionId: 'minimal-test',
        model: { value: 'Claude' }
        // Missing: projectPath, context, git, transcript, billing, alerts
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/minimal-test.json',
        JSON.stringify(health)
      );

      const { output, time } = runDisplay('{"session_id":"minimal-test"}');

      // Should not crash, should complete fast
      expect(time).toBeLessThan(100);
      expect(output).toContain('🤖:Claude');
    });

    test('handles null values in health data', () => {
      const health = {
        sessionId: 'null-test',
        projectPath: null,
        model: { value: null },
        context: { tokensLeft: null, percentUsed: null },
        git: { branch: null, ahead: null, behind: null, dirty: null },
        transcript: { exists: null, lastModifiedAgo: null },
        billing: { costToday: null, burnRatePerHour: null },
        alerts: { secretsDetected: null }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/null-test.json',
        JSON.stringify(health)
      );

      const { output, time } = runDisplay('{"session_id":"null-test"}');

      // Should not crash
      expect(time).toBeLessThan(100);
      expect(output.length).toBeGreaterThan(0);
    });
  });
});
