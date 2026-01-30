/**
 * Context Module - Session Context Window Data
 *
 * Data Source: JSON stdin from Claude Code
 * Refresh: Real-time (0ms interval, no cache)
 * Session-Specific: YES
 *
 * Responsibilities:
 * - Read context window size, used tokens from JSON input
 * - Calculate tokens until compact threshold (78%)
 * - Validate token counts don't exceed window size
 */

import { DataModule, ModuleConfig, ValidationResult } from '../types';

interface ContextData {
  sessionId: string;
  contextWindowSize: number;
  currentInputTokens: number;
  currentOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCurrentTokens: number;
  tokensUntilCompact: number;
  percentageUsedWindow: number;   // % of full window (for logs/debug)
  percentageUsedCompact: number;  // % toward compact threshold (for display)
  compactThreshold: number;       // 78 (78% default)
}

class ContextModule implements DataModule<ContextData> {
  readonly moduleId = 'context';

  config: ModuleConfig = {
    refreshInterval: 0,           // Real-time, no interval
    cacheTTL: 0,                  // No cache
    stalenessThreshold: 60000,    // 1 minute (shouldn't be stale)
    timeout: 100,                 // Fast operation
    maxRetries: 0,                // No retries needed
    maxConcurrent: Infinity       // No limit
  };

  /**
   * Fetch context data from JSON stdin
   *
   * CRITICAL: Session-specific data, must include sessionId in cache key
   */
  async fetch(sessionId: string, jsonInput: string): Promise<ContextData> {
    // STEP 1: Parse JSON input
    let parsed;
    try {
      parsed = JSON.parse(jsonInput);
    } catch (err) {
      throw new Error(`Failed to parse JSON input: ${err.message}`);
    }

    // STEP 2: Extract context window data
    const contextWindowSize = parsed.context_window?.context_window_size || 200000;
    const currentUsage = parsed.context_window?.current_usage || {};

    const currentInputTokens = currentUsage.input_tokens || 0;
    const currentOutputTokens = currentUsage.output_tokens || 0;
    const cacheReadTokens = currentUsage.cache_read_input_tokens || 0;
    const cacheCreationTokens = currentUsage.cache_creation_input_tokens || 0;

    // STEP 3: Calculate total current tokens
    // IMPORTANT: Use current_input + cache_read (NOT total_input which is cumulative)
    // NOTE: Output tokens NOT included pending verification of Claude Code compaction behavior
    // See: v2/docs/CONTEXT_CALCULATION_ANALYSIS.md for details
    const totalCurrentTokens = currentInputTokens + cacheReadTokens;

    // STEP 4: Calculate tokens until compact
    const compactThreshold = 78;  // 78% of window (should be configurable in v2)
    const usableTokens = Math.floor(contextWindowSize * compactThreshold / 100);
    const tokensUntilCompact = Math.max(0, usableTokens - totalCurrentTokens);

    // STEP 5: Calculate percentages
    // A. Percentage of window (for logs/debug)
    const percentageUsedWindow = contextWindowSize > 0
      ? Math.floor((totalCurrentTokens * 100) / contextWindowSize)
      : 0;

    // B. Percentage toward compact threshold (for progress bar)
    // FIXED: This is what should be displayed, not percentageUsedWindow
    const percentageUsedCompact = usableTokens > 0
      ? Math.floor((totalCurrentTokens * 100) / usableTokens)
      : 0;

    // STEP 6: Return structured data
    return {
      sessionId,
      contextWindowSize,
      currentInputTokens,
      currentOutputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      totalCurrentTokens,
      tokensUntilCompact,
      percentageUsedWindow,      // % of full window
      percentageUsedCompact,     // % toward compact (use for progress bar)
      compactThreshold
    };
  }

  /**
   * Validate context data
   *
   * Rules:
   * - Context window size must be > 0
   * - Current tokens cannot exceed window size
   * - All token counts must be non-negative
   * - Session ID must be valid UUID format
   */
  validate(data: ContextData): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Rule 1: Window size must be positive
    if (data.contextWindowSize <= 0) {
      errors.push('Context window size must be > 0');
    }

    // Rule 2: Current tokens cannot exceed window
    if (data.totalCurrentTokens > data.contextWindowSize) {
      errors.push(
        `Current tokens (${data.totalCurrentTokens}) exceed window size (${data.contextWindowSize})`
      );
    }

    // Rule 3: All token counts must be non-negative
    const tokenFields = [
      'currentInputTokens',
      'currentOutputTokens',
      'cacheReadTokens',
      'cacheCreationTokens'
    ];

