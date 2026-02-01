/**
 * Anthropic OAuth Usage API - Authoritative quota source
 *
 * Endpoint: https://api.anthropic.com/api/oauth/usage
 * Returns exact quota percentages and reset times
 *
 * This is the AUTHORITATIVE source for billing data, replacing ccusage estimates.
 */

import { BillingInfo } from '../types/session-health';

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

  /**
   * Fetch usage data from Anthropic OAuth API
   *
   * Requires: OAuth token in environment (ANTHROPIC_API_KEY or from keychain)
   */
  static async fetchUsage(authProfile?: string): Promise<BillingInfo | null> {
    try {
      // Get token from environment or keychain
      const token = await this.getOAuthToken(authProfile);
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
        console.error(`[AnthropicOAuthAPI] HTTP ${response.status}: ${response.statusText}`);
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
   */
  private static async getOAuthToken(authProfile?: string): Promise<string | null> {
    // Priority 1: Environment variable
    const envToken = process.env.ANTHROPIC_API_KEY;
    if (envToken && envToken.startsWith('sk-ant-')) {
      return envToken;
    }

    // Priority 2: Claude Code's OAuth token from keychain
    const claudeCodeToken = await this.getClaudeCodeOAuthToken();
    if (claudeCodeToken) return claudeCodeToken;

    // Priority 3: Profile-specific keychain entry (legacy)
    if (authProfile && authProfile !== 'default') {
      const profileToken = await this.getKeychainToken(authProfile);
      if (profileToken) return profileToken;
    }

    // Priority 4: Default keychain entry (legacy)
    const defaultToken = await this.getKeychainToken('default');
    if (defaultToken) return defaultToken;

    return null;
  }

  /**
   * Get OAuth token from Claude Code's keychain storage
   * Claude Code stores credentials under "Claude Code-credentials-{hash}" service names
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
              // Token expired, try next entry
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
