/**
 * Local Cost Calculator - Calculate session cost from transcript
 *
 * BYPASSES ccusage (which hangs on large transcript directories)
 * Only parses the CURRENT session's transcript file.
 *
 * Model pricing (as of Jan 2025, $/1M tokens):
 * - claude-opus-4-5:     input=$15, output=$75
 * - claude-sonnet-4:     input=$3, output=$15
 * - claude-haiku-3-5:    input=$0.80, output=$4
 *
 * Cache pricing (discounted):
 * - cache_creation:      1.25x input price (same as input)
 * - cache_read:          0.10x input price (90% discount)
 */

import { createReadStream, existsSync, statSync } from 'fs';
import { createInterface } from 'readline';
import { homedir } from 'os';

export interface LocalCostData {
  costUSD: number;
  costPerHour: number | null;
  totalTokens: number;
  tokensPerMinute: number | null;
  sessionStartTime: Date | null;
  sessionDurationMs: number;
  messageCount: number;
  lastFetched: number;
  isFresh: boolean;
  source: 'local-transcript';
}

// Model pricing per 1M tokens (USD)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Opus 4.5 (latest)
  'claude-opus-4-5-20251101': { input: 15, output: 75 },
  'claude-opus-4-5': { input: 15, output: 75 },
  'opus-4-5': { input: 15, output: 75 },
  'opus4.5': { input: 15, output: 75 },

  // Sonnet 4
  'claude-sonnet-4-20250514': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'sonnet-4': { input: 3, output: 15 },
  'sonnet4': { input: 3, output: 15 },

  // Haiku 3.5
  'claude-3-5-haiku-20241022': { input: 0.80, output: 4 },
  'claude-haiku-3-5': { input: 0.80, output: 4 },
  'haiku-3-5': { input: 0.80, output: 4 },
  'haiku3.5': { input: 0.80, output: 4 },

  // Legacy Opus 3.5 (same as 4.5)
  'claude-3-5-opus-20251205': { input: 15, output: 75 },
  'opus-3-5': { input: 15, output: 75 },

  // Legacy Sonnet 3.5
  'claude-3-5-sonnet-20241022': { input: 3, output: 15 },
  'claude-3-5-sonnet-20240620': { input: 3, output: 15 },
  'sonnet-3-5': { input: 3, output: 15 },
  'sonnet3.5': { input: 3, output: 15 },

  // Legacy Haiku 3
  'claude-3-haiku-20240307': { input: 0.25, output: 1.25 },
  'haiku-3': { input: 0.25, output: 1.25 },
  'haiku3': { input: 0.25, output: 1.25 },

  // Default fallback (use Opus pricing for safety)
  'default': { input: 15, output: 75 }
};

// Cache pricing multipliers
const CACHE_CREATION_MULTIPLIER = 1.25;  // Same as input (cached writes are expensive)
const CACHE_READ_MULTIPLIER = 0.10;      // 90% discount

