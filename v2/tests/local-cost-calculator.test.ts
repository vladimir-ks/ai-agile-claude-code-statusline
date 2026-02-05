/**
 * Local Cost Calculator Tests
 *
 * Tests the local cost calculator that bypasses ccusage by parsing
 * individual session transcripts directly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { writeFileSync, unlinkSync, mkdirSync, existsSync, rmSync } from 'fs';
import { LocalCostCalculator } from '../src/lib/local-cost-calculator';
import { homedir } from 'os';

const TEST_DIR = `${homedir()}/.claude/session-health/test-local-cost`;

describe('LocalCostCalculator', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
  });

  afterAll(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('calculateCost', () => {
    it('should calculate cost from simple transcript', async () => {
      const testFile = `${TEST_DIR}/simple.jsonl`;

      // Create a simple transcript with one assistant message
      const lines = [
        JSON.stringify({
          type: 'user',
          timestamp: '2026-01-01T10:00:00.000Z',
          message: { role: 'user', content: 'Hello' }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T10:01:00.000Z',
          message: {
            model: 'claude-opus-4-5-20251101',
            role: 'assistant',
            usage: {
              input_tokens: 1000,
              output_tokens: 500,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0
            }
          }
        })
      ];

      writeFileSync(testFile, lines.join('\n'));

      const result = await LocalCostCalculator.calculateCost(testFile);

      // Opus pricing: input=$15/1M, output=$75/1M
      // 1000 input = $0.015, 500 output = $0.0375
      const expectedCost = (1000 / 1_000_000) * 15 + (500 / 1_000_000) * 75;

      expect(result.isFresh).toBe(true);
      expect(result.messageCount).toBe(1);
      expect(result.totalTokens).toBe(1500);
      expect(result.costUSD).toBeCloseTo(expectedCost, 6);

      unlinkSync(testFile);
    });

    it('should handle cache tokens correctly', async () => {
      const testFile = `${TEST_DIR}/cache.jsonl`;

      const lines = [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T10:00:00.000Z',
          message: {
            model: 'claude-opus-4-5',
            role: 'assistant',
            usage: {
              input_tokens: 100,
              output_tokens: 200,
              cache_creation_input_tokens: 5000,
              cache_read_input_tokens: 10000
            }
          }
        })
      ];

      writeFileSync(testFile, lines.join('\n'));

      const result = await LocalCostCalculator.calculateCost(testFile);

      // Opus pricing: input=$15/1M, output=$75/1M
      // cache_creation = 1.25x input, cache_read = 0.1x input
      const inputCost = (100 / 1_000_000) * 15;
      const outputCost = (200 / 1_000_000) * 75;
      const cacheCreationCost = (5000 / 1_000_000) * 15 * 1.25;
      const cacheReadCost = (10000 / 1_000_000) * 15 * 0.10;
      const expectedCost = inputCost + outputCost + cacheCreationCost + cacheReadCost;

      expect(result.costUSD).toBeCloseTo(expectedCost, 6);
      expect(result.totalTokens).toBe(100 + 200 + 5000 + 10000);

      unlinkSync(testFile);
    });

    it('should calculate rates for multi-message sessions', async () => {
      const testFile = `${TEST_DIR}/multi.jsonl`;

      // Session with messages spanning 1 hour
      const lines = [
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T10:00:00.000Z',
          message: {
            model: 'claude-opus-4-5',
            usage: { input_tokens: 1000, output_tokens: 500 }
          }
        }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T11:00:00.000Z', // 1 hour later
          message: {
            model: 'claude-opus-4-5',
            usage: { input_tokens: 1000, output_tokens: 500 }
          }
        })
      ];

      writeFileSync(testFile, lines.join('\n'));

      const result = await LocalCostCalculator.calculateCost(testFile);

      expect(result.messageCount).toBe(2);
      expect(result.sessionDurationMs).toBe(60 * 60 * 1000); // 1 hour
      expect(result.costPerHour).toBeCloseTo(result.costUSD, 4); // Cost per hour ≈ total (1hr session)
      expect(result.tokensPerMinute).toBeCloseTo(result.totalTokens / 60, 0); // tokens/60 minutes

      unlinkSync(testFile);
    });

    it('should handle different model pricing', async () => {
      const testFile = `${TEST_DIR}/models.jsonl`;

      const lines = [
        // Haiku message
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T10:00:00.000Z',
          message: {
            model: 'claude-3-5-haiku-20241022',
            usage: { input_tokens: 1000, output_tokens: 1000 }
          }
        }),
        // Sonnet message
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T10:01:00.000Z',
          message: {
            model: 'claude-sonnet-4',
            usage: { input_tokens: 1000, output_tokens: 1000 }
          }
        }),
        // Opus message
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T10:02:00.000Z',
          message: {
            model: 'claude-opus-4-5',
            usage: { input_tokens: 1000, output_tokens: 1000 }
          }
        })
      ];

      writeFileSync(testFile, lines.join('\n'));

      const result = await LocalCostCalculator.calculateCost(testFile);

      // Haiku: $0.80 + $4 = $4.80/1M × 2K = $0.0096
      // Sonnet: $3 + $15 = $18/1M × 2K = $0.036
      // Opus: $15 + $75 = $90/1M × 2K = $0.18
      const haikuCost = (1000 / 1_000_000) * 0.80 + (1000 / 1_000_000) * 4;
      const sonnetCost = (1000 / 1_000_000) * 3 + (1000 / 1_000_000) * 15;
      const opusCost = (1000 / 1_000_000) * 15 + (1000 / 1_000_000) * 75;
      const expectedTotal = haikuCost + sonnetCost + opusCost;

      expect(result.costUSD).toBeCloseTo(expectedTotal, 6);
      expect(result.messageCount).toBe(3);

      unlinkSync(testFile);
    });

    it('should return empty result for missing file', async () => {
      const result = await LocalCostCalculator.calculateCost('/nonexistent/path.jsonl');

      expect(result.isFresh).toBe(false);
      expect(result.costUSD).toBe(0);
      expect(result.messageCount).toBe(0);
    });

    it('should handle malformed JSON lines gracefully', async () => {
      const testFile = `${TEST_DIR}/malformed.jsonl`;

      const lines = [
        '{ invalid json',
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-01-01T10:00:00.000Z',
          message: {
            model: 'claude-opus-4-5',
            usage: { input_tokens: 1000, output_tokens: 500 }
          }
        }),
        'another bad line',
        '',
        JSON.stringify({ type: 'user', message: 'ignored' })
      ];

      writeFileSync(testFile, lines.join('\n'));

      const result = await LocalCostCalculator.calculateCost(testFile);

      // Should only count the valid assistant message
      expect(result.messageCount).toBe(1);
      expect(result.isFresh).toBe(true);
      expect(result.costUSD).toBeGreaterThan(0);

      unlinkSync(testFile);
    });

    it('should respect maxLines limit', async () => {
      const testFile = `${TEST_DIR}/limited.jsonl`;

      // Create 100 messages
      const lines = [];
      for (let i = 0; i < 100; i++) {
        lines.push(JSON.stringify({
          type: 'assistant',
          timestamp: `2026-01-01T10:${String(i).padStart(2, '0')}:00.000Z`,
          message: {
            model: 'claude-opus-4-5',
            usage: { input_tokens: 100, output_tokens: 100 }
          }
        }));
      }

      writeFileSync(testFile, lines.join('\n'));

      const limited = await LocalCostCalculator.calculateCost(testFile, 10);
      const full = await LocalCostCalculator.calculateCost(testFile);

      expect(limited.messageCount).toBeLessThanOrEqual(10);
      expect(full.messageCount).toBe(100);

      unlinkSync(testFile);
    });
  });

  describe('estimateCostFromSize', () => {
    it('should estimate cost from file size', () => {
      const testFile = `${TEST_DIR}/size-test.jsonl`;

      // Create a 100KB file
      const content = 'x'.repeat(100 * 1024);
      writeFileSync(testFile, content);

      const estimate = LocalCostCalculator.estimateCostFromSize(testFile);

      // Expected: 100KB × $0.02/100KB = $0.02
      expect(estimate).toBeCloseTo(0.02, 2);

      unlinkSync(testFile);
    });

    it('should return 0 for nonexistent file', () => {
      const estimate = LocalCostCalculator.estimateCostFromSize('/nonexistent.jsonl');
      expect(estimate).toBe(0);
    });
  });

  describe('Real transcript parsing', () => {
    it('should parse real session transcript without error', async () => {
      // Use the actual current session transcript if available
      const realPath = `${homedir()}/.claude/projects/-Users-vmks--IT-Projects--aigile-os-ingestion/44be6263-d9b6-44f4-9222-4fc81f160b58.jsonl`;

      if (existsSync(realPath)) {
        const result = await LocalCostCalculator.calculateCost(realPath);

        console.log('\n=== REAL TRANSCRIPT PARSE ===');
        console.log(`Cost: $${result.costUSD.toFixed(2)}`);
        console.log(`Messages: ${result.messageCount}`);
        console.log(`Tokens: ${result.totalTokens.toLocaleString()}`);
        console.log(`Burn rate: $${result.costPerHour?.toFixed(2)}/hr`);
        console.log('=============================\n');

        expect(result.isFresh).toBe(true);
        expect(result.messageCount).toBeGreaterThan(0);
        expect(result.costUSD).toBeGreaterThan(0);
      } else {
        console.log('Skipping real transcript test - file not found');
        expect(true).toBe(true);
      }
    });
  });
});
