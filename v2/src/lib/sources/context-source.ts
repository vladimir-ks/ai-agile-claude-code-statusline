/**
 * Context Window Source — Tier 1 (instant, from stdin)
 *
 * Extracts context window usage from JSON input.
 * Pure computation, no I/O, no caching needed.
 *
 * Compaction threshold: 83% of window size.
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
    // Extract model ID from jsonInput for window-size inference (e.g. [1m] suffix)
    const modelId = ctx.jsonInput?.model?.id || ctx.jsonInput?.model?.model_id || undefined;
    return calculateContext(ctx.jsonInput, modelId);
  },

  merge(target: SessionHealth, data: ContextInfo): void {
    target.context = data;
    target.context.updatedAt = Date.now();
  },
};

/**
 * Detect context window size from model ID suffix.
 *
 * Examples:
 *   "claude-opus-4-7[1m]"   → 1_000_000
 *   "claude-sonnet-4-6[1m]" → 1_000_000
 *   "claude-haiku-3-5[200k]" → 200_000
 *
 * Returns null when no suffix is present or suffix is unrecognised.
 */
export function detectWindowFromModel(modelId?: string): number | null {
  if (!modelId) return null;
  // Match [1m], [1M], [200k], [200K] style suffixes
  const match = modelId.match(/\[(\d+)([mk])\]/i);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  if (unit === 'm') return value * 1_000_000;
  if (unit === 'k') return value * 1_000;
  return null;
}

/**
 * Calculate context window usage from JSON input.
 *
 * Claude Code provides nested structure:
 *   context_window.current_usage.input_tokens
 *   context_window.current_usage.output_tokens
 *   context_window.current_usage.cache_read_input_tokens
 *   context_window.current_usage.cache_creation_input_tokens
 *
 * NOTE: cache_creation_input_tokens is intentionally excluded from tokensUsed.
 * It represents tokens charged for writing to the cache, not the context
 * footprint of the current turn.
 */
function calculateContext(jsonInput: any, modelId?: string): ContextInfo {
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
  // Prefer explicit JSON field; fall back to model-ID suffix; then hard default.
  result.windowSize = ctx.context_window_size || detectWindowFromModel(modelId) || 200000;

  // Validate window size (10k - 2M tokens).
  // Upper bound raised to 2M to accommodate 1M-context models (e.g. claude-opus-4-7[1m]).
  if (result.windowSize < 10000 || result.windowSize > 2_000_000) {
    result.windowSize = 200000;
  }

  const currentUsage = ctx.current_usage;

  // Extract and validate token counts (must be non-negative).
  // Aggregates current-turn footprint: input + output + cache reads.
  // cache_creation_input_tokens is deliberately excluded (cache-write cost, not window usage).
  const inputTokens = Math.max(0, Number(currentUsage?.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(currentUsage?.output_tokens) || 0);
  const cacheReadTokens = Math.max(0, Number(currentUsage?.cache_read_input_tokens) || 0);

  // Total tokens = input + output + cache reads (current turn only)
  result.tokensUsed = inputTokens + outputTokens + cacheReadTokens;

  // Cap at 1.5x window size (bad data guard)
  if (result.tokensUsed > result.windowSize * 1.5) {
    result.tokensUsed = result.windowSize;
  }

  // Calculate tokens until 83% compaction threshold
  const compactionThreshold = Math.floor(result.windowSize * 0.83);
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
// detectWindowFromModel already exported via named export above

export default contextSource;
