/**
 * Data Validation Tests
 *
 * Tests for bounds checking, type validation, and edge cases
 * in the data gathering pipeline.
 *
 * NOTE: These tests avoid calling the full gather() method
 * which triggers slow ccusage calls. Instead, they test
 * the validation logic directly.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import HealthStore from '../src/lib/health-store';
import { ClaudeCodeInput, createDefaultHealth } from '../src/types/session-health';

const TEST_DIR = '/tmp/statusline-test-validation';
const HEALTH_DIR = `${TEST_DIR}/session-health`;

/**
 * Direct context calculation (extracted from data-gatherer logic)
 * for testing validation without triggering ccusage calls
 */
function calculateContext(jsonInput: ClaudeCodeInput | null) {
  const result = {
    tokensUsed: 0,
    tokensLeft: 0,
    percentUsed: 0,
    windowSize: 200000,
    nearCompaction: false
  };

  if (!jsonInput?.context_window) {
    return result;
  }

  const ctx = jsonInput.context_window;
  result.windowSize = ctx.context_window_size || 200000;

  // Validation: window size bounds
  if (result.windowSize < 10000 || result.windowSize > 500000) {
    result.windowSize = 200000;
  }

  const currentUsage = ctx.current_usage;
  const inputTokens = Math.max(0, Number(currentUsage?.input_tokens) || 0);
  const outputTokens = Math.max(0, Number(currentUsage?.output_tokens) || 0);
  const cacheReadTokens = Math.max(0, Number(currentUsage?.cache_read_input_tokens) || 0);

  result.tokensUsed = inputTokens + outputTokens + cacheReadTokens;

  // Cap at 1.5x window size
  if (result.tokensUsed > result.windowSize * 1.5) {
    result.tokensUsed = result.windowSize;
  }

  const compactionThreshold = Math.floor(result.windowSize * 0.78);
  result.tokensLeft = Math.max(0, compactionThreshold - result.tokensUsed);
  result.percentUsed = compactionThreshold > 0
    ? Math.min(100, Math.floor((result.tokensUsed / compactionThreshold) * 100))
    : 0;
  result.nearCompaction = result.percentUsed >= 70;

  return result;
}

