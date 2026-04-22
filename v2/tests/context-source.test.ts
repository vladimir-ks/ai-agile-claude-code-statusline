/**
 * Tests for v2/src/lib/sources/context-source.ts
 *
 * Tier 1 source: Context window usage from JSON input.
 * Pure computation — no I/O, no caching.
 */

import { describe, test, expect } from 'bun:test';
import { contextSource, calculateContext, detectWindowFromModel } from '../src/lib/sources/context-source';
import type { GatherContext } from '../src/lib/sources/types';
import type { SessionHealth } from '../src/types/session-health';
import { createDefaultHealth } from '../src/types/session-health';

function makeCtx(jsonInput: any = null): GatherContext {
  return {
    sessionId: 'test',
    transcriptPath: null,
    jsonInput,
    configDir: null,
    keychainService: null,
    deadline: Date.now() + 5000,
    existingHealth: null,
    projectPath: '.',
  };
}

describe('contextSource', () => {

  // -------------------------------------------------------------------------
  // Descriptor shape
  // -------------------------------------------------------------------------

  describe('descriptor', () => {
    test('has correct id', () => {
      expect(contextSource.id).toBe('context');
    });

    test('is tier 1', () => {
      expect(contextSource.tier).toBe(1);
    });

    test('has context freshnessCategory', () => {
      expect(contextSource.freshnessCategory).toBe('context');
    });

    test('has low timeout (pure computation)', () => {
      expect(contextSource.timeoutMs).toBeLessThanOrEqual(500);
    });
  });

  // -------------------------------------------------------------------------
  // fetch (via calculateContext)
  // -------------------------------------------------------------------------

  describe('fetch / calculateContext', () => {
    test('returns defaults when jsonInput is null', async () => {
      const result = await contextSource.fetch(makeCtx(null));
      expect(result.tokensUsed).toBe(0);
      expect(result.tokensLeft).toBe(0);
      expect(result.percentUsed).toBe(0);
      expect(result.windowSize).toBe(200000);
      expect(result.nearCompaction).toBe(false);
    });

    test('returns defaults when context_window is missing', () => {
      const result = calculateContext({ session_id: 'test' });
      expect(result.tokensUsed).toBe(0);
      expect(result.windowSize).toBe(200000);
    });

    test('calculates tokens from current_usage', () => {
      const result = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: 50000,
            output_tokens: 20000,
            cache_read_input_tokens: 10000,
          },
        },
      });
      expect(result.tokensUsed).toBe(80000); // 50k + 20k + 10k
    });

    test('uses custom window size', () => {
      const result = calculateContext({
        context_window: {
          context_window_size: 128000,
          current_usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
      expect(result.windowSize).toBe(128000);
    });

    test('defaults window size to 200k for out-of-range values', () => {
      const tooSmall = calculateContext({
        context_window: {
          context_window_size: 100, // < 10k
          current_usage: {},
        },
      });
      expect(tooSmall.windowSize).toBe(200000);

      // Values above 2M are still rejected (upper bound raised to 2M, not removed)
      const tooLarge = calculateContext({
        context_window: {
          context_window_size: 3_000_000, // > 2M
          current_usage: {},
        },
      });
      expect(tooLarge.windowSize).toBe(200000);
    });

    test('accepts 1M window size (claude-opus-4-7[1m] class models)', () => {
      const result = calculateContext({
        context_window: {
          context_window_size: 1_000_000,
          current_usage: { input_tokens: 517500 },
        },
      });
      expect(result.windowSize).toBe(1_000_000);
      // 517.5k / (1M * 0.83) ≈ 62%
      expect(result.percentUsed).toBeGreaterThan(60);
      expect(result.percentUsed).toBeLessThan(65);
    });

    test('calculates percentUsed relative to 83% compaction threshold', () => {
      // Window: 200k, threshold: 166k, used: 83k → 50%
      const result = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 83000 },
        },
      });
      expect(result.percentUsed).toBe(50);
    });

    test('calculates tokensLeft until compaction', () => {
      // Window: 200k, threshold: 166k, used: 50k → left: 116k
      const result = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 50000 },
        },
      });
      expect(result.tokensLeft).toBe(116000);
    });

    test('tokensLeft is 0 when above compaction threshold', () => {
      const result = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 170000 },
        },
      });
      expect(result.tokensLeft).toBe(0);
    });

    test('nearCompaction is true at >=70%', () => {
      // Window: 200k, threshold: 166k, 70% of threshold = 116.2k
      const result = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 117000 },
        },
      });
      expect(result.nearCompaction).toBe(true);
    });

    test('nearCompaction is false below 70%', () => {
      const result = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 50000 },
        },
      });
      expect(result.nearCompaction).toBe(false);
    });

    test('caps tokensUsed at windowSize for bad data (>1.5x)', () => {
      const result = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 400000 }, // 2x window
        },
      });
      expect(result.tokensUsed).toBe(200000);
    });

    test('handles negative token values gracefully', () => {
      const result = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: -5000,
            output_tokens: -100,
            cache_read_input_tokens: -50,
          },
        },
      });
      expect(result.tokensUsed).toBe(0);
    });

    test('handles NaN token values gracefully', () => {
      const result = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: 'not_a_number',
            output_tokens: undefined,
            cache_read_input_tokens: null,
          },
        },
      });
      expect(result.tokensUsed).toBe(0);
    });

    test('percentUsed caps at 100', () => {
      // Use tokens beyond the compaction threshold
      const result = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 190000 },
        },
      });
      expect(result.percentUsed).toBeLessThanOrEqual(100);
    });
  });

  // -------------------------------------------------------------------------
  // detectWindowFromModel
  // -------------------------------------------------------------------------

  describe('detectWindowFromModel', () => {
    test('parses [1m] suffix as 1_000_000', () => {
      expect(detectWindowFromModel('claude-opus-4-7[1m]')).toBe(1_000_000);
    });

    test('parses [1M] suffix (uppercase) as 1_000_000', () => {
      expect(detectWindowFromModel('claude-opus-4-7[1M]')).toBe(1_000_000);
    });

    test('parses [200k] suffix as 200_000', () => {
      expect(detectWindowFromModel('claude-haiku-3-5[200k]')).toBe(200_000);
    });

    test('returns null when no suffix', () => {
      expect(detectWindowFromModel('claude-opus-4-5-20251101')).toBeNull();
    });

    test('returns null for undefined', () => {
      expect(detectWindowFromModel(undefined)).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(detectWindowFromModel('')).toBeNull();
    });
  });

  describe('model-ID window fallback', () => {
    test('uses [1m] model suffix when context_window_size is absent', () => {
      // context_window_size missing → falls back to detectWindowFromModel
      const result = calculateContext(
        { context_window: { current_usage: { input_tokens: 517500 } } },
        'claude-opus-4-7[1m]'
      );
      expect(result.windowSize).toBe(1_000_000);
    });

    test('JSON context_window_size takes priority over model-ID suffix', () => {
      // Explicit field wins even when model has [1m]
      const result = calculateContext(
        { context_window: { context_window_size: 128000, current_usage: {} } },
        'claude-opus-4-7[1m]'
      );
      expect(result.windowSize).toBe(128000);
    });

    test('fetch() extracts model ID from jsonInput.model.id', async () => {
      const ctx = makeCtx({
        model: { id: 'claude-opus-4-7[1m]' },
        context_window: { current_usage: { input_tokens: 517500 } },
      });
      const result = await contextSource.fetch(ctx);
      expect(result.windowSize).toBe(1_000_000);
    });

    test('fetch() falls back to jsonInput.model.model_id', async () => {
      const ctx = makeCtx({
        model: { model_id: 'claude-opus-4-7[1m]' },
        context_window: { current_usage: { input_tokens: 100000 } },
      });
      const result = await contextSource.fetch(ctx);
      expect(result.windowSize).toBe(1_000_000);
    });
  });

  // -------------------------------------------------------------------------
  // merge
  // -------------------------------------------------------------------------

  describe('merge', () => {
    test('sets context on target health', () => {
      const health = createDefaultHealth('test');
      const data = calculateContext({
        context_window: {
          context_window_size: 200000,
          current_usage: { input_tokens: 80000 },
        },
      });
      contextSource.merge(health, data);
      expect(health.context.tokensUsed).toBe(80000);
    });

    test('sets updatedAt on context', () => {
      const health = createDefaultHealth('test');
      const before = Date.now();
      contextSource.merge(health, calculateContext(null));
      expect(health.context.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });
});
