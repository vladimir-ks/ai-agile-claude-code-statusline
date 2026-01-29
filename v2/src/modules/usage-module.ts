/**
 * Usage Module - Total Tokens + TPM (Tokens Per Minute)
 *
 * Displays: 📊:83.4Mtok(521ktpm)
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';
import type { ValidationResult } from '../types/validation';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

interface UsageData {
  totalTokens: number;
  tokensPerMinute: number | null;
  displayTokens: string;
  displayTPM: string | null;
}

class UsageModule implements DataModule<UsageData> {
  readonly moduleId = 'usage';

  config: DataModuleConfig = {
    timeout: 35000,  // ccusage can take 20-30s
    cacheTTL: 900000  // 15 min cache
  };

  async fetch(sessionId: string): Promise<UsageData> {
    try {
      const { stdout } = await execAsync('ccusage blocks --json --active', {
        timeout: this.config.timeout
      });

      const data = JSON.parse(stdout);
      const activeBlock = data.blocks?.find((b: any) => b.isActive === true);

      if (!activeBlock) {
        return this.getDefaultData();
      }

      const totalTokens = Math.max(0, activeBlock.totalTokens || 0);
      const tokensPerMinute = activeBlock.burnRate?.tokensPerMinute || null;

      const displayTokens = this.formatTokens(totalTokens);
      const displayTPM = tokensPerMinute ? this.formatTokens(tokensPerMinute) : null;

      return {
        totalTokens,
        tokensPerMinute,
        displayTokens,
        displayTPM
      };
    } catch (error) {
      return this.getDefaultData();
    }
  }

  private getDefaultData(): UsageData {
    return {
      totalTokens: 0,
      tokensPerMinute: null,
      displayTokens: '0',
      displayTPM: null
    };
  }

  private formatTokens(tokens: number): string {
    // Smooth tokens to reduce flicker
    let smoothed = tokens;

    if (tokens >= 10000000) {
      // Round to nearest 10M for very large numbers
      smoothed = Math.round(tokens / 10000000) * 10000000;
    } else if (tokens >= 1000000) {
      // Round to nearest 1M
      smoothed = Math.round(tokens / 1000000) * 1000000;
    } else if (tokens >= 1000) {
      // Round to nearest 100 for smaller numbers
      smoothed = Math.round(tokens / 100) * 100;
    }

    // Format compactly
    if (smoothed >= 1000000) {
      const millions = smoothed / 1000000;
      return `${millions.toFixed(1)}M`;
    } else if (smoothed >= 1000) {
      const thousands = Math.floor(smoothed / 1000);
      return `${thousands}k`;
    }

    return String(smoothed);
  }

  validate(data: UsageData): ValidationResult {
    if (!data || data.totalTokens < 0) {
      return {
        valid: false,
        confidence: 0,
        errors: ['Invalid usage data']
      };
    }

    return {
      valid: true,
      confidence: 100,
      warnings: []
    };
  }

  format(data: UsageData): string {
    if (!data || data.totalTokens === 0) {
      return '';  // Don't show if no usage data
    }

    let output = `📊:${data.displayTokens}tok`;

    if (data.displayTPM) {
      output += `(${data.displayTPM}tpm)`;
    }

    return output;
  }
}

export default UsageModule;
export { UsageData };
