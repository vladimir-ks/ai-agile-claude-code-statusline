/**
 * Cost Module - Claude Usage Billing Data (Production)
 *
 * Data Source: ccusage CLI
 * Refresh: Every 15 minutes (expensive operation)
 * Session-Specific: NO (shared across all sessions)
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';
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

  config: DataModuleConfig = {
    timeout: 35000,      // 35s (ccusage can take 20-30s)
    cacheTTL: 900000     // 15 min (aggressive caching)
  };

  /**
   * Fetch cost data from ccusage CLI
   */
  async fetch(sessionId: string): Promise<CostData> {
    try {
      // Execute ccusage with timeout
      const command = 'ccusage blocks --json --active';
      const { stdout } = await execAsync(command, {
        timeout: this.config.timeout,
        env: process.env
      });

      // Parse JSON
      let parsed;
      try {
        parsed = JSON.parse(stdout);
      } catch (err) {
        throw new Error('Failed to parse ccusage output');
      }

      // Extract active block
      const blocks = parsed.blocks || [];
      const activeBlock = blocks.find((b: any) => b.isActive === true);

      if (!activeBlock) {
        throw new Error('No active billing block found');
      }

      // Extract fields with safe defaults
      const blockId = activeBlock.id || 'unknown';
      const startTime = new Date(activeBlock.startTime || Date.now());
      const endTime = new Date(activeBlock.endTime || Date.now() + 5 * 3600000);
      const actualEndTime = activeBlock.actualEndTime ? new Date(activeBlock.actualEndTime) : null;
      const isActive = activeBlock.isActive === true;
      const costUSD = Math.max(0, activeBlock.costUSD || 0);
      const totalTokens = Math.max(0, activeBlock.totalTokens || 0);

      // Extract burn rate
      const burnRate = activeBlock.burnRate
        ? {
            costPerHour: Math.max(0, activeBlock.burnRate.costPerHour || 0),
            tokensPerMinute: Math.max(0, activeBlock.burnRate.tokensPerMinute || 0)
          }
        : null;

      // Extract projection
      const projection = activeBlock.projection
        ? {
            totalCost: Math.max(0, activeBlock.projection.totalCost || 0),
            remainingMinutes: Math.max(0, activeBlock.projection.remainingMinutes || 0)
          }
        : null;

      // Calculate time remaining
      const now = Date.now();
      const endTimestamp = endTime.getTime();
      const remainingMs = Math.max(0, endTimestamp - now);
      const hoursRemaining = remainingMs / (1000 * 60 * 60);

      // Calculate percentage complete
      const totalDuration = endTime.getTime() - startTime.getTime();
      const elapsed = now - startTime.getTime();
      const percentageComplete = totalDuration > 0
        ? Math.min(100, Math.floor((elapsed / totalDuration) * 100))
        : 0;

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

    } catch (error) {
      // Return default on error
      return this.getDefaultValue();
    }
  }

  /**
   * Validate cost data
   */
  validate(data: CostData): {
    valid: boolean;
    warnings: string[];
    errors: string[];
    sanitized?: CostData;
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      if (!data || typeof data !== 'object') {
        return { valid: false, errors: ['Invalid data structure'], warnings: [] };
      }

      // Validate cost is non-negative
      if (typeof data.costUSD !== 'number' || data.costUSD < 0 || !isFinite(data.costUSD)) {
        errors.push('Cost must be non-negative');
      }

      // Validate timestamps
      if (!(data.startTime instanceof Date) || isNaN(data.startTime.getTime())) {
        errors.push('Invalid start time');
      }

      if (!(data.endTime instanceof Date) || isNaN(data.endTime.getTime())) {
        errors.push('Invalid end time');
      }

      // Validate end time after start time
      if (data.startTime instanceof Date && data.endTime instanceof Date) {
        if (data.endTime.getTime() <= data.startTime.getTime()) {
          errors.push('End time must be after start time');
        }
      }

      // Validate burn rate if present
      if (data.burnRate) {
        if (data.burnRate.costPerHour < 0 || !isFinite(data.burnRate.costPerHour)) {
          errors.push('Burn rate must be non-negative');
        }
      }

      // Validate percentage complete
      if (data.percentageComplete < 0 || data.percentageComplete > 100) {
        errors.push('Percentage complete out of range');
      }

      return {
        valid: errors.length === 0,
        errors,
        warnings,
        sanitized: this.sanitize(data)
      };

    } catch (error) {
      return {
        valid: false,
        errors: ['Validation failed'],
        warnings: [],
        sanitized: this.getDefaultValue()
      };
    }
  }

  /**
   * Sanitize data
   */
  private sanitize(data: CostData): CostData {
    try {
      return {
        blockId: typeof data.blockId === 'string' ? data.blockId : 'unknown',
        startTime: data.startTime instanceof Date ? data.startTime : new Date(),
        endTime: data.endTime instanceof Date ? data.endTime : new Date(),
        actualEndTime: data.actualEndTime instanceof Date ? data.actualEndTime : null,
        isActive: Boolean(data.isActive),
        costUSD: Math.max(0, data.costUSD || 0),
        totalTokens: Math.max(0, data.totalTokens || 0),
        burnRate: data.burnRate
          ? {
              costPerHour: Math.max(0, data.burnRate.costPerHour || 0),
              tokensPerMinute: Math.max(0, data.burnRate.tokensPerMinute || 0)
            }
          : null,
        projection: data.projection
          ? {
              totalCost: Math.max(0, data.projection.totalCost || 0),
              remainingMinutes: Math.max(0, data.projection.remainingMinutes || 0)
            }
          : null,
        hoursRemaining: Math.max(0, data.hoursRemaining || 0),
        percentageComplete: Math.max(0, Math.min(100, data.percentageComplete || 0))
      };
    } catch (error) {
      return this.getDefaultValue();
    }
  }

  /**
   * Format for display: 💰:$40.3|$15.1/h
   */
  format(data: CostData): string {
    try {
      const cost = this.formatCost(data.costUSD);
      const burnRate = data.burnRate
        ? this.formatCost(data.burnRate.costPerHour)
        : '0.00';

      return `💰:$${cost}|$${burnRate}/h`;
    } catch (error) {
      return '💰:ERR';
    }
  }

  private formatCost(cost: number): string {
    if (!isFinite(cost) || cost < 0) return '0.00';
    return cost.toFixed(2);
  }

  private getDefaultValue(): CostData {
    const now = new Date();
    const endTime = new Date(now.getTime() + 5 * 3600000); // 5 hours from now

    return {
      blockId: 'unknown',
      startTime: now,
      endTime,
      actualEndTime: null,
      isActive: true,
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
export { CostData };
