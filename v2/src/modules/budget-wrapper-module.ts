/**
 * Budget Wrapper Module - Formats ccusage data for budget display
 *
 * NO ccusage call - uses data from ccusage-shared-module
 * Displays: ⌛:1h53m(62%)14:00
 */

import type { CCUsageData } from './ccusage-shared-module';

class BudgetWrapperModule {
  readonly moduleId = 'budgetWrapper';

  format(data: CCUsageData | null): string {
    if (!data || !data.isFresh || (data.hoursLeft === 0 && data.minutesLeft === 0)) {
      return '';  // Don't show if no data
    }

    return `⌛:${data.hoursLeft}h${data.minutesLeft}m(${data.percentageUsed}%)${data.resetTime}`;
  }
}

export default BudgetWrapperModule;
