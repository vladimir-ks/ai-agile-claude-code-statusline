/**
 * Context Module - Session Context Window Data (Production)
 *
 * Data Source: JSON stdin from Claude Code
 * Refresh: Real-time (0ms cache TTL)
 * Session-Specific: YES
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';

interface ContextData {
  sessionId: string;
  contextWindowSize: number;
  currentInputTokens: number;
  currentOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCurrentTokens: number;
  tokensUntilCompact: number;
  percentageUsedWindow: number;
  percentageUsedCompact: number;
  compactThreshold: number;
}

class ContextModule implements DataModule<ContextData> {
  readonly moduleId = 'context';

  config: DataModuleConfig = {
    timeout: 100,
    cacheTTL: 0  // No cache, real-time data
  };

  private jsonInput: string = '{}';

  /**
   * Set JSON input (called before fetch)
   */
  setJsonInput(json: string): void {
    this.jsonInput = json || '{}';
  }

  /**
   * Fetch context data from JSON stdin
   */
  async fetch(sessionId: string): Promise<ContextData> {
    try {
      // Parse JSON
      let parsed;
      try {
        parsed = JSON.parse(this.jsonInput);
      } catch (err) {
        throw new Error('Failed to parse JSON input');
      }

      // Extract context window data with safe defaults
      const contextWindowSize = parsed.context_window?.context_window_size || 200000;
      const currentUsage = parsed.context_window?.current_usage || {};

      const currentInputTokens = Math.max(0, currentUsage.input_tokens || 0);
      const currentOutputTokens = Math.max(0, currentUsage.output_tokens || 0);
      const cacheReadTokens = Math.max(0, currentUsage.cache_read_input_tokens || 0);
      const cacheCreationTokens = Math.max(0, currentUsage.cache_creation_input_tokens || 0);

      // Calculate total current tokens
      const totalCurrentTokens = currentInputTokens + cacheReadTokens;

      // Calculate tokens until compact (78% threshold)
      const compactThreshold = 78;
      const usableTokens = Math.floor(contextWindowSize * compactThreshold / 100);
      const tokensUntilCompact = Math.max(0, usableTokens - totalCurrentTokens);

      // Calculate percentages
      const percentageUsedWindow = contextWindowSize > 0
        ? Math.floor((totalCurrentTokens * 100) / contextWindowSize)
        : 0;

      const percentageUsedCompact = usableTokens > 0
        ? Math.floor((totalCurrentTokens * 100) / usableTokens)
        : 0;

      return {
        sessionId: sessionId || 'unknown',
        contextWindowSize,
        currentInputTokens,
        currentOutputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        totalCurrentTokens,
        tokensUntilCompact,
        percentageUsedWindow,
        percentageUsedCompact,
        compactThreshold
      };

    } catch (error) {
      // Return default on error
      return this.getDefaultValue(sessionId);
    }
  }

  /**
   * Validate context data
   */
  validate(data: ContextData): {
    valid: boolean;
    warnings: string[];
    errors: string[];
    sanitized?: ContextData;
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      if (!data || typeof data !== 'object') {
        return { valid: false, errors: ['Invalid data structure'], warnings: [] };
      }

      // Validate window size
      if (typeof data.contextWindowSize !== 'number' || data.contextWindowSize <= 0) {
        errors.push('Context window size must be > 0');
      }

      // Validate current tokens don't exceed window
      if (data.totalCurrentTokens > data.contextWindowSize) {
        errors.push('Current tokens exceed window size');
      }

      // Validate token counts are non-negative
      const fields = ['currentInputTokens', 'currentOutputTokens', 'cacheReadTokens', 'cacheCreationTokens'];
      for (const field of fields) {
        if (typeof data[field] !== 'number' || data[field] < 0 || !isFinite(data[field])) {
          errors.push(`${field} must be non-negative number`);
        }
      }

      // Validate percentages are in range
      if (data.percentageUsedWindow < 0 || data.percentageUsedWindow > 100) {
        errors.push('Percentage used (window) out of range');
      }

      if (data.percentageUsedCompact < 0 || data.percentageUsedCompact > 100) {
        errors.push('Percentage used (compact) out of range');
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
        errors: ['Validation failed with error'],
        warnings: [],
        sanitized: this.getDefaultValue(data?.sessionId || 'unknown')
      };
    }
  }

  /**
   * Sanitize data
   */
  private sanitize(data: ContextData): ContextData {
    try {
      return {
        sessionId: typeof data.sessionId === 'string' ? data.sessionId : 'unknown',
        contextWindowSize: Math.max(1, data.contextWindowSize || 200000),
        currentInputTokens: Math.max(0, data.currentInputTokens || 0),
        currentOutputTokens: Math.max(0, data.currentOutputTokens || 0),
        cacheReadTokens: Math.max(0, data.cacheReadTokens || 0),
        cacheCreationTokens: Math.max(0, data.cacheCreationTokens || 0),
        totalCurrentTokens: Math.max(0, data.totalCurrentTokens || 0),
        tokensUntilCompact: Math.max(0, data.tokensUntilCompact || 0),
        percentageUsedWindow: Math.max(0, Math.min(100, data.percentageUsedWindow || 0)),
        percentageUsedCompact: Math.max(0, Math.min(100, data.percentageUsedCompact || 0)),
        compactThreshold: data.compactThreshold || 78
      };
    } catch (error) {
      return this.getDefaultValue('unknown');
    }
  }

  /**
   * Format for display: 🧠:156kleft[---------|--]
   */
  format(data: ContextData): string {
    try {
      const smoothedTokens = this.smoothTokens(data.tokensUntilCompact);
      const tokensDisplay = this.formatTokens(smoothedTokens);
      const progressBar = this.generateProgressBar(data.percentageUsedCompact);

      if (data.tokensUntilCompact > 0) {
        return `🧠:${tokensDisplay}left[${progressBar}]`;
      } else {
        return `🧠:COMPACT![${progressBar}]`;
      }
    } catch (error) {
      return '🧠:ERR';
    }
  }

  private smoothTokens(tokens: number): number {
    if (!isFinite(tokens) || tokens < 0) return 0;
    if (tokens >= 10000) return Math.round(tokens / 1000) * 1000;
    return Math.round(tokens / 100) * 100;
  }

  private formatTokens(tokens: number): string {
    if (!isFinite(tokens) || tokens < 0) return '0';
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${Math.floor(tokens / 1000)}k`;
    return `${tokens}`;
  }

  private generateProgressBar(percentUsed: number): string {
    try {
      const totalWidth = 12;
      const usedPos = Math.floor(totalWidth * Math.max(0, Math.min(100, percentUsed)) / 100);

      let bar = '';
      for (let i = 0; i < totalWidth; i++) {
        bar += i < usedPos ? '=' : '-';
      }
      return bar;
    } catch (error) {
      return '------------';
    }
  }

  private getDefaultValue(sessionId: string = 'unknown'): ContextData {
    return {
      sessionId,
      contextWindowSize: 200000,
      currentInputTokens: 0,
      currentOutputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCurrentTokens: 0,
      tokensUntilCompact: 156000,
      percentageUsedWindow: 0,
      percentageUsedCompact: 0,
      compactThreshold: 78
    };
  }
}

export default ContextModule;
export { ContextData };
