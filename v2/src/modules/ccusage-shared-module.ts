/**
 * Shared ccusage Module - Single Source for Cost/Budget/Usage
 *
 * CRITICAL: This module is called ONCE and provides data for:
 * - CostModule (💰)
 * - BudgetModule (⌛)
 * - UsageModule (📊)
 *
 * This prevents 3 concurrent ccusage calls!
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';
import type { ValidationResult } from '../types/validation';
import { promisify } from 'util';
import { exec } from 'child_process';
import ProcessLock from '../lib/process-lock';

const execAsync = promisify(exec);
const ccusageLock = new ProcessLock({
  lockPath: `${process.env.HOME}/.claude/.ccusage.lock`,
  timeout: 35000,
  retryInterval: 100,
  maxRetries: 3
});

interface CCUsageData {
  // Raw block data
  blockId: string;
  startTime: Date;
  endTime: Date;
  isActive: boolean;

  // Cost data
  costUSD: number;
  costPerHour: number | null;

  // Budget data
  hoursLeft: number;
  minutesLeft: number;
  percentageUsed: number;
  resetTime: string;  // HH:MM format

  // Usage data
  totalTokens: number;
  tokensPerMinute: number | null;

  // Metadata
  isFresh: boolean;  // false if fetch failed
}

class CCUsageSharedModule implements DataModule<CCUsageData> {
  readonly moduleId = 'ccusage';  // Single module ID

  config: DataModuleConfig = {
    timeout: 35000,      // 35s (ccusage can take 20-30s)
    cacheTTL: 900000     // 15 min cache
  };

  async fetch(sessionId: string): Promise<CCUsageData> {
    // CRITICAL: Acquire system-wide lock to prevent concurrent ccusage spawns
    const result = await ccusageLock.withLock(async () => {
      try {
        const { stdout } = await execAsync('ccusage blocks --json --active', {
          timeout: this.config.timeout,
          killSignal: 'SIGKILL',  // Force kill on timeout to prevent orphans
          maxBuffer: 1024 * 1024  // 1MB max output
        });

        return JSON.parse(stdout);
      } catch (error) {
        // Log to daemon log for observability
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[CCUsageSharedModule] ccusage failed: ${msg}`);
        return null;
      }
    });

    // Lock acquisition failed or ccusage failed
    if (!result) {
      return this.getDefaultData();
    }

    try {
      const activeBlock = result.blocks?.find((b: any) => b.isActive === true);

      if (!activeBlock) {
        return this.getDefaultData();
      }

      // VALIDATION: Ensure required fields exist and are correct types
      if (typeof activeBlock.costUSD !== 'number' && activeBlock.costUSD !== undefined) {
        console.error('[CCUsageSharedModule] costUSD is not a number:', typeof activeBlock.costUSD);
        return this.getDefaultData();
      }

      // Extract all data from single ccusage call (with validation)
      const costUSD = Math.max(0, Number(activeBlock.costUSD) || 0);
      const costPerHour = activeBlock.burnRate?.costPerHour != null
        ? Math.max(0, Number(activeBlock.burnRate.costPerHour))
        : null;

      const totalTokens = Math.max(0, Number(activeBlock.totalTokens) || 0);
      const tokensPerMinute = activeBlock.burnRate?.tokensPerMinute != null
        ? Math.max(0, Number(activeBlock.burnRate.tokensPerMinute))
        : null;

      // NOTE: usageLimitResetTime is often null in ccusage output, fallback to endTime
      const resetTimeStr = activeBlock.usageLimitResetTime || activeBlock.endTime;
      const startTimeStr = activeBlock.startTime;

      let hoursLeft = 0;
      let minutesLeft = 0;
      let percentageUsed = 0;
      let resetTime = '00:00';

      if (resetTimeStr && startTimeStr) {
        const startTime = new Date(startTimeStr);
        const endTime = new Date(resetTimeStr);
        const now = new Date();

        // VALIDATION: Check for valid dates
        if (isNaN(startTime.getTime()) || isNaN(endTime.getTime())) {
          console.error('[CCUsageSharedModule] Invalid date strings:', { startTimeStr, resetTimeStr });
          return this.getDefaultData();
        }

        const totalMs = endTime.getTime() - startTime.getTime();
        const elapsedMs = now.getTime() - startTime.getTime();
        const remainingMs = Math.max(0, endTime.getTime() - now.getTime());

        // VALIDATION: Prevent division by zero and cap percentage
        if (totalMs > 0) {
          percentageUsed = Math.min(100, Math.max(0, Math.floor((elapsedMs / totalMs) * 100)));
        }

        // VALIDATION: Ensure non-negative time values
        hoursLeft = Math.max(0, Math.floor(remainingMs / (1000 * 60 * 60)));
        minutesLeft = Math.max(0, Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60)));
        resetTime = `${String(endTime.getUTCHours()).padStart(2, '0')}:${String(endTime.getUTCMinutes()).padStart(2, '0')}`;
      }

      return {
        // FIX: ccusage uses 'id' not 'blockId'
        blockId: activeBlock.id || '',
        startTime: new Date(startTimeStr),
        endTime: new Date(resetTimeStr),
        isActive: true,
        costUSD,
        costPerHour,
        hoursLeft,
        minutesLeft,
        percentageUsed,
        resetTime,
        totalTokens,
        tokensPerMinute,
        isFresh: true
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('[CCUsageSharedModule] Parse error:', msg);
      return this.getDefaultData();
    }
  }

  private getDefaultData(): CCUsageData {
    return {
      blockId: '',
      startTime: new Date(),
      endTime: new Date(),
      isActive: false,
      costUSD: 0,
      costPerHour: null,
      hoursLeft: 0,
      minutesLeft: 0,
      percentageUsed: 0,
      resetTime: '00:00',
      totalTokens: 0,
      tokensPerMinute: null,
      isFresh: false
    };
  }

  validate(data: CCUsageData): ValidationResult {
    if (!data || !data.isFresh) {
      return {
        valid: false,
        confidence: 0,
        errors: ['ccusage data unavailable']
      };
    }

    return {
      valid: true,
      confidence: 100,
      warnings: []
    };
  }

  format(data: CCUsageData): string {
    // This module doesn't format - individual modules will
    return '';
  }

  // Helper methods for individual modules to use
  formatCost(costUSD: number): string {
    if (costUSD >= 100) {
      return `$${costUSD.toFixed(0)}`;
    } else if (costUSD >= 10) {
      return `$${costUSD.toFixed(1)}`;
    } else {
      return `$${costUSD.toFixed(2)}`;
    }
  }

  formatTokens(tokens: number): string {
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

export default CCUsageSharedModule;
export { CCUsageData };
