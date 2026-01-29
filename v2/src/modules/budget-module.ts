/**
 * Budget Module - Billing Period Tracking
 *
 * Displays: ⌛:1h53m(62%)14:00
 * Format: hours_left minutes_left (percentage_used%) reset_time_HH:MM
 */

import type { DataModule, DataModuleConfig, ValidationResult } from '../types/data-module';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

interface BudgetData {
  hoursLeft: number;
  minutesLeft: number;
  percentageUsed: number;
  resetTime: string;  // HH:MM format
  startTime?: Date;
  endTime?: Date;
  isStale?: boolean;
}

class BudgetModule implements DataModule<BudgetData> {
  readonly moduleId = 'budget';

  config: DataModuleConfig = {
    timeout: 35000,  // ccusage can take 20-30s
    cacheTTL: 900000  // 15 min cache (same as cost)
  };

  async fetch(sessionId: string): Promise<BudgetData> {
    try {
      const { stdout } = await execAsync('ccusage blocks --json --active', {
        timeout: this.config.timeout
      });

      const data = JSON.parse(stdout);
      const activeBlock = data.blocks?.find((b: any) => b.isActive === true);

      if (!activeBlock) {
        return this.getDefaultData();
      }

      const resetTimeStr = activeBlock.usageLimitResetTime || activeBlock.endTime;
      const startTimeStr = activeBlock.startTime;

      if (!resetTimeStr || !startTimeStr) {
        return this.getDefaultData();
      }

      const startTime = new Date(startTimeStr);
      const endTime = new Date(resetTimeStr);
      const now = new Date();

      // Calculate elapsed and remaining
      const totalMs = endTime.getTime() - startTime.getTime();
      const elapsedMs = now.getTime() - startTime.getTime();
      const remainingMs = Math.max(0, endTime.getTime() - now.getTime());

      const percentageUsed = Math.min(100, Math.floor((elapsedMs / totalMs) * 100));

      // Convert remaining to hours and minutes
      const hoursLeft = Math.floor(remainingMs / (1000 * 60 * 60));
      const minutesLeft = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));

      // Format reset time as HH:MM
      const resetTime = `${String(endTime.getUTCHours()).padStart(2, '0')}:${String(endTime.getUTCMinutes()).padStart(2, '0')}`;

      return {
        hoursLeft,
        minutesLeft,
        percentageUsed,
        resetTime,
        startTime,
        endTime,
        isStale: false
      };
    } catch (error) {
      return this.getDefaultData();
    }
  }

  private getDefaultData(): BudgetData {
    return {
      hoursLeft: 0,
      minutesLeft: 0,
      percentageUsed: 0,
      resetTime: '00:00',
      isStale: true
    };
  }

  validate(data: BudgetData): ValidationResult {
    if (!data || data.isStale) {
      return {
        valid: false,
        confidence: 0,
        errors: ['Budget data unavailable or stale']
      };
    }

    if (data.percentageUsed < 0 || data.percentageUsed > 100) {
      return {
        valid: false,
        confidence: 0,
        errors: ['Invalid percentage']
      };
    }

    return {
      valid: true,
      confidence: 100,
      warnings: []
    };
  }

  format(data: BudgetData): string {
    if (!data || data.isStale || (data.hoursLeft === 0 && data.minutesLeft === 0 && data.percentageUsed === 0)) {
      return '';  // Don't show if no budget data
    }

    // Format: 1h53m(62%)14:00
    const staleness = data.isStale ? '🔴' : '';
    return `⌛:${data.hoursLeft}h${data.minutesLeft}m(${data.percentageUsed}%)${data.resetTime}${staleness}`;
  }
}

export default BudgetModule;
export { BudgetData };