export class LocalCostCalculator {
  /**
   * Calculate cost for a session by parsing its transcript
   *
   * Uses streaming to handle large files efficiently.
   * Skips to last known position if transcript was previously parsed.
   *
   * @param transcriptPath - Path to session's .jsonl transcript file
   * @param maxLines - Maximum lines to parse (0 = unlimited)
   */
  static async calculateCost(
    transcriptPath: string,
    maxLines: number = 0
  ): Promise<LocalCostData> {
    const result: LocalCostData = {
      costUSD: 0,
      costPerHour: null,
      totalTokens: 0,
      tokensPerMinute: null,
      sessionStartTime: null,
      sessionDurationMs: 0,
      messageCount: 0,
      lastFetched: Date.now(),
      isFresh: false,
      source: 'local-transcript'
    };

    if (!transcriptPath || !existsSync(transcriptPath)) {
      console.error('[LocalCost] Transcript not found:', transcriptPath);
      return result;
    }

    try {
      const stats = statSync(transcriptPath);
      let lineCount = 0;
      let firstTimestamp: Date | null = null;
      let lastTimestamp: Date | null = null;

      // Create read stream and parse line by line
      const fileStream = createReadStream(transcriptPath, { encoding: 'utf-8' });
      const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (maxLines > 0 && lineCount >= maxLines) break;
        lineCount++;

        // Skip empty lines
        if (!line.trim()) continue;

        try {
          const entry = JSON.parse(line);

          // Track timestamps
          if (entry.timestamp) {
            const ts = new Date(entry.timestamp);
            if (!isNaN(ts.getTime())) {
              if (!firstTimestamp) firstTimestamp = ts;
              lastTimestamp = ts;
            }
          }

          // Only process assistant messages with usage data
          if (entry.type !== 'assistant') continue;
          if (!entry.message?.usage) continue;

          const usage = entry.message.usage;
          const model = entry.message?.model || 'default';

          // Get pricing for this model
          const pricing = this.getPricing(model);

          // Calculate tokens (validate: non-negative numbers only)
          const inputTokens = Math.max(0, Number(usage.input_tokens) || 0);
          const outputTokens = Math.max(0, Number(usage.output_tokens) || 0);
          const cacheCreation = Math.max(0, Number(usage.cache_creation_input_tokens) || 0);
          const cacheRead = Math.max(0, Number(usage.cache_read_input_tokens) || 0);

          // Calculate cost for this message
          // Input tokens (excluding cache operations)
          const inputCost = (inputTokens / 1_000_000) * pricing.input;

          // Output tokens
          const outputCost = (outputTokens / 1_000_000) * pricing.output;

          // Cache creation (1.25x input price)
          const cacheCreationCost = (cacheCreation / 1_000_000) * pricing.input * CACHE_CREATION_MULTIPLIER;

          // Cache read (0.10x input price - 90% discount)
          const cacheReadCost = (cacheRead / 1_000_000) * pricing.input * CACHE_READ_MULTIPLIER;

          const messageCost = inputCost + outputCost + cacheCreationCost + cacheReadCost;

          result.costUSD += messageCost;
          result.totalTokens += inputTokens + outputTokens + cacheCreation + cacheRead;
          result.messageCount++;
        } catch {
          // Skip malformed JSON lines
          continue;
        }
      }

      // Calculate session duration and rates
      if (firstTimestamp && lastTimestamp) {
        result.sessionStartTime = firstTimestamp;
        result.sessionDurationMs = lastTimestamp.getTime() - firstTimestamp.getTime();

        if (result.sessionDurationMs > 60000) { // At least 1 minute
          const durationHours = result.sessionDurationMs / (1000 * 60 * 60);
          const durationMinutes = result.sessionDurationMs / (1000 * 60);

          result.costPerHour = durationHours > 0 ? result.costUSD / durationHours : null;
          result.tokensPerMinute = durationMinutes > 0 ? result.totalTokens / durationMinutes : null;
        }
      }

      result.isFresh = true;
      result.lastFetched = Date.now();

      console.error(`[LocalCost] Parsed ${lineCount} lines, ${result.messageCount} messages, cost: $${result.costUSD.toFixed(4)}`);

      return result;
    } catch (error) {
      console.error('[LocalCost] Error parsing transcript:', error);
      return result;
    }
  }

  /**
   * Get pricing for a model (handles various naming conventions)
   */
  private static getPricing(model: string): { input: number; output: number } {
    // Normalize model name
    const normalized = model.toLowerCase().trim();

    // Direct match
    if (MODEL_PRICING[normalized]) {
      return MODEL_PRICING[normalized];
    }

    // Partial match (e.g., "opus" matches "claude-opus-4-5")
    if (normalized.includes('opus')) {
      return MODEL_PRICING['claude-opus-4-5'];
    }
    if (normalized.includes('sonnet')) {
      return MODEL_PRICING['claude-sonnet-4'];
    }
    if (normalized.includes('haiku')) {
      return MODEL_PRICING['claude-haiku-3-5'];
    }

    // Default to Opus pricing (conservative)
    return MODEL_PRICING['default'];
  }

  /**
   * Quick cost estimate using file size heuristic
   * Much faster than full parse - useful for initial estimates
   *
   * Assumes ~$0.02 per 100KB of transcript (empirical average)
   */
  static estimateCostFromSize(transcriptPath: string): number {
    try {
      if (!existsSync(transcriptPath)) return 0;
      const stats = statSync(transcriptPath);
      const sizeKB = stats.size / 1024;
      return sizeKB * 0.0002; // $0.02 per 100KB
    } catch {
      return 0;
    }
  }
}

export default LocalCostCalculator;
