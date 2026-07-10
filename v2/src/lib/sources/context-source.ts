/**
 * Context Window Source — Tier 1 (instant, from stdin)
 *
 * Extracts context window usage from JSON input.
 * Pure computation, no I/O, no caching needed.
 *
 * Semantics: FULL-WINDOW truth, matching Claude Code's own /context math.
 * percentUsed = native stdin used_percentage when present, else used/window.
 * tokensLeft = window − used. tokensUsed includes cache_creation_input_tokens.
 * why: a hardcoded 83%-compact-threshold basis showed "0 left/100%" while the
 * session kept working, and never matched CC's displayed % — contract:
 * context-source.test.ts full-window-truth tests
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
 * Calculate context window usage from stdin JSON — full-window semantics
 * (matches Claude Code's own /context: percent of window, tokens left in window).
 * tokensUsed includes cache_creation_input_tokens (cache-written tokens ARE in
 * the prompt/context — excluding them showed ~0 used on cache-heavy first turns).
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

  // Validate window size (10k - 2M tokens)
  if (result.windowSize < 10000 || result.windowSize > 2_000_000) {
    result.windowSize = 200000;
  }

  const currentUsage = ctx.current_usage;
  const inputTokens = Math.max(0, Number(currentUsage?.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(currentUsage?.output_tokens) || 0);
  const cacheReadTokens = Math.max(0, Number(currentUsage?.cache_read_input_tokens) || 0);
  const cacheCreationTokens = Math.max(0, Number(currentUsage?.cache_creation_input_tokens) || 0);

  result.tokensUsed = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;

  // Cap at window size (bad data guard)
  if (result.tokensUsed > result.windowSize * 1.5) {
    result.tokensUsed = result.windowSize;
  }

  result.tokensLeft = Math.max(0, result.windowSize - result.tokensUsed);

  // Native percentage is CC's own number — authoritative when present
  const nativePct = Number(ctx.used_percentage);
  result.percentUsed = Number.isFinite(nativePct) && nativePct >= 0
    ? Math.min(100, Math.round(nativePct))
    : Math.min(100, Math.floor((result.tokensUsed / result.windowSize) * 100));

  result.nearCompaction = result.percentUsed >= 80;

  return result;
}

// Export for testing
export { calculateContext };
// detectWindowFromModel already exported via named export above

export default contextSource;
