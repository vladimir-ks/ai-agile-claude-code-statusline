/**
 * Notification Source — Tier 3 (global, 5s freshness)
 *
 * Manages the notification lifecycle: cleanup old dismissed notifications.
 * The actual notification registration is done by other sources (version, slot).
 * This source handles periodic maintenance.
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth } from '../../types/session-health';
import { NotificationManager } from '../notification-manager';

export interface NotificationSourceData {
  cleanedAt: number;
}

export const notificationSource: DataSourceDescriptor<NotificationSourceData> = {
  id: 'notifications',
  tier: 3,
  freshnessCategory: 'notifications',
  timeoutMs: 500,

  async fetch(_ctx: GatherContext): Promise<NotificationSourceData> {
    // Cleanup old dismissed notifications (>24h)
    NotificationManager.cleanup();
    return { cleanedAt: Date.now() };
  },

  merge(_target: SessionHealth, _data: NotificationSourceData): void {
    // Notifications don't write to SessionHealth — they have their own file.
  },
};

export default notificationSource;
