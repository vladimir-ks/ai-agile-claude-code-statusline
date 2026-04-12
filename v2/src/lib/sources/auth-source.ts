/**
 * Auth Source — Tier 2 (per-session)
 *
 * Detects which account is active for the current session.
 *
 * Detection priority:
 *   1. SESSION-LOCKED: Already detected via trusted method → reuse
 *   2. KEYCHAIN IDENTITY: Read oauthAccount.emailAddress from keychain blob
 *   3. CONFIG DIR PATH: Match configDir to hot-swap slot
 *   4. .claude.json oauthAccount: Fallback (can be stale)
 *   5. API FINGERPRINT: Last resort for destroyed keychains
 *   6. DEFAULT: AuthProfileDetector generic
 *
 * Session lock persists until:
 *   - Session ends and a new one starts (fresh detection)
 *   - User runs /login inside the session (auth-change detector clears identity)
 *
 * Keychain blob structure (written by Claude Code on /login):
 *   { claudeAiOauth: { accessToken, ... }, oauthAccount: { emailAddress, accountUuid, ... } }
 *
 * The oauthAccount section survives token refreshes (when refresh code is correct)
 * and is the GROUND TRUTH for which account owns the keychain entry.
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth } from '../../types/session-health';
import { AuthProfileDetector } from '../../modules/auth-profile-detector';
import { KeychainResolver } from '../../modules/keychain-resolver';
import { HotSwapQuotaReader } from '../hot-swap-quota-reader';
import { NotificationManager } from '../notification-manager';
import { AnthropicOAuthAPI } from '../../modules/anthropic-oauth-api';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';

export interface AuthSourceData {
  authProfile: string;
  detectionMethod: string;
  configDir: string | null;
  keychainService: string | null;
  slotId: string | null;
}

/**
 * Find slot by email in hot-swap cache.
 */
function findSlotByEmail(email: string, cache: Record<string, any>): string | null {
  for (const [slotId, slotData] of Object.entries(cache)) {
    if (slotData?.email && slotData.email.toLowerCase() === email.toLowerCase()) {
      return slotId;
    }
  }
  return null;
}

/**
 * Read .claude.json oauthAccount.emailAddress as fallback.
 * WARNING: Can be stale — use only when keychain identity is unavailable.
 */
function readOAuthEmailFromClaudeJson(configDir: string | null): string | null {
  try {
    const dir = configDir || resolve(homedir(), '.claude');
    const statePath = resolve(dir, '.claude.json');
    if (!existsSync(statePath)) return null;

    const raw = readFileSync(statePath, 'utf-8');
    const state = JSON.parse(raw);
    const email = state?.oauthAccount?.emailAddress;
    return typeof email === 'string' && email.includes('@') ? email : null;
  } catch {
    return null;
  }
}

/**
 * API utilization fingerprint — last resort when keychain has no identity.
 * Calls Anthropic API with session's token, matches utilization against known slots.
 */
async function detectViaApiFingerprint(
  keychainService: string,
  cache: Record<string, any>
): Promise<{ email: string; slotId: string } | null> {
  try {
    // Pipeline invariant: only shell fetch-quotas.sh calls /api/oauth/usage.
    // This fingerprint path is an alternate OAuth-API caller; gate it behind
    // the same env var as billing-source so operators can kill all TS-side API
    // traffic without touching code. Default off.
    if (process.env.STATUSLINE_OAUTH_API !== '1') return null;

    const entry = KeychainResolver.readKeychainEntry(keychainService);
    if (!entry?.accessToken || entry.isExpired) return null;

    // Skip API fingerprint when ANY slot is in rate-limit backoff.
    // The fingerprint is a last-resort identity probe; hitting 429 here
    // extends the ban and starves unrelated callers.
    for (const slotId of Object.keys(cache)) {
      if (AnthropicOAuthAPI.isSlotInBackoff(slotId)) {
        console.error('[AuthSource] Skipping API fingerprint — slot in rate-limit backoff');
        return null;
      }
    }

    const response = await fetch('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${entry.accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });

    if (response.status === 429) {
      // Propagate 429 to shared backoff state so shell + TS honor it
      const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10) || 0;
      const matchSlot = Object.keys(cache)[0] || 'unknown';
      if (matchSlot !== 'unknown') {
        AnthropicOAuthAPI.recordRateLimitBackoff(matchSlot, retryAfter);
      }
      console.error(`[AuthSource] Fingerprint hit 429 (Retry-After=${retryAfter}s)`);
      return null;
    }
    if (!response.ok) return null;

    const data = await response.json() as Record<string, any>;
    const fiveHour = data?.five_hour?.utilization ?? -1;
    const sevenDay = data?.seven_day?.utilization ?? -1;
    if (sevenDay < 0) return null;

    // Match against slots by utilization proximity
    let bestMatch: { slotId: string; email: string; distance: number } | null = null;
    for (const [slotId, slotData] of Object.entries(cache)) {
      if (!slotData?.email) continue;
      const sevenDayDist = Math.abs(sevenDay - (slotData.seven_day_util ?? -999));
      const fiveHourDist = Math.abs(fiveHour - (slotData.five_hour_util ?? -999));
      const distance = sevenDayDist * 2 + fiveHourDist;
      if (sevenDayDist <= 5 && fiveHourDist <= 10) {
        if (!bestMatch || distance < bestMatch.distance) {
          bestMatch = { slotId, email: slotData.email, distance };
        }
      }
    }

    if (bestMatch) {
      console.error(
        `[AuthSource] API fingerprint: 5h=${fiveHour}%/7d=${sevenDay}% → ${bestMatch.email} (${bestMatch.slotId})`
      );
    }
    return bestMatch ? { email: bestMatch.email, slotId: bestMatch.slotId } : null;
  } catch {
    return null;
  }
}

