/**
 * Cost Wrapper Module - Formats ccusage data for cost display
 *
 * NO ccusage call - uses data from ccusage-shared-module
 * Displays: 💰:$40.30|$15.10/h
 */

import type { CCUsageData } from './ccusage-shared-module';

class CostWrapperModule {
  readonly moduleId = 'costWrapper';

  format(data: CCUsageData | null): string {
    if (!data || !data.isFresh || data.costUSD === 0) {
      return '';  // Don't show if no data
    }

    const cost = this.formatCost(data.costUSD);

    // V1 parity: Don't show burn rate if null/0 (show only cost)
    if (!data.costPerHour || data.costPerHour === 0) {
      return `💰:${cost}`;
    }

    const burnRate = this.formatCost(data.costPerHour);
    const stale = data.isFresh ? '' : '🔴';  // Staleness indicator

    return `💰:${cost}|${burnRate}/h${stale}`;
  }

  private formatCost(costUSD: number): string {
    if (costUSD >= 100) {
      return `$${costUSD.toFixed(0)}`;
    } else if (costUSD >= 10) {
      return `$${costUSD.toFixed(1)}`;
    } else {
      return `$${costUSD.toFixed(2)}`;
    }
  }
}

export default CostWrapperModule;
