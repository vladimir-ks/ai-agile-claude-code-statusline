/**
 * Cost Module - Claude Usage Billing Data
 *
 * Data Source: ccusage CLI (blocks command)
 * Refresh: Every 3 minutes (180000ms)
 * Session-Specific: NO (shared across all sessions)
 *
 * Responsibilities:
 * - Fetch current 5-hour billing block data
 * - Extract cost, burn rate, tokens per minute
 * - Calculate time remaining in block
 * - Validate cost data is reasonable
 *
 * CRITICAL: This is EXPENSIVE (20+ seconds), must use:
 * - Aggressive caching (15min TTL)
 * - Fetch deduplication (only 1 fetch for 15 parallel sessions)
 * - Shared cache key ("cost:shared")
 */

import { DataModule, ModuleConfig, ValidationResult } from '../types';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface CostData {
  blockId: string;
  startTime: Date;
  endTime: Date;
  actualEndTime: Date | null;
  isActive: boolean;
  costUSD: number;
  totalTokens: number;
  burnRate: {
    costPerHour: number;
    tokensPerMinute: number;
  } | null;
  projection: {
    totalCost: number;
    remainingMinutes: number;
  } | null;
  hoursRemaining: number;
  percentageComplete: number;
}

class CostModule implements DataModule<CostData> {
  readonly moduleId = 'cost';

  config: ModuleConfig = {
    refreshInterval: 180000,      // 3 minutes
    cacheTTL: 900000,              // 15 minutes
    stalenessThreshold: 3600000,   // 1 hour
    timeout: 35000,                // 35 seconds (ccusage can take 20-30s)
    maxRetries: 1,                 // Only 1 retry (expensive)
    maxConcurrent: 1               // Only 1 concurrent fetch
  };

  /**
   * Fetch cost data from ccusage CLI
   *
   * CRITICAL: Use shared cache key to prevent duplicate fetches
   */
  async fetch(sessionId: string): Promise<CostData> {
    // STEP 1: Execute ccusage command with timeout
    const command = 'ccusage blocks --json --active';
    const { stdout } = await execAsync(command, {
      timeout: this.config.timeout,
      env: process.env
    });

    // STEP 2: Parse JSON output
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new Error(`Failed to parse ccusage output: ${err.message}`);
    }

    // STEP 3: Extract active block
    const blocks = parsed.blocks || [];
    const activeBlock = blocks.find(b => b.isActive === true);

    if (!activeBlock) {
      throw new Error('No active billing block found');
    }

    // STEP 4: Extract fields
    const blockId = activeBlock.id;
    const startTime = new Date(activeBlock.startTime);
    const endTime = new Date(activeBlock.endTime);
    const actualEndTime = activeBlock.actualEndTime
      ? new Date(activeBlock.actualEndTime)
      : null;
    const isActive = activeBlock.isActive;
    const costUSD = activeBlock.costUSD || 0;
    const totalTokens = activeBlock.totalTokens || 0;

    // STEP 5: Extract burn rate (may be null if no activity)
    const burnRate = activeBlock.burnRate
      ? {
          costPerHour: activeBlock.burnRate.costPerHour || 0,
          tokensPerMinute: activeBlock.burnRate.tokensPerMinute || 0
        }
      : null;

    // STEP 6: Extract projection
    const projection = activeBlock.projection
      ? {
          totalCost: activeBlock.projection.totalCost || 0,
          remainingMinutes: activeBlock.projection.remainingMinutes || 0
        }
      : null;

    // STEP 7: Calculate time remaining
    const now = Date.now();
    const endTimestamp = endTime.getTime();
    const remainingMs = Math.max(0, endTimestamp - now);
    const hoursRemaining = remainingMs / (1000 * 60 * 60);

    // STEP 8: Calculate percentage complete
    const totalDuration = endTime.getTime() - startTime.getTime();
    const elapsed = now - startTime.getTime();
    const percentageComplete = totalDuration > 0
      ? Math.min(100, Math.floor((elapsed / totalDuration) * 100))
      : 0;

