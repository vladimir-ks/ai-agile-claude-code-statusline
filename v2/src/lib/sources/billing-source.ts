/**
 * Billing Source — Tier 3 (global, shared cache)
 *
 * Orchestrates the 3-tier billing fallback:
 *   1. OAuth API (authoritative, has weekly quota)
 *   2. ccusage CLI (shared cache, cross-session)
 *   3. Local cost calculation (transcript parsing)
 *
 * Single-flight coordinated: only one daemon refreshes at a time.
 * Time-budget aware: respects ctx.deadline.
 *
 * Also handles session-specific cost calculation (always runs).
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { BillingInfo, SessionHealth } from '../../types/session-health';
import { AnthropicOAuthAPI } from '../../modules/anthropic-oauth-api';
import CCUsageSharedModule from '../../modules/ccusage-shared-module';
import { LocalCostCalculator } from '../local-cost-calculator';
import { HotSwapQuotaReader } from '../hot-swap-quota-reader';
import { FreshnessManager } from '../freshness-manager';
import { DebugStateWriter } from '../debug-state-writer';
import { sanitizeError, redactEmail } from '../sanitize';
import { existsSync } from 'fs';

const ccusageModule = new CCUsageSharedModule({
  id: 'ccusage',
  name: 'CCUsage Module',
  enabled: true,
  cacheTTL: 120000,
  timeout: 25000,
});

export interface BillingSourceData {
  billing: BillingInfo;
  source: 'oauth' | 'ccusage' | 'local' | 'stale' | 'none';
  fetchedAt: number;
}

export const billingSource: DataSourceDescriptor<BillingSourceData> = {
  id: 'billing',
  tier: 3,
  freshnessCategory: 'billing_oauth',
  timeoutMs: 20000, // Billing is the slowest source

  async fetch(ctx: GatherContext): Promise<BillingSourceData> {
    const fetchedAt = Date.now();
    const configDir = ctx.configDir;

    // Check slot status for OAuth skip logic
    const slotStatus = configDir
      ? HotSwapQuotaReader.getSlotStatus(
          HotSwapQuotaReader.getSlotByConfigDir(configDir)?.slotId || ''
        )
      : 'unknown';

    // Attempt 1: OAuth API
    if (slotStatus !== 'inactive') {
      const oauthStart = Date.now();
      try {
        const oauthBilling = await AnthropicOAuthAPI.fetchUsage(
          ctx.existingHealth?.launch?.authProfile,
          ctx.keychainService || undefined
        );

        DebugStateWriter.recordFetch({
          category: 'billing_oauth',
          timestamp: oauthStart,
          success: !!(oauthBilling && oauthBilling.isFresh),
          durationMs: Date.now() - oauthStart,
        });

        if (oauthBilling && oauthBilling.isFresh) {
          return { billing: oauthBilling, source: 'oauth', fetchedAt };
        }
      } catch (err) {
        DebugStateWriter.recordFetch({
          category: 'billing_oauth',
          timestamp: oauthStart,
          success: false,
          durationMs: Date.now() - oauthStart,
          error: sanitizeError(err),
        });
      }
    }

    // Attempt 2: ccusage CLI
    const ccusageStart = Date.now();
    try {
      const billingData = await ccusageModule.fetch(ctx.sessionId || '');

      if (billingData && billingData.isFresh) {
        DebugStateWriter.recordFetch({
          category: 'billing_ccusage',
          timestamp: ccusageStart,
          success: true,
          durationMs: Date.now() - ccusageStart,
        });
        return {
          billing: createBillingFromCcusage(billingData, true),
          source: 'ccusage',
          fetchedAt,
        };
      }

      DebugStateWriter.recordFetch({
        category: 'billing_ccusage',
        timestamp: ccusageStart,
        success: false,
        durationMs: Date.now() - ccusageStart,
      });

      // Attempt 3: Local cost calculation
      const transcriptPath = ctx.transcriptPath;
      if (transcriptPath && existsSync(transcriptPath)) {
        const localStart = Date.now();
        try {
          const localCost = await LocalCostCalculator.calculateCost(transcriptPath);
          if (localCost && localCost.isFresh && localCost.costUSD > 0) {
            const totalMinutes = billingData
              ? (billingData.hoursLeft || 0) * 60 + (billingData.minutesLeft || 0)
              : (ctx.existingHealth?.billing?.budgetRemaining || 0);

            DebugStateWriter.recordFetch({
              category: 'billing_local',
              timestamp: localStart,
              success: true,
              durationMs: Date.now() - localStart,
            });

            return {
              billing: {
                costToday: localCost.costUSD,
                burnRatePerHour: localCost.costPerHour || 0,
                budgetRemaining: totalMinutes,
                budgetPercentUsed: billingData?.percentageUsed ||
                  ctx.existingHealth?.billing?.budgetPercentUsed || 0,
                resetTime: billingData?.resetTime ||
                  ctx.existingHealth?.billing?.resetTime || '',
                totalTokens: localCost.totalTokens || 0,
                tokensPerMinute: localCost.tokensPerMinute || null,
                isFresh: true,
                lastFetched: localCost.lastFetched,
              },
              source: 'local',
              fetchedAt,
            };
          }
        } catch (localErr) {
          DebugStateWriter.recordFetch({
            category: 'billing_local',
            timestamp: localStart,
            success: false,
            durationMs: Date.now() - localStart,
            error: sanitizeError(localErr),
          });
        }
      }

      // Fallback: stale ccusage data
      if (billingData && billingData.costUSD >= 0) {
        return {
          billing: createBillingFromCcusage(billingData, false),
          source: 'stale',
          fetchedAt,
        };
      }
    } catch (err) {
      DebugStateWriter.recordFetch({
        category: 'billing_ccusage',
        timestamp: ccusageStart,
        success: false,
        durationMs: Date.now() - ccusageStart,
        error: sanitizeError(err),
      });
    }

    // Final fallback: stale existing health
    if (ctx.existingHealth?.billing?.costToday > 0) {
      return {
        billing: { ...ctx.existingHealth.billing, isFresh: false },
        source: 'stale',
        fetchedAt,
      };
    }

    // Nothing available
    return {
      billing: {
        costToday: 0,
        burnRatePerHour: 0,
        budgetRemaining: 0,
        budgetPercentUsed: 0,
        resetTime: '',
        isFresh: false,
        lastFetched: 0,
      },
      source: 'none',
      fetchedAt,
    };
  },

  merge(target: SessionHealth, data: BillingSourceData): void {
    target.billing = {
      ...target.billing,
      ...data.billing,
    };
  },
};

/**
 * Create BillingInfo from ccusage module data.
 */
function createBillingFromCcusage(billingData: any, isFresh: boolean): BillingInfo {
  const totalMinutes = (billingData.hoursLeft || 0) * 60 + (billingData.minutesLeft || 0);
  return {
    costToday: billingData.costUSD || 0,
    burnRatePerHour: billingData.costPerHour || 0,
    budgetRemaining: totalMinutes,
    budgetPercentUsed: billingData.percentageUsed || 0,
    resetTime: billingData.resetTime || '',
    totalTokens: billingData.totalTokens || 0,
    tokensPerMinute: billingData.tokensPerMinute || null,
    isFresh,
    lastFetched: billingData.lastFetched || Date.now(),
  };
}

// Export for testing
export { createBillingFromCcusage };

export default billingSource;
