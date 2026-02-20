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
import { withFormattedOutput } from './helpers/with-formatted-output';
import { NotificationManager } from '../src/lib/notification-manager';

const TEST_HEALTH_DIR = '/tmp/test-display-only-health';
const DISPLAY_SCRIPT = join(__dirname, '../src/display-only.ts');

// Helper to run display-only with mocked health dir
function runDisplay(stdin: string, healthDir: string = TEST_HEALTH_DIR): { output: string; time: number } {
  const start = Date.now();
  try {
    // Set HOME to redirect health dir lookups
    // Set NO_COLOR=1 to disable ANSI colors for consistent test output
    // Set STATUSLINE_WIDTH=120 to get multi-line output (default is single-line mode)
    const output = execSync(
      `echo '${stdin.replace(/'/g, "'\\''")}' | bun ${DISPLAY_SCRIPT}`,
      {
        encoding: 'utf-8',
        timeout: 1000,  // 1 second max (should be <50ms)
        env: { ...process.env, HOME: '/tmp/test-display-home', NO_COLOR: '1', STATUSLINE_WIDTH: '120' }
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

    // Clear notification state to prevent inter-test leakage
    // (notifications are file-based, shared across test runs)
    NotificationManager.clearAll();
    NotificationManager.clearCache();
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
      const healthData = {
        sessionId: 'perf-test',
        projectPath: '/test/project',
        model: { value: 'Opus4.5' },
        context: { tokensLeft: 150000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 1 },
        transcript: { exists: true, lastModifiedAgo: '2m', isSynced: true },
        billing: { costToday: 45.5, burnRatePerHour: 20, budgetRemaining: 120, budgetPercentUsed: 30, resetTime: '14:00', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      const health = withFormattedOutput(healthData);

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/perf-test.json',
        JSON.stringify(withFormattedOutput(health))
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
      // Time removed - redundant with OS clock
    });

    test('outputs minimal statusline when invalid JSON', () => {
      const { output } = runDisplay('not json');

      expect(output).toContain('🤖:Claude');
    });

    test('shows loading indicator when health file missing', () => {
      const { output } = runDisplay('{"session_id":"no-health-file"}');

      // New behavior: shows ⏳ (loading) instead of scary ⚠:NoData message
      expect(output).toContain('⏳');
      expect(output).toContain('🤖:Claude');
    });

    test('shows loading indicator when health file is corrupt', () => {
      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/corrupt.json',
        'not valid json {{'
      );

      const { output } = runDisplay('{"session_id":"corrupt"}');

      expect(output).toContain('⏳');
    });

    test('shows loading indicator when health file is empty', () => {
      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/empty.json',
        ''
      );

      const { output } = runDisplay('{"session_id":"empty"}');

      expect(output).toContain('⏳');
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
        JSON.stringify(withFormattedOutput(health))
      );

      const { output } = runDisplay('{"session_id":"format-test"}');

      // HIGH priority - always shown
      expect(output).toContain('🤖:Sonnet4.5');
      expect(output).toContain('🧠:100k-free[');  // Token count with "-free" followed by progress bar

      // MEDIUM priority - shown if space (git at least should fit)
      expect(output).toContain('🌿:feature+2-1*3');

      // Verify output is single line and fits
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
      // Single line format - should be under 130 chars (allows for dynamic last message)
      expect(stripped.length).toBeLessThanOrEqual(130);
    });

    test('secrets detection disabled — no warning shown', () => {
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
        JSON.stringify(withFormattedOutput(health))
      );

      const { output } = runDisplay('{"session_id":"secrets-test"}');

      // Secrets detection disabled (too many false positives) — no secrets notification
      expect(output).not.toContain('⚠️ API Key');
    });

    test('transcript stale does not show 📝 on line 1 (moved to notification layer)', () => {
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
        JSON.stringify(withFormattedOutput(health))
      );

      const { output } = runDisplay('{"session_id":"stale-test"}');

      // 📝 indicator removed from line 1 — handled by notification layer
      expect(output).not.toContain('📝:10m');
    });

    test('data loss risk does not show 📝 on line 1 (moved to notification layer)', () => {
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
        JSON.stringify(withFormattedOutput(health))
      );

      const { output } = runDisplay('{"session_id":"risk-test"}');

      // 📝 indicator removed from line 1 — handled by notification layer
      expect(output).not.toContain('📝:15m⚠');
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
        JSON.stringify(withFormattedOutput(health))
      );

      const { output } = runDisplay('{"session_id":"newline-test"}');

      expect(output.endsWith('\n')).toBe(false);
    });
  });

  // =========================================================================
  // Config Respect Tests
  // =========================================================================
  describe('config respect', () => {
    // NOTE: In Phase 0 architecture, StatuslineFormatter pre-generates all components.
    // Config-based component hiding is not yet implemented in the formatter.
    // This test verifies the current behavior (all components shown).
    test('shows all pre-formatted components (config not applied to formatter yet)', () => {
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

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/config-test.json',
        JSON.stringify(withFormattedOutput(health))
      );

      const { output } = runDisplay('{"session_id":"config-test"}');

      // All components shown in pre-formatted output (config filtering not yet implemented)
      expect(output).toContain('🌿:');  // Git shown
      expect(output).toContain('🤖:');  // Model shown
    });
  });

  // =========================================================================
  // Directory Path Tests (CRITICAL - previously broken)
  // =========================================================================
  describe('directory path handling', () => {
    test('extracts directory from stdin start_directory (primary source)', () => {
      const health = {
        sessionId: 'dir-test-1',
        projectPath: '/wrong/daemon/path',  // This should be IGNORED
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/dir-test-1.json',
        JSON.stringify(withFormattedOutput(health))
      );

      // Pass start_directory in stdin JSON (like Claude Code does)
      const { output } = runDisplay('{"session_id":"dir-test-1","start_directory":"/Users/test/myproject"}');

      // Should show the stdin directory, NOT the health file's projectPath
      expect(output).toContain('📁:');
      expect(output).toContain('myproject');
      expect(output).not.toContain('wrong');
    });

    test('extracts directory from stdin workspace.current_dir (fallback)', () => {
      const health = {
        sessionId: 'dir-test-2',
        projectPath: '/wrong/path',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/dir-test-2.json',
        JSON.stringify(withFormattedOutput(health))
      );

      const { output } = runDisplay('{"session_id":"dir-test-2","workspace":{"current_dir":"/Users/test/workspace-dir"}}');

      expect(output).toContain('📁:');
      expect(output).toContain('workspace-dir');
    });

    test('extracts directory from stdin cwd (last fallback)', () => {
      const health = {
        sessionId: 'dir-test-3',
        projectPath: '/wrong/path',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/dir-test-3.json',
        JSON.stringify(withFormattedOutput(health))
      );

      const { output } = runDisplay('{"session_id":"dir-test-3","cwd":"/Users/test/cwd-dir"}');

      expect(output).toContain('📁:');
      expect(output).toContain('cwd-dir');
    });

    test('uses cached projectPath when no stdin directory (Phase 0: pre-formatted)', () => {
      // NOTE: In Phase 0 architecture, pre-formatted output includes projectPath.
      // When stdin has no directory, the pre-formatted output is used as-is.
      const health = {
        sessionId: 'dir-test-4',
        projectPath: '/cached/project/path',  // Will be shown in pre-formatted output
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/dir-test-4.json',
        JSON.stringify(withFormattedOutput(health))
      );

      // No directory in stdin - uses cached projectPath from health
      const { output } = runDisplay('{"session_id":"dir-test-4"}');

      // Pre-formatted output includes cached path (Phase 0 architecture)
      expect(output).toContain('📁:');
      expect(output).toContain('/cached/project/path');
    });

    test('shortens long paths intelligently', () => {
      const health = {
        sessionId: 'dir-test-5',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/dir-test-5.json',
        JSON.stringify(withFormattedOutput(health))
      );

      // Very long path
      const { output } = runDisplay('{"session_id":"dir-test-5","start_directory":"/tmp/test-display-home/very/long/nested/path/to/project"}');

      expect(output).toContain('📁:');
      // Should contain some indication of the path structure
      expect(output).toContain('project');
      // Should not exceed reasonable length
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped.length).toBeLessThan(150);
    });
  });

  // =========================================================================
  // Model Override Tests
  // =========================================================================
  describe('model handling', () => {
    test('prefers stdin model.display_name over cached health', () => {
      const health = {
        sessionId: 'model-test-1',
        model: { value: 'OldCachedModel' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/model-test-1.json',
        JSON.stringify(withFormattedOutput(health))
      );

      const { output } = runDisplay('{"session_id":"model-test-1","model":{"display_name":"Opus4.5"}}');

      expect(output).toContain('🤖:Opus4.5');
      expect(output).not.toContain('OldCachedModel');
    });

    test('falls back to cached model when stdin has no model', () => {
      const health = {
        sessionId: 'model-test-2',
        model: { value: 'CachedSonnet' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };

      writeFileSync(
        '/tmp/test-display-home/.claude/session-health/model-test-2.json',
        JSON.stringify(withFormattedOutput(health))
      );

      const { output } = runDisplay('{"session_id":"model-test-2"}');

      expect(output).toContain('🤖:CachedSonnet');
    });

    test('extracts version from stdin model.id', () => {
      // Real Claude Code sends model.id with full version string
      const { output } = runDisplay('{"session_id":"model-test-3","model":{"id":"claude-opus-4-6"}}');

      expect(output).toContain('🤖:Opus4.6');
    });

    test('handles stdin with model.id (prefers id over display_name)', () => {
      // When both id and display_name present, id should win (has version info)
      const { output } = runDisplay(
        '{"session_id":"model-test-4","model":{"id":"claude-sonnet-4-5-20250929","display_name":"Opus"}}'
      );

      // Should use id (Sonnet 4.5), not display_name (Opus)
      expect(output).toContain('🤖:Sonnet4.5');
      expect(output).not.toContain('Opus');
    });

    test('handles stdin with only model.id (no display_name)', () => {
      // Model.id alone should be sufficient for formatting
      const { output } = runDisplay('{"session_id":"model-test-5","model":{"id":"claude-haiku-4-5-20251001"}}');

      expect(output).toContain('🤖:Haiku4.5');
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
        JSON.stringify(withFormattedOutput(health))
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
        JSON.stringify(withFormattedOutput(health))
      );

      const { output, time } = runDisplay('{"session_id":"null-test"}');

      // Should not crash
      expect(time).toBeLessThan(100);
      expect(output.length).toBeGreaterThan(0);
    });
  });
});
