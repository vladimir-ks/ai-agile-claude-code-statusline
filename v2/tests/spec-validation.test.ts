/**
 * Specification Validation Tests
 *
 * These tests validate the statusline output against STATUSLINE_SPEC.md
 * They ensure the output format is correct and reliable.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';

const DISPLAY_SCRIPT = join(__dirname, '../src/display-only.ts');

function runDisplay(stdin: string): string {
  try {
    return execSync(
      `echo '${stdin.replace(/'/g, "'\\''")}' | bun ${DISPLAY_SCRIPT}`,
      {
        encoding: 'utf-8',
        timeout: 1000,
        env: { ...process.env, HOME: '/tmp/test-spec-home', NO_COLOR: '1' }
      }
    );
  } catch (error: any) {
    return error.stdout || '⚠:ERR';
  }
}

function createHealthFile(sessionId: string, data: object): void {
  const testHome = '/tmp/test-spec-home/.claude/session-health';
  mkdirSync(testHome, { recursive: true });
  writeFileSync(`${testHome}/${sessionId}.json`, JSON.stringify(data));
}

describe('SPEC: Output Format', () => {
  beforeEach(() => {
    if (existsSync('/tmp/test-spec-home')) {
      rmSync('/tmp/test-spec-home', { recursive: true });
    }
    mkdirSync('/tmp/test-spec-home/.claude/session-health', { recursive: true });
  });

  afterEach(() => {
    if (existsSync('/tmp/test-spec-home')) {
      rmSync('/tmp/test-spec-home', { recursive: true });
    }
  });

  // =========================================================================
  // SPEC: Single Line Output
  // =========================================================================
  describe('Single Line Format', () => {
    test('output is a single line with no newline', () => {
      createHealthFile('single-line', {
        sessionId: 'single-line',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, isFresh: true },
        alerts: { secretsDetected: false, transcriptStale: false, dataLossRisk: false }
      });

      const output = runDisplay('{"session_id":"single-line"}');

      expect(output.includes('\n')).toBe(false);
      expect(output.endsWith('\n')).toBe(false);
    });
  });

  // =========================================================================
  // SPEC: Directory Component
  // =========================================================================
  describe('Directory Component (📁)', () => {
    test('shows ~ for home directory paths', () => {
      createHealthFile('dir-home', {
        sessionId: 'dir-home',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"dir-home","start_directory":"/tmp/test-spec-home/project"}');

      expect(output).toContain('📁:');
      expect(output).toContain('~');
    });

    test('truncates long paths preserving ~ prefix', () => {
      createHealthFile('dir-long', {
        sessionId: 'dir-long',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: {}
      });

      // Very long path
      const longPath = '/tmp/test-spec-home/very/long/nested/path/to/my-project/src';
      const output = runDisplay(`{"session_id":"dir-long","start_directory":"${longPath}"}`);

      expect(output).toContain('📁:');
      expect(output).toContain('~/…');  // Should preserve ~ with ellipsis truncation indicator
    });

    test('hidden when no directory in stdin', () => {
      createHealthFile('dir-missing', {
        sessionId: 'dir-missing',
        projectPath: '/wrong/daemon/path',  // Should be ignored
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"dir-missing"}');

      expect(output).not.toContain('📁:');
      expect(output).not.toContain('wrong');  // Daemon path NOT used
    });
  });

  // =========================================================================
  // SPEC: Git Component
  // =========================================================================
  describe('Git Component (🌿)', () => {
    test('shows branch with ahead/behind/dirty', () => {
      createHealthFile('git-full', {
        sessionId: 'git-full',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: 'main', ahead: 5, behind: 2, dirty: 3 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"git-full"}');

      expect(output).toContain('🌿:main+5-2*3');
    });

    test('hidden when no branch', () => {
      createHealthFile('git-none', {
        sessionId: 'git-none',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"git-none"}');

      expect(output).not.toContain('🌿:');
    });
  });

  // =========================================================================
  // SPEC: Model Component
  // =========================================================================
  describe('Model Component (🤖)', () => {
    test('prefers stdin model over cached', () => {
      createHealthFile('model-stdin', {
        sessionId: 'model-stdin',
        model: { value: 'CachedModel' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"model-stdin","model":{"display_name":"Opus4.5"}}');

      expect(output).toContain('🤖:Opus4.5');
      expect(output).not.toContain('CachedModel');
    });

    test('falls back to cached model', () => {
      createHealthFile('model-cached', {
        sessionId: 'model-cached',
        model: { value: 'Sonnet4.5' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"model-cached"}');

      expect(output).toContain('🤖:Sonnet4.5');
    });

    test('defaults to Claude when no model', () => {
      createHealthFile('model-default', {
        sessionId: 'model-default',
        model: {},
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"model-default"}');

      expect(output).toContain('🤖:Claude');
    });
  });

  // =========================================================================
  // SPEC: Context Component
  // =========================================================================
  describe('Context Component (🧠)', () => {
    test('shows tokens with progress bar', () => {
      createHealthFile('context-normal', {
        sessionId: 'context-normal',
        model: { value: 'Claude' },
        context: { tokensLeft: 138000, percentUsed: 30 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"context-normal"}');

      expect(output).toContain('🧠:138k');
      expect(output).toMatch(/\[.+\|.+\]/);  // Progress bar with | marker
    });

    test('progress bar has threshold marker at position 9', () => {
      createHealthFile('context-bar', {
        sessionId: 'context-bar',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 50 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"context-bar"}');

      // Bar format: [======---|--] where | is at position 9 (78% threshold, 12-char bar)
      expect(output).toMatch(/\[.{9}\|.+\]/);
    });
  });

  // =========================================================================
  // SPEC: Cost Component
  // =========================================================================
  describe('Cost Component (💰)', () => {
    test('shows cost with burn rate', () => {
      createHealthFile('cost-full', {
        sessionId: 'cost-full',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 45.5, burnRatePerHour: 12.3, budgetRemaining: 120, isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"cost-full"}');

      expect(output).toContain('💰:$45.5|$12.3/h');
    });

    test('hidden when cost is zero', () => {
      createHealthFile('cost-zero', {
        sessionId: 'cost-zero',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 0, burnRatePerHour: 0, budgetRemaining: 0, isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"cost-zero"}');

      expect(output).not.toContain('💰:');
    });
  });

  // =========================================================================
  // SPEC: Budget Component
  // =========================================================================
  describe('Budget Component (⌛)', () => {
    test('shows budget with reset time when fresh', () => {
      createHealthFile('budget-fresh', {
        sessionId: 'budget-fresh',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 10, budgetRemaining: 150, resetTime: '14:00', isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"budget-fresh"}');

      // V1 format: XhXm(XX%)HH:MM
      expect(output).toMatch(/⌛:2h30m\(\d+%\)14:00/);
    });

    test('shows 🔴 when stale', () => {
      createHealthFile('budget-stale', {
        sessionId: 'budget-stale',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { costToday: 10, budgetRemaining: 60, resetTime: '14:00', isFresh: false },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"budget-stale"}');

      expect(output).toContain('⌛:');
      expect(output).toContain('🔴');
    });
  });

  // =========================================================================
  // SPEC: Transcript Sync Component
  // =========================================================================
  describe('Transcript Sync Component (📝)', () => {
    test('hidden when fresh (no need to show "everything ok")', () => {
      createHealthFile('sync-fresh', {
        sessionId: 'sync-fresh',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '2m', isSynced: true },
        billing: { isFresh: true },
        alerts: { transcriptStale: false, dataLossRisk: false }
      });

      const output = runDisplay('{"session_id":"sync-fresh"}');

      // Transcript sync is now hidden when fresh - only shows when there's a problem
      expect(output).not.toContain('📝:');
    });

    test('shows ⚠ when transcript stale', () => {
      createHealthFile('sync-stale', {
        sessionId: 'sync-stale',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '10m', isSynced: false },
        billing: { isFresh: true },
        alerts: { transcriptStale: true, dataLossRisk: false }
      });

      const output = runDisplay('{"session_id":"sync-stale"}');

      expect(output).toContain('📝:10m⚠');
    });

    test('shows 🔴 when data loss risk', () => {
      createHealthFile('sync-risk', {
        sessionId: 'sync-risk',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '15m', isSynced: false },
        billing: { isFresh: true },
        alerts: { transcriptStale: true, dataLossRisk: true }
      });

      const output = runDisplay('{"session_id":"sync-risk"}');

      expect(output).toContain('📝:15m🔴');
    });
  });

  // =========================================================================
  // SPEC: Error Handling
  // =========================================================================
  describe('Error Handling', () => {
    test('no stdin → shows 🤖:Claude with time', () => {
      const output = runDisplay('{}');
      expect(output).toContain('🤖:Claude');
      expect(output).toMatch(/🕐:\d{2}:\d{2}/);  // Time component HH:MM
    });

    test('invalid JSON → shows 🤖:Claude with time', () => {
      const output = runDisplay('not json');
      expect(output).toContain('🤖:Claude');
      expect(output).toMatch(/🕐:\d{2}:\d{2}/);
    });

    test('no health file → shows loading indicator with model', () => {
      const output = runDisplay('{"session_id":"nonexistent"}');
      // New behavior: shows ⏳ (loading) instead of scary ⚠:NoData message
      expect(output).toContain('⏳');
      expect(output).toContain('🤖:Claude');
    });
  });

  // =========================================================================
  // SPEC: Width Management
  // =========================================================================
  describe('Width Management', () => {
    test('output is reasonable length for Claude Code UI (~150 visible cols max)', () => {
      createHealthFile('width-test', {
        sessionId: 'width-test',
        model: { value: 'Opus4.5' },
        context: { tokensLeft: 138000, percentUsed: 30 },
        git: { branch: 'feature', ahead: 10, behind: 5, dirty: 8 },
        transcript: {
          exists: true,
          lastModifiedAgo: '2m',
          isSynced: true,
          lastMessagePreview: 'Test message preview',
          lastMessageAgo: '3m'
        },
        billing: { costToday: 186.5, burnRatePerHour: 45.3, budgetRemaining: 120, resetTime: '16:00', isFresh: true },
        alerts: {}
      });

      const shortPath = '/tmp/test-spec-home/myproj';
      const output = runDisplay(`{"session_id":"width-test","start_directory":"${shortPath}","model":{"display_name":"Opus4.5"}}`);

      // With multi-line wrapping, check each line's width
      const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu;
      const lines = output.split('\n');

      for (const line of lines) {
        const emojiCount = (line.match(emojiRegex) || []).length;
        const lineWidth = line.length + emojiCount;
        // Each line should be under 150 visible columns
        expect(lineWidth).toBeLessThanOrEqual(150);
      }
    });

    test('long content wraps to multiple lines instead of truncating', () => {
      createHealthFile('width-wrap', {
        sessionId: 'width-wrap',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: {
          exists: true,
          lastModifiedAgo: '1m',
          isSynced: true,
          lastMessagePreview: 'This is a very long message that should wrap to next line because it exceeds available space',
          lastMessageAgo: '2m'
        },
        billing: { isFresh: true },
        alerts: {}
      });

      const output = runDisplay('{"session_id":"width-wrap"}');

      // With multi-line wrapping, full message should appear (not truncated)
      expect(output).toContain('💬:');
      expect(output).toContain('(2m)');
      // Should wrap to multiple lines
      expect(output).toContain('\n');
    });
  });

  // =========================================================================
  // SPEC: Alerts
  // =========================================================================
  describe('Alerts', () => {
    test('shows secrets warning when detected', () => {
      createHealthFile('alert-secrets', {
        sessionId: 'alert-secrets',
        model: { value: 'Claude' },
        context: { tokensLeft: 100000, percentUsed: 25 },
        git: { branch: '', ahead: 0, behind: 0, dirty: 0 },
        transcript: { exists: true, lastModifiedAgo: '1m', isSynced: true },
        billing: { isFresh: true },
        alerts: { secretsDetected: true, secretTypes: ['API Key'], transcriptStale: false, dataLossRisk: false }
      });

      const output = runDisplay('{"session_id":"alert-secrets"}');

      // New format: 🔐API instead of 🔐SECRETS!(API Key)
      expect(output).toContain('🔐API');
    });

    // Note: Stale indicator (⚠Xm) was removed as it was confusing to users
    // Staleness is now only shown via 🔴 on billing data
  });
});
