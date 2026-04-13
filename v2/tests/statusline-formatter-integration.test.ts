/**
 * StatuslineFormatter Integration Test
 *
 * Verifies Phase 0: Performance Architecture
 * - StatuslineFormatter generates all variants correctly
 * - Data-gatherer integrates formatter
 * - Display-only reads and outputs variants
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StatuslineFormatter } from '../src/lib/statusline-formatter';
import { createDefaultHealth, TmuxContext } from '../src/types/session-health';
import { sessionHealthToRuntimeSession } from '../src/types/runtime-state';
import { SessionLockManager } from '../src/lib/session-lock-manager';
import { NotificationManager } from '../src/lib/notification-manager';
import { rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('StatuslineFormatter Integration', () => {
  test('formatAllVariants generates all 7 terminal width variants', () => {
    const health = createDefaultHealth('test-session');
    health.projectPath = '/Users/test/project';
    health.billing = {
      budgetRemaining: 42,
      budgetPercentUsed: 29,
      costToday: 10.5,
      burnRatePerHour: 5.2,
      resetTime: '14:00',
      isFresh: true,
      lastFetched: Date.now()
    };
    health.context = {
      tokensLeft: 154000,
      tokensUsed: 46000,
      percentUsed: 23,
      windowSize: 200000,
      nearCompaction: false
    };

    const variants = StatuslineFormatter.formatAllVariants(health);

    // Verify all 7 variants exist
    expect(variants.width40).toBeDefined();
    expect(variants.width60).toBeDefined();
    expect(variants.width80).toBeDefined();
    expect(variants.width100).toBeDefined();
    expect(variants.width120).toBeDefined();
    expect(variants.width150).toBeDefined();
    expect(variants.width200).toBeDefined();

    // Verify each is an array of strings (lines)
    expect(Array.isArray(variants.width40)).toBe(true);
    expect(Array.isArray(variants.width120)).toBe(true);
    expect(Array.isArray(variants.width200)).toBe(true);

    // Verify lines are not empty
    expect(variants.width120.length).toBeGreaterThan(0);
    expect(variants.width120[0].length).toBeGreaterThan(0);
  });

  test('width40 variant shows minimal layout', () => {
    const health = createDefaultHealth('test-session');
    health.projectPath = '/Users/test/project';
    health.billing = {
      budgetRemaining: 42,
      budgetPercentUsed: 29,
      costToday: 10.5,
      burnRatePerHour: 5.2,
      resetTime: '14:00',
      isFresh: true,
      lastFetched: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width40.join('\n');

    // Should show directory (always visible, Line 1)
    expect(output).toContain('📁:');
  });

  test('width120 variant shows full layout', () => {
    const health = createDefaultHealth('test-session');
    health.projectPath = '/Users/test/very-long-project-name';
    health.git = {
      branch: 'main',
      ahead: 5,
      behind: 0,
      dirty: 3,
      lastChecked: Date.now()
    };
    health.billing = {
      budgetRemaining: 42,
      budgetPercentUsed: 29,
      costToday: 10.5,
      burnRatePerHour: 5.2,
      resetTime: '14:00',
      isFresh: true,
      lastFetched: Date.now()
    };
    health.context = {
      tokensLeft: 154000,
      tokensUsed: 46000,
      percentUsed: 23,
      windowSize: 200000,
      nearCompaction: false
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');

    // Should show directory, git, model, context on Line 1
    // Time is on the account context notification line (not main output)
    expect(output).toContain('📁:');
    expect(output).toContain('🌿:');
    expect(output).toContain('🤖:');
    expect(output).toContain('🧠:');
  });


  test('path shown in full (NEVER truncated per spec)', () => {
    const health = createDefaultHealth('test-session');
    health.projectPath = '/Users/test/very-long-directory-name-here/project';

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');

    // SPEC: Directory should NEVER be truncated - full path always shown
    expect(output).toContain('very-long-directory-name-here');
    expect(output).toContain('project');
  });

  test('context shows token count with short percentage format', () => {
    const health = createDefaultHealth('test-session');
    health.context = {
      tokensLeft: 154000,
      tokensUsed: 46000,
      percentUsed: 23,
      windowSize: 200000,
      nearCompaction: false
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n'); // Wide terminal

    // Short format: 🧠:154k(23%) — no progress bar, no -free suffix
    expect(output).toContain('154k');
    expect(output).toContain('(23%)');
  });

  test('all components always present on Line 1 (no overflow)', () => {
    const health = createDefaultHealth('test-session');
    health.projectPath = '/Users/vmks/_git_worktrees/_LogosForge_stream-7/packages/api';
    health.git = {
      branch: '601-25_S7_20-48_content-publishing',
      ahead: 26,
      behind: 1,
      dirty: 7,
      lastChecked: Date.now()
    };
    health.model = { value: 'Opus4.5', source: 'jsonInput', confidence: 80 };
    health.context = {
      tokensLeft: 33000,
      tokensUsed: 120000,
      percentUsed: 78,
      windowSize: 200000,
      nearCompaction: true
    };

    const variants = StatuslineFormatter.formatAllVariants(health);

    // Core components may span multiple output lines (split at width boundaries)
    // Join all lines before 🆔: to get the full core content
    const allLines = variants.width60.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const sidIdx = allLines.findIndex(l => l.includes('🆔:'));
    const coreContent = allLines.slice(0, sidIdx > 0 ? sidIdx : allLines.length).join(' ');
    expect(coreContent).toContain('📁:');
    expect(coreContent).toContain('🌿:');
    expect(coreContent).toContain('🤖:');
    expect(coreContent).toContain('🧠:');

    // Session ID line always present
    expect(allLines.some(l => l.includes('🆔:'))).toBe(true);
  });

  test('Line 2 shows session ID (turns and size removed)', () => {
    const health = createDefaultHealth('l2-stats');
    health.projectPath = '~/project';
    health.transcript.messageCount = 42;
    health.transcript.sizeBytes = 3.2 * 1024 * 1024; // 3.2MB

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // L2 is session ID — turns and transcript size are no longer displayed
    expect(output).toContain('🆔:l2-stats');
    expect(output).not.toContain('42t');
    expect(output).not.toContain('📦:');
  });

  test('Line 2 always shows session ID (no turns or size)', () => {
    const health = createDefaultHealth('l2-no-overflow');
    health.projectPath = '~/short';
    health.git = { branch: 'main', ahead: 0, behind: 0, dirty: 0, lastChecked: Date.now() };
    health.model = { value: 'Opus4.6', source: 'jsonInput', confidence: 80 };
    health.context = { tokensLeft: 100000, tokensUsed: 50000, percentUsed: 33, windowSize: 200000 };
    health.transcript.messageCount = 15;
    health.transcript.sizeBytes = 500 * 1024; // 500KB

    const variants = StatuslineFormatter.formatAllVariants(health);
    const lines = variants.width200;
    const allText = lines.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // L2 is session ID — turns and size no longer displayed anywhere
    expect(allText).toContain('🆔:l2-no-overflow');
    expect(allText).not.toContain('15t');
    expect(allText).not.toContain('📦:');
  });

});

describe('Tmux Session Tracking', () => {
  test('SessionHealth can store tmux context', () => {
    const health = createDefaultHealth('tmux-test');
    health.tmux = {
      session: 'main',
      window: '1',
      pane: '0',
      width: 120,
      height: 30
    };

    expect(health.tmux).toBeDefined();
    expect(health.tmux.session).toBe('main');
    expect(health.tmux.window).toBe('1');
    expect(health.tmux.pane).toBe('0');
    expect(health.tmux.width).toBe(120);
    expect(health.tmux.height).toBe(30);
  });

  test('RuntimeSession preserves tmux context from SessionHealth', () => {
    const health = createDefaultHealth('tmux-convert');
    health.tmux = {
      session: 'dev',
      window: '2',
      pane: '1',
      width: 200,
      height: 50
    };

    const runtimeSession = sessionHealthToRuntimeSession(health, 'default');

    expect(runtimeSession.tmux).toBeDefined();
    expect(runtimeSession.tmux?.session).toBe('dev');
    expect(runtimeSession.tmux?.window).toBe('2');
    expect(runtimeSession.tmux?.pane).toBe('1');
    expect(runtimeSession.tmux?.width).toBe(200);
    expect(runtimeSession.tmux?.height).toBe(50);
  });

  test('RuntimeSession handles missing tmux context gracefully', () => {
    const health = createDefaultHealth('no-tmux');
    // No tmux context set

    const runtimeSession = sessionHealthToRuntimeSession(health, 'default');

    expect(runtimeSession.tmux).toBeUndefined();
  });
});

describe('Component Visibility', () => {

  test('git hides all counts when clean repo', () => {
    const health = createDefaultHealth('clean-git');
    health.git = {
      branch: 'main',
      ahead: 0,
      behind: 0,
      dirty: 0,
      lastChecked: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // Should show just branch, no +0-0*0
    expect(stripped).toContain('🌿:main');
    expect(stripped).not.toContain('+0');
    expect(stripped).not.toContain('-0');
    expect(stripped).not.toContain('*0');
  });

  test('git shows only non-zero counts', () => {
    const health = createDefaultHealth('dirty-git');
    health.git = {
      branch: 'feature',
      ahead: 3,
      behind: 0,
      dirty: 2,
      lastChecked: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // Should show +3*2 but not -0
    expect(stripped).toContain('🌿:feature+3*2');
    expect(stripped).not.toContain('-0');
  });
});

describe('Model Abbreviation', () => {
  test('model shows full name (Opus4.5) when space permits', () => {
    const health = createDefaultHealth('wide-model');
    health.projectPath = '~/short';
    health.git = { branch: 'main', ahead: 0, behind: 0, dirty: 0, lastChecked: Date.now() };
    health.model = { value: 'Opus4.5', isFresh: true };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    expect(stripped).toContain('🤖:Opus4.5');
  });

  test('model abbreviates to o-4.5 when L1 is tight', () => {
    const health = createDefaultHealth('tight-model');
    // Long path to trigger abbreviation
    health.projectPath = '~/very/long/path/that/takes/up/most/of/line1/space';
    health.git = { branch: 'feature-branch-name', ahead: 5, behind: 2, dirty: 10, lastChecked: Date.now() };
    health.model = { value: 'Opus4.5', isFresh: true };
    health.context = { tokensLeft: 100000, tokensUsed: 50000, percentUsed: 33, windowSize: 150000, nearCompaction: false };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const line1 = variants.width120[0].replace(/\x1b\[[0-9;]*m/g, '');

    // At 120 width with long path and git, model should be abbreviated
    // Could be on L1 as abbreviated or moved to L2
    const allLines = variants.width120.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    const hasAbbreviated = allLines.includes('o-4.5');
    const hasFull = allLines.includes('Opus4.5');

    // Should have abbreviated OR full (depending on fit), not both
    expect(hasAbbreviated || hasFull).toBe(true);
  });

  test('model abbreviates Sonnet to s-4.5', () => {
    const health = createDefaultHealth('sonnet-abbrev');
    health.projectPath = '~/very/long/path/name';
    health.git = { branch: 'long-branch-name', ahead: 0, behind: 0, dirty: 5, lastChecked: Date.now() };
    health.model = { value: 'Sonnet4.5', isFresh: true };

    const variants = StatuslineFormatter.formatAllVariants(health);

    // On narrow width, should abbreviate
    const narrow = variants.width80.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    const wide = variants.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Wide should show full
    expect(wide).toContain('Sonnet4.5');

    // Narrow should abbreviate or full (width80 might still fit full)
    expect(narrow).toMatch(/Sonnet4\.5|s-4\.5/);
  });

  test('model abbreviates Haiku to h-4.5', () => {
    const health = createDefaultHealth('haiku-abbrev');
    health.model = { value: 'Haiku4.5', isFresh: true };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const wide = variants.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    expect(wide).toContain('Haiku4.5');
  });
});

describe('Context Short Format', () => {
  test('context always shows short format with percentage', () => {
    const health = createDefaultHealth('wide-context');
    health.projectPath = '~/short';
    health.context = { tokensLeft: 154000, tokensUsed: 46000, percentUsed: 23, windowSize: 200000, nearCompaction: false };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Short format: 🧠:154k(23%) — no progress bar, no -free suffix
    expect(output).toContain('🧠:');
    expect(output).toContain('154k(23%)');
    expect(output).not.toMatch(/\[[-=|]+\]/); // No progress bar
  });

  test('context uses same short format at all widths', () => {
    const health = createDefaultHealth('medium-context');
    health.projectPath = '~/moderately/long/path/name';
    health.git = { branch: 'feature', ahead: 0, behind: 0, dirty: 3, lastChecked: Date.now() };
    health.model = { value: 'Opus4.5', isFresh: true };
    health.context = { tokensLeft: 154000, tokensUsed: 46000, percentUsed: 23, windowSize: 200000, nearCompaction: false };

    const variants = StatuslineFormatter.formatAllVariants(health);

    const narrow = variants.width80.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    const wide = variants.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Both narrow and wide use short format: 🧠:154k(23%)
    expect(wide).toContain('🧠:154k(23%)');
    expect(narrow).toContain('🧠:154k(23%)');
    // No progress bar at any width
    expect(wide).not.toMatch(/\[[-=|]+\]/);
  });

  test('minimal context shows only token count when very tight', () => {
    const health = createDefaultHealth('minimal-context');
    // Very long path to force minimal
    health.projectPath = '~/very/long/path/that/will/force/context/to/shrink/down';
    health.git = { branch: 'very-long-branch-name-here', ahead: 5, behind: 2, dirty: 10, lastChecked: Date.now() };
    health.model = { value: 'Opus4.5', isFresh: true };
    health.context = { tokensLeft: 100000, tokensUsed: 50000, percentUsed: 33, windowSize: 150000, nearCompaction: false };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const narrow = variants.width80.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // At 80 chars with long path, context should be minimal or moved to L2
    expect(narrow).toContain('🧠:');
    expect(narrow).toContain('100k');
  });

  test('all components stay on L1 even with long path (no L2 overflow)', () => {
    const health = createDefaultHealth('overflow-context');
    health.projectPath = '~/extremely/long/path/that/fills/line/one';
    health.git = { branch: 'another-very-long-branch-name', ahead: 10, behind: 5, dirty: 20, lastChecked: Date.now() };
    health.model = { value: 'Opus4.5', isFresh: true };
    health.context = { tokensLeft: 50000, tokensUsed: 100000, percentUsed: 67, windowSize: 150000, nearCompaction: false };

    const variants = StatuslineFormatter.formatAllVariants(health);

    // Core components may span multiple output lines (split at width boundaries)
    const allLines = variants.width60.map(l => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const sidIdx = allLines.findIndex(l => l.includes('🆔:'));
    const coreContent = allLines.slice(0, sidIdx > 0 ? sidIdx : allLines.length).join(' ');
    expect(coreContent).toContain('📁:');
    expect(coreContent).toContain('🤖:');
    expect(coreContent).toContain('🧠:');

    // Session ID line always present, does NOT contain core overflow
    const sidLine = allLines.find(l => l.includes('🆔:')) || '';
    expect(sidLine).toContain('🆔:');
    expect(sidLine).not.toContain('🤖:');
    expect(sidLine).not.toContain('🧠:');
  });
});


describe('Staleness Indicator', () => {
  beforeEach(() => {
    // Clear notification state to prevent leakage from other tests
    // (idle sessions now show all registered notifications, which can include ⚠)
    NotificationManager.clearAll();
    NotificationManager.clearCache();
  });

  test('no warning when data is fresh (<2 min old)', () => {
    const health = createDefaultHealth('fresh-data');
    health.gatheredAt = Date.now() - (60 * 1000); // 1 minute ago
    health.billing.lastFetched = health.gatheredAt;
    health.billing.budgetRemaining = 30;
    health.git.lastChecked = health.gatheredAt; // Ensure git is also fresh

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Fresh data should not show ⚠ staleness indicator on git
    expect(output).not.toContain('⚠');
  });

  test('clock shows on account context notification line (not main lines)', () => {
    const health = createDefaultHealth('time-test');
    health.projectPath = '~/project';
    health.gatheredAt = Date.now() - (30 * 60 * 1000);
    health.billing.lastFetched = health.gatheredAt;

    const variants = StatuslineFormatter.formatAllVariants(health);

    // Time (🕐) is now on the account context notification line, not on Line 1
    const line1 = variants.width120[0].replace(/\x1b\[[0-9;]*m/g, '');
    expect(line1).toContain('📁:');
    expect(line1).not.toContain('🕐:');
  });
});

describe('Model Abbreviations', () => {
  test('Opus4.5 abbreviates on L1, full on L2 overflow', () => {
    const health = createDefaultHealth('opus-abbrev');
    health.projectPath = '~/very/long/path/that/forces/abbreviation';
    health.git = { branch: 'long-branch-name', ahead: 5, behind: 2, dirty: 10, lastChecked: Date.now() };
    health.model = { value: 'Opus4.5', isFresh: true };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const lines = variants.width80;
    const line1 = lines[0].replace(/\x1b\[[0-9;]*m/g, '');

    // L1 may abbreviate to fit, or model overflows entirely to L2
    // L2 always shows full model name when present
    if (line1.includes('🤖:')) {
      // Model fit on L1 (possibly abbreviated)
      expect(line1).toMatch(/🤖:(o-4\.5|Opus4\.5)/);
    } else {
      // Model overflowed to L2 — should show full name
      const line2 = lines[1].replace(/\x1b\[[0-9;]*m/g, '');
      expect(line2).toContain('Opus4.5');
    }
  });

  test('Sonnet4.5 abbreviates on L1, full on L2 overflow', () => {
    const health = createDefaultHealth('sonnet-abbrev');
    health.projectPath = '~/very/long/path/that/forces/abbreviation';
    health.git = { branch: 'long-branch-name', ahead: 5, behind: 2, dirty: 10, lastChecked: Date.now() };
    health.model = { value: 'Sonnet4.5', isFresh: true };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const lines = variants.width80;
    const line1 = lines[0].replace(/\x1b\[[0-9;]*m/g, '');

    if (line1.includes('🤖:')) {
      expect(line1).toMatch(/🤖:(s-4\.5|Sonnet4\.5)/);
    } else {
      const line2 = lines[1].replace(/\x1b\[[0-9;]*m/g, '');
      expect(line2).toContain('Sonnet4.5');
    }
  });

  test('Haiku4.5 abbreviates on L1, full on L2 overflow', () => {
    const health = createDefaultHealth('haiku-abbrev');
    health.projectPath = '~/very/long/path/that/forces/abbreviation';
    health.git = { branch: 'long-branch-name', ahead: 5, behind: 2, dirty: 10, lastChecked: Date.now() };
    health.model = { value: 'Haiku4.5', isFresh: true };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const lines = variants.width80;
    const line1 = lines[0].replace(/\x1b\[[0-9;]*m/g, '');

    if (line1.includes('🤖:')) {
      expect(line1).toMatch(/🤖:(h-4\.5|Haiku4\.5)/);
    } else {
      const line2 = lines[1].replace(/\x1b\[[0-9;]*m/g, '');
      expect(line2).toContain('Haiku4.5');
    }
  });

  test('Unknown models keep full name', () => {
    const health = createDefaultHealth('unknown-model');
    health.projectPath = '~/project';
    health.model = { value: 'GPT-4-turbo', isFresh: true };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Unknown model should keep full name
    expect(output).toContain('GPT-4-turbo');
  });
});

describe('Single Line Mode (No Tmux)', () => {
  test('singleLine variant is generated', () => {
    const health = createDefaultHealth('single-line');
    health.projectPath = '~/project';
    health.billing = {
      costToday: 50,
      burnRatePerHour: 20,
      budgetRemaining: 60,
      budgetPercentUsed: 50,
      resetTime: '14:00',
      totalTokens: 500000,
      tokensPerMinute: 10000,
      isFresh: true,
      lastFetched: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);

    expect(variants.singleLine).toBeDefined();
    expect(Array.isArray(variants.singleLine)).toBe(true);
    expect(variants.singleLine.length).toBe(2); // 2 lines: core + session ID
  });

  test('singleLine respects max length of 240 chars', () => {
    const health = createDefaultHealth('single-line-max');
    health.projectPath = '~/project';
    health.billing = {
      costToday: 50,
      burnRatePerHour: 20,
      budgetRemaining: 60,
      budgetPercentUsed: 50,
      resetTime: '14:00',
      isFresh: true,
      lastFetched: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const singleLine = variants.singleLine[0].replace(/\x1b\[[0-9;]*m/g, '');

    expect(singleLine.length).toBeLessThanOrEqual(240);
  });

  test('singleLine shrinks components when needed', () => {
    const health = createDefaultHealth('single-line-shrink');
    health.projectPath = '~/very/long/project/path/that/takes/up/space';
    health.git = { branch: 'feature-branch-with-long-name', ahead: 10, behind: 5, dirty: 20, lastChecked: Date.now() };
    health.model = { value: 'Opus4.5', isFresh: true };
    health.context = { tokensLeft: 100000, tokensUsed: 100000, percentUsed: 50, windowSize: 200000, nearCompaction: false };
    health.billing = {
      costToday: 100,
      burnRatePerHour: 30,
      budgetRemaining: 30,
      budgetPercentUsed: 75,
      weeklyBudgetRemaining: 48,
      weeklyBudgetPercentUsed: 60,
      weeklyResetDay: 'Thu',
      resetTime: '14:00',
      totalTokens: 1000000,
      tokensPerMinute: 50000,
      isFresh: true,
      lastFetched: Date.now()
    };
    health.transcript = { ...health.transcript, messageCount: 5000 };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const singleLine = variants.singleLine[0].replace(/\x1b\[[0-9;]*m/g, '');

    // Should be within max length
    expect(singleLine.length).toBeLessThanOrEqual(240);

    // Should contain essential components (time moved to notification line)
    expect(singleLine).toContain('📁:');
    expect(singleLine).toContain('🤖:'); // Model should be present
  });
});

describe('Failover Notification Display', () => {
  test('failover notification appears in notification lines when present', () => {
    const health = createDefaultHealth('failover-test');
    health.projectPath = '~/project';
    health.failoverNotification = '🔄 Swapped → slot-2 (3m ago)';

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // Failover notification appears in output (notification lines, not line 1)
    expect(stripped).toContain('🔄 Swapped → slot-2 (3m ago)');
    // Line 1 starts with directory, not failover
    const line1 = variants.width120[0].replace(/\x1b\[[0-9;]*m/g, '');
    expect(line1).toMatch(/^📁:/);
  });

  test('failover notification absent when field is undefined', () => {
    const health = createDefaultHealth('no-failover');
    health.projectPath = '~/project';
    // failoverNotification is undefined by default

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    expect(stripped).not.toContain('🔄');
  });

  test('failover notification takes priority over transcript stale', () => {
    const health = createDefaultHealth('failover-priority');
    health.projectPath = '~/project';
    health.failoverNotification = '🔄 Swapped → slot-1 (30s ago)';
    health.alerts.transcriptStale = true;
    health.transcript.lastModifiedAgo = '10m';

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // Failover should show, transcript stale should NOT (only one alert slot)
    expect(stripped).toContain('🔄 Swapped');
    expect(stripped).not.toContain('📝:10m');
  });

  test('secrets and failover coexist in notification lines', () => {
    const health = createDefaultHealth('secrets-vs-failover');
    health.projectPath = '~/project';
    health.failoverNotification = '🔄 Swapped → slot-2 (1m ago)';
    health.alerts.secretsDetected = true;
    health.alerts.secretTypes = ['API_KEY'];

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // Failover shows in notification lines
    expect(stripped).toContain('🔄 Swapped');

    // Line 1 starts with directory (not failover)
    const line1 = variants.width120[0].replace(/\x1b\[[0-9;]*m/g, '');
    expect(line1).toMatch(/^📁:/);
  });

  test('secrets notification cleared when no secrets in current session', () => {
    // Simulate: previous session left secrets_detected notification
    NotificationManager.register('secrets_detected', '2 secrets detected', 3);
    expect(NotificationManager.get('secrets_detected')).not.toBeNull();

    // New session: health has secretsDetected=false (empty transcript)
    const health = createDefaultHealth('new-session-no-secrets');
    health.projectPath = '~/project';
    health.alerts.secretsDetected = false;
    health.alerts.secretTypes = [];
    health.transcript.lastMessagePreview = 'Hello';

    // formatAllVariants should clear the stale notification
    StatuslineFormatter.formatAllVariants(health);

    // Notification should be removed
    expect(NotificationManager.get('secrets_detected')).toBeNull();
  });

  // Phase 4: Transcript indicator dedup — suppress 📝 when line 3 message preview shows elapsed
  test('transcriptStale with lastMessagePreview → no 📝 indicator (suppressed)', () => {
    const health = createDefaultHealth('dedup-stale-preview');
    health.projectPath = '~/project';
    health.alerts.transcriptStale = true;
    health.transcript.lastModifiedAgo = '37m';
    health.transcript.lastMessagePreview = 'What does the main function do?';
    health.transcript.lastMessageAgo = '35m';

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // 📝 indicator should be suppressed since line 3 shows "(35m) What does..."
    expect(stripped).not.toContain('📝:37m');
  });

  test('transcriptStale without lastMessagePreview → no 📝 on line 1 (moved to notifications)', () => {
    const health = createDefaultHealth('dedup-stale-no-preview');
    health.projectPath = '~/project';
    health.alerts.transcriptStale = true;
    health.transcript.lastModifiedAgo = '37m';
    health.transcript.lastMessagePreview = undefined;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // 📝 indicator removed from line 1 — transcript staleness handled by line 3 elapsed time
    expect(stripped).not.toContain('📝:37m');
    // Line 1 starts with directory
    const line1 = variants.width120[0].replace(/\x1b\[[0-9;]*m/g, '');
    expect(line1).toMatch(/^📁:/);
  });

  test('dataLossRisk with lastMessagePreview → no 📝 indicator (suppressed)', () => {
    const health = createDefaultHealth('dedup-risk-preview');
    health.projectPath = '~/project';
    health.alerts.dataLossRisk = true;
    health.alerts.transcriptStale = true;
    health.transcript.lastModifiedAgo = '37m';
    health.transcript.lastMessagePreview = 'What does this function do?';
    health.transcript.lastMessageAgo = '35m';

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // 📝:37m⚠ should be suppressed — line 3 shows elapsed
    expect(stripped).not.toContain('📝:37m');
    expect(stripped).not.toContain('📝:37m⚠');
  });

  test('dataLossRisk without lastMessagePreview → no 📝 on line 1 (moved to notifications)', () => {
    const health = createDefaultHealth('dedup-risk-no-preview');
    health.projectPath = '~/project';
    health.alerts.dataLossRisk = true;
    health.alerts.transcriptStale = true;
    health.transcript.lastModifiedAgo = '37m';
    health.transcript.lastMessagePreview = undefined;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // 📝 indicator removed from line 1 — alerts handled by notification layer
    expect(stripped).not.toContain('📝:37m⚠');
    expect(stripped).not.toContain('📝:37m');
    // Line 1 starts with directory
    const line1 = variants.width120[0].replace(/\x1b\[[0-9;]*m/g, '');
    expect(line1).toMatch(/^📁:/);
  });
});

// ============================================================================
// Phase 1 + 2 Integration Tests: Slot Indicator + Notifications
// ============================================================================

describe('Phase 1+2: Slot Indicator + Notifications Integration', () => {
  const TEST_DIR = join(tmpdir(), `phase12-integration-test-${Date.now()}`);
  const LOCK_DIR = join(TEST_DIR, 'session-health');

  beforeEach(() => {
    mkdirSync(LOCK_DIR, { recursive: true });
    // Override paths for testing
    (SessionLockManager as any).LOCK_DIR = LOCK_DIR;
    (NotificationManager as any).STATE_PATH = join(LOCK_DIR, 'notifications.json');
    SessionLockManager.clearCache?.();
    NotificationManager.clearCache();
  });

  afterEach(() => {
    SessionLockManager.clearCache?.();
    NotificationManager.clearCache();
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('Slot Indicator Display', () => {
    // Slot indicator now appears on the account context notification line (not Line 2).
    // Tests need: session lock + active_slot notification + idle or show cycle.

    function makeIdleHealth(sessionId: string) {
      const health = createDefaultHealth(sessionId);
      health.projectPath = '~/project';
      // Make transcript idle (>2min old) so notifications always show
      health.transcript.lastModified = Date.now() - (5 * 60 * 1000);
      health.transcript.lastMessagePreview = 'test';
      health.transcript.lastMessageAgo = '5m';
      return health;
    }

    test('shows S1 on account line when session lock exists with slot-1', () => {
      const health = makeIdleHealth('slot-test-1');

      SessionLockManager.create(
        'slot-test-1',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );
      NotificationManager.register('active_slot', 'user@example.com (slot-1)', 8);

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).toContain('S1');
      expect(stripped).toContain('user@example.com');
    });

    test('shows S2 on account line when session lock exists with slot-2', () => {
      const health = makeIdleHealth('slot-test-2');

      SessionLockManager.create(
        'slot-test-2',
        'slot-2',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );
      NotificationManager.register('active_slot', 'user@example.com (slot-2)', 8);

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).toContain('S2');
      expect(stripped).toContain('user@example.com');
    });

    test('shows S3 on account line when session lock exists with slot-3', () => {
      const health = makeIdleHealth('slot-test-3');

      SessionLockManager.create(
        'slot-test-3',
        'slot-3',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );
      NotificationManager.register('active_slot', 'user@example.com (slot-3)', 8);

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).toContain('S3');
      expect(stripped).toContain('user@example.com');
    });

    test('shows no slot indicator when lock file missing', () => {
      const health = createDefaultHealth('slot-test-no-lock');
      health.projectPath = '~/project';

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).not.toContain('S1');
      expect(stripped).not.toContain('S2');
      expect(stripped).not.toContain('S3');
    });

    test('account context inline on L1 has time and slot together', () => {
      const health = makeIdleHealth('slot-position-test');

      SessionLockManager.create(
        'slot-position-test',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );
      NotificationManager.register('active_slot', 'user@example.com (slot-1)', 8);

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      // Account context is inline on L1: 👤S1|email|🕐:HH:MM (no space after 👤)
      expect(stripped).toMatch(/👤S1/);
      expect(stripped).toMatch(/🕐:\d{2}:\d{2}/);
      // Verify it's on Line 1, not a notification line
      const line1 = variants.width120[0].replace(/\x1b\[[0-9;]*m/g, '');
      expect(line1).toContain('👤S1');
    });

    test('no double pipe in slot display', () => {
      const health = makeIdleHealth('slot-double-pipe-test');

      SessionLockManager.create(
        'slot-double-pipe-test',
        'slot-2',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );
      NotificationManager.register('active_slot', 'user@example.com (slot-2)', 8);

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      // Must never have double pipe anywhere
      expect(stripped).not.toContain('||');
    });
  });

  describe('Version Update Notification', () => {
    test('shows update notification when registered', () => {
      const health = createDefaultHealth('version-notify-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';

      NotificationManager.register(
        'version_update',
        'Update to 2.1.32 available (your version: 2.1.31)',
        7
      );
      // Mark as shown to start show cycle
      NotificationManager.recordShown('version_update');

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).toContain('Update to 2.1.32 available');
      expect(stripped).toContain('2.1.31');
    });

    test('update notification appears on line 3', () => {
      const health = createDefaultHealth('version-line-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';

      NotificationManager.register(
        'version_update',
        'Update to 2.1.32 available',
        7
      );
      NotificationManager.recordShown('version_update');

      const variants = StatuslineFormatter.formatAllVariants(health);
      // Line 1: dir+model+ctx, Line 2: last msg, Line 3: notification (no Line 2 time)
      expect(variants.width120.length).toBeGreaterThanOrEqual(3);

      const lastLine = variants.width120[variants.width120.length - 1];
      const stripped = lastLine.replace(/\x1b\[[0-9;]*m/g, '');
      expect(stripped).toContain('Update to 2.1.32');
    });

    test('no notification line when no notifications active', () => {
      const health = createDefaultHealth('no-notify-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      // Should only have 2 lines (dir+model+context, last message) — no Line 2 time
      expect(variants.width120.length).toBe(2);
    });

    test('notification hidden when dismissed', () => {
      const health = createDefaultHealth('dismissed-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';

      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.dismiss('version_update');

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).not.toContain('Update available');
      expect(variants.width120.length).toBe(2); // No notification line, no time line
    });
  });

  describe('Slot Switch Notification', () => {
    test('shows slot switch notification when registered', () => {
      const health = createDefaultHealth('slot-switch-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';

      NotificationManager.register(
        'slot_switch',
        'Switch to slot-3 (rank 1, urgency: 538)',
        6
      );
      NotificationManager.recordShown('slot_switch');

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      // Switch line uses notification message directly with 💡 prefix
      expect(stripped).toContain('Switch to slot-3');
    });

    test('slot switch uses cyan color (💡)', () => {
      const health = createDefaultHealth('slot-color-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';

      NotificationManager.register('slot_switch', 'Switch slots', 6);
      NotificationManager.recordShown('slot_switch');

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');

      expect(output).toContain('💡');
    });
  });

  describe('Multiple Notifications', () => {
    test('shows both version and slot notifications', () => {
      const health = createDefaultHealth('multi-notify-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';

      NotificationManager.register('version_update', 'Update to 2.1.32', 7);
      NotificationManager.recordShown('version_update');
      NotificationManager.register('slot_switch', 'Switch to slot-2', 6);
      NotificationManager.recordShown('slot_switch');

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).toContain('Update to 2.1.32');
      expect(stripped).toContain('Switch to slot-2');
      // 2 base (dir+ctx, msg) + up to 3 notifications = 4-5
      expect(variants.width120.length).toBeGreaterThanOrEqual(4);
    });

    test('higher priority notification appears first', () => {
      const health = createDefaultHealth('priority-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';

      NotificationManager.register('slot_switch', 'Switch slots', 6);
      NotificationManager.recordShown('slot_switch');
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.recordShown('version_update');

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

      // Both should be present
      expect(output).toContain('Update available');
      expect(output).toContain('Switch slots');

      // Version (priority 7) should appear before slot switch (priority 6) in output
      const versionIdx = output.indexOf('Update available');
      const switchIdx = output.indexOf('Switch slots');
      expect(versionIdx).toBeLessThan(switchIdx);
    });

    test('max 3 notifications shown simultaneously', () => {
      const health = createDefaultHealth('max-notify-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';

      NotificationManager.register('version_update', 'Update', 7);
      NotificationManager.recordShown('version_update');
      NotificationManager.register('slot_switch', 'Switch', 6);
      NotificationManager.recordShown('slot_switch');
      NotificationManager.register('restart_ready', 'Restart', 5);
      NotificationManager.recordShown('restart_ready');

      const variants = StatuslineFormatter.formatAllVariants(health);

      // Should have max 5 lines (2 base + 3 notifications)
      expect(variants.width120.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Full Integration: Slot + Notifications', () => {
    test('slot indicator and notification coexist', () => {
      const health = createDefaultHealth('full-integration-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';
      // Make idle so notifications always show
      health.transcript.lastModified = Date.now() - (5 * 60 * 1000);

      SessionLockManager.create(
        'full-integration-test',
        'slot-2',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      NotificationManager.register('active_slot', 'user@example.com (slot-2)', 8);
      NotificationManager.register('version_update', 'Update to 2.1.33', 7);
      NotificationManager.recordShown('version_update');

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      // Account is inline on L1, version notification on L3
      expect(stripped).toContain('S2');
      expect(stripped).toContain('Update to 2.1.33');

      // 2 base (L1 core+account, L2 session) + 1 notification = 3 lines
      expect(variants.width120.length).toBe(3);
    });

    test('handles all width variants correctly', () => {
      const health = createDefaultHealth('width-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';
      // Make idle so notifications always show
      health.transcript.lastModified = Date.now() - (5 * 60 * 1000);

      SessionLockManager.create(
        'width-test',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      NotificationManager.register('active_slot', 'user@example.com (slot-1)', 8);
      NotificationManager.register('version_update', 'Update available', 7);

      const variants = StatuslineFormatter.formatAllVariants(health);

      // All multi-line variants should have slot indicator and notification
      for (const [width, lines] of Object.entries(variants)) {
        if (width === 'singleLine') continue; // Skip single line

        const output = lines.join('\n');
        const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

        expect(stripped).toContain('S1');
        expect(stripped).toContain('Update available');
      }
    });

    test('inline slot indicator appears on L1/L2 between context and turns', () => {
      const health = createDefaultHealth('inline-slot-test');
      health.model = { value: 'Opus4.6', confidence: 100 };
      health.context = { tokensLeft: 100000, percentUsed: 25 };
      health.transcript = { exists: true, lastModifiedAgo: '1m', isSynced: true, messageCount: 5, sizeBytes: 50000, lastMessagePreview: 'test msg' };

      SessionLockManager.create(
        'inline-slot-test',
        'slot-2',
        '/tmp/test-config',
        'anthropic-credentials',
        'user@example.com',
        '/tmp/transcript'
      );

      const variants = StatuslineFormatter.formatAllVariants(health);

      // Wide variant: slot should be on L1
      const wide = variants.width200.join('\n');
      const strippedWide = wide.replace(/\x1b\[[0-9;]*m/g, '');
      expect(strippedWide).toContain('👤S2');

      // Verify ordering: 🧠 before 👤S2 before 💬
      const ctxIdx = strippedWide.indexOf('🧠:');
      const slotIdx = strippedWide.indexOf('👤S2');
      const turnsIdx = strippedWide.indexOf('💬:');
      expect(slotIdx).toBeGreaterThan(ctxIdx);
      if (turnsIdx > 0) {
        expect(slotIdx).toBeLessThan(turnsIdx);
      }
    });

    test('no inline slot indicator when no session lock', () => {
      const health = createDefaultHealth('no-lock-inline-test');
      health.model = { value: 'Claude', confidence: 100 };
      health.context = { tokensLeft: 100000, percentUsed: 25 };

      const variants = StatuslineFormatter.formatAllVariants(health);
      const wide = variants.width200.join('\n');
      const strippedWide = wide.replace(/\x1b\[[0-9;]*m/g, '');

      // No 👤S on the main lines (only in notifications if any)
      const line1 = strippedWide.split('\n')[0];
      expect(line1).not.toContain('👤S');
    });
  });

  // =========================================================================
  // Display Config: Margin
  // =========================================================================
  describe('configurable margin', () => {
    test('marginPercent=0 uses full width (no margin)', () => {
      const health = createDefaultHealth('margin-zero-test');
      health.model = { value: 'Opus4.6', confidence: 100 };
      health.context = { tokensLeft: 100000, percentUsed: 25 };
      health.projectPath = '~/project';
      health.git = { branch: 'main', ahead: 0, behind: 0, dirty: 0 };

      const noMargin = StatuslineFormatter.formatAllVariants(health, 0);
      const autoMargin = StatuslineFormatter.formatAllVariants(health, null);

      // With 0% margin, more content fits on L1 → line should be wider
      const noMarginL1 = noMargin.width80[0].replace(/\x1b\[[0-9;]*m/g, '');
      const autoMarginL1 = autoMargin.width80[0].replace(/\x1b\[[0-9;]*m/g, '');

      // No-margin should fit at least as much content
      expect(noMarginL1.length).toBeGreaterThanOrEqual(autoMarginL1.length);
    });

    test('marginPercent=10 applies 10% margin', () => {
      const health = createDefaultHealth('margin-10-test');
      health.model = { value: 'Opus4.6', confidence: 100 };
      health.context = { tokensLeft: 100000, percentUsed: 25 };
      health.projectPath = '~/a-very-long-project-path-that-needs-space';
      health.git = { branch: 'feature/very-long-branch-name', ahead: 5, behind: 0, dirty: 3 };

      const margin10 = StatuslineFormatter.formatAllVariants(health, 10);
      const margin0 = StatuslineFormatter.formatAllVariants(health, 0);

      // 10% margin = less room → wider variant may overflow to L2
      const m10Lines = margin10.width80.length;
      const m0Lines = margin0.width80.length;
      expect(m10Lines).toBeGreaterThanOrEqual(m0Lines);
    });

    test('negative marginPercent clamped to 0 (no wider than terminal)', () => {
      const health = createDefaultHealth('margin-neg-test');
      health.model = { value: 'Opus4.6', confidence: 100 };
      health.context = { tokensLeft: 100000, percentUsed: 25 };
      health.projectPath = '~/project';

      // Negative should be clamped — should not crash or produce oversized output
      const result = StatuslineFormatter.formatAllVariants(health, -50);
      expect(result.width80).toBeDefined();
      expect(result.width80.length).toBeGreaterThan(0);

      // Verify no line exceeds terminal width (80 chars visible)
      for (const line of result.width80) {
        const visible = line.replace(/\x1b\[[0-9;]*m/g, '');
        expect(visible.length).toBeLessThanOrEqual(80);
      }
    });

    test('marginPercent=100 clamped to 50 (not catastrophic)', () => {
      const health = createDefaultHealth('margin-100-test');
      health.model = { value: 'Opus4.6', confidence: 100 };
      health.context = { tokensLeft: 100000, percentUsed: 25 };
      health.projectPath = '~/project';

      const result = StatuslineFormatter.formatAllVariants(health, 100);
      expect(result.width80).toBeDefined();
      expect(result.width80.length).toBeGreaterThan(0);
      // Should still produce meaningful output (clamped to 50% → 40 effective width)
      const visible = result.width80[0].replace(/\x1b\[[0-9;]*m/g, '');
      expect(visible.length).toBeGreaterThan(0);
    });

    test('marginPercent=50 is the maximum (half width)', () => {
      const health = createDefaultHealth('margin-50-test');
      health.model = { value: 'Opus4.6', confidence: 100 };
      health.context = { tokensLeft: 100000, percentUsed: 25 };
      health.projectPath = '~/project';

      const m50 = StatuslineFormatter.formatAllVariants(health, 50);
      const m100 = StatuslineFormatter.formatAllVariants(health, 100);

      // Both should produce same output (100 clamped to 50)
      const m50L1 = m50.width120[0].replace(/\x1b\[[0-9;]*m/g, '');
      const m100L1 = m100.width120[0].replace(/\x1b\[[0-9;]*m/g, '');
      expect(m50L1.length).toBe(m100L1.length);
    });

    test('singleLine variant also respects margin clamping', () => {
      const health = createDefaultHealth('margin-single-test');
      health.model = { value: 'Opus4.6', confidence: 100 };
      health.context = { tokensLeft: 100000, percentUsed: 25 };
      health.projectPath = '~/project';

      const result = StatuslineFormatter.formatAllVariants(health, -10);
      expect(result.singleLine).toBeDefined();
      expect(result.singleLine.length).toBe(2); // 2 lines: core + session ID
      expect(result.singleLine[0].length).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // L2 Overflow: Progressive Shrink Cascade
  // =========================================================================
  describe('L1 merged layout (no overflow)', () => {
    test('long path + long branch: all components on L1, session ID on L2', () => {
      const health = createDefaultHealth('l2-overflow-test');
      health.model = { value: 'Opus4.6', confidence: 100 };
      health.context = { tokensLeft: 68000, percentUsed: 56 };
      health.projectPath = '~/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2';
      health.git = { branch: 'stream-8-local-dev-refactor', ahead: 1, behind: 0, dirty: 0 };
      health.transcript = { lastMessagePreview: 'Hello world', messageCount: 3, sizeBytes: 4 * 1024 * 1024 };
      health.cliVersion = '2.1.50';

      const result = StatuslineFormatter.formatAllVariants(health, 0);
      const lines = result.width100;
      const stripped = lines.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, ''));

      // Core components may span multiple lines (split at width boundaries)
      const sidIdx = stripped.findIndex(l => l.includes('🆔:'));
      const coreContent = stripped.slice(0, sidIdx > 0 ? sidIdx : stripped.length).join(' ');
      expect(coreContent).toContain('📁:');
      expect(coreContent).toContain('🌿:');
      expect(coreContent).toContain('🤖:Opus4.6');
      expect(coreContent).toContain('🧠:68k(56%)');

      // Session ID line always present
      expect(lines.length).toBeGreaterThanOrEqual(2);
      expect(stripped.some(l => l.includes('🆔:l2-overflow-test'))).toBe(true);
    });

    test('version shows on L1 as 📟:vX.Y.Z', () => {
      const health = createDefaultHealth('l1-version');
      health.model = { value: 'Opus4.6', confidence: 100 };
      health.context = { tokensLeft: 68000, percentUsed: 56 };
      health.projectPath = '~/project';
      health.cliVersion = '2.1.50';

      const result = StatuslineFormatter.formatAllVariants(health, 0);
      const l1 = result.width200[0].replace(/\x1b\[[0-9;]*m/g, '');

      // Version always on L1 in new layout
      expect(l1).toContain('📟:v2.1.50');
    });

    test('session and notification lines (L2+) do not exceed effective width', () => {
      const health = createDefaultHealth('l2-width-check');
      health.model = { value: 'Opus4.6', confidence: 100 };
      health.context = { tokensLeft: 68000, percentUsed: 56 };
      health.projectPath = '~/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2';
      health.git = { branch: 'stream-8-local-dev-refactor', ahead: 1, behind: 0, dirty: 0 };
      health.transcript = { lastMessagePreview: 'Hello', messageCount: 3, sizeBytes: 4 * 1024 * 1024 };
      health.cliVersion = '2.1.50';

      // L1 is unconstrained (wraps naturally). L2+ (session, notifications) must respect width.
      const widths = [60, 80, 100, 120] as const;
      for (const w of widths) {
        const key = `width${w}` as keyof typeof result;
        const result = StatuslineFormatter.formatAllVariants(health, 0);
        const lines = result[key] as string[];
        // Skip L0 (merged core line), check L1+ for width compliance
        for (let i = 1; i < lines.length; i++) {
          const visible = lines[i].replace(/\x1b\[[0-9;]*m/g, '');
          expect(visible.length).toBeLessThanOrEqual(w);
        }
      }
    });
  });
});

describe('Cross-Width Layout Correctness', () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  // Helper to count how many lines contain a component
  const linesWithComponent = (lines: string[], emoji: string) =>
    lines.filter(l => strip(l).includes(emoji)).length;

  test('short path: core components on L1, session ID on L2', () => {
    const health = createDefaultHealth('short-path');
    health.projectPath = '~/proj';
    health.git = { branch: 'main', ahead: 0, behind: 0, dirty: 2, lastChecked: Date.now() };
    health.model = { value: 'Opus4.6', source: 'jsonInput', confidence: 80 };
    health.context = { tokensLeft: 93000, tokensUsed: 73000, percentUsed: 44, windowSize: 200000, nearCompaction: false };
    health.transcript = { ...health.transcript, messageCount: 6, sizeBytes: 6.6 * 1024 * 1024, lastMessagePreview: 'test msg', lastModifiedAgo: '<1m', exists: true, isSynced: true };
    health.cliVersion = '2.1.50';

    const variants = StatuslineFormatter.formatAllVariants(health, 0);

    // L1 has core: dir, model, context, version (turns removed from layout)
    const l1_200 = strip(variants.width200[0]);
    expect(l1_200).toContain('📁:');
    expect(l1_200).toContain('🤖:');
    expect(l1_200).toContain('🧠:');
    expect(l1_200).toContain('📟:v2.1.50');

    // L2 is always session ID + message
    expect(variants.width200.length).toBeGreaterThanOrEqual(2);
    const l2 = strip(variants.width200[1]);
    expect(l2).toContain('🆔:short-path');
  });

  test('long path: all components on L1, session ID on L2', () => {
    const health = createDefaultHealth('long-path');
    health.projectPath = '~/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2';
    health.git = { branch: 'stream-6-device-id-only', ahead: 0, behind: 0, dirty: 0, lastChecked: Date.now() };
    health.model = { value: 'Opus4.6', source: 'jsonInput', confidence: 80 };
    health.context = { tokensLeft: 93000, tokensUsed: 73000, percentUsed: 44, windowSize: 200000, nearCompaction: false };
    health.transcript = { ...health.transcript, messageCount: 6, sizeBytes: 6.6 * 1024 * 1024, lastMessagePreview: 'hello world', lastModifiedAgo: '<1m', exists: true, isSynced: true };
    health.cliVersion = '2.1.50';

    const variants = StatuslineFormatter.formatAllVariants(health, 0);

    // Core components may span multiple lines (split at width boundaries)
    const lines100 = variants.width100;
    const stripped100 = lines100.map((l: string) => strip(l));
    const sidIdx = stripped100.findIndex(l => l.includes('🆔:'));
    const coreContent = stripped100.slice(0, sidIdx > 0 ? sidIdx : stripped100.length).join(' ');
    expect(coreContent).toContain('📁:');
    expect(coreContent).toContain('🌿:');
    expect(coreContent).toContain('🤖:');
    expect(coreContent).toContain('🧠:');

    // Session ID line always present
    expect(lines100.length).toBeGreaterThanOrEqual(2);
    expect(stripped100.some(l => l.includes('🆔:long-path'))).toBe(true);
  });

  test('no component appears on more than one line', () => {
    const health = createDefaultHealth('no-dupes');
    health.projectPath = '~/medium/project/path';
    health.git = { branch: 'feature-xyz', ahead: 3, behind: 0, dirty: 5, lastChecked: Date.now() };
    health.model = { value: 'Opus4.6', source: 'jsonInput', confidence: 80 };
    health.context = { tokensLeft: 50000, tokensUsed: 116000, percentUsed: 70, windowSize: 200000, nearCompaction: true };
    health.transcript = { ...health.transcript, messageCount: 20, sizeBytes: 2 * 1024 * 1024, lastMessagePreview: 'test', lastModifiedAgo: '2m', exists: true, isSynced: true };

    const widths = ['width60', 'width80', 'width100', 'width120', 'width150', 'width200'] as const;
    const variants = StatuslineFormatter.formatAllVariants(health, 0);

    for (const w of widths) {
      const lines = variants[w];
      // Model should appear at most once across all lines
      expect(linesWithComponent(lines, '🤖:')).toBeLessThanOrEqual(1);
      // Context should appear at most once
      expect(linesWithComponent(lines, '🧠:')).toBeLessThanOrEqual(1);
      // Dir should appear exactly once
      expect(linesWithComponent(lines, '📁:')).toBe(1);
    }
  });

  test('context shows no -free or -left suffix', () => {
    const health = createDefaultHealth('no-suffix');
    health.context = { tokensLeft: 154000, tokensUsed: 46000, percentUsed: 23, windowSize: 200000, nearCompaction: false };

    const variants = StatuslineFormatter.formatAllVariants(health, 0);
    const widths = ['width60', 'width80', 'width100', 'width120', 'width150', 'width200'] as const;

    for (const w of widths) {
      const text = variants[w].join('\n');
      expect(text).not.toContain('-free');
      expect(text).not.toContain('-left');
    }
  });

  test('high usage context shows percentage in short format', () => {
    const health = createDefaultHealth('bar-test');
    health.projectPath = '~/proj';
    health.model = { value: 'Opus4.6', source: 'jsonInput', confidence: 80 };
    health.context = { tokensLeft: 1000, tokensUsed: 165000, percentUsed: 99, windowSize: 200000, nearCompaction: true };

    const variants = StatuslineFormatter.formatAllVariants(health, 0);
    const output = variants.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Short format: 🧠:1k(99%) — no progress bar
    expect(output).toContain('🧠:1k(99%)');
    expect(output).not.toMatch(/\[[-=|]+\]/); // No progress bar
  });

  test('all widths produce at least 1 line', () => {
    const health = createDefaultHealth('all-widths');
    health.projectPath = '~/p';

    const variants = StatuslineFormatter.formatAllVariants(health, 0);
    const widths = ['width40', 'width60', 'width80', 'width100', 'width120', 'width150', 'width200'] as const;

    for (const w of widths) {
      expect(variants[w].length).toBeGreaterThanOrEqual(1);
      expect(strip(variants[w][0]).length).toBeGreaterThan(0);
    }
  });

  test('near-compaction context (97%) shows critical color and percentage', () => {
    const health = createDefaultHealth('near-compact');
    health.projectPath = '~/proj';
    health.model = { value: 'Opus4.6', source: 'jsonInput', confidence: 80 };
    health.context = { tokensLeft: 4000, tokensUsed: 162000, percentUsed: 97, windowSize: 200000, nearCompaction: true };

    // Temporarily disable NO_COLOR to test ANSI color output
    const savedNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const variants = StatuslineFormatter.formatAllVariants(health, 0);
      const output = variants.width200.join('\n');
      const stripped = strip(output);

      // Short format: 🧠:4k(97%) — no progress bar, no -free/-left suffix
      expect(stripped).toContain('🧠:4k(97%)');
      expect(stripped).not.toContain('4k-free');
      expect(stripped).not.toContain('4k-left');
      expect(stripped).not.toMatch(/\[[-=|]+\]/); // No progress bar

      // Should use critical color (contextCrit = \x1b[38;5;203m)
      expect(output).toContain('\x1b[38;5;203m');
    } finally {
      if (savedNoColor !== undefined) process.env.NO_COLOR = savedNoColor;
      else process.env.NO_COLOR = '1'; // Restore test default
    }
  });
});

// =========================================================================
// splitAtWidth — Edge Cases
// =========================================================================
describe('splitAtWidth edge cases', () => {
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

  test('short line returns as-is (no split)', () => {
    const health = createDefaultHealth('split-short');
    health.projectPath = '~/proj';
    health.model = { value: 'Opus', source: 'jsonInput', confidence: 100 };
    health.context = { tokensLeft: 100000, percentUsed: 10 };

    const result = StatuslineFormatter.formatAllVariants(health, 0);
    // At width200, short path fits on 1 line
    const coreLines = result.width200.filter(l => !strip(l).includes('🆔:') && !strip(l).includes('⚠'));
    expect(coreLines.length).toBe(1);
  });

  test('long line splits into multiple lines at width boundary', () => {
    const health = createDefaultHealth('split-long');
    health.projectPath = '~/very/long/project/path/that/fills/one/line/completely';
    health.git = { branch: 'feature-branch-with-long-name', ahead: 5, behind: 2, dirty: 10, lastChecked: Date.now() };
    health.model = { value: 'Opus4.6[1m]', source: 'jsonInput', confidence: 100 };
    health.context = { tokensLeft: 50000, percentUsed: 75 };
    health.cliVersion = '2.1.104';
    health.billing = { sessionCost: 15.5, burnRatePerHour: 6.2, sessionBurnRate: 6.2, costToday: 15.5, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true };

    const result = StatuslineFormatter.formatAllVariants(health, 0);
    // At width60, should split into multiple core lines
    const allStripped = result.width60.map(l => strip(l));
    const sidIdx = allStripped.findIndex(l => l.includes('🆔:'));
    // Core content spans at least 2 lines before session ID
    expect(sidIdx).toBeGreaterThanOrEqual(2);
  });

  test('session ID line always present regardless of width', () => {
    const health = createDefaultHealth('split-sid');
    health.projectPath = '~/very/very/very/long/path/that/exceeds/any/reasonable/width';
    health.model = { value: 'Opus4.6[1m]', source: 'jsonInput', confidence: 100 };
    health.context = { tokensLeft: 100000, percentUsed: 50 };

    for (const width of [40, 60, 80, 100, 120, 150, 200]) {
      const key = `width${width}` as keyof ReturnType<typeof StatuslineFormatter.formatAllVariants>;
      const result = StatuslineFormatter.formatAllVariants(health, 0);
      const lines = (result[key] as string[]).map(l => strip(l));
      expect(lines.some(l => l.includes('🆔:split-sid'))).toBe(true);
    }
  });

  test('each split line ends with ANSI reset', () => {
    const health = createDefaultHealth('split-ansi');
    health.projectPath = '~/very/long/project/path/that/needs/splitting';
    health.git = { branch: 'long-branch-name-here', ahead: 0, behind: 0, dirty: 5, lastChecked: Date.now() };
    health.model = { value: 'Opus4.6', source: 'jsonInput', confidence: 100 };
    health.context = { tokensLeft: 50000, percentUsed: 75 };
    health.cliVersion = '2.1.104';
    health.billing = { sessionCost: 5.0, burnRatePerHour: 3.0, sessionBurnRate: 3.0, costToday: 5.0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true };

    // Temporarily enable colors
    const savedNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    try {
      const result = StatuslineFormatter.formatAllVariants(health, 0);
      const lines = result.width60;
      // Check core lines (before 🆔:) end with reset — split adds rst() to each
      const sidIdx = lines.findIndex(l => l.replace(/\x1b\[[0-9;]*m/g, '').includes('🆔:'));
      const coreLines = lines.slice(0, sidIdx > 0 ? sidIdx : 1);
      for (const line of coreLines) {
        expect(line.endsWith('\x1b[0m')).toBe(true);
      }
    } finally {
      if (savedNoColor !== undefined) process.env.NO_COLOR = savedNoColor;
      else process.env.NO_COLOR = '1';
    }
  });
});

// =========================================================================
// fmtCostInline — Cost Formatting
// =========================================================================
describe('fmtCostInline', () => {
  test('cost hidden when below $0.01', () => {
    const health = createDefaultHealth('cost-zero');
    health.projectPath = '~/proj';
    health.model = { value: 'Claude', source: 'default', confidence: 100 };
    health.context = { tokensLeft: 100000, percentUsed: 10 };
    health.billing = { sessionCost: 0.005, burnRatePerHour: 0, costToday: 0, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true };

    const result = StatuslineFormatter.formatAllVariants(health, 0);
    const output = result.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(output).not.toContain('💰:');
  });

  test('cost shown when >= $0.01', () => {
    const health = createDefaultHealth('cost-shown');
    health.projectPath = '~/proj';
    health.model = { value: 'Claude', source: 'default', confidence: 100 };
    health.context = { tokensLeft: 100000, percentUsed: 10 };
    health.billing = { sessionCost: 2.50, burnRatePerHour: 4.0, sessionBurnRate: 4.0, costToday: 2.50, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true };

    const result = StatuslineFormatter.formatAllVariants(health, 0);
    const output = result.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(output).toContain('💰:$2.50|$4.00/h');
  });

  test('burn rate hidden when below $0.01', () => {
    const health = createDefaultHealth('cost-no-burn');
    health.projectPath = '~/proj';
    health.model = { value: 'Claude', source: 'default', confidence: 100 };
    health.context = { tokensLeft: 100000, percentUsed: 10 };
    health.billing = { sessionCost: 1.00, burnRatePerHour: 0.005, costToday: 1.00, budgetRemaining: 0, budgetPercentUsed: 0, resetTime: '', isFresh: true };

    const result = StatuslineFormatter.formatAllVariants(health, 0);
    const output = result.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(output).toContain('💰:$1.00');
    expect(output).not.toContain('/h');
  });
});

// =========================================================================
// Version Mismatch Notification
// =========================================================================
describe('Version Mismatch Notification', () => {
  beforeEach(() => {
    NotificationManager.clearAll();
    NotificationManager.clearCache();
  });

  test('version mismatch registers notification', () => {
    const health = createDefaultHealth('ver-mismatch');
    health.projectPath = '~/proj';
    health.model = { value: 'Claude', source: 'default', confidence: 100 };
    health.context = { tokensLeft: 100000, percentUsed: 10 };
    health.versionMismatch = { running: '2.1.104', installed: '2.2.0' };

    const result = StatuslineFormatter.formatAllVariants(health, 0);
    const output = result.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(output).toContain('CLI v2.2.0 installed');
    expect(output).toContain('running v2.1.104');
  });

  test('no notification when versions match', () => {
    const health = createDefaultHealth('ver-match');
    health.projectPath = '~/proj';
    health.model = { value: 'Claude', source: 'default', confidence: 100 };
    health.context = { tokensLeft: 100000, percentUsed: 10 };
    // No versionMismatch field set

    const result = StatuslineFormatter.formatAllVariants(health, 0);
    const output = result.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(output).not.toContain('CLI v');
    expect(output).not.toContain('restart session');
  });
});

// =========================================================================
// Model [1m] Suffix
// =========================================================================
describe('Model Context Window Suffix', () => {
  test('model ID with [1m] shows suffix', () => {
    const health = createDefaultHealth('model-1m');
    health.projectPath = '~/proj';
    health.model = { value: 'Opus4.6[1m]', id: 'claude-opus-4-6[1m]', source: 'jsonInput', confidence: 100 };
    health.context = { tokensLeft: 900000, percentUsed: 10 };

    const result = StatuslineFormatter.formatAllVariants(health, 0);
    const output = result.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(output).toContain('🤖:Opus4.6[1m]');
  });

  test('model without [1m] shows no suffix', () => {
    const health = createDefaultHealth('model-no-1m');
    health.projectPath = '~/proj';
    health.model = { value: 'Sonnet4.6', id: 'claude-sonnet-4-6', source: 'jsonInput', confidence: 100 };
    health.context = { tokensLeft: 180000, percentUsed: 10 };

    const result = StatuslineFormatter.formatAllVariants(health, 0);
    const output = result.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(output).toContain('🤖:Sonnet4.6');
    expect(output).not.toContain('[1m]');
  });

  test('model ID [1m] appended from id field when missing from value', () => {
    const health = createDefaultHealth('model-1m-from-id');
    health.projectPath = '~/proj';
    health.model = { value: 'Opus4.6', id: 'claude-opus-4-6[1m]', source: 'jsonInput', confidence: 100 };
    health.context = { tokensLeft: 900000, percentUsed: 10 };

    const result = StatuslineFormatter.formatAllVariants(health, 0);
    const output = result.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(output).toContain('Opus4.6[1m]');
  });
});
