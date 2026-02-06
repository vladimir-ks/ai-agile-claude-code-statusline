/**
 * Version Check Source — Tier 3 (global, 4h cooldown)
 *
 * Checks for Claude Code updates by fetching install.sh.
 * Registers notification via NotificationManager if update available.
 * Does NOT write to SessionHealth directly — writes to notification system.
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth } from '../../types/session-health';
import { VersionChecker } from '../version-checker';
import { NotificationManager } from '../notification-manager';
import { SessionLockManager } from '../session-lock-manager';

export interface VersionSourceData {
  currentVersion: string;
  latestVersion: string | null;
  needsUpdate: boolean;
  checkedAt: number;
}

export const versionSource: DataSourceDescriptor<VersionSourceData> = {
  id: 'version_check',
  tier: 3,
  freshnessCategory: 'version_check',
  timeoutMs: 10000, // Network fetch

  async fetch(ctx: GatherContext): Promise<VersionSourceData> {
    const currentVersion = VersionChecker.getCurrentVersion();
    const checkedAt = Date.now();

    // Only fetch if cooldown expired (4h)
    if (VersionChecker.getCheckCooldown() > 0) {
      return {
        currentVersion,
        latestVersion: null,
        needsUpdate: false,
        checkedAt,
      };
    }

    const latest = await VersionChecker.getLatestVersion();
    const needsUpdate = latest
      ? currentVersion !== 'unknown' && VersionChecker.needsUpdate(currentVersion, latest.version)
      : false;

    return {
      currentVersion,
      latestVersion: latest?.version || null,
      needsUpdate,
      checkedAt,
    };
  },

  merge(target: SessionHealth, data: VersionSourceData): void {
    // Version check doesn't write to SessionHealth directly.
    // It updates the notification system.
    if (data.needsUpdate && data.latestVersion) {
      NotificationManager.register(
        'version_update',
        `Update to ${data.latestVersion} available (your version: ${data.currentVersion})`,
        7
      );
    }

    // Update session lock with check timestamp
    if (target.sessionId && data.latestVersion) {
      try {
        SessionLockManager.update(target.sessionId, {
          lastVersionCheck: data.checkedAt,
        });
      } catch { /* non-critical */ }
    }
  },
};

export default versionSource;
