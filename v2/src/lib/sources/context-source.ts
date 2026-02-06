/**
 * Context Window Source — Tier 1 (instant, from stdin)
 *
 * Extracts context window usage from JSON input.
 * Pure computation, no I/O, no caching needed.
 *
 * Compaction threshold: 78% of window size.
 * tokensLeft = tokens until compaction triggers (not until window full).
 * percentUsed = percentage of compaction threshold (not total window).
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { ContextInfo, SessionHealth } from '../../types/session-health';

export const contextSource: DataSourceDescriptor<ContextInfo> = {
  id: 'context',
  tier: 1,
  freshnessCategory: 'context',
  timeoutMs: 100, // Pure computation, virtually instant

  async fetch(ctx: GatherContext): Promise<ContextInfo> {
    return calculateContext(ctx.jsonInput);
  },

  merge(target: SessionHealth, data: ContextInfo): void {
    target.context = data;
    target.context.updatedAt = Date.now();
  },
};

/**
 * Calculate context window usage from JSON input.
 *
 * Claude Code provides nested structure:
 *   context_window.current_usage.input_tokens
 *   context_window.current_usage.output_tokens
 *   context_window.current_usage.cache_read_input_tokens
 *   context_window.current_usage.cache_creation_input_tokens
 */
function calculateContext(jsonInput: any): ContextInfo {
  const result: ContextInfo = {
    tokensUsed: 0,
    tokensLeft: 0,
    percentUsed: 0,
    windowSize: 200000,
    nearCompaction: false,
  };

  if (!jsonInput?.context_window) {
    return result;
  }

  const ctx = jsonInput.context_window;
  result.windowSize = ctx.context_window_size || 200000;

  // Validate window size (10k - 500k tokens)
  if (result.windowSize < 10000 || result.windowSize > 500000) {
    result.windowSize = 200000;
  }

  const currentUsage = ctx.current_usage;

  // Extract and validate token counts (must be non-negative)
  const inputTokens = Math.max(0, Number(currentUsage?.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(currentUsage?.output_tokens) || 0);
  const cacheReadTokens = Math.max(0, Number(currentUsage?.cache_read_input_tokens) || 0);

  // Total tokens = input + output + cache reads
  result.tokensUsed = inputTokens + outputTokens + cacheReadTokens;

  // Cap at 1.5x window size (bad data guard)
  if (result.tokensUsed > result.windowSize * 1.5) {
    result.tokensUsed = result.windowSize;
  }

  // Calculate tokens until 78% compaction threshold
  const compactionThreshold = Math.floor(result.windowSize * 0.78);
  result.tokensLeft = Math.max(0, compactionThreshold - result.tokensUsed);

  // Percentage used (of compaction threshold, not total window)
  result.percentUsed = compactionThreshold > 0
    ? Math.min(100, Math.floor((result.tokensUsed / compactionThreshold) * 100))
    : 0;

  // Near compaction warning
  result.nearCompaction = result.percentUsed >= 70;

  return result;
}

// Export for testing
export { calculateContext };

export default contextSource;
