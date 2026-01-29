/**
 * Cache Module - Cache Hit Ratio Display
 *
 * Displays: 💾:16%
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';
import type { ValidationResult } from '../types/validation';

interface CacheData {
  cacheRead: number;
  cacheCreation: number;
  totalCacheEligible: number;
  hitRatio: number;  // percentage
  displayRatio: string;
}

class CacheModule implements DataModule<CacheData> {
  readonly moduleId = 'cache';

  config: DataModuleConfig = {
    timeout: 100,
    cacheTTL: 0  // Real-time (cache metrics from JSON input)
  };

  private jsonInput: string = '';

  setJsonInput(jsonInput: string): void {
    this.jsonInput = jsonInput;
  }

  async fetch(sessionId: string): Promise<CacheData> {
    try {
      if (!this.jsonInput) {
        return this.getDefaultData();
      }

      const parsed = JSON.parse(this.jsonInput);
      const currentUsage = parsed.context_window?.current_usage || {};

      const cacheRead = Math.max(0, currentUsage.cache_read_input_tokens || 0);
      const cacheCreation = Math.max(0, currentUsage.cache_creation_input_tokens || 0);

      const totalCacheEligible = cacheRead + cacheCreation;

      let hitRatio = 0;
      if (totalCacheEligible > 0) {
        hitRatio = Math.floor((cacheRead * 100) / totalCacheEligible);
      }

      // Smooth to nearest 5% to reduce flicker
      const smoothedRatio = Math.round(hitRatio / 5) * 5;

      return {
        cacheRead,
        cacheCreation,
        totalCacheEligible,
        hitRatio: smoothedRatio,
        displayRatio: `${smoothedRatio}%`
      };
    } catch (error) {
      return this.getDefaultData();
    }
  }

  private getDefaultData(): CacheData {
    return {
      cacheRead: 0,
      cacheCreation: 0,
      totalCacheEligible: 0,
      hitRatio: 0,
      displayRatio: '0%'
    };
  }

  validate(data: CacheData): ValidationResult {
    if (!data || data.hitRatio < 0 || data.hitRatio > 100) {
      return {
        valid: false,
        confidence: 0,
        errors: ['Invalid cache ratio']
      };
    }

    return {
      valid: true,
      confidence: 100,
      warnings: []
    };
  }

  format(data: CacheData): string {
    if (!data || data.totalCacheEligible === 0) {
      return '';  // Don't show if no cache data
    }

    return `💾:${data.displayRatio}`;
  }
}

export default CacheModule;
export { CacheData };