export const authSource: DataSourceDescriptor<AuthSourceData> = {
  id: 'auth_profile',
  tier: 2,
  freshnessCategory: 'auth_profile',
  timeoutMs: 2000, // Keychain read is fast; API fingerprint only as fallback

  async fetch(ctx: GatherContext): Promise<AuthSourceData> {
    // Step 1: Resolve configDir and keychainService from transcript path
    const { configDir, keychainService } = KeychainResolver.resolveFromTranscript(
      ctx.transcriptPath
    );

    let authProfile = '';
    let detectionMethod = 'default';
    let slotId: string | null = null;

    // Step 2: SESSION-LOCKED — if already detected via trusted method, reuse
    const existing = ctx.existingHealth?.launch;
    const trustedMethods = ['keychain_identity', 'path', 'api_fingerprint'];
    if (existing?.authProfile &&
        existing.authProfile !== 'default' &&
        trustedMethods.includes(existing.detectionMethod || '')) {
      const cache = HotSwapQuotaReader.read();
      const resolvedSlotId = cache ? findSlotByEmail(existing.authProfile, cache) : null;
      return {
        authProfile: existing.authProfile,
        detectionMethod: existing.detectionMethod,
        configDir,
        keychainService,
        slotId: resolvedSlotId,
      };
    }

    // Step 3: KEYCHAIN IDENTITY — read oauthAccount from keychain blob (BEST)
    if (keychainService) {
      const entry = KeychainResolver.readKeychainEntry(keychainService);
      if (entry?.emailAddress) {
        authProfile = entry.emailAddress;
        detectionMethod = 'keychain_identity';
        const cache = HotSwapQuotaReader.read();
        slotId = cache ? findSlotByEmail(authProfile, cache) : null;
        console.error(`[AuthSource] Detected ${authProfile} via keychain identity (${slotId || 'no slot match'})`);
      }
    }

    // Step 4: CONFIG DIR PATH — for non-default configDirs (hot-swap slot dirs)
    if (!authProfile && configDir && configDir !== resolve(homedir(), '.claude')) {
      const matchedSlot = HotSwapQuotaReader.getSlotByConfigDir(configDir);
      if (matchedSlot) {
        authProfile = matchedSlot.email;
        detectionMethod = 'path';
        slotId = matchedSlot.slotId;
        console.error(`[AuthSource] Detected ${authProfile} via configDir path (${slotId})`);
      }
    }

    // Step 5: .claude.json oauthAccount — fallback (can be stale)
    if (!authProfile) {
      const oauthEmail = readOAuthEmailFromClaudeJson(configDir);
      if (oauthEmail) {
        authProfile = oauthEmail;
        detectionMethod = 'claude_json_fallback';
        const cache = HotSwapQuotaReader.read();
        slotId = cache ? findSlotByEmail(oauthEmail, cache) : null;
        console.error(`[AuthSource] Fallback .claude.json: ${authProfile} (may be stale)`);
      }
    }

    // Step 6: API FINGERPRINT — last resort for destroyed keychains
    if (!authProfile && keychainService) {
      const cache = HotSwapQuotaReader.read();
      if (cache && Object.keys(cache).length > 0) {
        const match = await detectViaApiFingerprint(keychainService, cache);
        if (match) {
          authProfile = match.email;
          detectionMethod = 'api_fingerprint';
          slotId = match.slotId;
        }
      }
    }

    // Step 7: Last resort — generic detection
    if (!authProfile) {
      const detected = AuthProfileDetector.detectProfile(
        ctx.projectPath || '',
        ctx.existingHealth?.billing || null,
        []
      );
      authProfile = detected.authProfile || '';
      detectionMethod = detected.detectionMethod || 'default';
    }

    return { authProfile, detectionMethod, configDir, keychainService, slotId };
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

    // Register active slot notification (high priority for launch visibility)
    // Note: emoji prefix added by buildNotifications, not here
    if (data.authProfile && data.authProfile !== 'default' && data.slotId) {
      NotificationManager.register('active_slot', `${data.authProfile} (${data.slotId})`, 8);
    } else if (data.authProfile && data.authProfile !== 'default') {
      NotificationManager.register('active_slot', `${data.authProfile}`, 8);
    }
  },
};

export default authSource;
