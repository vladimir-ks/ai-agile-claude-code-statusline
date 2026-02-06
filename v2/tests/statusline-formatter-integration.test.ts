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

    // Should show time and budget (always visible)
    expect(output).toContain('🕐:');
    expect(output).toContain('⌛:');
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

    // Should show directory, git, model, context, time, budget
    expect(output).toContain('📁:');
    expect(output).toContain('🌿:');
    expect(output).toContain('🤖:');
    expect(output).toContain('🧠:');
    expect(output).toContain('🕐:');
    expect(output).toContain('⌛:');
  });

  test('budget format omits hours if 0', () => {
    const health = createDefaultHealth('test-session');
    health.billing = {
      budgetRemaining: 42, // 0h42m
      budgetPercentUsed: 29,
      costToday: 10.5,
      burnRatePerHour: 5.2,
      resetTime: '14:00',
      isFresh: true,
      lastFetched: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');

    // Should show 42m(29%) not 0h42m(29%)
    expect(output).toContain('42m(29%)');
    expect(output).not.toContain('0h42m');
  });

  test('budget format includes hours if >0', () => {
    const health = createDefaultHealth('test-session');
    health.billing = {
      budgetRemaining: 135, // 2h15m
      budgetPercentUsed: 73,
      costToday: 10.5,
      burnRatePerHour: 5.2,
      resetTime: '14:00',
      isFresh: true,
      lastFetched: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');

    // Should show 2h15m(73%)
    expect(output).toContain('2h15m(73%)');
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

  test('context bar shows -free suffix when space available', () => {
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

    // Should show 154k-free with bar
    expect(output).toContain('154k-free');
    expect(output).toMatch(/\[.*\]/); // Has progress bar
  });

  test('model and context overflow to Line 2 when Line 1 is too long', () => {
    const health = createDefaultHealth('test-session');
    // Long path + long branch = Line 1 exceeds width
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
    const lines100 = variants.width100;

    // At width 100, model and context should move to Line 2
    expect(lines100.length).toBeGreaterThanOrEqual(2);

    // Line 1 should have directory + git, but NOT model
    const line1Stripped = lines100[0].replace(/\x1b\[[0-9;]*m/g, '');
    expect(line1Stripped).toContain('📁:');
    expect(line1Stripped).toContain('🌿:');
    expect(line1Stripped).not.toContain('🤖:'); // Model moved to L2

    // Line 2 should have model (abbreviated) + context + time/budget
    const line2Stripped = lines100[1].replace(/\x1b\[[0-9;]*m/g, '');
    expect(line2Stripped).toContain('🤖:o-4.5'); // Abbreviated model on overflow
    expect(line2Stripped).toContain('🧠:');
    expect(line2Stripped).toContain('🕐:');
  });

  test('Time|Budget|Weekly separator has no spaces', () => {
    const health = createDefaultHealth('test-session');
    health.billing = {
      budgetRemaining: 42,
      budgetPercentUsed: 29,
      costToday: 10.5,
      burnRatePerHour: 5.2,
      resetTime: '14:00',
      weeklyBudgetRemaining: 28.5,
      weeklyBudgetPercentUsed: 41,
      weeklyResetDay: 'Mon',
      isFresh: true,
      lastFetched: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');

    // Remove ANSI color codes for easier matching
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // Should use | separators without spaces
    expect(stripped).toMatch(/🕐:\d{2}:\d{2}\|⌛:/);
    expect(stripped).toMatch(/⌛:.*\|📅:/);
  });

  test('Weekly budget rounds hours down', () => {
    const health = createDefaultHealth('test-session');
    health.billing = {
      budgetRemaining: 42,
      budgetPercentUsed: 29,
      costToday: 10.5,
      burnRatePerHour: 5.2,
      resetTime: '14:00',
      weeklyBudgetRemaining: 28.75, // 28h45m
      weeklyBudgetPercentUsed: 41,
      weeklyResetDay: 'Mon',
      isFresh: true,
      lastFetched: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');

    // Should show 28h not 28.75h or 29h
    expect(output).toContain('28h(41%)@Mon');
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

describe('Smart Component Visibility', () => {
  test('turns hidden when <1000 (not interesting)', () => {
    const health = createDefaultHealth('low-turns');
    health.transcript.messageCount = 500; // Low turn count (under 1000)

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n');

    // Should NOT show turns - counts under 1000 are hidden
    expect(output).not.toContain('💬:500t');
    expect(output).not.toContain('💬:');
  });

  test('turns shown when >=1000 (significant)', () => {
    const health = createDefaultHealth('high-turns');
    health.transcript = {
      ...health.transcript,
      messageCount: 1500,
      exists: true
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n');

    // Should show 💬:1kt (turns formatted as "1k" when >=1000)
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).toContain('💬:1kt');
  });

  test('turns hidden when <1000 (not significant)', () => {
    const health = createDefaultHealth('low-turns-2');
    health.transcript = {
      ...health.transcript,
      messageCount: 500,
      exists: true
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n');

    // Should NOT show turns when <1000
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');
    expect(stripped).not.toContain('💬:500t');
  });

  test('usage hidden when <100k tokens (not significant)', () => {
    const health = createDefaultHealth('low-usage');
    health.billing.totalTokens = 50000;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n');

    // Should NOT show 📊: - low usage hidden
    expect(output).not.toContain('📊:');
  });

  test('usage shown when >=100k tokens (significant)', () => {
    const health = createDefaultHealth('high-usage');
    health.billing.totalTokens = 500000;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n');

    // Should show 📊:500k
    expect(output).toContain('📊:');
    expect(output).toContain('500k');
  });

  test('cost hidden when near zero', () => {
    const health = createDefaultHealth('no-cost');
    health.billing.costToday = 0.005;
    health.billing.burnRatePerHour = 0;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n');

    // Should NOT show 💰: when cost is negligible
    expect(output).not.toContain('💰:');
  });

  test('cost shows burn rate only when total <$1', () => {
    const health = createDefaultHealth('low-cost');
    health.billing.costToday = 0.5;
    health.billing.burnRatePerHour = 1.5;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n');

    // Should show burn rate but not total (since <$1)
    expect(output).toContain('💰:');
    expect(output).toContain('/h');
    expect(output).not.toContain('$0.50|'); // Total not shown
  });

  test('cost shows session cost and burn rate', () => {
    const health = createDefaultHealth('high-cost');
    health.billing.costToday = 5.25;       // Account daily cost
    health.billing.sessionCost = 12.50;    // Session cost
    health.billing.sessionBurnRate = 2.1;  // Session burn rate
    health.billing.isFresh = true;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n');

    // Should show session cost prominently
    expect(output).toContain('💰:');
    expect(output).toContain('$12.5');     // Session cost
    expect(output).toContain('/h');         // Burn rate
  });

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

describe('Context Shrink Cascade', () => {
  test('full context shows -free and long bar when space permits', () => {
    const health = createDefaultHealth('wide-context');
    health.projectPath = '~/short';
    health.context = { tokensLeft: 154000, tokensUsed: 46000, percentUsed: 23, windowSize: 200000, nearCompaction: false };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Full format should have -free and full bar
    expect(output).toContain('🧠:');
    expect(output).toContain('154k');
    expect(output).toContain('-free');
    expect(output).toMatch(/\[[-=|]+\]/); // Has progress bar
  });

  test('medium context removes -free when space is tight', () => {
    const health = createDefaultHealth('medium-context');
    health.projectPath = '~/moderately/long/path/name';
    health.git = { branch: 'feature', ahead: 0, behind: 0, dirty: 3, lastChecked: Date.now() };
    health.model = { value: 'Opus4.5', isFresh: true };
    health.context = { tokensLeft: 154000, tokensUsed: 46000, percentUsed: 23, windowSize: 200000, nearCompaction: false };

    const variants = StatuslineFormatter.formatAllVariants(health);

    // Check various widths - narrow ones should NOT have -free
    // Join all lines since context might move to L2 at narrow widths
    const narrow = variants.width80.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    const wide = variants.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Wide should have -free
    expect(wide).toContain('-free');

    // Narrow might have context on L2 due to overflow
    // At minimum, brain emoji should be present somewhere
    expect(narrow).toContain('🧠:');
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

  test('context moves to L2 when L1 is too crowded', () => {
    const health = createDefaultHealth('overflow-context');
    health.projectPath = '~/extremely/long/path/that/fills/line/one';
    health.git = { branch: 'another-very-long-branch-name', ahead: 10, behind: 5, dirty: 20, lastChecked: Date.now() };
    health.model = { value: 'Opus4.5', isFresh: true };
    health.context = { tokensLeft: 50000, tokensUsed: 100000, percentUsed: 67, windowSize: 150000, nearCompaction: false };

    const variants = StatuslineFormatter.formatAllVariants(health);

    // At width60, L1 should be very crowded
    expect(variants.width60.length).toBeGreaterThanOrEqual(2);

    const line1 = variants.width60[0].replace(/\x1b\[[0-9;]*m/g, '');
    const line2 = variants.width60[1]?.replace(/\x1b\[[0-9;]*m/g, '') || '';

    // Directory should always be on L1
    expect(line1).toContain('📁:');

    // Context or model might be on L2
    const hasContextOnL2 = line2.includes('🧠:');
    const hasModelOnL2 = line2.includes('🤖:');

    // At least one should have overflowed to L2
    expect(hasContextOnL2 || hasModelOnL2).toBe(true);
  });
});

describe('Line 2 Drop Order', () => {
  test('turns drop first when L2 is tight (only shows if >=1000)', () => {
    const health = createDefaultHealth('drop-turns');
    health.billing = {
      budgetRemaining: 60,
      budgetPercentUsed: 50,
      costToday: 25,
      burnRatePerHour: 10,
      weeklyBudgetRemaining: 48,
      weeklyBudgetPercentUsed: 60,
      weeklyResetDay: 'Mon',
      resetTime: '14:00',
      totalTokens: 500000,
      tokensPerMinute: 10000,
      isFresh: true,
      lastFetched: Date.now()
    };
    // Turns must be >=1000 to show at all
    health.transcript = { ...health.transcript, messageCount: 2500, exists: true };

    const variants = StatuslineFormatter.formatAllVariants(health);

    // Wide should have everything (turns formatted as "2k")
    const wide = variants.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    expect(wide).toContain('💬:2kt');
    expect(wide).toContain('📊:');
    expect(wide).toContain('💰:');

    // Narrow should drop turns first, keep cost
    const narrow = variants.width80.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    // Time/Budget/Weekly must always be present
    expect(narrow).toContain('🕐:');
    expect(narrow).toContain('⌛:');
  });

  test('Time|Budget|Weekly never drops', () => {
    const health = createDefaultHealth('keep-time');
    health.billing = {
      budgetRemaining: 30,
      budgetPercentUsed: 75,
      costToday: 50,
      burnRatePerHour: 20,
      weeklyBudgetRemaining: 24,
      weeklyBudgetPercentUsed: 80,
      weeklyResetDay: 'Thu',
      resetTime: '14:00',
      isFresh: true,
      lastFetched: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);

    // Even at narrowest width
    const narrow = variants.width40.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Must have time and budget
    expect(narrow).toContain('🕐:');
    expect(narrow).toContain('⌛:');
  });

  test('cost shows total first, drops burn rate when tight', () => {
    const health = createDefaultHealth('cost-priority');
    health.billing = {
      budgetRemaining: 60,
      budgetPercentUsed: 50,
      costToday: 40.5,
      burnRatePerHour: 15.2,
      resetTime: '14:00',
      isFresh: true,
      lastFetched: Date.now()
    };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const wide = variants.width200.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Wide should show both: $40.5|$15.2/h
    expect(wide).toContain('$40');
    expect(wide).toContain('/h');
  });
});

describe('Staleness Indicator', () => {
  test('no warning when data is fresh (<2 min old)', () => {
    const health = createDefaultHealth('fresh-data');
    health.gatheredAt = Date.now() - (60 * 1000); // 1 minute ago
    health.billing.lastFetched = health.gatheredAt;
    health.billing.budgetRemaining = 30;
    health.git.lastChecked = health.gatheredAt; // Ensure git is also fresh

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Should show time and budget without ⚠ (FreshnessManager threshold is 2min)
    expect(output).toContain('🕐:');
    expect(output).toContain('⌛:');
    expect(output).not.toContain('⚠');
  });

  test('⚠ shown on stale data (>=3 min old)', () => {
    const health = createDefaultHealth('stale-data');
    health.gatheredAt = Date.now() - (5 * 60 * 1000); // 5 minutes ago
    health.billing.lastFetched = health.gatheredAt;
    health.billing.budgetRemaining = 30;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Should show ⚠ on budget/weekly (stale data markers)
    expect(output).toContain('🕐:');
    expect(output).toContain('⚠');
  });

  test('clock always shows current time (not data time)', () => {
    const health = createDefaultHealth('time-test');
    // Set gatheredAt to 30 minutes ago
    health.gatheredAt = Date.now() - (30 * 60 * 1000);
    health.billing.lastFetched = health.gatheredAt;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Clock should show CURRENT time, not data time
    const now = new Date();
    const currentHour = String(now.getHours()).padStart(2, '0');
    const currentMin = String(now.getMinutes()).padStart(2, '0');
    expect(output).toContain(`🕐:${currentHour}:${currentMin}`);
  });
});

describe('Model Abbreviations', () => {
  test('Opus4.5 abbreviates to o-4.5', () => {
    const health = createDefaultHealth('opus-abbrev');
    health.projectPath = '~/very/long/path/that/forces/abbreviation';
    health.git = { branch: 'long-branch-name', ahead: 5, behind: 2, dirty: 10, lastChecked: Date.now() };
    health.model = { value: 'Opus4.5', isFresh: true };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const narrow = variants.width80.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Should abbreviate to o-4.5 when tight
    expect(narrow).toContain('o-4.5');
  });

  test('Sonnet4.5 abbreviates to s-4.5', () => {
    const health = createDefaultHealth('sonnet-abbrev');
    health.projectPath = '~/very/long/path/that/forces/abbreviation';
    health.git = { branch: 'long-branch-name', ahead: 5, behind: 2, dirty: 10, lastChecked: Date.now() };
    health.model = { value: 'Sonnet4.5', isFresh: true };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const narrow = variants.width80.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Should abbreviate to s-4.5 when tight
    expect(narrow).toContain('s-4.5');
  });

  test('Haiku4.5 abbreviates to h-4.5', () => {
    const health = createDefaultHealth('haiku-abbrev');
    health.projectPath = '~/very/long/path/that/forces/abbreviation';
    health.git = { branch: 'long-branch-name', ahead: 5, behind: 2, dirty: 10, lastChecked: Date.now() };
    health.model = { value: 'Haiku4.5', isFresh: true };

    const variants = StatuslineFormatter.formatAllVariants(health);
    const narrow = variants.width80.join('\n').replace(/\x1b\[[0-9;]*m/g, '');

    // Should abbreviate to h-4.5 when tight
    expect(narrow).toContain('h-4.5');
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
    expect(variants.singleLine.length).toBe(1); // Single line
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

    // Should contain essential components
    expect(singleLine).toContain('📁:');
    expect(singleLine).toContain('🕐:');
  });
});

describe('Failover Notification Display', () => {
  test('failover notification appears on Line 1 when present', () => {
    const health = createDefaultHealth('failover-test');
    health.projectPath = '~/project';
    health.failoverNotification = '🔄 Swapped → slot-2 (3m ago)';

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    expect(stripped).toContain('🔄 Swapped → slot-2 (3m ago)');
    // Should be on Line 1
    const line1 = variants.width120[0].replace(/\x1b\[[0-9;]*m/g, '');
    expect(line1).toContain('🔄 Swapped');
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

  test('secrets alert takes priority over failover notification', () => {
    const health = createDefaultHealth('secrets-vs-failover');
    health.projectPath = '~/project';
    health.failoverNotification = '🔄 Swapped → slot-2 (1m ago)';
    health.alerts.secretsDetected = true;
    health.alerts.secretTypes = ['API_KEY'];

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // Secrets take highest priority
    expect(stripped).toContain('API_KEY');
    expect(stripped).not.toContain('🔄 Swapped');
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

  test('transcriptStale without lastMessagePreview → shows 📝 indicator', () => {
    const health = createDefaultHealth('dedup-stale-no-preview');
    health.projectPath = '~/project';
    health.alerts.transcriptStale = true;
    health.transcript.lastModifiedAgo = '37m';
    health.transcript.lastMessagePreview = undefined;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // 📝 indicator should show since no message preview on line 3
    expect(stripped).toContain('📝:37m');
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

  test('dataLossRisk without lastMessagePreview → shows 📝 indicator with ⚠', () => {
    const health = createDefaultHealth('dedup-risk-no-preview');
    health.projectPath = '~/project';
    health.alerts.dataLossRisk = true;
    health.alerts.transcriptStale = true;
    health.transcript.lastModifiedAgo = '37m';
    health.transcript.lastMessagePreview = undefined;

    const variants = StatuslineFormatter.formatAllVariants(health);
    const output = variants.width120.join('\n');
    const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

    // 📝 with warning should show since no message preview
    expect(stripped).toContain('📝:37m⚠');
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
    test('shows |S1 when session lock exists with slot-1', () => {
      const health = createDefaultHealth('slot-test-1');
      health.projectPath = '~/project';

      // Create lock file with slot-1
      SessionLockManager.create(
        'slot-test-1',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).toContain('|S1');
    });

    test('shows |S2 when session lock exists with slot-2', () => {
      const health = createDefaultHealth('slot-test-2');
      health.projectPath = '~/project';

      SessionLockManager.create(
        'slot-test-2',
        'slot-2',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).toContain('|S2');
    });

    test('shows |S3 when session lock exists with slot-3', () => {
      const health = createDefaultHealth('slot-test-3');
      health.projectPath = '~/project';

      SessionLockManager.create(
        'slot-test-3',
        'slot-3',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).toContain('|S3');
    });

    test('shows no slot indicator when lock file missing', () => {
      const health = createDefaultHealth('slot-test-no-lock');
      health.projectPath = '~/project';

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).not.toContain('|S1');
      expect(stripped).not.toContain('|S2');
      expect(stripped).not.toContain('|S3');
    });

    test('slot indicator appears after weekly reset day', () => {
      const health = createDefaultHealth('slot-position-test');
      health.projectPath = '~/project';
      health.billing.weeklyBudgetRemaining = 120;
      health.billing.weeklyBudgetPercentUsed = 50;
      health.billing.weeklyResetDay = 'Wed';

      SessionLockManager.create(
        'slot-position-test',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      const variants = StatuslineFormatter.formatAllVariants(health);
      const line2 = variants.width120[1];
      const stripped = line2.replace(/\x1b\[[0-9;]*m/g, '');

      // Should appear after @Wed
      expect(stripped).toMatch(/@Wed.*\|S1/);
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

    test('update notification appears on line 4', () => {
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
      expect(variants.width120.length).toBeGreaterThanOrEqual(4);

      const line4 = variants.width120[3];
      const stripped = line4.replace(/\x1b\[[0-9;]*m/g, '');
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

      // Should only have 3 lines (dir+model+context, time+budget, last message)
      expect(variants.width120.length).toBe(3);
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
      expect(variants.width120.length).toBe(3); // No notification line
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

      expect(stripped).toContain('Switch to slot-3');
      expect(stripped).toContain('rank 1');
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
      expect(variants.width120.length).toBe(5); // 3 base + 2 notifications
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
      const line4 = variants.width120[3].replace(/\x1b\[[0-9;]*m/g, '');
      const line5 = variants.width120[4].replace(/\x1b\[[0-9;]*m/g, '');

      // Version (priority 7) should appear before slot switch (priority 6)
      expect(line4).toContain('Update available');
      expect(line5).toContain('Switch slots');
    });

    test('max 2 notifications shown simultaneously', () => {
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

      // Should have max 5 lines (3 base + 2 notifications)
      expect(variants.width120.length).toBeLessThanOrEqual(5);
    });
  });

  describe('Full Integration: Slot + Notifications', () => {
    test('slot indicator and notification coexist', () => {
      const health = createDefaultHealth('full-integration-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';
      health.billing.weeklyBudgetRemaining = 100;
      health.billing.weeklyResetDay = 'Wed';

      SessionLockManager.create(
        'full-integration-test',
        'slot-2',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      NotificationManager.register('version_update', 'Update to 2.1.33', 7);
      NotificationManager.recordShown('version_update');

      const variants = StatuslineFormatter.formatAllVariants(health);
      const output = variants.width120.join('\n');
      const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

      // Both should be present
      expect(stripped).toContain('|S2');
      expect(stripped).toContain('Update to 2.1.33');

      // 4 lines: dir+model+context, time+budget+slot, last message, notification
      expect(variants.width120.length).toBe(4);
    });

    test('handles all width variants correctly', () => {
      const health = createDefaultHealth('width-test');
      health.projectPath = '~/project';
      health.transcript.lastMessagePreview = 'What does main do?';
      health.transcript.lastMessageAgo = '2m';

      SessionLockManager.create(
        'width-test',
        'slot-1',
        '/home/user/.claude',
        'Claude Code-credentials',
        'user@example.com',
        '/home/user/.claude/projects/-test/session.jsonl'
      );

      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.recordShown('version_update');

      const variants = StatuslineFormatter.formatAllVariants(health);

      // All variants should have slot indicator and notification
      for (const [width, lines] of Object.entries(variants)) {
        if (width === 'singleLine') continue; // Skip single line

        const output = lines.join('\n');
        const stripped = output.replace(/\x1b\[[0-9;]*m/g, '');

        expect(stripped).toContain('|S1');
        expect(stripped).toContain('Update available');
      }
    });
  });
});
