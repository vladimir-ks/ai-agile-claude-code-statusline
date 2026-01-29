/**
 * Unit Tests: Context Module
 *
 * Tests:
 * 1. JSON parsing and data extraction
 * 2. Context window calculations (FIXED formulas)
 * 3. Percentage calculations (window vs compact)
 * 4. Progress bar generation
 * 5. Validation rules
 * 6. Edge cases
 */

import { describe, test, expect } from 'bun:test';

// Mock data structures (will be replaced with actual types)
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

// Mock implementation (simplified from pseudocode)
class ContextModule {
  calculateContext(input: {
    contextWindowSize: number;
    currentInputTokens: number;
    cacheReadTokens: number;
    currentOutputTokens: number;
  }): ContextData {
    const { contextWindowSize, currentInputTokens, cacheReadTokens, currentOutputTokens } = input;

    // Current formula (pending output token verification)
    const totalCurrentTokens = currentInputTokens + cacheReadTokens;

    // Calculate usable tokens (78% threshold)
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
      sessionId: 'test-session',
      contextWindowSize,
      currentInputTokens,
      currentOutputTokens,
      cacheReadTokens,
      cacheCreationTokens: 0,
      totalCurrentTokens,
      tokensUntilCompact,
      percentageUsedWindow,
      percentageUsedCompact,
      compactThreshold
    };
  }

  formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
      return `${Math.floor(tokens / 1000)}k`;
    } else {
      return `${tokens}`;
    }
  }

  generateProgressBar(percentUsed: number, width: number = 12): string {
    const usedPos = Math.floor(width * percentUsed / 100);
    let bar = '';
    for (let i = 0; i < width; i++) {
      bar += i < usedPos ? '=' : '-';
    }
    return bar;
  }
}

describe('ContextModule - Calculation Logic', () => {
  const module = new ContextModule();

  test('Fresh session: 0 tokens used', () => {
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: 0,
      cacheReadTokens: 0,
      currentOutputTokens: 0
    });

    expect(result.totalCurrentTokens).toBe(0);
    expect(result.tokensUntilCompact).toBe(156000); // 78% of 200k
    expect(result.percentageUsedWindow).toBe(0);
    expect(result.percentageUsedCompact).toBe(0);
  });

  test('Half full toward compact: 78k tokens (50% toward 156k)', () => {
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: 50000,
      cacheReadTokens: 28000,
      currentOutputTokens: 0
    });

    expect(result.totalCurrentTokens).toBe(78000);
    expect(result.tokensUntilCompact).toBe(78000); // 156k - 78k
    expect(result.percentageUsedWindow).toBe(39); // 78k / 200k = 39%
    expect(result.percentageUsedCompact).toBe(50); // 78k / 156k = 50%
  });

  test('Near compact: 150k tokens (96% toward 156k)', () => {
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: 140000,
      cacheReadTokens: 10000,
      currentOutputTokens: 0
    });

    expect(result.totalCurrentTokens).toBe(150000);
    expect(result.tokensUntilCompact).toBe(6000); // 156k - 150k
    expect(result.percentageUsedWindow).toBe(75); // 150k / 200k = 75%
    expect(result.percentageUsedCompact).toBe(96); // 150k / 156k = 96%
  });

  test('At compact threshold: 156k tokens (100%)', () => {
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: 150000,
      cacheReadTokens: 6000,
      currentOutputTokens: 0
    });

    expect(result.totalCurrentTokens).toBe(156000);
    expect(result.tokensUntilCompact).toBe(0); // At threshold
    expect(result.percentageUsedWindow).toBe(78); // 156k / 200k = 78%
    expect(result.percentageUsedCompact).toBe(100); // 156k / 156k = 100%
  });

  test('Over compact threshold: 180k tokens (clamped)', () => {
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: 100000,
      cacheReadTokens: 80000,
      currentOutputTokens: 0
    });

    expect(result.totalCurrentTokens).toBe(180000);
    expect(result.tokensUntilCompact).toBe(0); // Over threshold, clamped to 0
    expect(result.percentageUsedWindow).toBe(90); // 180k / 200k = 90%
    expect(result.percentageUsedCompact).toBe(115); // 180k / 156k = 115% (over 100%)
  });

  test('Large context window: 500k tokens', () => {
    const result = module.calculateContext({
      contextWindowSize: 500000,
      currentInputTokens: 200000,
      cacheReadTokens: 100000,
      currentOutputTokens: 0
    });

    expect(result.totalCurrentTokens).toBe(300000);
    expect(result.tokensUntilCompact).toBe(90000); // 390k - 300k (78% of 500k = 390k)
    expect(result.percentageUsedWindow).toBe(60); // 300k / 500k = 60%
    expect(result.percentageUsedCompact).toBe(76); // 300k / 390k = 76%
  });
});

describe('ContextModule - Progress Bar Accuracy', () => {
  const module = new ContextModule();

  test('Progress bar at 0% should be empty', () => {
    const bar = module.generateProgressBar(0, 12);
    expect(bar).toBe('------------');
  });

  test('Progress bar at 50% should be half filled', () => {
    const bar = module.generateProgressBar(50, 12);
    expect(bar).toBe('======------');
  });

  test('Progress bar at 96% should be almost full', () => {
    const bar = module.generateProgressBar(96, 12);
    expect(bar).toBe('===========-');
  });

  test('Progress bar at 100% should be full', () => {
    const bar = module.generateProgressBar(100, 12);
    expect(bar).toBe('============');
  });

  test('Progress bar handles values >100%', () => {
    const bar = module.generateProgressBar(115, 12);
    expect(bar).toBe('============'); // Should cap at 100%
  });
});

