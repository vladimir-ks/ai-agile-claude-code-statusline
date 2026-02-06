/**
 * Tests for NotificationManager - Intermittent notification display
 *
 * Verifies:
 * - Registration
 * - Visibility timing (30s show / 5min hide)
 * - Multiple notifications
 * - State persistence
 * - Cleanup
 * - Priority sorting
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { NotificationManager } from '../src/lib/notification-manager';

const TEST_DIR = join(tmpdir(), `notification-test-${Date.now()}`);
const STATE_FILE = join(TEST_DIR, 'notifications.json');

describe('NotificationManager', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Override path for testing
    (NotificationManager as any).STATE_PATH = STATE_FILE;
    NotificationManager.clearCache();
  });

  afterEach(() => {
    NotificationManager.clearCache();
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('register', () => {
    test('creates new notification', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      const notification = NotificationManager.get('version_update');
      expect(notification).not.toBeNull();
      expect(notification!.message).toBe('Update available');
      expect(notification!.priority).toBe(7);
      expect(notification!.dismissed).toBe(false);
      expect(notification!.showCount).toBe(0);
    });

    test('updates existing notification message', () => {
      NotificationManager.register('version_update', 'Update to 2.1.31', 7);
      const first = NotificationManager.get('version_update');
      const firstCreatedAt = first!.createdAt;

      NotificationManager.register('version_update', 'Update to 2.1.32', 7);
      const second = NotificationManager.get('version_update');

      expect(second!.message).toBe('Update to 2.1.32');
      expect(second!.createdAt).toBe(firstCreatedAt); // Not recreated
      expect(second!.dismissed).toBe(false); // Re-enabled
    });

    test('re-enables dismissed notification when re-registered', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.dismiss('version_update');

      expect(NotificationManager.get('version_update')!.dismissed).toBe(true);

      NotificationManager.register('version_update', 'New update available', 7);
      expect(NotificationManager.get('version_update')!.dismissed).toBe(false);
    });

    test('defaults priority to 5 if not specified', () => {
      NotificationManager.register('slot_switch', 'Switch slots');

      const notification = NotificationManager.get('slot_switch');
      expect(notification!.priority).toBe(5);
    });

    test('writes state to disk', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      expect(existsSync(STATE_FILE)).toBe(true);
    });
  });

  describe('shouldShow', () => {
    test('returns true for never-shown notification', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      expect(NotificationManager.shouldShow('version_update')).toBe(true);
    });

    test('returns false for dismissed notification', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.dismiss('version_update');

      expect(NotificationManager.shouldShow('version_update')).toBe(false);
    });

    test('returns false for nonexistent notification', () => {
      expect(NotificationManager.shouldShow('version_update')).toBe(false);
    });

    test('returns true during show period (0-30s)', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      // Record as shown (starts show cycle)
      NotificationManager.recordShown('version_update');

      // Should still be showing
      expect(NotificationManager.shouldShow('version_update')).toBe(true);
    });

    test('returns false during hide period (30s-5m30s)', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      // Manually set lastShownAt to 2 minutes ago
      const notification = NotificationManager.get('version_update')!;
      notification.lastShownAt = Date.now() - 2 * 60 * 1000; // 2 min ago

      // Manually update state
      const state = (NotificationManager as any).readState();
      state.notifications['version_update'] = notification;
      (NotificationManager as any).writeState(state);
      NotificationManager.clearCache();

      // Should be in hide period
      expect(NotificationManager.shouldShow('version_update')).toBe(false);
    });

    test('returns true after full cycle (>5m30s)', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      // Set lastShownAt to 6 minutes ago
      const notification = NotificationManager.get('version_update')!;
      notification.lastShownAt = Date.now() - 6 * 60 * 1000;

      const state = (NotificationManager as any).readState();
      state.notifications['version_update'] = notification;
      (NotificationManager as any).writeState(state);
      NotificationManager.clearCache();

      // Should show again
      expect(NotificationManager.shouldShow('version_update')).toBe(true);
    });
  });

  describe('recordShown', () => {
    test('sets lastShownAt on first show', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      const before = Date.now();

      NotificationManager.recordShown('version_update');

      const notification = NotificationManager.get('version_update');
      expect(notification!.lastShownAt).toBeGreaterThanOrEqual(before);
      expect(notification!.showCount).toBe(1);
    });

    test('increments showCount', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      NotificationManager.recordShown('version_update');
      expect(NotificationManager.get('version_update')!.showCount).toBe(1);

      // Set to 6 min ago to trigger new cycle
      const notification = NotificationManager.get('version_update')!;
      notification.lastShownAt = Date.now() - 6 * 60 * 1000;
      const state = (NotificationManager as any).readState();
      state.notifications['version_update'] = notification;
      (NotificationManager as any).writeState(state);
      NotificationManager.clearCache();

      NotificationManager.recordShown('version_update');
      expect(NotificationManager.get('version_update')!.showCount).toBe(2);
    });

    test('does not update lastShownAt during show period', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      NotificationManager.recordShown('version_update');
      const firstShownAt = NotificationManager.get('version_update')!.lastShownAt;

      // Wait 1ms
      const start = Date.now();
      while (Date.now() - start < 2) { /* wait */ }

      NotificationManager.recordShown('version_update');
      const secondShownAt = NotificationManager.get('version_update')!.lastShownAt;

      // Should be same timestamp (still in show period)
      expect(secondShownAt).toBe(firstShownAt);
    });

    test('does nothing for nonexistent notification', () => {
      expect(() => NotificationManager.recordShown('version_update')).not.toThrow();
    });
  });

  describe('dismiss', () => {
    test('marks notification as dismissed', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      NotificationManager.dismiss('version_update');

      expect(NotificationManager.get('version_update')!.dismissed).toBe(true);
    });

    test('dismissed notification not shown', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.dismiss('version_update');

      expect(NotificationManager.shouldShow('version_update')).toBe(false);
      expect(NotificationManager.getActive().length).toBe(0);
    });

    test('does nothing for nonexistent notification', () => {
      expect(() => NotificationManager.dismiss('version_update')).not.toThrow();
    });
  });

  describe('remove', () => {
    test('completely removes notification', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      NotificationManager.remove('version_update');

      expect(NotificationManager.get('version_update')).toBeNull();
    });

    test('does nothing for nonexistent notification', () => {
      expect(() => NotificationManager.remove('version_update')).not.toThrow();
    });
  });

  describe('getActive', () => {
    test('returns empty array when no notifications', () => {
      const active = NotificationManager.getActive();
      expect(active).toEqual([]);
    });

    test('returns active non-dismissed notifications', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.register('slot_switch', 'Switch slots', 6);

      const active = NotificationManager.getActive();
      expect(active.length).toBe(2);
    });

    test('excludes dismissed notifications', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.register('slot_switch', 'Switch slots', 6);
      NotificationManager.dismiss('version_update');

      const active = NotificationManager.getActive();
      expect(active.length).toBe(1);
      expect(active[0][0]).toBe('slot_switch');
    });

    test('excludes notifications in hide period', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      // Set to hide period (2 min ago)
      const notification = NotificationManager.get('version_update')!;
      notification.lastShownAt = Date.now() - 2 * 60 * 1000;
      const state = (NotificationManager as any).readState();
      state.notifications['version_update'] = notification;
      (NotificationManager as any).writeState(state);
      NotificationManager.clearCache();

      const active = NotificationManager.getActive();
      expect(active.length).toBe(0);
    });

    test('sorts by priority descending (highest first)', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.register('slot_switch', 'Switch slots', 6);
      NotificationManager.register('restart_ready', 'Restart ready', 5);

      const active = NotificationManager.getActive();
      expect(active.length).toBe(3);
      expect(active[0][0]).toBe('version_update'); // priority 7
      expect(active[1][0]).toBe('slot_switch');    // priority 6
      expect(active[2][0]).toBe('restart_ready');  // priority 5
    });
  });

  describe('clearAll', () => {
    test('removes all notifications', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.register('slot_switch', 'Switch slots', 6);

      NotificationManager.clearAll();

      expect(NotificationManager.getActive().length).toBe(0);
      expect(NotificationManager.get('version_update')).toBeNull();
      expect(NotificationManager.get('slot_switch')).toBeNull();
    });
  });

  describe('cleanup', () => {
    test('removes old dismissed notifications (>24h)', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.dismiss('version_update');

      // Manually set createdAt to 25 hours ago
      const notification = NotificationManager.get('version_update')!;
      notification.createdAt = Date.now() - 25 * 60 * 60 * 1000;
      const state = (NotificationManager as any).readState();
      state.notifications['version_update'] = notification;
      (NotificationManager as any).writeState(state);
      NotificationManager.clearCache();

      NotificationManager.cleanup();

      expect(NotificationManager.get('version_update')).toBeNull();
    });

    test('preserves recent dismissed notifications (<24h)', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.dismiss('version_update');

      NotificationManager.cleanup();

      expect(NotificationManager.get('version_update')).not.toBeNull();
    });

    test('preserves active (non-dismissed) notifications regardless of age', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      // Set to 25 hours ago but NOT dismissed
      const notification = NotificationManager.get('version_update')!;
      notification.createdAt = Date.now() - 25 * 60 * 60 * 1000;
      const state = (NotificationManager as any).readState();
      state.notifications['version_update'] = notification;
      (NotificationManager as any).writeState(state);
      NotificationManager.clearCache();

      NotificationManager.cleanup();

      expect(NotificationManager.get('version_update')).not.toBeNull();
    });
  });

  describe('getCycleInfo', () => {
    test('returns "ready" for never-shown notification', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      const info = NotificationManager.getCycleInfo('version_update');
      expect(info.state).toBe('ready');
      expect(info.remainingMs).toBe(0);
    });

    test('returns "showing" during show period', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.recordShown('version_update');

      const info = NotificationManager.getCycleInfo('version_update');
      expect(info.state).toBe('showing');
      expect(info.remainingMs).toBeGreaterThan(0);
      expect(info.remainingMs).toBeLessThanOrEqual(30 * 1000);
    });

    test('returns "hiding" during hide period', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      // Set to hide period (2 min ago)
      const notification = NotificationManager.get('version_update')!;
      notification.lastShownAt = Date.now() - 2 * 60 * 1000;
      const state = (NotificationManager as any).readState();
      state.notifications['version_update'] = notification;
      (NotificationManager as any).writeState(state);
      NotificationManager.clearCache();

      const info = NotificationManager.getCycleInfo('version_update');
      expect(info.state).toBe('hiding');
      expect(info.remainingMs).toBeGreaterThan(0);
    });

    test('returns "ready" after full cycle', () => {
      NotificationManager.register('version_update', 'Update available', 7);

      // Set to 6 min ago (past full cycle)
      const notification = NotificationManager.get('version_update')!;
      notification.lastShownAt = Date.now() - 6 * 60 * 1000;
      const state = (NotificationManager as any).readState();
      state.notifications['version_update'] = notification;
      (NotificationManager as any).writeState(state);
      NotificationManager.clearCache();

      const info = NotificationManager.getCycleInfo('version_update');
      expect(info.state).toBe('ready');
      expect(info.remainingMs).toBe(0);
    });

    test('returns "ready" for dismissed notification', () => {
      NotificationManager.register('version_update', 'Update available', 7);
      NotificationManager.dismiss('version_update');

      const info = NotificationManager.getCycleInfo('version_update');
      expect(info.state).toBe('ready');
      expect(info.remainingMs).toBe(0);
    });
  });

  describe('edge cases', () => {
    test('corrupted state file returns default state', () => {
      writeFileSync(STATE_FILE, 'NOT VALID JSON {{{', 'utf-8');
      NotificationManager.clearCache();

      // Should not throw — returns empty active list
      const active = NotificationManager.getActive();
      expect(active).toEqual([]);
    });

    test('empty state file returns default state', () => {
      writeFileSync(STATE_FILE, '', 'utf-8');
      NotificationManager.clearCache();

      const active = NotificationManager.getActive();
      expect(active).toEqual([]);
    });

    test('state file with missing notifications key returns default', () => {
      writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: Date.now() }), 'utf-8');
      NotificationManager.clearCache();

      const active = NotificationManager.getActive();
      expect(active).toEqual([]);
    });

    test('register after corrupted file creates fresh state', () => {
      writeFileSync(STATE_FILE, 'corrupted', 'utf-8');
      NotificationManager.clearCache();

      NotificationManager.register('version_update', 'Update available', 7);
      const notification = NotificationManager.get('version_update');
      expect(notification).not.toBeNull();
      expect(notification!.message).toBe('Update available');
    });

    test('cleanup removes only old dismissed notifications', () => {
      // Create 3 notifications: active recent, dismissed recent, dismissed old
      NotificationManager.register('version_update', 'Update', 7);
      NotificationManager.register('slot_switch', 'Switch', 6);
      NotificationManager.register('restart_ready', 'Restart', 5);

      NotificationManager.dismiss('slot_switch');
      NotificationManager.dismiss('restart_ready');

      // Backdate restart_ready to 25h ago
      const state = (NotificationManager as any).readState();
      state.notifications['restart_ready'].createdAt = Date.now() - 25 * 60 * 60 * 1000;
      (NotificationManager as any).writeState(state);
      NotificationManager.clearCache();

      NotificationManager.cleanup();

      // Active: version_update (still active)
      expect(NotificationManager.get('version_update')).not.toBeNull();
      // Recent dismissed: slot_switch (kept — <24h)
      expect(NotificationManager.get('slot_switch')).not.toBeNull();
      // Old dismissed: restart_ready (removed — >24h)
      expect(NotificationManager.get('restart_ready')).toBeNull();
    });

    test('getCycleInfo for nonexistent notification returns ready', () => {
      const info = NotificationManager.getCycleInfo('version_update');
      expect(info.state).toBe('ready');
      expect(info.remainingMs).toBe(0);
    });
  });
});