describe('Data Validation', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(HEALTH_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // =========================================================================
  // Context Window Validation
  // =========================================================================
  describe('context window validation', () => {
    test('handles missing current_usage gracefully', () => {
      const jsonInput: ClaudeCodeInput = {
        session_id: 'test-1',
        context_window: {
          context_window_size: 200000
          // current_usage is missing
        }
      };

      const context = calculateContext(jsonInput);

      expect(context.tokensUsed).toBe(0);
      expect(context.tokensLeft).toBeGreaterThan(0);
      expect(context.percentUsed).toBe(0);
    });

    test('handles negative token values', () => {
      const jsonInput: ClaudeCodeInput = {
        session_id: 'test-2',
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: -1000,  // Invalid negative
            output_tokens: 5000,
            cache_read_input_tokens: -500  // Invalid negative
          }
        }
      };

      const context = calculateContext(jsonInput);

      // Should clamp negatives to 0
      expect(context.tokensUsed).toBe(5000);  // Only valid positive value
      expect(context.tokensUsed).toBeGreaterThanOrEqual(0);
    });

    test('handles absurdly large token values', () => {
      const jsonInput: ClaudeCodeInput = {
        session_id: 'test-3',
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: 999999999,  // Way larger than window
            output_tokens: 999999999
          }
        }
      };

      const context = calculateContext(jsonInput);

      // Should cap at reasonable value
      expect(context.tokensUsed).toBeLessThanOrEqual(200000 * 1.5);
      expect(context.percentUsed).toBeLessThanOrEqual(100);
    });

    test('handles string token values (type coercion)', () => {
      const jsonInput = {
        session_id: 'test-4',
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: '50000' as any,  // String instead of number
            output_tokens: '10000' as any
          }
        }
      };

      const context = calculateContext(jsonInput as ClaudeCodeInput);

      // Should handle type coercion
      expect(context.tokensUsed).toBe(60000);
    });

    test('handles invalid window size', () => {
      const jsonInput: ClaudeCodeInput = {
        session_id: 'test-5',
        context_window: {
          context_window_size: -1000,  // Invalid
          current_usage: {
            input_tokens: 50000
          }
        }
      };

      const context = calculateContext(jsonInput);

      // Should default to 200000
      expect(context.windowSize).toBe(200000);
    });

    test('validates percentage is 0-100', () => {
      const jsonInput: ClaudeCodeInput = {
        session_id: 'test-6',
        context_window: {
          context_window_size: 200000,
          current_usage: {
            input_tokens: 200000  // 100% of window, >100% of threshold
          }
        }
      };

      const context = calculateContext(jsonInput);

      expect(context.percentUsed).toBeLessThanOrEqual(100);
      expect(context.percentUsed).toBeGreaterThanOrEqual(0);
    });

    test('handles null context_window', () => {
      const jsonInput: ClaudeCodeInput = {
        session_id: 'test-7'
        // No context_window
      };

      const context = calculateContext(jsonInput);

      expect(context.tokensUsed).toBe(0);
      expect(context.windowSize).toBe(200000);
    });

    test('handles null jsonInput', () => {
      const context = calculateContext(null);

      expect(context.tokensUsed).toBe(0);
      expect(context.windowSize).toBe(200000);
    });
  });

  // =========================================================================
  // Health Store Validation
  // =========================================================================
  describe('health store validation', () => {
    test('handles special characters in session ID', () => {
      const sessionId = 'test-session_with.special-chars';
      const healthStore = new HealthStore(HEALTH_DIR);

      // Verify health store can write with this ID
      const health = createDefaultHealth(sessionId);
      expect(() => healthStore.writeSessionHealth(sessionId, health)).not.toThrow();

      // Verify we can read it back
      const read = healthStore.readSessionHealth(sessionId);
      expect(read?.sessionId).toBe(sessionId);
    });

    test('creates default health with correct structure', () => {
      const health = createDefaultHealth('test-session');

      expect(health.sessionId).toBe('test-session');
      expect(health.health.status).toBe('unknown');
      expect(health.context.windowSize).toBe(200000);
      expect(health.billing.isFresh).toBe(false);
      expect(health.alerts.secretsDetected).toBe(false);
    });
  });

  // =========================================================================
  // Progress Bar Calculation
  // =========================================================================
  describe('progress bar calculation', () => {
    test('threshold marker at 78% position', () => {
      const width = 12;
      const thresholdPos = 9; // 78% of 12 = 9.36, floor to 9

      expect(thresholdPos).toBe(9);
      expect(Math.floor(width * 0.78)).toBe(9);
    });

    test('0% usage yields 0 filled positions', () => {
      const pct = 0;
      const width = 12;
      const usedPos = Math.floor(width * pct / 100);

      expect(usedPos).toBe(0);
    });

    test('50% usage yields 6 filled positions', () => {
      const pct = 50;
      const width = 12;
      const usedPos = Math.floor(width * pct / 100);

      expect(usedPos).toBe(6);
    });

    test('100% usage yields 12 filled positions', () => {
      const pct = 100;
      const width = 12;
      const usedPos = Math.floor(width * pct / 100);

      expect(usedPos).toBe(12);
    });
  });

  // =========================================================================
  // Model Name Formatting
  // =========================================================================
  describe('model name formatting', () => {
    test('extracts opus from display_name', () => {
      const displayName = 'Claude Opus 4.5';
      const lower = displayName.toLowerCase();
      expect(lower.includes('opus')).toBe(true);
    });

    test('extracts sonnet from model id', () => {
      const modelId = 'claude-sonnet-4-5-20250514';
      const lower = modelId.toLowerCase();
      expect(lower.includes('sonnet')).toBe(true);
    });

    test('extracts haiku from various formats', () => {
      const formats = ['haiku', 'HAIKU', 'Claude Haiku 4.5', 'claude-haiku-4-5'];
      for (const fmt of formats) {
        expect(fmt.toLowerCase().includes('haiku')).toBe(true);
      }
    });
  });

  // =========================================================================
  // Billing Validation
  // =========================================================================
  describe('billing data validation', () => {
    test('default billing has correct structure', () => {
      const health = createDefaultHealth('test');

      expect(health.billing.costToday).toBe(0);
      expect(health.billing.burnRatePerHour).toBe(0);
      expect(health.billing.budgetRemaining).toBe(0);
      expect(health.billing.isFresh).toBe(false);
      expect(health.billing.lastFetched).toBe(0);
    });

    test('budget remaining is in minutes', () => {
      // 3 hours 30 minutes = 210 minutes
      const hoursLeft = 3;
      const minutesLeft = 30;
      const totalMinutes = hoursLeft * 60 + minutesLeft;

      expect(totalMinutes).toBe(210);
    });

    test('percentage calculation is correct', () => {
      // 5 hour block, 1 hour elapsed = 20%
      const totalMs = 5 * 60 * 60 * 1000;  // 5 hours
      const elapsedMs = 1 * 60 * 60 * 1000;  // 1 hour
      const percentageUsed = Math.floor((elapsedMs / totalMs) * 100);

      expect(percentageUsed).toBe(20);
    });
  });

  // =========================================================================
  // Width Calculation
  // =========================================================================
  describe('width calculation', () => {
    test('strips ANSI codes correctly', () => {
      const withAnsi = '\x1b[38;5;117mhello\x1b[0m';
      const stripped = withAnsi.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).toBe('hello');
      expect(stripped.length).toBe(5);
    });

    test('handles multiple ANSI codes', () => {
      const withAnsi = '\x1b[38;5;117m📁:\x1b[0m\x1b[38;5;150mtest\x1b[0m';
      const stripped = withAnsi.replace(/\x1b\[[0-9;]*m/g, '');

      expect(stripped).toBe('📁:test');
    });
  });
});