    // STEP 9: Return structured data
    return {
      blockId,
      startTime,
      endTime,
      actualEndTime,
      isActive,
      costUSD,
      totalTokens,
      burnRate,
      projection,
      hoursRemaining,
      percentageComplete
    };
  }

  /**
   * Validate cost data
   *
   * Rules:
   * - Cost must be non-negative
   * - Burn rate must be non-negative
   * - Timestamps must be valid dates
   * - End time must be after start time
   * - Percentage complete must be 0-100
   */
  validate(data: CostData): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Rule 1: Cost must be non-negative
    if (data.costUSD < 0) {
      errors.push(`Cost cannot be negative: $${data.costUSD}`);
    }

    // Rule 2: Total tokens must be non-negative
    if (data.totalTokens < 0) {
      errors.push(`Total tokens cannot be negative: ${data.totalTokens}`);
    }

    // Rule 3: Burn rate validation (if present)
    if (data.burnRate) {
      if (data.burnRate.costPerHour < 0) {
        errors.push(`Burn rate cannot be negative: $${data.burnRate.costPerHour}/h`);
      }

      if (data.burnRate.tokensPerMinute < 0) {
        errors.push(`TPM cannot be negative: ${data.burnRate.tokensPerMinute}`);
      }

      // Sanity check: cost/hour vs tokens/min ratio
      // Typical ratio: ~$3-5 per 1M tokens
      // If ratio is >$100/1M tokens, something is wrong
      if (data.burnRate.tokensPerMinute > 0) {
        const tokensPerHour = data.burnRate.tokensPerMinute * 60;
        const costPer1MTokens = (data.burnRate.costPerHour / tokensPerHour) * 1000000;

        if (costPer1MTokens > 100) {
          warnings.push(
            `Unusual cost/token ratio: $${costPer1MTokens.toFixed(2)} per 1M tokens`
          );
        }
      }
    }

    // Rule 4: Timestamp validation
    if (!(data.startTime instanceof Date) || isNaN(data.startTime.getTime())) {
      errors.push('Invalid start time');
    }

    if (!(data.endTime instanceof Date) || isNaN(data.endTime.getTime())) {
      errors.push('Invalid end time');
    }

    // Rule 5: End time must be after start time
    if (data.endTime <= data.startTime) {
      errors.push('End time must be after start time');
    }

    // Rule 6: Percentage complete must be 0-100
    if (data.percentageComplete < 0 || data.percentageComplete > 100) {
      errors.push(`Percentage complete out of range: ${data.percentageComplete}%`);
    }

    // Rule 7: If block has ended, should not be marked as active
    if (data.actualEndTime && data.isActive) {
      warnings.push('Block has actualEndTime but is still marked as active');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      sanitized: this.sanitize(data)
    };
  }

  /**
   * Sanitize data (fix common issues)
   */
  private sanitize(data: CostData): CostData {
    return {
      ...data,
      costUSD: Math.max(0, data.costUSD),
      totalTokens: Math.max(0, data.totalTokens),
      hoursRemaining: Math.max(0, data.hoursRemaining),
      percentageComplete: Math.max(0, Math.min(100, data.percentageComplete)),
      burnRate: data.burnRate
        ? {
            costPerHour: Math.max(0, data.burnRate.costPerHour),
            tokensPerMinute: Math.max(0, data.burnRate.tokensPerMinute)
          }
        : null
    };
  }

  /**
   * Format data for display
   *
   * Output 1 (session time): ⌛:1h32m(69%)23:00
   * Output 2 (cost): 💰:$57.5|$26.1/h
   * Output 3 (tokens): 📊:125.0Mtok(951ktpm)
   */
  format(data: CostData): {
    sessionTime: string;
    cost: string;
    tokens: string;
  } {
    // Session time display
    const hours = Math.floor(data.hoursRemaining);
    const minutes = Math.floor((data.hoursRemaining - hours) * 60);
    const endTimeStr = data.endTime.toISOString().substring(11, 16); // HH:MM

    const sessionTime = `⌛:${hours}h${minutes}m(${data.percentageComplete}%)${endTimeStr}`;

    // Cost display
    const costDisplay = data.burnRate
      ? `💰:$${data.costUSD.toFixed(1)}|$${data.burnRate.costPerHour.toFixed(1)}/h`
      : `💰:$${data.costUSD.toFixed(1)}`;

    // Tokens display
    const tokensCompact = this.formatCompactNumber(data.totalTokens);
    const tokensDisplay = data.burnRate
      ? `📊:${tokensCompact}tok(${this.formatCompactNumber(data.burnRate.tokensPerMinute)}tpm)`
      : `📊:${tokensCompact}tok`;

    return {
      sessionTime,
      cost: costDisplay,
      tokens: tokensDisplay
    };
  }

  /**
   * Format large numbers compactly (125.0M, 951k, etc.)
   */
  private formatCompactNumber(num: number): string {
    if (num >= 1000000) {
      return `${(num / 1000000).toFixed(1)}M`;
    } else if (num >= 1000) {
      return `${Math.floor(num / 1000)}k`;
    } else {
      return `${num}`;
    }
  }

  /**
   * Get default value (fallback if fetch fails)
   */
  getDefaultValue(): CostData {
    const now = new Date();
    const fiveHoursLater = new Date(now.getTime() + 5 * 60 * 60 * 1000);

    return {
      blockId: 'unknown',
      startTime: now,
      endTime: fiveHoursLater,
      actualEndTime: null,
      isActive: false,
      costUSD: 0,
      totalTokens: 0,
      burnRate: null,
      projection: null,
      hoursRemaining: 5,
      percentageComplete: 0
    };
  }
}

export default CostModule;