    for (const field of tokenFields) {
      if (data[field] < 0) {
        errors.push(`${field} cannot be negative: ${data[field]}`);
      }
    }

    // Rule 4: Session ID format validation
    const uuidRegex = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
    if (!uuidRegex.test(data.sessionId)) {
      warnings.push(`Session ID format unusual: ${data.sessionId}`);
    }

    // Rule 5: Percentages should be 0-100
    if (data.percentageUsedWindow < 0 || data.percentageUsedWindow > 100) {
      errors.push(`Percentage used (window) out of range: ${data.percentageUsedWindow}%`);
    }

    if (data.percentageUsedCompact < 0 || data.percentageUsedCompact > 100) {
      errors.push(`Percentage used (compact) out of range: ${data.percentageUsedCompact}%`);
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
  private sanitize(data: ContextData): ContextData {
    return {
      ...data,
      contextWindowSize: Math.max(1, data.contextWindowSize),
      currentInputTokens: Math.max(0, data.currentInputTokens),
      currentOutputTokens: Math.max(0, data.currentOutputTokens),
      cacheReadTokens: Math.max(0, data.cacheReadTokens),
      cacheCreationTokens: Math.max(0, data.cacheCreationTokens),
      totalCurrentTokens: Math.max(0, data.totalCurrentTokens),
      tokensUntilCompact: Math.max(0, data.tokensUntilCompact),
      percentageUsedWindow: Math.max(0, Math.min(100, data.percentageUsedWindow)),
      percentageUsedCompact: Math.max(0, Math.min(100, data.percentageUsedCompact))
    };
  }

  /**
   * Format data for display
   *
   * Output: 🧠:156kleft[---------|--]
   *
   * FIXED: Use percentageUsedCompact (progress toward compact), not percentageUsedWindow
   */
  format(data: ContextData): string {
    const smoothedTokens = this.smoothTokens(data.tokensUntilCompact);
    const tokensDisplay = this.formatTokens(smoothedTokens);
    // FIXED: Use percentageUsedCompact for progress bar (% toward compact threshold)
    const progressBar = this.generateProgressBar(data.percentageUsedCompact, 100);

    if (data.tokensUntilCompact > 0) {
      return `🧠:${tokensDisplay}left[${progressBar}]`;
    } else {
      return `🧠:COMPACT![${progressBar}]`;
    }
  }

  /**
   * Smooth token count to reduce flicker
   *
   * Strategy: Round to nearest 1000 for large numbers, 100 for small
   */
  private smoothTokens(tokens: number): number {
    if (tokens >= 10000) {
      return Math.round(tokens / 1000) * 1000;
    } else {
      return Math.round(tokens / 100) * 100;
    }
  }

  /**
   * Format token count (156k, 2.3M, etc.)
   */
  private formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
      return `${Math.floor(tokens / 1000)}k`;
    } else {
      return `${tokens}`;
    }
  }

  /**
   * Generate progress bar showing progress toward compact threshold
   *
   * FIXED: Bar now shows % toward compact (0-100%), not % of window
   *
   * Examples:
   *   50% toward compact: [======------] (halfway)
   *   78% toward compact: [=========---] (close)
   *   100% toward compact: [============] (COMPACT!)
   *
   * Note: Marker removed since bar represents 0-100% of usable space
   */
  private generateProgressBar(percentUsed: number, thresholdPercent: number): string {
    const totalWidth = 12;
    const thresholdPos = Math.floor(totalWidth * thresholdPercent / 100);
    const usedPos = Math.floor(totalWidth * percentUsed / 100);

    let bar = '';
    for (let i = 0; i < totalWidth; i++) {
      if (i === thresholdPos && thresholdPercent < 100) {
        bar += '|';  // Only show marker if threshold < 100%
      } else if (i < usedPos) {
        bar += '=';
      } else {
        bar += '-';
      }
    }

    return bar;
  }

  /**
   * Get default value (fallback if fetch fails)
   */
  getDefaultValue(): ContextData {
    return {
      sessionId: 'unknown',
      contextWindowSize: 200000,
      currentInputTokens: 0,
      currentOutputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCurrentTokens: 0,
      tokensUntilCompact: 156000,  // 78% of 200k
      percentageUsedWindow: 0,      // 0% of window
      percentageUsedCompact: 0,     // 0% toward compact
      compactThreshold: 78
    };
  }
}

export default ContextModule;
