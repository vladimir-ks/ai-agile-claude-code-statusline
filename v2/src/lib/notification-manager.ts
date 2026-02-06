/**
 * Notification Manager - Intermittent notification display controller
 *
 * Pattern: Show 30s → Hide 5min → Repeat
 * State: ~/.claude/session-health/notifications.json
 *
 * Notification types:
 * - version_update: New Claude Code version available
 * - slot_switch: Recommended to switch slots
 * - restart_ready: Auto-restart conditions met (dry-run indicator)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname } from 'path';

export type NotificationType = 'version_update' | 'slot_switch' | 'restart_ready';

export interface Notification {
  type: NotificationType;
  message: string;
  priority: number;         // Higher = more important (1-10)
  createdAt: number;        // Unix timestamp ms
  lastShownAt?: number;     // When last displayed
  showCount: number;        // How many times shown
  dismissed: boolean;       // User manually dismissed
}

interface NotificationState {
  notifications: Record<string, Notification>; // key = type
  updatedAt: number;
}

// In-memory cache
let cachedState: NotificationState | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5000; // 5s (frequent reads during statusline invocations)

export class NotificationManager {
  private static readonly STATE_PATH = `${homedir()}/.claude/session-health/notifications.json`;
  private static readonly SHOW_DURATION = 30 * 1000; // 30 seconds
  private static readonly HIDE_DURATION = 5 * 60 * 1000; // 5 minutes

  /**
   * Read notification state (with caching)
   */
  private static readState(): NotificationState {
    const now = Date.now();

    // Return cached if fresh
    if (cachedState && (now - cacheTimestamp) < CACHE_TTL) {
      return cachedState;
    }

    // Read from file
    try {
      if (existsSync(this.STATE_PATH)) {
        const content = readFileSync(this.STATE_PATH, 'utf-8');
        const parsed = JSON.parse(content);

        if (parsed && parsed.notifications) {
          cachedState = parsed as NotificationState;
          cacheTimestamp = now;
          return cachedState;
        }
      }
    } catch {
      // Parse error - start fresh
    }

    // Default state
    const defaultState: NotificationState = {
      notifications: {},
      updatedAt: now
    };

    cachedState = defaultState;
    cacheTimestamp = now;
    return defaultState;
  }

  /**
   * Write notification state (atomic)
   */
  private static writeState(state: NotificationState): boolean {
    try {
      const dir = dirname(this.STATE_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      state.updatedAt = Date.now();

      // Atomic write
      const tmpPath = `${this.STATE_PATH}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 });
      try {
        renameSync(tmpPath, this.STATE_PATH);
      } catch {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        return false;
      }

      // Update cache
      cachedState = state;
      cacheTimestamp = Date.now();

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Register or update notification
   */
  static register(type: NotificationType, message: string, priority: number = 5): void {
    const state = this.readState();
    const now = Date.now();

    const existing = state.notifications[type];

    if (existing) {
      // Update existing notification
      existing.message = message;
      existing.priority = priority;
      existing.dismissed = false; // Re-enable if message changed
    } else {
      // Create new notification
      state.notifications[type] = {
        type,
        message,
        priority,
        createdAt: now,
        showCount: 0,
        dismissed: false
      };
    }

    this.writeState(state);
  }

  /**
   * Check if notification should be shown now
   * Implements intermittent pattern: 30s show, 5min hide
   */
  static shouldShow(type: NotificationType): boolean {
    const state = this.readState();
    const notification = state.notifications[type];

    if (!notification || notification.dismissed) {
      return false;
    }

    const now = Date.now();

    // Never shown before → show it
    if (!notification.lastShownAt) {
      return true;
    }

    const timeSinceLastShown = now - notification.lastShownAt;

    // If < 30s since last shown → still showing
    if (timeSinceLastShown < this.SHOW_DURATION) {
      return true;
    }

    // If < 5min 30s since last shown → in hide period
    if (timeSinceLastShown < (this.SHOW_DURATION + this.HIDE_DURATION)) {
      return false;
    }

    // If >= 5min 30s since last shown → show again
    return true;
  }

  /**
   * Record that notification was shown (update lastShownAt if appropriate)
   */
  static recordShown(type: NotificationType): void {
    const state = this.readState();
    const notification = state.notifications[type];

    if (!notification) {
      return;
    }

    const now = Date.now();

    // Only update lastShownAt if starting a new show cycle
    if (!notification.lastShownAt ||
        (now - notification.lastShownAt) >= (this.SHOW_DURATION + this.HIDE_DURATION)) {
      notification.lastShownAt = now;
      notification.showCount++;
      this.writeState(state);
    }
  }

  /**
   * Dismiss notification (user-initiated)
   */
  static dismiss(type: NotificationType): void {
    const state = this.readState();
    const notification = state.notifications[type];

    if (notification) {
      notification.dismissed = true;
      this.writeState(state);
    }
  }

  /**
   * Remove notification entirely
   */
  static remove(type: NotificationType): void {
    const state = this.readState();
    delete state.notifications[type];
    this.writeState(state);
  }

  /**
   * Get all active (non-dismissed) notifications sorted by priority
   * Returns array of [type, notification] tuples
   */
  static getActive(): Array<[NotificationType, Notification]> {
    const state = this.readState();
    const active: Array<[NotificationType, Notification]> = [];

    for (const [type, notification] of Object.entries(state.notifications)) {
      if (!notification.dismissed && this.shouldShow(type as NotificationType)) {
        active.push([type as NotificationType, notification]);
      }
    }

    // Sort by priority descending (highest first)
    active.sort((a, b) => b[1].priority - a[1].priority);

    return active;
  }

  /**
   * Get specific notification
   */
  static get(type: NotificationType): Notification | null {
    const state = this.readState();
    return state.notifications[type] || null;
  }

  /**
   * Clear all notifications
   */
  static clearAll(): void {
    const state: NotificationState = {
      notifications: {},
      updatedAt: Date.now()
    };
    this.writeState(state);
  }

  /**
   * Cleanup old dismissed notifications (>24h old)
   */
  static cleanup(): void {
    const state = this.readState();
    const now = Date.now();
    const threshold = 24 * 60 * 60 * 1000; // 24 hours

    let cleaned = false;

    for (const [type, notification] of Object.entries(state.notifications)) {
      if (notification.dismissed && (now - notification.createdAt) > threshold) {
        delete state.notifications[type];
        cleaned = true;
      }
    }

    if (cleaned) {
      this.writeState(state);
    }
  }

  /**
   * Clear in-memory cache (for testing)
   */
  static clearCache(): void {
    cachedState = null;
    cacheTimestamp = 0;
  }

  /**
   * Get time remaining in current show/hide cycle
   * Returns: { state: 'showing' | 'hiding', remainingMs: number }
   */
  static getCycleInfo(type: NotificationType): { state: 'showing' | 'hiding' | 'ready'; remainingMs: number } {
    const notification = this.get(type);
    if (!notification || notification.dismissed) {
      return { state: 'ready', remainingMs: 0 };
    }

    if (!notification.lastShownAt) {
      return { state: 'ready', remainingMs: 0 };
    }

    const now = Date.now();
    const elapsed = now - notification.lastShownAt;

    if (elapsed < this.SHOW_DURATION) {
      return {
        state: 'showing',
        remainingMs: this.SHOW_DURATION - elapsed
      };
    }

    if (elapsed < (this.SHOW_DURATION + this.HIDE_DURATION)) {
      return {
        state: 'hiding',
        remainingMs: (this.SHOW_DURATION + this.HIDE_DURATION) - elapsed
      };
    }

    return { state: 'ready', remainingMs: 0 };
  }
}

export default NotificationManager;
