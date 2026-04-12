/**
 * Quota Source — Tier 3 (global, shared cache)
 *
 * Reads weekly/daily quota from the 3-tier fallback:
 *   1. QuotaBrokerClient (merged-quota-cache.json)
 *   2. HotSwapQuotaReader (hot-swap-quota.json)
 *   3. SubscriptionReader (subscription.yaml)
 *
 * Read-only consumer — the broker is the sole writer.
 * No auto-refresh (removed — it used the wrong keychain token).
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth } from '../../types/session-health';
import { QuotaBrokerClient } from '../quota-broker-client';
import { HotSwapQuotaReader } from '../hot-swap-quota-reader';
import { SubscriptionReader } from '../subscription-reader';
import { NotificationManager } from '../notification-manager';
import { redactEmail } from '../sanitize';

export interface QuotaSourceData {
  weeklyBudgetRemaining?: number;
  weeklyBudgetPercentUsed?: number;
  weeklyResetDay?: string;
  weeklyDataStale?: boolean;
  weeklyLastModified?: number;
  dailyPercentUsed?: number;
  dailyResetAt?: string;  // ISO timestamp of 5h window reset — if in the past, dailyPercentUsed is stale
  sessionPercentUsed?: number;
  slotStatus?: string;  // 'active' | 'inactive' — inactive slots are expected stale
  source: 'broker' | 'hotswap' | 'oauth' | 'subscription' | 'none';
  fetchedAt: number;
}

export const quotaSource: DataSourceDescriptor<QuotaSourceData> = {
  id: 'quota',
  tier: 3,
  freshnessCategory: 'quota_broker',
  timeoutMs: 1000, // File reads only

  async fetch(ctx: GatherContext): Promise<QuotaSourceData> {
    const configDir = ctx.configDir || undefined;
    const keychainService = ctx.keychainService || undefined;
    const authEmail = ctx.authEmail || undefined;
    const fetchedAt = Date.now();

    // Strategy 1: QuotaBrokerClient (primary)
    if (QuotaBrokerClient.isAvailable()) {
      const brokerQuota = QuotaBrokerClient.getActiveQuota(configDir, keychainService, authEmail);
      if (brokerQuota) {
        return {
          weeklyBudgetRemaining: brokerQuota.weeklyBudgetRemaining,
          weeklyBudgetPercentUsed: brokerQuota.weeklyPercentUsed,
          weeklyResetDay: brokerQuota.weeklyResetDay,
          weeklyDataStale: brokerQuota.isStale,
          weeklyLastModified: brokerQuota.lastFetched,
          dailyPercentUsed: brokerQuota.dailyPercentUsed > 0
            ? brokerQuota.dailyPercentUsed
            : undefined,
          dailyResetAt: brokerQuota.dailyResetAt,
          slotStatus: brokerQuota.slotStatus,
          source: 'broker',
          fetchedAt,
        };
      }
    }

    // Strategy 2: HotSwapQuotaReader (fallback)
    const hotSwapQuota = HotSwapQuotaReader.getActiveQuota(configDir);
    if (hotSwapQuota) {
      return {
        weeklyBudgetRemaining: hotSwapQuota.weeklyBudgetRemaining,
        weeklyBudgetPercentUsed: hotSwapQuota.weeklyPercentUsed,
        weeklyResetDay: hotSwapQuota.weeklyResetDay,
        weeklyDataStale: hotSwapQuota.isStale,
        weeklyLastModified: hotSwapQuota.lastFetched,
        dailyPercentUsed: hotSwapQuota.dailyPercentUsed > 0
          ? hotSwapQuota.dailyPercentUsed
          : undefined,
        source: 'hotswap',
        fetchedAt,
      };
    }

    // Strategy 3: subscription.yaml
    const subscriptionQuota = SubscriptionReader.getWeeklyQuota();
    if (subscriptionQuota) {
      const sessionQuota = SubscriptionReader.getCurrentSessionQuota();
      return {
        weeklyBudgetRemaining: subscriptionQuota.hoursRemaining,
        weeklyBudgetPercentUsed: subscriptionQuota.percentUsed,
        weeklyResetDay: subscriptionQuota.resetDay,
        weeklyDataStale: subscriptionQuota.isStale,
        weeklyLastModified: subscriptionQuota.lastModified,
        sessionPercentUsed: sessionQuota?.percentUsed || undefined,
        source: 'subscription',
        fetchedAt,
      };
    }

    return { source: 'none', fetchedAt };
  },

  merge(target: SessionHealth, data: QuotaSourceData): void {
    if (data.source === 'none') return;

    if (data.weeklyBudgetRemaining !== undefined) {
      target.billing.weeklyBudgetRemaining = data.weeklyBudgetRemaining;
    }
    if (data.weeklyBudgetPercentUsed !== undefined) {
      target.billing.weeklyBudgetPercentUsed = data.weeklyBudgetPercentUsed;
    }
    if (data.weeklyResetDay !== undefined) {
      target.billing.weeklyResetDay = data.weeklyResetDay;
    }
    if (data.weeklyDataStale !== undefined) {
      target.billing.weeklyDataStale = data.weeklyDataStale;
    }
    if (data.weeklyLastModified !== undefined) {
      target.billing.weeklyLastModified = data.weeklyLastModified;
    }
    if (data.dailyPercentUsed !== undefined) {
      // Detect past reset: if dailyResetAt is in the past, the 5h window already
      // reset and the displayed percentage is from a previous window (meaningless).
      // Mark as stale so user sees "data outdated" instead of a phantom number.
      if (data.dailyResetAt) {
        const resetEpoch = new Date(data.dailyResetAt).getTime();
        if (!isNaN(resetEpoch) && resetEpoch < Date.now()) {
          // 5h window already reset — don't show stale percentage
          data.weeklyDataStale = true;
          NotificationManager.register(
            'quota_reset_passed',
            `⚠ 5h quota window reset — data outdated, waiting for refresh`,
            7
          );
        } else {
          NotificationManager.remove('quota_reset_passed');
        }
      }
      target.billing.budgetPercentUsed = data.dailyPercentUsed;
    }
    if (data.sessionPercentUsed !== undefined) {
      target.billing.budgetPercentUsed = data.sessionPercentUsed;
    }

    // Staleness notification: alert when data is stale AND refresh is likely broken
    // Skip for inactive slots — their staleness is expected (broker skips inactive accounts)
    if (data.weeklyDataStale && data.weeklyLastModified && data.slotStatus !== 'inactive') {
      const ageMin = Math.round((Date.now() - data.weeklyLastModified) / 60000);
      if (ageMin > 30) {
        NotificationManager.register(
          'quota_stale',
          `⚠ Quota Data Stale: data ${ageMin}min old. Check launchd: launchctl list | grep claude. Log: ~/.claude/session-health/quota-refresh-error.log`,
          9
        );
      } else {
        NotificationManager.remove('quota_stale');
      }
    } else {
      // Data is fresh OR slot is inactive — remove stale notification
      NotificationManager.remove('quota_stale');
    }
  },
};

export default quotaSource;
