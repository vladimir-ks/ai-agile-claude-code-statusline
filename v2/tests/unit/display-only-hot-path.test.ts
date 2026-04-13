/**
 * P1-d — Display-only hot path: formatPicked (NOT formatAllVariants)
 *
 * CONTRACT: display-only.ts must render for ONE width bucket only.
 * formatAllVariants computes 8 variants × O(line) — unnecessary on hot path.
 *
 * This suite asserts:
 *   T1  formatPicked returns lines for a single bucket matching terminal width
 *   T2  formatPicked invokes 0 `formatAllVariants` calls (no regression to 8× work)
 *   T3  paneWidth → bucket mapping is deterministic (mirrors legacy selectVariant)
 *   T4  output parity: formatPicked(h, 120, false) ≡ formatAllVariants(h).width120
 *   T5  singleLine path: forceSingleLine=true → singleLine bucket
 *   T6  ultra-narrow path: paneWidth<=30 → singleLine bucket
 *   T7  readOnlyNotifications defaults to true (P1-g integration)
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StatuslineFormatter } from '../../src/lib/statusline-formatter';
import { NotificationManager } from '../../src/lib/notification-manager';
import type { SessionHealth } from '../../src/types/session-health';

function mkHealth(): SessionHealth {
  return {
    sessionId: 'hot-path-test',
    projectPath: '/tmp/test',
    transcriptPath: '',
    launch: { authProfile: 'default', detectionMethod: 'default' },
    health: { status: 'healthy', lastUpdate: Date.now(), issues: [] },
    transcript: {
      exists: true,
      sizeBytes: 100,
      lastModified: Date.now() - 1000,
      lastModifiedAgo: '<1m',
      messageCount: 5,
      lastMessageTime: Date.now() - 2000,
      lastMessagePreview: 'test preview',
      lastMessageAgo: '1m',
      isSynced: true,
    },
    model: { value: 'Opus4.6', source: 'stdin', confidence: 100 },
    context: {
      tokensUsed: 50_000,
      tokensLeft: 100_000,
      percentUsed: 30,
      windowSize: 200_000,
      nearCompaction: false,
    },
    git: { branch: 'main', ahead: 0, behind: 0, dirty: 0, lastChecked: Date.now() },
    billing: {
      costToday: 1.5,
      burnRatePerHour: 0.1,
      budgetRemaining: 0,
      budgetPercentUsed: 0,
      resetTime: '',
      isFresh: true,
      lastFetched: Date.now(),
    },
    alerts: { secretsDetected: false, secretTypes: [], transcriptStale: false, dataLossRisk: false },
    gatheredAt: Date.now(),
  } as SessionHealth;
}

describe('P1-d display-only hot path — formatPicked', () => {
  beforeEach(() => {
    process.env.NO_COLOR = '1';
    NotificationManager.clearCache();
    NotificationManager.clearAll();
  });
  afterEach(() => {
    delete process.env.NO_COLOR;
    NotificationManager.clearCache();
  });

  test('T1 — returns non-empty string array for valid health', () => {
    const h = mkHealth();
    const out = StatuslineFormatter.formatPicked(h, 120, false);
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every(l => typeof l === 'string')).toBe(true);
  });

  test('T2 — does NOT call formatAllVariants (spy)', () => {
    const h = mkHealth();
    let callCount = 0;
    const original = (StatuslineFormatter as any).formatAllVariants;
    (StatuslineFormatter as any).formatAllVariants = function (...args: any[]) {
      callCount++;
      return original.apply(this, args);
    };
    try {
      StatuslineFormatter.formatPicked(h, 120, false);
      expect(callCount).toBe(0);
    } finally {
      (StatuslineFormatter as any).formatAllVariants = original;
    }
  });

  test('T3 — bucket mapping is deterministic across common pane widths', () => {
    const h = mkHealth();
    // Paired: [paneWidth, expectedBucketName]
    const cases: Array<[number, string]> = [
      [25, 'singleLine'], // ultra-narrow
      [40, 'width40'],
      [60, 'width60'],
      [80, 'width80'],
      [100, 'width100'],
      [120, 'width120'],
      [150, 'width150'],
      [200, 'width200'],
    ];
    // All variants pre-computed once
    const allVariants = StatuslineFormatter.formatAllVariants(h);
    for (const [paneWidth, bucket] of cases) {
      const picked = StatuslineFormatter.formatPicked(h, paneWidth, false);
      const expected = (allVariants as any)[bucket];
      expect(picked).toEqual(expected);
    }
  });

  test('T4 — parity: formatPicked(h,120,false) equals formatAllVariants(h).width120', () => {
    const h = mkHealth();
    const picked = StatuslineFormatter.formatPicked(h, 120, false);
    const all = StatuslineFormatter.formatAllVariants(h);
    expect(picked).toEqual(all!.width120);
  });

  test('T5 — forceSingleLine=true selects singleLine bucket', () => {
    const h = mkHealth();
    const picked = StatuslineFormatter.formatPicked(h, 120, true);
    const all = StatuslineFormatter.formatAllVariants(h);
    expect(picked).toEqual(all!.singleLine);
  });

  test('T6 — ultra-narrow (<=30) forces singleLine', () => {
    const h = mkHealth();
    const picked = StatuslineFormatter.formatPicked(h, 20, false);
    const all = StatuslineFormatter.formatAllVariants(h);
    expect(picked).toEqual(all!.singleLine);
  });

  test('T7 — readOnlyNotifications defaults to true (P1-g)', () => {
    // Register a notification first so any render path writes would be visible
    NotificationManager.register('version_mismatch', 'test msg', 8);
    const before = NotificationManager.get('version_mismatch');
    expect(before).not.toBeNull();
    const beforeShowCount = before!.showCount;

    const h = mkHealth();
    // Default call — readOnly should be true; recordShown must NOT mutate showCount
    // even though version_mismatch would normally be emitted in the hot path.
    h.versionMismatch = undefined;
    StatuslineFormatter.formatPicked(h, 120, false); // default readOnlyNotifications=true

    // versionMismatch being absent would normally trigger NotificationManager.remove
    // in a write-path call — in readOnly it must NOT.
    const after = NotificationManager.get('version_mismatch');
    expect(after).not.toBeNull(); // still exists — readOnly did not remove it
    expect(after!.showCount).toBe(beforeShowCount); // recordShown was a no-op
  });
});
