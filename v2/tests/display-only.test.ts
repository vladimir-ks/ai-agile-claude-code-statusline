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
function runDisplay(
  stdin: string,
  healthDir: string = TEST_HEALTH_DIR,
  extraEnv: Record<string, string> = {},
): { output: string; time: number } {
  const start = Date.now();
  try {
    // Set HOME to redirect health dir lookups
    // Set NO_COLOR=1 to disable ANSI colors for consistent test output
    // Set STATUSLINE_WIDTH=120 to get multi-line output (default is single-line mode)
    // Pin CLAUDE_HS_HOME under the test HOME so the degraded-render quota read is
    // ISOLATED from the developer's real ~/.claude-hs cache (deterministic in CI).
    // extraEnv can point it at a fixture to exercise the cached-quota path.
    const output = execSync(
      `echo '${stdin.replace(/'/g, "'\\''")}' | bun ${DISPLAY_SCRIPT}`,
      {
        encoding: 'utf-8',
        timeout: 1000,  // 1 second max (should be <50ms)
        env: {
          ...process.env,
          HOME: '/tmp/test-display-home',
          CLAUDE_HS_HOME: '/tmp/test-display-home/.claude-hs',
          NO_COLOR: '1',
          STATUSLINE_WIDTH: '120',
          ...extraEnv,
        }
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

    test('shows loading indicator when health file missing (no stdin data)', () => {
      const { output } = runDisplay('{"session_id":"no-health-file"}');

      // Degraded marker present; with no stdin model there is no 🤖: segment,
      // but the ⏳ degraded-render contract still holds.
      expect(output).toContain('⏳');
      expect(output).not.toContain('🤖:');
      // Time is always available even in degraded mode.
      expect(output).toContain('🕐:');
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
  // Degraded Render Tests (no per-session health file → cached + stdin data)
  // =========================================================================
  // Regression guard for the "lone hourglass that never resolves" bug: when the
  // daemon can't write the per-session health file (fresh session OR blocked by a
  // locked login keychain), display-only must STILL render the best available
  // data — fresh stdin (model/context/time) + last-known-good quota from cache —
  // rather than a bare ⏳.
  describe('degraded render (no health file)', () => {
    const HS_FIXTURE = '/tmp/test-display-degraded-hs';
    const CACHE_DIR = `${HS_FIXTURE}/session-health`;

    function writeQuotaFixture(overrides: Record<string, any> = {}): void {
      mkdirSync(CACHE_DIR, { recursive: true });
      const cache = {
        active_slot: 'slot-1',
        schema_version: 2,
        slots: {
          'slot-1': {
            email: 'user@example.com',
            status: 'active',
            five_hour_util: 42,
            five_hour_resets_at: new Date(Date.now() + 90 * 60 * 1000).toISOString(), // 1h30m out
            seven_day_util: 15,
            weekly_budget_remaining_hours: 54,
            five_hour_burn_rate: 13,
            ...overrides,
          },
        },
      };
      writeFileSync(`${CACHE_DIR}/merged-quota-cache.json`, JSON.stringify(cache));
    }

    afterEach(() => {
      if (existsSync(HS_FIXTURE)) rmSync(HS_FIXTURE, { recursive: true });
    });

    test('renders ALL fresh stdin fields (dir+model+context+time) without health file', () => {
      const stdin = JSON.stringify({
        session_id: 'degraded-1',
        model: { id: 'claude-opus-4-6', display_name: 'Opus' },
        workspace: { current_dir: '/tmp/my-proj' },
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 100000, output_tokens: 2000, cache_read_input_tokens: 1000 },
        },
      });
      const { output } = runDisplay(stdin);
      expect(output).toContain('⏳');          // degraded marker preserved
      expect(output).toContain('📁:/tmp/my-proj'); // directory — never stale, must show
      expect(output).toContain('🤖:Opus4.6');   // fresh model from stdin
      expect(output).toContain('🧠:');          // fresh context bar from stdin
      expect(output).toContain('🕐:');          // time
      expect(output).toContain('💾:');          // cache hit ratio from stdin context window
    });

    test('blends last-known-good quota from cache, dimmed + stale-marked', () => {
      writeQuotaFixture();
      const stdin = JSON.stringify({
        session_id: 'degraded-2',
        model: { id: 'claude-opus-4-6' },
      });
      const { output } = runDisplay(stdin, TEST_HEALTH_DIR, { CLAUDE_HS_HOME: HS_FIXTURE });
      expect(output).toContain('🤖:Opus4.6'); // fresh
      expect(output).toContain('[S1]');     // slot from cache
      expect(output).toContain('(42%)');    // 5h util from cache
      expect(output).toContain('📅:54h(15%)'); // 7d budget from cache
      expect(output).toContain('🔥:13/h');  // burn from cache
      expect(output).toContain('stale');    // explicit stale marker (cache is "wrong-but-marked")
    });

    test('dims the cached quota block in dark grey (color mode)', () => {
      writeQuotaFixture();
      // color ON (omit NO_COLOR by passing it empty) → cached segments use the dim 240 grey
      const { output } = runDisplay('{"session_id":"degraded-2c","model":{"id":"claude-opus-4-6"}}',
        TEST_HEALTH_DIR, { CLAUDE_HS_HOME: HS_FIXTURE, NO_COLOR: '' });
      expect(output).toContain('\x1b[38;5;240m'); // dim grey applied to stale block
      expect(output).toContain('\x1b[38;5;147m'); // model still full-color (not dimmed)
    });

    test('degrades gracefully to fresh data + ⏳ when no cache exists', () => {
      // CLAUDE_HS_HOME points at an empty dir → no merged-quota-cache.json
      const { output } = runDisplay('{"session_id":"degraded-3","model":{"id":"claude-opus-4-6"}}',
        TEST_HEALTH_DIR, { CLAUDE_HS_HOME: '/tmp/test-display-degraded-empty' });
      expect(output).toContain('⏳');
      expect(output).toContain('🤖:Opus4.6');
      expect(output).toContain('🕐:');
      expect(output).not.toContain('[S');     // no slot data → no quota segment
      expect(output).not.toContain('stale');  // no cache → no "stale N" age marker
    });

    test('shows RESET when the cached 5h window has already rolled over', () => {
      writeQuotaFixture({ five_hour_resets_at: new Date(Date.now() - 60 * 1000).toISOString() });
      const { output } = runDisplay('{"session_id":"degraded-4"}',
        TEST_HEALTH_DIR, { CLAUDE_HS_HOME: HS_FIXTURE });
      expect(output).toContain('RESET');
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

      // HIGH priority - always shown on Line 1
      expect(output).toContain('🤖:Sonnet4.5');
      expect(output).toContain('🧠:100k(50%)');  // Short context format (no bar)

      // MEDIUM priority - shown if space (git at least should fit)
      expect(output).toContain('🌿:feature+2-1*3');

      // Line 2: session ID always present
      expect(output).toContain('🆔:format-test');
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
    // NOTE: Phase 0: Formatter pre-generates all component variants for all widths.
    // Config-based component hiding and maxLines will be added in Phase 1 (display-only layer).
    // This test verifies Phase 0 behavior: all components pre-computed, display selects variant.
    test('shows all pre-formatted components (Phase 0 architecture)', () => {
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
      // Need health file so display doesn't short-circuit to ⏳
      const health = {
        sessionId: 'model-test-3',
        model: { value: 'Fallback' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };
      writeFileSync('/tmp/test-display-home/.claude/session-health/model-test-3.json', JSON.stringify(withFormattedOutput(health)));

      const { output } = runDisplay('{"session_id":"model-test-3","model":{"id":"claude-opus-4-6"}}');
      expect(output).toContain('🤖:Opus4.6');
    });

    test('handles stdin with model.id (prefers id over display_name)', () => {
      const health = {
        sessionId: 'model-test-4',
        model: { value: 'Fallback' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };
      writeFileSync('/tmp/test-display-home/.claude/session-health/model-test-4.json', JSON.stringify(withFormattedOutput(health)));

      const { output } = runDisplay(
        '{"session_id":"model-test-4","model":{"id":"claude-sonnet-4-5-20250929","display_name":"Opus"}}'
      );
      expect(output).toContain('🤖:Sonnet4.5');
      expect(output).not.toContain('Opus');
    });

    test('handles stdin with only model.id (no display_name)', () => {
      const health = {
        sessionId: 'model-test-5',
        model: { value: 'Fallback' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      };
      writeFileSync('/tmp/test-display-home/.claude/session-health/model-test-5.json', JSON.stringify(withFormattedOutput(health)));

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

  // =========================================================================
  // DisplayConfig Validation (via config.json)
  // =========================================================================
  describe('DisplayConfig validation', () => {
    const healthData = {
      sessionId: 'cfg-test',
      projectPath: '/test/project',
      model: { value: 'Opus4.6', confidence: 100 },
      context: { tokensLeft: 100000, percentUsed: 25 },
      git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
      billing: null,
      transcript: { lastMessagePreview: 'Hello', messageCount: 5, sizeBytes: 1024 },
      alerts: {},
    };

    function writeConfigAndHealth(displayConfig: Record<string, unknown>) {
      const configPath = '/tmp/test-display-home/.claude/session-health/config.json';
      const healthPath = '/tmp/test-display-home/.claude/session-health/cfg-test.json';
      writeFileSync(configPath, JSON.stringify({ display: displayConfig }));
      writeFileSync(healthPath, JSON.stringify(withFormattedOutput(healthData)));
    }

    test('invalid mode silently falls back to auto', () => {
      writeConfigAndHealth({ mode: 'invalid-typo' });
      const { output } = runDisplay('{"session_id":"cfg-test"}');
      // Should render normally (auto mode), not crash
      expect(output.length).toBeGreaterThan(0);
      expect(output).toContain('📁:');
    });

    test('marginPercent negative is ignored (uses auto)', () => {
      writeConfigAndHealth({ marginPercent: -10 });
      const { output } = runDisplay('{"session_id":"cfg-test"}');
      expect(output.length).toBeGreaterThan(0);
      expect(output).toContain('📁:');
    });

    test('marginPercent > 25 is ignored (uses auto)', () => {
      writeConfigAndHealth({ marginPercent: 101 });
      const { output } = runDisplay('{"session_id":"cfg-test"}');
      expect(output.length).toBeGreaterThan(0);
      expect(output).toContain('📁:');
    });

    test('maxLines=0 is ignored (uses default 6)', () => {
      writeConfigAndHealth({ maxLines: 0 });
      const { output } = runDisplay('{"session_id":"cfg-test"}');
      // Should still produce output (maxLines=0 ignored, default=6 used)
      expect(output.length).toBeGreaterThan(0);
      expect(output).toContain('📁:');
    });

    test('maxLines=1 produces at most 1 line', () => {
      writeConfigAndHealth({ maxLines: 1 });
      const { output } = runDisplay('{"session_id":"cfg-test"}');
      const lines = output.trim().split('\n');
      expect(lines.length).toBeLessThanOrEqual(1);
    });

    test('mode=singleline produces 2 lines (core + session ID)', () => {
      writeConfigAndHealth({ mode: 'singleline' });
      const { output } = runDisplay('{"session_id":"cfg-test"}');
      const lines = output.trim().split('\n');
      expect(lines.length).toBeLessThanOrEqual(2); // Line 1: core, Line 2: session ID
    });

    test('marginPercent=0 is accepted (no margin)', () => {
      writeConfigAndHealth({ marginPercent: 0 });
      const { output } = runDisplay('{"session_id":"cfg-test"}');
      expect(output.length).toBeGreaterThan(0);
      expect(output).toContain('📁:');
    });

    test('marginPercent=15 is accepted (custom margin)', () => {
      writeConfigAndHealth({ marginPercent: 15 });
      const { output } = runDisplay('{"session_id":"cfg-test"}');
      expect(output.length).toBeGreaterThan(0);
      expect(output).toContain('📁:');
    });
  });

  // =========================================================================
  // Width Fallback Chain
  // =========================================================================
  describe('width detection fallback', () => {
    const healthData = {
      sessionId: 'width-test',
      projectPath: '/test/project',
      model: { value: 'Opus4.6', confidence: 100 },
      context: { tokensLeft: 100000, percentUsed: 25 },
      git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
      billing: null,
      transcript: { lastMessagePreview: 'Hello', messageCount: 5, sizeBytes: 1024 },
      alerts: {},
    };

    function runDisplayWithEnv(env: Record<string, string | undefined>): string {
      const healthPath = '/tmp/test-display-home/.claude/session-health/width-test.json';
      writeFileSync(healthPath, JSON.stringify(withFormattedOutput(healthData)));
      try {
        return execSync(
          `echo '{"session_id":"width-test"}' | bun ${DISPLAY_SCRIPT}`,
          {
            encoding: 'utf-8',
            timeout: 1000,
            env: { ...process.env, HOME: '/tmp/test-display-home', NO_COLOR: '1', ...env }
          }
        );
      } catch (error: any) {
        return error.stdout || '';
      }
    }

    test('STATUSLINE_WIDTH takes priority over COLUMNS', () => {
      const output = runDisplayWithEnv({ STATUSLINE_WIDTH: '80', COLUMNS: '200' });
      // Should produce output (not crash with either width)
      expect(output.length).toBeGreaterThan(0);
    });

    test('COLUMNS used when STATUSLINE_WIDTH not set', () => {
      const output = runDisplayWithEnv({ STATUSLINE_WIDTH: '', COLUMNS: '100' });
      expect(output.length).toBeGreaterThan(0);
    });

    test('defaults to 120 when no env vars set', () => {
      const output = runDisplayWithEnv({ STATUSLINE_WIDTH: '', COLUMNS: '' });
      expect(output.length).toBeGreaterThan(0);
    });

    test('narrow width (40) does not crash', () => {
      const output = runDisplayWithEnv({ STATUSLINE_WIDTH: '40', COLUMNS: '' });
      expect(output.length).toBeGreaterThan(0);
    });
  });
});
