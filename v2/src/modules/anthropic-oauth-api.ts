/**
 * Anthropic OAuth Usage API - Authoritative quota source
 *
 * Endpoint: https://api.anthropic.com/api/oauth/usage
 * Returns exact quota percentages and reset times
 *
 * This is the AUTHORITATIVE source for billing data, replacing ccusage estimates.
 */

import { BillingInfo } from '../types/session-health';
import { existsSync, statSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { createHash } from 'crypto';

const COOLDOWN_DIR = `${homedir()}/.claude/session-health/cooldowns`;

export interface AnthropicOAuthUsageResponse {
  quota_percentage_used?: number;  // Exact percentage (0-100)
  reset_time?: string;              // ISO 8601 timestamp (daily)
  cost_usd?: number;                // Actual cost in USD
  tokens_used?: number;             // Total tokens consumed
  quota_limit_usd?: number;         // Daily quota limit
  quota_remaining_usd?: number;     // Remaining quota (daily)

  // Weekly quota fields
  weekly_quota_limit_usd?: number;      // Weekly quota limit
  weekly_quota_remaining_usd?: number;  // Weekly remaining
  weekly_quota_percentage_used?: number; // Weekly percentage used
  weekly_reset_time?: string;           // ISO 8601 timestamp (weekly reset)
}

export class AnthropicOAuthAPI {
  private static API_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

  // Cooldown persisted to disk so ALL daemon processes respect it.
  // Each daemon invocation is a new process — in-memory cooldown was useless.
  private static COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

  /**
   * Get cooldown file path for a service name.
   * Uses hash to avoid filesystem-unsafe characters in service names.
   */
  private static cooldownPath(serviceName: string): string {
    const hash = createHash('sha256').update(serviceName).digest('hex').slice(0, 12);
    return `${COOLDOWN_DIR}/oauth-${hash}.cooldown`;
  }

  /**
   * Check if a service is in cooldown after a recent failure.
   * Uses file mtime for cross-process persistence.
   */
  private static isInCooldown(serviceName: string): boolean {
    try {
      const path = this.cooldownPath(serviceName);
      if (!existsSync(path)) return false;
      const mtime = statSync(path).mtimeMs;
      if (Date.now() - mtime < this.COOLDOWN_MS) return true;
      // Cooldown expired, remove file
      try { unlinkSync(path); } catch { /* ignore */ }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Record a failure for cooldown tracking (persisted to disk).
   */
  private static recordFailure(serviceName: string): void {
    try {
      if (!existsSync(COOLDOWN_DIR)) {
        mkdirSync(COOLDOWN_DIR, { recursive: true, mode: 0o700 });
      }
      writeFileSync(this.cooldownPath(serviceName), String(Date.now()), { mode: 0o600 });
    } catch { /* ignore */ }
  }

  /**
   * Clear cooldown for a service (e.g., after successful refresh).
   */
  static clearCooldown(serviceName?: string): void {
    try {
      if (serviceName) {
        const path = this.cooldownPath(serviceName);
        if (existsSync(path)) unlinkSync(path);
      } else {
        // Clear all OAuth cooldowns
        if (existsSync(COOLDOWN_DIR)) {
          const { readdirSync } = require('fs');
          for (const file of readdirSync(COOLDOWN_DIR)) {
            if (file.startsWith('oauth-') && file.endsWith('.cooldown')) {
              try { unlinkSync(`${COOLDOWN_DIR}/${file}`); } catch { /* ignore */ }
            }
          }
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Fetch usage data from Anthropic OAuth API
   *
   * Requires: OAuth token in environment (ANTHROPIC_API_KEY or from keychain)
   */
  static async fetchUsage(authProfile?: string, keychainService?: string): Promise<BillingInfo | null> {
    try {
      // Get token from environment or keychain
      const token = await this.getOAuthToken(authProfile, keychainService);
      if (!token) {
        console.error('[AnthropicOAuthAPI] No OAuth token available');
        return null;
      }

      // Fetch usage data
      const response = await fetch(this.API_ENDPOINT, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json'
        },
        signal: AbortSignal.timeout(10000) // 10s timeout
      });

      if (!response.ok) {
        // Record cooldown on auth failures to prevent retry storm
        if (response.status === 401 || response.status === 403) {
          const service = keychainService || 'api-fetch';
          this.recordFailure(service);
          console.error(`[AnthropicOAuthAPI] HTTP ${response.status}: ${response.statusText} (cooldown ${service} for 5min)`);
        } else {
          console.error(`[AnthropicOAuthAPI] HTTP ${response.status}: ${response.statusText}`);
        }
        return null;
      }

      const data: AnthropicOAuthUsageResponse = await response.json();

      // Convert to BillingInfo format
      return this.convertToBillingInfo(data);

    } catch (error) {
      console.error('[AnthropicOAuthAPI] Failed to fetch usage:', error);
      return null;
    }
  }

  /**
   * Convert OAuth API response to BillingInfo
   */
  private static convertToBillingInfo(data: AnthropicOAuthUsageResponse): BillingInfo {
    // Defensive: Validate and sanitize input data
    const costToday = Math.max(0, data.cost_usd || 0);
    const quotaLimit = Math.max(0, data.quota_limit_usd || 0);
    const quotaRemaining = Math.max(0, data.quota_remaining_usd ?? (quotaLimit - costToday));
    const budgetPercentUsed = Math.max(0, Math.min(100, data.quota_percentage_used || 0));

    // Calculate burn rate (extrapolate from current usage)
    const now = new Date();
    const hoursSinceReset = this.calculateHoursSinceReset(data.reset_time);
    const burnRatePerHour = hoursSinceReset > 0 && isFinite(costToday / hoursSinceReset)
      ? costToday / hoursSinceReset
      : 0;

    // Calculate budget remaining in minutes
    const budgetRemaining = burnRatePerHour > 0 && quotaRemaining > 0
      ? Math.floor(Math.min((quotaRemaining / burnRatePerHour) * 60, 9999)) // Cap at 9999 minutes
      : 999;

    // Parse reset time
    const resetTime = this.extractResetTime(data.reset_time);

    // Calculate weekly quota fields
    const weeklyFields = this.calculateWeeklyQuota(data);

    return {
      costToday,
      burnRatePerHour,
      budgetRemaining,
      budgetPercentUsed,
      resetTime,
      totalTokens: data.tokens_used || 0,
      tokensPerMinute: null, // Not provided by API
      isFresh: true,
      lastFetched: Date.now(),

      // Weekly quota
      ...weeklyFields
    };
  }

  /**
   * Calculate weekly quota fields from OAuth response
   */
  private static calculateWeeklyQuota(data: AnthropicOAuthUsageResponse): {
    weeklyBudgetRemaining?: number;
    weeklyBudgetPercentUsed?: number;
    weeklyResetDay?: string;
    weeklyLimitUSD?: number;
  } {
    // Defensive: Validate weekly quota data exists and is sane
    if (!data.weekly_quota_limit_usd ||
        typeof data.weekly_quota_limit_usd !== 'number' ||
        data.weekly_quota_limit_usd <= 0) {
      return {}; // No valid weekly quota data available
    }

    const weeklyLimit = data.weekly_quota_limit_usd;
    const weeklyRemaining = Math.max(0, data.weekly_quota_remaining_usd || 0);
    const weeklyPercentUsed = Math.max(0, Math.min(100, data.weekly_quota_percentage_used || 0));

    // Calculate hours until reset (assuming constant burn rate)
    const currentCost = weeklyLimit - weeklyRemaining;
    const now = new Date();
    const weeklyResetTime = data.weekly_reset_time ? new Date(data.weekly_reset_time) : null;

    let weeklyBudgetRemaining = 0;
    if (weeklyResetTime && weeklyResetTime > now) {
      const hoursUntilReset = (weeklyResetTime.getTime() - now.getTime()) / (1000 * 60 * 60);
      weeklyBudgetRemaining = Math.floor(hoursUntilReset); // Round down
    }

    // Extract day of week from reset time
    const weeklyResetDay = weeklyResetTime
      ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][weeklyResetTime.getDay()]
      : undefined;

    return {
      weeklyBudgetRemaining,
      weeklyBudgetPercentUsed: weeklyPercentUsed,
      weeklyResetDay,
      weeklyLimitUSD: weeklyLimit
    };
  }

  /**
   * Calculate hours since quota reset
   */
  private static calculateHoursSinceReset(resetTime?: string): number {
    if (!resetTime) return 0;

    try {
      const reset = new Date(resetTime);
      const now = new Date();

      // If reset is in the future, we're likely in the current period
      // Calculate from previous reset (24 hours ago)
      if (reset > now) {
        const previousReset = new Date(reset.getTime() - 24 * 60 * 60 * 1000);
        return (now.getTime() - previousReset.getTime()) / (1000 * 60 * 60);
      }

      // Reset is in the past, calculate from reset time
      return (now.getTime() - reset.getTime()) / (1000 * 60 * 60);
    } catch {
      return 0;
    }
  }

  /**
   * Extract reset time in HH:MM UTC format
   */
  private static extractResetTime(resetTime?: string): string {
    if (!resetTime) return '00:00';

    try {
      const reset = new Date(resetTime);
      const hours = reset.getUTCHours().toString().padStart(2, '0');
      const minutes = reset.getUTCMinutes().toString().padStart(2, '0');
      return `${hours}:${minutes}`;
    } catch {
      return '00:00';
    }
  }

  /**
   * Get OAuth token from environment or macOS keychain
   *
   * @param authProfile - Optional auth profile name (for legacy keychain lookup)
   * @param keychainService - Optional exact keychain service name (from KeychainResolver)
   *                          When provided, tries this entry FIRST before scanning all entries
   */
  private static async getOAuthToken(authProfile?: string, keychainService?: string): Promise<string | null> {
    // Priority 1: Environment variable
    const envToken = process.env.ANTHROPIC_API_KEY;
    if (envToken && envToken.startsWith('sk-ant-')) {
      return envToken;
    }

    // Priority 2: TARGETED keychain lookup (session-aware)
    // When keychainService is provided, we know exactly which entry belongs to this session
    if (keychainService) {
      const targeted = await this.getTargetedToken(keychainService);
      if (targeted) return targeted;
      // Targeted entry failed (expired, no refresh token) - fall through
    }

    // Priority 3: Scan all Claude Code keychain entries (legacy fallback)
    const claudeCodeToken = await this.getClaudeCodeOAuthToken();
    if (claudeCodeToken) return claudeCodeToken;

    // Priority 4: Profile-specific keychain entry (legacy)
    if (authProfile && authProfile !== 'default') {
      const profileToken = await this.getKeychainToken(authProfile);
      if (profileToken) return profileToken;
    }

    // Priority 5: Default keychain entry (legacy)
    const defaultToken = await this.getKeychainToken('default');
    if (defaultToken) return defaultToken;

    return null;
  }

  /**
   * Get token from a specific keychain entry (targeted lookup)
   * Used when we know exactly which keychain service belongs to the session.
   * Handles expiry checking and token refresh.
   */
  private static async getTargetedToken(serviceName: string): Promise<string | null> {
    // Skip if recently failed
    if (this.isInCooldown(serviceName)) {
      return null;
    }

    try {
      const { execSync } = require('child_process');

      const credJson = execSync(
        `security find-generic-password -s "${serviceName}" -w 2>/dev/null`,
        { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();

      if (!credJson) return null;

      const cred = JSON.parse(credJson);
      if (!cred.claudeAiOauth?.accessToken) return null;

      const expiresAt = cred.claudeAiOauth.expiresAt;

      // Token valid (not expired or no expiry set)
      if (!expiresAt || expiresAt > Date.now()) {
        this.clearCooldown(serviceName); // Clear any stale cooldown
        console.error(`[AnthropicOAuthAPI] Using targeted token from ${serviceName}`);
        return cred.claudeAiOauth.accessToken;
      }

      // Token expired - attempt refresh
      if (cred.claudeAiOauth.refreshToken) {
        console.error(`[AnthropicOAuthAPI] Targeted token expired, refreshing ${serviceName}...`);
        const refreshed = await this.refreshOAuthToken(
          cred.claudeAiOauth.refreshToken,
          serviceName
        );
        if (refreshed) {
          this.clearCooldown(serviceName); // Refresh succeeded
          return refreshed;
        }
      }

      // Record failure so we don't retry this service for 5 minutes
      this.recordFailure(serviceName);
      console.error(`[AnthropicOAuthAPI] Targeted token failed for ${serviceName} (cooldown 5min)`);
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Get OAuth token from Claude Code's keychain storage
   * Claude Code stores credentials under "Claude Code-credentials-{hash}" service names
   *
   * IMPORTANT: If token is expired, attempts to refresh using refresh_token
   */
  private static async getClaudeCodeOAuthToken(): Promise<string | null> {
    try {
      const { execSync } = require('child_process');

      // Find Claude Code credential entries in keychain
      const dumpOutput = execSync(
        'security dump-keychain 2>/dev/null | grep -A2 "Claude Code-credentials"',
        { encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] }
      );

      // Extract service names from dump
      const serviceMatches = dumpOutput.match(/"svce"<blob>="(Claude Code-credentials-[^"]+)"/g);
      if (!serviceMatches || serviceMatches.length === 0) {
        return null;
      }

      // Try each credential entry
      for (const match of serviceMatches) {
        const serviceName = match.match(/"svce"<blob>="([^"]+)"/)?.[1];
        if (!serviceName) continue;

        // Skip entries in cooldown (recently failed)
        if (this.isInCooldown(serviceName)) continue;

        try {
          const credJson = execSync(
            `security find-generic-password -s "${serviceName}" -w 2>/dev/null`,
            { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] }
          ).trim();

          if (credJson) {
            const cred = JSON.parse(credJson);
            if (cred.claudeAiOauth?.accessToken) {
              // Check if token is expired
              const expiresAt = cred.claudeAiOauth.expiresAt;
              if (expiresAt && expiresAt > Date.now()) {
                return cred.claudeAiOauth.accessToken;
              } else if (!expiresAt) {
                // No expiry, assume valid
                return cred.claudeAiOauth.accessToken;
              }

              // Token expired - attempt refresh
              if (cred.claudeAiOauth.refreshToken) {
                console.error(`[AnthropicOAuthAPI] Token expired, attempting refresh for ${serviceName}...`);
                const refreshedToken = await this.refreshOAuthToken(
                  cred.claudeAiOauth.refreshToken,
                  serviceName
                );
                if (refreshedToken) {
                  return refreshedToken;
                }
              }
              // Refresh failed or no refresh token — record cooldown and try next entry
              this.recordFailure(serviceName);
            }
          }
        } catch {
          // This entry didn't work, try next
          continue;
        }
      }

      return null;
    } catch (error) {
      console.error('[AnthropicOAuthAPI] Failed to get Claude Code OAuth token:', error);
      return null;
    }
  }

  /**
   * Refresh an expired OAuth token using the refresh_token
   * Updates keychain with new credentials on success
   *
   * NOTE: Anthropic OAuth refresh tokens are single-use and server-side sessions
   * may expire after extended inactivity (12+ hours). When this happens,
   * the user needs to run `claude /login` to re-authenticate.
   */
  private static async refreshOAuthToken(
    refreshToken: string,
    serviceName: string
  ): Promise<string | null> {
    try {
      // Anthropic OAuth token refresh endpoint (standard OAuth2 flow)
      const response = await fetch('https://api.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken
        }).toString(),
        signal: AbortSignal.timeout(10000)
      });

      if (!response.ok) {
        // 400/401 usually means server-side session expired
        // User needs to run `claude /login` to get fresh tokens
        this.recordFailure(serviceName);
        if (response.status === 400 || response.status === 401) {
          console.error(`[AnthropicOAuthAPI] Session expired for ${serviceName} - user needs to run: claude /login (cooldown 5min)`);
        } else {
          console.error(`[AnthropicOAuthAPI] Token refresh failed for ${serviceName}: HTTP ${response.status} (cooldown 5min)`);
        }
        return null;
      }

      const data = await response.json();

      if (!data.access_token) {
        console.error('[AnthropicOAuthAPI] No access_token in refresh response');
        return null;
      }

      // Calculate new expiry (typically 1-2 hours)
      const expiresIn = data.expires_in || 3600; // Default 1 hour
      const newExpiresAt = Date.now() + (expiresIn * 1000);

      // Update keychain with new credentials
      const updatedCreds = {
        claudeAiOauth: {
          accessToken: data.access_token,
          refreshToken: data.refresh_token || refreshToken, // Use new refresh token if provided
          expiresAt: newExpiresAt,
          scopes: data.scopes || ['user:inference', 'user:profile'],
          subscriptionType: data.subscription_type,
          rateLimitTier: data.rate_limit_tier
        }
      };

      await this.updateKeychainCredentials(serviceName, updatedCreds);
      console.error(`[AnthropicOAuthAPI] Token refreshed successfully, expires ${new Date(newExpiresAt).toISOString()}`);

      return data.access_token;
    } catch (error) {
      console.error('[AnthropicOAuthAPI] Token refresh error:', error);
      return null;
    }
  }

  /**
   * Update credentials in macOS keychain
   */
  private static async updateKeychainCredentials(
    serviceName: string,
    credentials: any
  ): Promise<boolean> {
    try {
      const { execSync } = require('child_process');
      const credJson = JSON.stringify(credentials);

      // Delete old entry and add new one (update isn't reliable)
      try {
        execSync(`security delete-generic-password -s "${serviceName}" 2>/dev/null`, {
          stdio: 'ignore',
          timeout: 2000
        });
      } catch {
        // Entry might not exist, that's fine
      }

      execSync(
        `security add-generic-password -s "${serviceName}" -a "vmks" -w '${credJson.replace(/'/g, "'\\''")}' -U`,
        {
          encoding: 'utf-8',
          stdio: 'ignore',
          timeout: 2000
        }
      );

      return true;
    } catch (error) {
      console.error('[AnthropicOAuthAPI] Failed to update keychain:', error);
      return false;
    }
  }

  /**
   * Get token from macOS keychain (legacy method)
   */
  private static async getKeychainToken(profileId: string): Promise<string | null> {
    try {
      const { execSync } = require('child_process');

      // Use security command to read from keychain
      // User should store tokens with: security add-generic-password -s "claude-code" -a "work" -w "sk-ant-..."
      const token = execSync(
        `security find-generic-password -s "claude-code" -a "${profileId}" -w 2>/dev/null`,
        {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
          timeout: 2000
        }
      ).trim();

      return token || null;
    } catch {
      return null;
    }
  }

  /**
   * Test if OAuth API is accessible
   */
  static async testConnection(): Promise<boolean> {
    try {
      const billing = await this.fetchUsage();
      return billing !== null && billing.isFresh;
    } catch {
      return false;
    }
  }
}