describe('ContextModule - Token Formatting', () => {
  const module = new ContextModule();

  test('Small numbers: <1000', () => {
    expect(module.formatTokens(0)).toBe('0');
    expect(module.formatTokens(500)).toBe('500');
    expect(module.formatTokens(999)).toBe('999');
  });

  test('Thousands: 1k-999k', () => {
    expect(module.formatTokens(1000)).toBe('1k');
    expect(module.formatTokens(6000)).toBe('6k');
    expect(module.formatTokens(78000)).toBe('78k');
    expect(module.formatTokens(156000)).toBe('156k');
    expect(module.formatTokens(999000)).toBe('999k');
  });

  test('Millions: 1M+', () => {
    expect(module.formatTokens(1000000)).toBe('1.0M');
    expect(module.formatTokens(2345678)).toBe('2.3M');
    expect(module.formatTokens(10000000)).toBe('10.0M');
  });
});

describe('ContextModule - Edge Cases', () => {
  const module = new ContextModule();

  test('Zero window size (invalid input)', () => {
    const result = module.calculateContext({
      contextWindowSize: 0,
      currentInputTokens: 100,
      cacheReadTokens: 50,
      currentOutputTokens: 0
    });

    expect(result.percentageUsedWindow).toBe(0); // Should not crash
    expect(result.percentageUsedCompact).toBe(0);
  });

  test('Negative tokens (sanitized)', () => {
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: -100, // Invalid
      cacheReadTokens: 50,
      currentOutputTokens: 0
    });

    // Should handle gracefully (sanitization would happen in validation)
    expect(result.totalCurrentTokens).toBe(-50); // Math still works, validation should catch
  });

  test('Very large numbers (no overflow)', () => {
    const result = module.calculateContext({
      contextWindowSize: 100000000, // 100M
      currentInputTokens: 50000000,
      cacheReadTokens: 30000000,
      currentOutputTokens: 0
    });

    expect(result.totalCurrentTokens).toBe(80000000);
    expect(result.percentageUsedWindow).toBe(80);
    expect(result.percentageUsedCompact).toBe(102); // Over threshold
  });
});

describe('ContextModule - Percentage Comparison (CRITICAL TEST)', () => {
  const module = new ContextModule();

  test('Bug verification: percentageUsedWindow vs percentageUsedCompact', () => {
    // This test verifies the fix for the misleading progress bar bug
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: 50000,
      cacheReadTokens: 50000,
      currentOutputTokens: 0
    });

    // 100k tokens used
    expect(result.totalCurrentTokens).toBe(100000);

    // OLD (v1 behavior): Shows % of window
    expect(result.percentageUsedWindow).toBe(50); // 100k / 200k = 50%

    // NEW (v2 behavior): Shows % toward compact
    expect(result.percentageUsedCompact).toBe(64); // 100k / 156k = 64%

    // Visual difference:
    // v1 would show: [======|------] (50% filled, marker at 78%)
    // v2 should show: [========----] (64% filled, full bar = 100%)

    // CRITICAL: percentageUsedCompact should be HIGHER than percentageUsedWindow
    // because the usable space (156k) is smaller than the full window (200k)
    expect(result.percentageUsedCompact).toBeGreaterThan(result.percentageUsedWindow);
  });

  test('At compact threshold: both percentages align correctly', () => {
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: 156000,
      cacheReadTokens: 0,
      currentOutputTokens: 0
    });

    expect(result.percentageUsedWindow).toBe(78); // 156k / 200k = 78%
    expect(result.percentageUsedCompact).toBe(100); // 156k / 156k = 100%

    // At compact:
    // percentageUsedWindow should equal compactThreshold
    expect(result.percentageUsedWindow).toBe(result.compactThreshold);
    // percentageUsedCompact should be 100%
    expect(result.percentageUsedCompact).toBe(100);
  });
});

describe('ContextModule - Real-World Scenarios', () => {
  const module = new ContextModule();

  test('Scenario: Active coding session with cache', () => {
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: 30000,    // Recent messages
      cacheReadTokens: 90000,       // Cached context
      currentOutputTokens: 5000     // Claude responses
    });

    expect(result.totalCurrentTokens).toBe(120000); // 30k + 90k
    expect(result.tokensUntilCompact).toBe(36000);  // 156k - 120k
    expect(result.percentageUsedCompact).toBe(76);   // 120k / 156k = 76%

    // Should show: "🧠:36kleft[=========---]" (76% toward compact)
    const display = `🧠:${module.formatTokens(result.tokensUntilCompact)}left`;
    expect(display).toBe('🧠:36kleft');
  });

  test('Scenario: Fresh chat, no cache', () => {
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: 5000,
      cacheReadTokens: 0,
      currentOutputTokens: 1000
    });

    expect(result.totalCurrentTokens).toBe(5000);
    expect(result.tokensUntilCompact).toBe(151000); // 156k - 5k
    expect(result.percentageUsedCompact).toBe(3);    // 5k / 156k = 3%

    // Should show: "🧠:151kleft[------------]" (almost empty)
  });

  test('Scenario: Near compact warning (< 5% remaining)', () => {
    const result = module.calculateContext({
      contextWindowSize: 200000,
      currentInputTokens: 150000,
      cacheReadTokens: 4000,
      currentOutputTokens: 0
    });

    expect(result.totalCurrentTokens).toBe(154000);
    expect(result.tokensUntilCompact).toBe(2000);   // Only 2k left!
    expect(result.percentageUsedCompact).toBe(98);   // 154k / 156k = 98%

    // Should show: "🧠:2kleft[===========-]" with RED warning color
  });
});
