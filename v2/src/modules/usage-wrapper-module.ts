/**
 * Usage Wrapper Module - Formats ccusage data for usage display
 *
 * NO ccusage call - uses data from ccusage-shared-module
 * Displays: 📊:83.4Mtok(521ktpm)
 */

import type { CCUsageData } from './ccusage-shared-module';

class UsageWrapperModule {
  readonly moduleId = 'usageWrapper';

  format(data: CCUsageData | null): string {
    if (!data || !data.isFresh || data.totalTokens === 0) {
      return '';  // Don't show if no data
    }

    const tokens = this.formatTokens(data.totalTokens);
    const tpm = data.tokensPerMinute ? this.formatTokens(data.tokensPerMinute) : null;
    const stale = data.isFresh ? '' : '🔴';  // Staleness indicator

    let output = `📊:${tokens}tok`;
    if (tpm) {
      output += `(${tpm}tpm)`;
    }
    output += stale;

    return output;
  }

  private formatTokens(tokens: number): string {
    let smoothed = tokens;

    if (tokens >= 10000000) {
      smoothed = Math.round(tokens / 10000000) * 10000000;
    } else if (tokens >= 1000000) {
      smoothed = Math.round(tokens / 1000000) * 1000000;
    } else if (tokens >= 1000) {
      smoothed = Math.round(tokens / 100) * 100;
    }

    if (smoothed >= 1000000) {
      const millions = smoothed / 1000000;
      return `${millions.toFixed(1)}M`;
    } else if (smoothed >= 1000) {
      const thousands = Math.floor(smoothed / 1000);
      return `${thousands}k`;
    }

    return String(smoothed);
  }
}

export default UsageWrapperModule;
