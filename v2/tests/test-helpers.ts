/**
 * Test Helpers & Utilities
 *
 * Shared test utilities for mocking, fixtures, and assertions
 */

// Mock JSON input for context module tests
export const mockContextInput = (overrides?: Partial<{
  contextWindowSize: number;
  currentInputTokens: number;
  currentOutputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}>): string => {
  const defaults = {
    contextWindowSize: 200000,
    currentInputTokens: 0,
    currentOutputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0
  };

  const data = { ...defaults, ...overrides };

  return JSON.stringify({
    context_window: {
      context_window_size: data.contextWindowSize,
      current_usage: {
        input_tokens: data.currentInputTokens,
        output_tokens: data.currentOutputTokens,
        cache_read_input_tokens: data.cacheReadTokens,
        cache_creation_input_tokens: data.cacheCreationTokens
      }
    },
    model: { display_name: 'Claude Sonnet 4.5' },
    session_id: 'test-session-id'
  });
};

// Mock ccusage output for cost module tests
export const mockCcusageOutput = (overrides?: Partial<{
  blockId: string;
  startTime: string;
  endTime: string;
  isActive: boolean;
  costUSD: number;
  totalTokens: number;
  costPerHour: number;
  tokensPerMinute: number;
  projectedCost: number;
  remainingMinutes: number;
}>): string => {
  const defaults = {
    blockId: '2026-01-29T08:00:00.000Z',
    startTime: '2026-01-29T08:00:00.000Z',
    endTime: '2026-01-29T13:00:00.000Z',
    isActive: true,
    costUSD: 11.63,
    totalTokens: 24651156,
    costPerHour: 5.25,
    tokensPerMinute: 185460,
    projectedCost: 26.24,
    remainingMinutes: 167
  };

  const data = { ...defaults, ...overrides };

  return JSON.stringify({
    blocks: [{
      id: data.blockId,
      startTime: data.startTime,
      endTime: data.endTime,
      isActive: data.isActive,
      costUSD: data.costUSD,
      totalTokens: data.totalTokens,
      burnRate: {
        costPerHour: data.costPerHour,
        tokensPerMinute: data.tokensPerMinute
      },
      projection: {
        totalCost: data.projectedCost,
        remainingMinutes: data.remainingMinutes
      }
    }]
  });
};

// Mock git status output
export const mockGitStatus = (overrides?: Partial<{
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
}>): string => {
  const defaults = {
    branch: 'main',
    ahead: 0,
    behind: 0,
    dirty: 0
  };

  const data = { ...defaults, ...overrides };

  return `## ${data.branch}...origin/${data.branch}\n` +
    (data.dirty > 0 ? ` M file.txt\n`.repeat(data.dirty) : '');
};

// Assertion helpers
export const assertAlmostEqual = (actual: number, expected: number, tolerance: number = 0.01) => {
  const diff = Math.abs(actual - expected);
  if (diff > tolerance) {
    throw new Error(`Expected ${actual} to be close to ${expected} (tolerance: ${tolerance}), but diff was ${diff}`);
  }
};

// Time helpers for consistent testing
export const mockDate = (isoString: string): Date => {
  return new Date(isoString);
};

// Memory testing helpers
export const getMemoryUsage = (): number => {
  const mem = process.memoryUsage();
  return Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100; // MB
};

// Performance testing helpers
export const measurePerformance = async (fn: () => Promise<void> | void): Promise<number> => {
  const start = performance.now();
  await fn();
  const end = performance.now();
  return Math.round((end - start) * 100) / 100; // ms
};

// Retry helper for flaky tests
export const retry = async <T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 100
): Promise<T> => {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  throw lastError;
};

// Snapshot testing helper (simplified)
export const matchesSnapshot = (actual: any, snapshotName: string): boolean => {
  // TODO: Implement proper snapshot testing
  // For now, just return true (placeholder)
  return true;
};
