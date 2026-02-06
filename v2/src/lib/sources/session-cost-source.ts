/**
 * Session Cost Source — Tier 2 (per-session)
 *
 * Calculates cost of THIS specific session from transcript parsing.
 * Separate from account billing (Tier 3) — this is local per-session data.
 * Always runs if transcript exists.
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth } from '../../types/session-health';
import { LocalCostCalculator } from '../local-cost-calculator';
import { existsSync } from 'fs';

export interface SessionCostData {
  sessionCost: number;
  sessionTokens: number;
  sessionBurnRate: number;
  calculated: boolean;
}

export const sessionCostSource: DataSourceDescriptor<SessionCostData> = {
  id: 'session_cost',
  tier: 2,
  freshnessCategory: 'transcript', // Same freshness as transcript data
  timeoutMs: 5000,

  async fetch(ctx: GatherContext): Promise<SessionCostData> {
    if (!ctx.transcriptPath || !existsSync(ctx.transcriptPath)) {
      return { sessionCost: 0, sessionTokens: 0, sessionBurnRate: 0, calculated: false };
    }

    try {
      const cost = await LocalCostCalculator.calculateCost(ctx.transcriptPath);
      return {
        sessionCost: cost.costUSD || 0,
        sessionTokens: cost.totalTokens || 0,
        sessionBurnRate: cost.costPerHour || 0,
        calculated: true,
      };
    } catch {
      return { sessionCost: 0, sessionTokens: 0, sessionBurnRate: 0, calculated: false };
    }
  },

  merge(target: SessionHealth, data: SessionCostData): void {
    if (data.calculated) {
      target.billing.sessionCost = data.sessionCost;
      target.billing.sessionTokens = data.sessionTokens;
      target.billing.sessionBurnRate = data.sessionBurnRate;
    }
  },
};

export default sessionCostSource;
