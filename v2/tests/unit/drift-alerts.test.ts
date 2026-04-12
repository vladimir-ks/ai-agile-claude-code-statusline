/**
 * Drift Alerts — Unit Tests (Task #25)
 *
 * Covers:
 * 1. quota_stale trigger via quota-source merge (data stale > 30min)
 * 2. quota_stale dedup (same type not re-registered within hide period)
 * 3. weekly_quota_waste_certain trigger
 * 4. weekly_quota_waste_likely trigger
 * 5. Mutually exclusive: certain + likely never both active
 * 6. Conditions cleared → both removed
 * 7. NotificationType union includes quota_reset_passed
 * 8. transcript_sampler_dead registration pattern
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { NotificationManager } from '../../src/lib/notification-manager';
import type { NotificationType } from '../../src/lib/notification-manager';

// ── Test isolation ────────────────────────────────────────────────────────────
const TEST_DIR = join(tmpdir(), `drift-alerts-test-${Date.now()}`);
const STATE_FILE = join(TEST_DIR, 'notifications.json');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  (NotificationManager as any).STATE_PATH = STATE_FILE;
  NotificationManager.clearCache();
  NotificationManager.clearAll();
});

afterEach(() => {
  NotificationManager.clearCache();
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Helper: simulate weekly waste notification logic (mirrors buildNotifications) ─
function triggerWeeklyWasteNotifications(opts: {
  bestCase: number | null;
  projected: number | null;
  resetDay?: string;
}): void {
  const { bestCase, projected, resetDay = 'Mon' } = opts;
  const GUARANTEED_THRESHOLD = 95;
  const LIKELY_THRESHOLD = 85;

  if (bestCase != null && bestCase < GUARANTEED_THRESHOLD) {
    const waste = Math.max(0, 100 - Math.round(bestCase));
    const current = Math.round(bestCase);
    NotificationManager.register(
      'weekly_quota_waste_certain',
      `⚠ Weekly Quota Loss Risk: best-case finish ~${current}% by ${resetDay}. Increase usage to avoid unused ${waste}% allotment.`,
      9
    );
    NotificationManager.remove('weekly_quota_waste_likely');
  } else if (projected != null && projected < LIKELY_THRESHOLD) {
    const current = Math.round(projected);
    NotificationManager.register(
      'weekly_quota_waste_likely',
      `Weekly Pacing Alert: trending toward ~${current}% used by ${resetDay}. Consider more sessions to avoid waste.`,
      8
    );
    NotificationManager.remove('weekly_quota_waste_certain');
  } else {
    NotificationManager.remove('weekly_quota_waste_certain');
    NotificationManager.remove('weekly_quota_waste_likely');
  }
}

// ── Helper: simulate quota_stale trigger logic (mirrors quota-source merge) ───
function triggerQuotaStaleNotification(ageMin: number, slotActive = true): void {
  if (!slotActive) {
    NotificationManager.remove('quota_stale');
    return;
  }
  if (ageMin > 30) {
    NotificationManager.register(
      'quota_stale',
      `⚠ Quota Data Stale: data ${ageMin}min old. Check launchd: launchctl list | grep claude. Log: ~/.claude/session-health/quota-refresh-error.log`,
      9
    );
  } else {
    NotificationManager.remove('quota_stale');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. quota_stale trigger
// ─────────────────────────────────────────────────────────────────────────────

describe('quota_stale notification trigger', () => {
  test('fires when data age > 30min', () => {
    triggerQuotaStaleNotification(35);

    const n = NotificationManager.get('quota_stale');
    expect(n).not.toBeNull();
    expect(n!.message).toContain('35min');
    expect(n!.message).toContain('launchctl list | grep claude');
    expect(n!.message).toContain('quota-refresh-error.log');
    expect(n!.priority).toBe(9);
  });

  test('not fired when data age <= 30min', () => {
    triggerQuotaStaleNotification(29);
    expect(NotificationManager.get('quota_stale')).toBeNull();
  });

  test('exactly 31min fires', () => {
    triggerQuotaStaleNotification(31);
    expect(NotificationManager.get('quota_stale')).not.toBeNull();
  });

  test('removed when data freshens (age drops below threshold)', () => {
    triggerQuotaStaleNotification(35);
    expect(NotificationManager.get('quota_stale')).not.toBeNull();

    // Simulate data refresh — age now 5min
    triggerQuotaStaleNotification(5);
    expect(NotificationManager.get('quota_stale')).toBeNull();
  });

  test('not fired for inactive slot (expected staleness)', () => {
    triggerQuotaStaleNotification(60, false); // inactive slot
    expect(NotificationManager.get('quota_stale')).toBeNull();
  });

  test('dedup: re-registration updates message but preserves lastShownAt cycle', () => {
    triggerQuotaStaleNotification(35);
    NotificationManager.recordShown('quota_stale');
    const firstShownAt = NotificationManager.get('quota_stale')!.lastShownAt;

    // Re-trigger (same condition, 1min later age)
    triggerQuotaStaleNotification(36);

    const n = NotificationManager.get('quota_stale');
    expect(n).not.toBeNull();
    expect(n!.message).toContain('36min');
    // lastShownAt preserved (still within 30s show window)
    expect(n!.lastShownAt).toBe(firstShownAt);
  });

  test('dedup: stays in hide period after show cycle starts', () => {
    triggerQuotaStaleNotification(35);
    NotificationManager.recordShown('quota_stale');

    // Simulate re-trigger 10s later (still in 30s show window)
    const isShowing = NotificationManager.shouldShow('quota_stale');
    expect(isShowing).toBe(true); // within 30s show period

    // Manually push into hide period (35s since shown)
    const n = NotificationManager.get('quota_stale')!;
    n.lastShownAt = Date.now() - 35_000;
    const state = (NotificationManager as any).readState();
    state.notifications['quota_stale'] = n;
    (NotificationManager as any).writeState(state);
    NotificationManager.clearCache();

    // Re-trigger with same condition — should NOT re-appear (in 5min hide)
    triggerQuotaStaleNotification(36);
    expect(NotificationManager.shouldShow('quota_stale')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. weekly_quota_waste_certain
// ─────────────────────────────────────────────────────────────────────────────

describe('weekly_quota_waste_certain notification', () => {
  test('fires when bestCase < 95', () => {
    triggerWeeklyWasteNotifications({ bestCase: 90, projected: 110 });

    const n = NotificationManager.get('weekly_quota_waste_certain');
    expect(n).not.toBeNull();
    expect(n!.message).toContain('90%');
    expect(n!.message).toContain('10%');  // waste = 100 - 90
    expect(n!.message).toContain('Mon');
    expect(n!.priority).toBe(9);
  });

  test('fires at exactly 94 (just below 95 threshold)', () => {
    triggerWeeklyWasteNotifications({ bestCase: 94, projected: 110 });
    expect(NotificationManager.get('weekly_quota_waste_certain')).not.toBeNull();
  });

  test('does NOT fire when bestCase == 95', () => {
    triggerWeeklyWasteNotifications({ bestCase: 95, projected: 110 });
    expect(NotificationManager.get('weekly_quota_waste_certain')).toBeNull();
  });

  test('does NOT fire when bestCase is null', () => {
    triggerWeeklyWasteNotifications({ bestCase: null, projected: 110 });
    expect(NotificationManager.get('weekly_quota_waste_certain')).toBeNull();
  });

  test('message text is human-readable and actionable', () => {
    triggerWeeklyWasteNotifications({ bestCase: 88, projected: null, resetDay: 'Fri' });
    const n = NotificationManager.get('weekly_quota_waste_certain')!;
    expect(n.message).toMatch(/Weekly Quota Loss Risk/);
    expect(n.message).toMatch(/88%/);
    expect(n.message).toMatch(/Fri/);
    expect(n.message).toMatch(/Increase usage/);
  });

  test('dedup: message updates on re-register but cycle preserved', () => {
    triggerWeeklyWasteNotifications({ bestCase: 90, projected: null });
    NotificationManager.recordShown('weekly_quota_waste_certain');
    const firstShownAt = NotificationManager.get('weekly_quota_waste_certain')!.lastShownAt;

    // Re-trigger with slightly different bestCase
    triggerWeeklyWasteNotifications({ bestCase: 89, projected: null });

    const n = NotificationManager.get('weekly_quota_waste_certain')!;
    expect(n.message).toContain('89%');
    // lastShownAt preserved (still within 30s show window)
    expect(n.lastShownAt).toBe(firstShownAt);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. weekly_quota_waste_likely
// ─────────────────────────────────────────────────────────────────────────────

describe('weekly_quota_waste_likely notification', () => {
  test('fires when projected < 85 and bestCase >= 95', () => {
    triggerWeeklyWasteNotifications({ bestCase: 98, projected: 80 });

    const n = NotificationManager.get('weekly_quota_waste_likely');
    expect(n).not.toBeNull();
    expect(n!.message).toContain('80%');
    expect(n!.priority).toBe(8);
  });

  test('fires at exactly 84 (just below threshold)', () => {
    triggerWeeklyWasteNotifications({ bestCase: 98, projected: 84 });
    expect(NotificationManager.get('weekly_quota_waste_likely')).not.toBeNull();
  });

  test('does NOT fire when projected == 85', () => {
    triggerWeeklyWasteNotifications({ bestCase: 98, projected: 85 });
    expect(NotificationManager.get('weekly_quota_waste_likely')).toBeNull();
  });

  test('does NOT fire when projected is null', () => {
    triggerWeeklyWasteNotifications({ bestCase: 98, projected: null });
    expect(NotificationManager.get('weekly_quota_waste_likely')).toBeNull();
  });

  test('message text is actionable', () => {
    triggerWeeklyWasteNotifications({ bestCase: 98, projected: 75, resetDay: 'Sun' });
    const n = NotificationManager.get('weekly_quota_waste_likely')!;
    expect(n.message).toMatch(/Weekly Pacing Alert/);
    expect(n.message).toMatch(/75%/);
    expect(n.message).toMatch(/Sun/);
    expect(n.message).toMatch(/more sessions/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Mutual exclusivity: certain + likely never both active
// ─────────────────────────────────────────────────────────────────────────────

describe('weekly waste mutual exclusivity', () => {
  test('when certain fires, likely is removed', () => {
    // First set likely
    triggerWeeklyWasteNotifications({ bestCase: 98, projected: 80 });
    expect(NotificationManager.get('weekly_quota_waste_likely')).not.toBeNull();

    // Then conditions change: bestCase drops below 95
    triggerWeeklyWasteNotifications({ bestCase: 90, projected: 80 });
    expect(NotificationManager.get('weekly_quota_waste_certain')).not.toBeNull();
    expect(NotificationManager.get('weekly_quota_waste_likely')).toBeNull();
  });

  test('when likely fires, certain is removed', () => {
    // First set certain
    triggerWeeklyWasteNotifications({ bestCase: 90, projected: 80 });
    expect(NotificationManager.get('weekly_quota_waste_certain')).not.toBeNull();

    // bestCase improves above 95 but projected still low
    triggerWeeklyWasteNotifications({ bestCase: 97, projected: 80 });
    expect(NotificationManager.get('weekly_quota_waste_likely')).not.toBeNull();
    expect(NotificationManager.get('weekly_quota_waste_certain')).toBeNull();
  });

  test('when both conditions clear, both removed', () => {
    triggerWeeklyWasteNotifications({ bestCase: 90, projected: 80 });
    expect(NotificationManager.get('weekly_quota_waste_certain')).not.toBeNull();

    // Both recover: bestCase ≥ 95 AND projected ≥ 85
    triggerWeeklyWasteNotifications({ bestCase: 99, projected: 95 });
    expect(NotificationManager.get('weekly_quota_waste_certain')).toBeNull();
    expect(NotificationManager.get('weekly_quota_waste_likely')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. NotificationType union completeness
// ─────────────────────────────────────────────────────────────────────────────

describe('NotificationType union coverage', () => {
  const expectedTypes: NotificationType[] = [
    'version_update',
    'version_mismatch',
    'slot_switch',
    'restart_ready',
    'secrets_detected',
    'active_slot',
    'quota_stale',
    'quota_reset_passed',
    'transcript_sampler_dead',
    'weekly_quota_waste_certain',
    'weekly_quota_waste_likely',
  ];

  for (const type of expectedTypes) {
    test(`NotificationType includes '${type}'`, () => {
      // If the type is not in the union, TypeScript compilation would fail.
      // This test exercises the runtime registration to catch union drift.
      NotificationManager.register(type, `test message for ${type}`, 5);
      const n = NotificationManager.get(type);
      expect(n).not.toBeNull();
      expect(n!.type).toBe(type);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. transcript_sampler_dead registration pattern
// ─────────────────────────────────────────────────────────────────────────────

describe('transcript_sampler_dead pattern', () => {
  test('registers with correct priority and message', () => {
    NotificationManager.register(
      'transcript_sampler_dead',
      'Transcript sampler appears dead (75s since last sample). Statusline using API baseline only.',
      6
    );

    const n = NotificationManager.get('transcript_sampler_dead');
    expect(n).not.toBeNull();
    expect(n!.priority).toBe(6);
    expect(n!.message).toContain('API baseline');
  });

  test('dedup: stays hidden during 5min hide period', () => {
    NotificationManager.register('transcript_sampler_dead', 'sampler dead', 6);
    NotificationManager.recordShown('transcript_sampler_dead');

    // Push into hide period
    const n = NotificationManager.get('transcript_sampler_dead')!;
    n.lastShownAt = Date.now() - 35_000; // 35s ago (past 30s show window)
    const state = (NotificationManager as any).readState();
    state.notifications['transcript_sampler_dead'] = n;
    (NotificationManager as any).writeState(state);
    NotificationManager.clearCache();

    // Re-register (simulates next fmtBurnRate call)
    NotificationManager.register('transcript_sampler_dead', 'sampler dead', 6);

    expect(NotificationManager.shouldShow('transcript_sampler_dead')).toBe(false);
  });

  test('reappears after full 5min30s cycle', () => {
    NotificationManager.register('transcript_sampler_dead', 'sampler dead', 6);

    // Set to 6 minutes ago (past full cycle)
    const n = NotificationManager.get('transcript_sampler_dead')!;
    n.lastShownAt = Date.now() - 6 * 60_000;
    const state = (NotificationManager as any).readState();
    state.notifications['transcript_sampler_dead'] = n;
    (NotificationManager as any).writeState(state);
    NotificationManager.clearCache();

    expect(NotificationManager.shouldShow('transcript_sampler_dead')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Multiple distinct types fire independently in same render pass
// ─────────────────────────────────────────────────────────────────────────────

describe('multiple notification types in single render pass', () => {
  test('quota_stale + weekly_quota_waste_certain fire together independently', () => {
    triggerQuotaStaleNotification(40);
    triggerWeeklyWasteNotifications({ bestCase: 88, projected: null });

    const stale = NotificationManager.get('quota_stale');
    const certain = NotificationManager.get('weekly_quota_waste_certain');

    expect(stale).not.toBeNull();
    expect(certain).not.toBeNull();

    // They are independent — both should show
    expect(NotificationManager.shouldShow('quota_stale')).toBe(true);
    expect(NotificationManager.shouldShow('weekly_quota_waste_certain')).toBe(true);
  });

  test('same type only fires once (dedup in same render pass)', () => {
    // Register twice in same pass
    triggerWeeklyWasteNotifications({ bestCase: 88, projected: null });
    const firstCreatedAt = NotificationManager.get('weekly_quota_waste_certain')!.createdAt;

    triggerWeeklyWasteNotifications({ bestCase: 87, projected: null });
    const secondCreatedAt = NotificationManager.get('weekly_quota_waste_certain')!.createdAt;

    // Same notification object (not re-created)
    expect(secondCreatedAt).toBe(firstCreatedAt);
    // Message updated
    expect(NotificationManager.get('weekly_quota_waste_certain')!.message).toContain('87%');
  });

  test('active list contains all fired types sorted by priority', () => {
    triggerQuotaStaleNotification(40);                                    // priority 9
    triggerWeeklyWasteNotifications({ bestCase: 88, projected: null });   // priority 9
    NotificationManager.register('transcript_sampler_dead', 'dead', 6);  // priority 6

    const active = NotificationManager.getActive();
    const types = active.map(([t]) => t);

    expect(types).toContain('quota_stale');
    expect(types).toContain('weekly_quota_waste_certain');
    expect(types).toContain('transcript_sampler_dead');

    // Sorted by priority (desc): 9, 9, 6
    const priorities = active.map(([, n]) => n.priority);
    for (let i = 1; i < priorities.length; i++) {
      expect(priorities[i]).toBeLessThanOrEqual(priorities[i - 1]);
    }
  });
});
