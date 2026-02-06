/**
 * Auth Source — Tier 2 (per-session)
 *
 * Detects authentication profile for the current session:
 *   1. AuthProfileDetector.detectProfile() — generic detection
 *   2. KeychainResolver.resolveFromTranscript() — session-specific configDir
 *   3. HotSwapQuotaReader.getSlotByConfigDir() — precise slot matching
 *
 * Provides configDir, keychainService, authProfile, and detectionMethod.
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth } from '../../types/session-health';
import { AuthProfileDetector } from '../../modules/auth-profile-detector';
import { KeychainResolver } from '../../modules/keychain-resolver';
import { HotSwapQuotaReader } from '../hot-swap-quota-reader';

export interface AuthSourceData {
  authProfile: string;
  detectionMethod: string;
  configDir: string | null;
  keychainService: string | null;
  slotId: string | null;
}

export const authSource: DataSourceDescriptor<AuthSourceData> = {
  id: 'auth_profile',
  tier: 2,
  freshnessCategory: 'auth_profile',
  timeoutMs: 1000, // File reads only

  async fetch(ctx: GatherContext): Promise<AuthSourceData> {
    // Step 1: Resolve configDir and keychainService from transcript path
    const { configDir, keychainService } = KeychainResolver.resolveFromTranscript(
      ctx.transcriptPath
    );

    // Step 2: Match to hot-swap slot if configDir available
    let authProfile = '';
    let detectionMethod = 'default';
    let slotId: string | null = null;

    if (configDir) {
      const matchedSlot = HotSwapQuotaReader.getSlotByConfigDir(configDir);
      if (matchedSlot) {
        authProfile = matchedSlot.email;
        detectionMethod = 'path';
        slotId = matchedSlot.slotId;
      }
    }

    // Step 3: Fall back to generic detection if no slot match
    if (!authProfile) {
      const detected = AuthProfileDetector.detectProfile(
        ctx.projectPath || '',
        ctx.existingHealth?.billing || null,
        [] // authProfiles from runtime state — no profiles available at this point
      );
      authProfile = detected.authProfile || '';
      detectionMethod = detected.detectionMethod || 'default';
    }

    return {
      authProfile,
      detectionMethod,
      configDir,
      keychainService,
      slotId,
    };
  },

  merge(target: SessionHealth, data: AuthSourceData): void {
    target.launch.authProfile = data.authProfile;
    target.launch.detectionMethod = data.detectionMethod;
    if (data.configDir) {
      target.launch.configDir = data.configDir;
    }
    if (data.keychainService) {
      target.launch.keychainService = data.keychainService;
    }
  },
};

export default authSource;
