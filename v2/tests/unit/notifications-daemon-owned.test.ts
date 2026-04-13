/**
 * P1-g — Notifications.json ownership moved to daemon path (write-mode gated)
 *
 * ARCHITECTURE (before → after):
 *   Before: display-only.ts → formatAllVariants → buildNotifications → register/remove
 *           Every tmux pane spawn races on notifications.json RMW (dedup defeated).
 *   After:  daemon path (unified-data-broker) → formatAllVariants(readOnly=false)
 *             → WRITES notifications.json (singleton-locked via data-daemon.ts)
 *           display-only path → formatPicked(readOnly=true)
 *             → READ ONLY; never writes; observes daemon-owned state.
 *
 * This suite asserts:
 *   T1  formatPicked with default readOnly=true: ZERO NotificationManager
 *       state mutations during a full render (versionMismatch/weekly waste
 *       paths skipped).
 *   T2  formatAllVariants: writes notifications on daemon path as before
 *       (daemon side of the split remains the authoritative writer).
 *   T3  dedup state persists across renders: lastShownAt/showCount NOT mutated
 *       by display-only readOnly renders — so daemon-written state is stable.
 *   T4  graceful degradation: formatPicked does not throw when
 *       notifications.json is missing (read-only path).
 *   T5  transcript_sampler_dead: register/remove is gated — readOnly does
 *       not mutate it (daemon owns that notification too).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { StatuslineFormatter } from '../../src/lib/statusline-formatter';
import { NotificationManager } from '../../src/lib/notification-manager';
import type { SessionHealth } from '../../src/types/session-health';

const TEST_DIR = join(tmpdir(), `notif-daemon-owned-${Date.now()}`);
const STATE_FILE = join(TEST_DIR, 'notifications.json');

function mkHealth(overrides: Partial<SessionHealth> = {}): SessionHealth {
  return {
    sessionId: 'daemon-owned-test',
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
      lastMessagePreview: 'hello',
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
    ...overrides,
  } as SessionHealth;
}

/** Wrap NotificationManager methods with call-counting spies. Returns restore fn. */
function spyOnManager() {
  const counts = { register: 0, remove: 0, recordShown: 0, dismiss: 0 };
  const originals = {
    register: NotificationManager.register,
    remove: NotificationManager.remove,
    recordShown: NotificationManager.recordShown,
    dismiss: NotificationManager.dismiss,
  };
  NotificationManager.register = function (...args: any[]) {
    counts.register++;
    return (originals.register as any).apply(NotificationManager, args);
  } as any;
  NotificationManager.remove = function (...args: any[]) {
    counts.remove++;
    return (originals.remove as any).apply(NotificationManager, args);
  } as any;
  NotificationManager.recordShown = function (...args: any[]) {
    counts.recordShown++;
    return (originals.recordShown as any).apply(NotificationManager, args);
  } as any;
  NotificationManager.dismiss = function (...args: any[]) {
    counts.dismiss++;
    return (originals.dismiss as any).apply(NotificationManager, args);
  } as any;
  const restore = () => {
    NotificationManager.register = originals.register;
    NotificationManager.remove = originals.remove;
    NotificationManager.recordShown = originals.recordShown;
    NotificationManager.dismiss = originals.dismiss;
  };
  return { counts, restore };
}

describe('P1-g daemon-owned notifications', () => {
  beforeEach(() => {
    process.env.NO_COLOR = '1';
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
    (NotificationManager as any).STATE_PATH = STATE_FILE;
    NotificationManager.clearCache();
    NotificationManager.clearAll();
  });
  afterEach(() => {
    delete process.env.NO_COLOR;
    NotificationManager.clearCache();
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('T1 — formatPicked(readOnly=true) performs ZERO notification writes', () => {
    // Register one notification — render should NOT touch it in readOnly mode
    NotificationManager.register('slot_switch', 'Switch to S2', 6);

    const { counts, restore } = spyOnManager();
    try {
      const h = mkHealth();
      StatuslineFormatter.formatPicked(h, 120, false); // default readOnly=true
      // readOnly: zero writes
      expect(counts.register).toBe(0);
      expect(counts.remove).toBe(0);
      expect(counts.recordShown).toBe(0);
      expect(counts.dismiss).toBe(0);
    } finally {
      restore();
    }
  });

  test('T2 — formatAllVariants (daemon path) DOES write notifications', () => {
    // versionMismatch will register version_mismatch on daemon path
    const h = mkHealth({
      versionMismatch: { running: '1.0.0', installed: '1.0.1' },
    } as any);

    const { counts, restore } = spyOnManager();
    try {
      StatuslineFormatter.formatAllVariants(h);
      // Daemon path: writes are expected. Each width pass runs the notification
      // builder (register + remove calls). We assert non-zero to confirm the
      // daemon still owns the writes.
      expect(counts.register + counts.remove).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  test('T3 — dedup state persists across display-only renders', () => {
    // Daemon writes showCount=5; multiple display-only renders must NOT increment it
    NotificationManager.register('version_mismatch', 'old msg', 8);
    // Simulate 5 prior daemon-side displays by mutating state directly through public API
    // recordShown is the only mutator for showCount; call it 5x via the daemon-style write-mode
    for (let i = 0; i < 5; i++) {
      // Force new show-cycle by backdating lastShownAt
      const state = (NotificationManager as any).readState();
      const n = state.notifications.version_mismatch;
      if (n) {
        n.lastShownAt = Date.now() - (30_000 + 5 * 60_000 + 1_000); // past HIDE_DURATION
        (NotificationManager as any).writeState(state);
      }
      NotificationManager.recordShown('version_mismatch');
    }
    const baseline = NotificationManager.get('version_mismatch')!;
    const baselineShowCount = baseline.showCount;
    const baselineLastShown = baseline.lastShownAt;

    // Now do 5 display-only renders — they MUST NOT mutate showCount/lastShownAt
    const h = mkHealth();
    for (let i = 0; i < 5; i++) {
      StatuslineFormatter.formatPicked(h, 120, false);
    }

    const after = NotificationManager.get('version_mismatch')!;
    expect(after.showCount).toBe(baselineShowCount);
    expect(after.lastShownAt).toBe(baselineLastShown);
  });

  test('T4 — graceful read when notifications.json is missing', () => {
    // Remove the state file
    try { unlinkSync(STATE_FILE); } catch { /* may not exist */ }
    NotificationManager.clearCache();

    const h = mkHealth();
    // Must not throw; must return a render
    let out: string[] | undefined;
    expect(() => {
      out = StatuslineFormatter.formatPicked(h, 120, false);
    }).not.toThrow();
    expect(out).toBeDefined();
    expect(out!.length).toBeGreaterThan(0);
  });

  test('T5 — transcript_sampler_dead gated by readOnly flag', () => {
    // Seed an existing sampler-dead notification so we can observe non-removal
    NotificationManager.register('transcript_sampler_dead', 'stale', 6);
    const before = NotificationManager.get('transcript_sampler_dead');
    expect(before).not.toBeNull();

    const { counts, restore } = spyOnManager();
    try {
      const h = mkHealth();
      // Hot path render — formatPicked with readOnly=true
      StatuslineFormatter.formatPicked(h, 120, false);
      // fmtBurnRate would normally remove this notification on a write-path call
      // (ageS undefined/null means "clear"). In readOnly mode it must NOT.
      expect(counts.register).toBe(0);
      expect(counts.remove).toBe(0);
    } finally {
      restore();
    }
    const after = NotificationManager.get('transcript_sampler_dead');
    expect(after).not.toBeNull(); // untouched by display-only
  });
});
