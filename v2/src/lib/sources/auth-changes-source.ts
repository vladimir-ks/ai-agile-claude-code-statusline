/**
 * Auth Changes Source — Tier 2 (per-session)
 *
 * Detects authentication profile switches via UnifiedTranscriptScanner's
 * AuthChangeDetector. Integrates with SessionLockManager to track account
 * switches and update session metadata.
 *
 * Flow:
 * 1. Scan transcript for /login or /swap-auth commands
 * 2. Detect success confirmations with email extraction
 * 3. Compare with current session lock email
 * 4. Update session lock if auth changed
 * 5. Return auth change metadata for health
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth } from '../../types/session-health';
import { UnifiedTranscriptScanner } from '../transcript-scanner/unified-transcript-scanner';
import { SessionLockManager } from '../session-lock-manager';
import { existsSync } from 'fs';

const scanner = new UnifiedTranscriptScanner();

export interface AuthChangesData {
  hasAuthChanges: boolean;
  latestEmail: string | null;
  changeCount: number;
  lastChangeTimestamp: number;
  sessionEmailUpdated: boolean; // true if session lock was updated
}

export const authChangesSource: DataSourceDescriptor<AuthChangesData> = {
  id: 'auth_changes',
  tier: 2,
  freshnessCategory: 'auth_profile', // Shares freshness with auth profile
  timeoutMs: 3000,

  async fetch(ctx: GatherContext): Promise<AuthChangesData> {
    const emptyResult: AuthChangesData = {
      hasAuthChanges: false,
      latestEmail: null,
      changeCount: 0,
      lastChangeTimestamp: 0,
      sessionEmailUpdated: false,
    };

    if (!ctx.transcriptPath || !existsSync(ctx.transcriptPath)) {
      return emptyResult;
    }

    try {
      // Scan transcript for auth changes
      const scanResult = scanner.scan(ctx.sessionId, ctx.transcriptPath);

      if (scanResult.authChanges.length === 0) {
        return emptyResult;
      }

      // Get latest auth change (most recent)
      const latest = scanResult.authChanges[scanResult.authChanges.length - 1];

      // Check current session lock
      const currentLock = SessionLockManager.read(ctx.sessionId);

      // Update session lock if email changed
      let sessionEmailUpdated = false;
      if (currentLock && currentLock.email !== latest.email) {
        // Email changed - update session lock
        const updatedLock = {
          ...currentLock,
          email: latest.email,
          updatedAt: Date.now(),
        };

        const writeSuccess = SessionLockManager.write(updatedLock);
        if (writeSuccess) {
          sessionEmailUpdated = true;
          console.log(`[AuthChangesSource] Updated session ${ctx.sessionId} email: ${currentLock.email} → ${latest.email}`);
        }
      }

      return {
        hasAuthChanges: true,
        latestEmail: latest.email,
        changeCount: scanResult.authChanges.length,
        lastChangeTimestamp: latest.loginTimestamp,
        sessionEmailUpdated,
      };
    } catch (error) {
      console.error('[AuthChangesSource] Failed to detect auth changes:', error);
      return emptyResult;
    }
  },

  merge(target: SessionHealth, data: AuthChangesData): void {
    // Update auth metadata in health
    if (data.hasAuthChanges) {
      target.launch.authProfile = data.latestEmail || target.launch.authProfile;

      // Add notification if session email was updated
      if (data.sessionEmailUpdated) {
        const { NotificationManager } = require('../notification-manager');
        NotificationManager.register(
          'auth_switch',
          `Account switched to ${data.latestEmail}`,
          5 // Priority 5 (important but not critical)
        );
      }
    }
  },
};

export default authChangesSource;
