/**
 * Unit Tests - Context Validator
 *
 * Tests multi-source context token validation with tolerance
 */

import { describe, test, expect } from 'bun:test';
import ContextValidator from '../../../src/validators/context-validator';
import type { DataPoint } from '../../../src/types/validation';

interface ContextTokens {
  currentInputTokens: number;
  cacheReadTokens: number;
  currentOutputTokens: number;
  totalCurrentTokens: number;
}

describe('ContextValidator', () => {
  const validator = new ContextValidator();

  // Helper to create data points
  function createDataPoint(
    tokens: ContextTokens,
    source: string,
    age = 0
  ): DataPoint<ContextTokens> {
    return {
      value: tokens,
      source,
      fetchedAt: Date.now() - age
    };
  }

  // Helper to create token data
  function createTokens(input: number, cache: number, output: number): ContextTokens {
    return {
      currentInputTokens: input,
      cacheReadTokens: cache,
      currentOutputTokens: output,
      totalCurrentTokens: input + cache + output
    };
  }

  describe('Both sources available - comparison', () => {
    test('Exact match - confidence 100%', () => {
      const json = createDataPoint(createTokens(50000, 50000, 0), 'json');
      const transcript = createDataPoint(createTokens(50000, 50000, 0), 'transcript');

      const result = validator.validate(json, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.recommendedSource).toBe('json');
    });

    test('Close match (±5%) - confidence 100%', () => {
      const json = createDataPoint(createTokens(50000, 50000, 0), 'json'); // 100k total
      const transcript = createDataPoint(createTokens(47000, 48000, 0), 'transcript'); // 95k total (5% diff)

      const result = validator.validate(json, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0);
      expect(result.metadata.sourceAgreement).toBeGreaterThan(90);
    });

    test('Moderate mismatch (20%) - confidence 60%, warning', () => {
      const json = createDataPoint(createTokens(50000, 50000, 0), 'json'); // 100k total
      const transcript = createDataPoint(createTokens(40000, 40000, 0), 'transcript'); // 80k total (20% diff)

      const result = validator.validate(json, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(60);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Token count mismatch');
      expect(result.warnings[0]).toContain('20%');
      expect(result.recommendedSource).toBe('json'); // Prefer JSON
    });

    test('Large mismatch (60%) - confidence 30%, error, show 🔴', () => {
      const json = createDataPoint(createTokens(100000, 0, 0), 'json'); // 100k total
      const transcript = createDataPoint(createTokens(20000, 20000, 0), 'transcript'); // 40k total (60% diff)

      const result = validator.validate(json, [transcript]);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(30);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Large token count mismatch');
      expect(result.errors[0]).toContain('60%');
      expect(result.showStaleIndicator).toBe(true);
      expect(result.recommendedSource).toBe('json'); // Still prefer JSON
    });

    test('Both sources zero tokens - confidence 100%', () => {
      const json = createDataPoint(createTokens(0, 0, 0), 'json');
      const transcript = createDataPoint(createTokens(0, 0, 0), 'transcript');

      const result = validator.validate(json, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.recommendedSource).toBe('json');
    });
  });

  describe('Single source scenarios', () => {
    test('Only JSON available - confidence 80%', () => {
      const json = createDataPoint(createTokens(50000, 50000, 0), 'json');

      const result = validator.validate(json, []);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(80);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Single source only');
      expect(result.recommendedSource).toBe('json');
    });

    test('Only transcript available - confidence 60%, show 🔴', () => {
      const json = createDataPoint(createTokens(0, 0, 0), 'json'); // Treat as unavailable
      const transcript = createDataPoint(createTokens(50000, 50000, 0), 'transcript');

      // Simulate empty JSON by passing value: null
      const emptyJson: DataPoint<ContextTokens> = {
        value: null as any,
        source: 'json',
        fetchedAt: Date.now()
      };

      const result = validator.validate(emptyJson, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(60);
      expect(result.warnings[0]).toContain('transcript estimate');
      expect(result.showStaleIndicator).toBe(true); // Lower confidence
      expect(result.recommendedSource).toBe('transcript');
    });

    test('No sources available - fail with confidence 0', () => {
      const emptyJson: DataPoint<ContextTokens> = {
        value: null as any,
        source: 'json',
        fetchedAt: Date.now()
      };

      const result = validator.validate(emptyJson, []);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('No context token data');
      expect(result.showStaleIndicator).toBe(true);
    });
  });

  describe('Token formatting', () => {
    test('Formats large numbers (millions)', () => {
      const json = createDataPoint(createTokens(1000000, 500000, 0), 'json'); // 1.5M
      const transcript = createDataPoint(createTokens(900000, 400000, 0), 'transcript'); // 1.3M

      const result = validator.validate(json, [transcript]);

      // Check warning contains formatted numbers
      if (result.warnings.length > 0) {
        expect(result.warnings[0]).toMatch(/\d+\.\d+M/); // e.g., "1.5M"
      }
    });

    test('Formats thousands (k)', () => {
      const json = createDataPoint(createTokens(50000, 50000, 0), 'json'); // 100k
      const transcript = createDataPoint(createTokens(40000, 40000, 0), 'transcript'); // 80k

      const result = validator.validate(json, [transcript]);

      if (result.warnings.length > 0) {
        expect(result.warnings[0]).toMatch(/\d+k/); // e.g., "100k"
      }
    });

    test('Formats small numbers (raw)', () => {
      const json = createDataPoint(createTokens(500, 300, 0), 'json'); // 800
      const transcript = createDataPoint(createTokens(400, 200, 0), 'transcript'); // 600

      const result = validator.validate(json, [transcript]);

      if (result.warnings.length > 0) {
        expect(result.warnings[0]).toMatch(/\d{3}/); // Raw number
      }
    });
  });

  describe('Tolerance boundaries (10% and 50%)', () => {
    test('Exactly 10% difference - should be good (boundary)', () => {
      const json = createDataPoint(createTokens(100000, 0, 0), 'json'); // 100k
      const transcript = createDataPoint(createTokens(90000, 0, 0), 'transcript'); // 90k (10% diff)

      const result = validator.validate(json, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100); // Still within tolerance
      expect(result.warnings).toHaveLength(0);
    });

    test('Exactly 50% difference - should warn (boundary)', () => {
      const json = createDataPoint(createTokens(100000, 0, 0), 'json'); // 100k
      const transcript = createDataPoint(createTokens(50000, 0, 0), 'transcript'); // 50k (50% diff)

      const result = validator.validate(json, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(60); // Warning level
      expect(result.warnings).toHaveLength(1);
      expect(result.showStaleIndicator).toBeUndefined(); // No 🔴 at exactly 50%
    });

    test('Just above 50% difference - should error', () => {
      const json = createDataPoint(createTokens(100000, 0, 0), 'json'); // 100k
      const transcript = createDataPoint(createTokens(49000, 0, 0), 'transcript'); // 49k (51% diff)

      const result = validator.validate(json, [transcript]);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(30);
      expect(result.errors).toHaveLength(1);
      expect(result.showStaleIndicator).toBe(true); // 🔴 shown
    });
  });

  describe('Metadata validation', () => {
    test('Staleness calculated from oldest source', () => {
      const json = createDataPoint(createTokens(100000, 0, 0), 'json', 5000); // 5s old
      const transcript = createDataPoint(createTokens(100000, 0, 0), 'transcript', 10000); // 10s old

      const result = validator.validate(json, [transcript]);

      expect(result.metadata.staleness).toBeGreaterThanOrEqual(10000); // Max age
      expect(result.metadata.sourcesChecked).toBe(2);
    });

    test('Source agreement percentage correct', () => {
      const json = createDataPoint(createTokens(100000, 0, 0), 'json');
      const transcript = createDataPoint(createTokens(80000, 0, 0), 'transcript'); // 20% diff

      const result = validator.validate(json, [transcript]);

      // Agreement should be around 80% (100% - 20% diff)
      expect(result.metadata.sourceAgreement).toBeGreaterThan(70);
      expect(result.metadata.sourceAgreement).toBeLessThan(85);
    });
  });

  describe('Breakdown validation (deep validation)', () => {
    test('validateBreakdown checks individual components', () => {
      const json = createTokens(50000, 50000, 10000); // 110k total
      const transcript = createTokens(49000, 51000, 10000); // 110k total (components differ slightly)

      const breakdown = validator.validateBreakdown(json, transcript);

      expect(breakdown.inputMatch).toBe(true); // 50k vs 49k (2% diff)
      expect(breakdown.cacheMatch).toBe(true); // 50k vs 51k (2% diff)
      expect(breakdown.outputMatch).toBe(true); // 10k vs 10k (exact)
    });

    test('validateBreakdown detects component mismatches', () => {
      const json = createTokens(100000, 0, 0); // 100k total
      const transcript = createTokens(0, 0, 100000); // 100k total (but different components)

      const breakdown = validator.validateBreakdown(json, transcript);

      expect(breakdown.inputMatch).toBe(false); // 100k vs 0 (100% diff)
      expect(breakdown.cacheMatch).toBe(true); // 0 vs 0 (match)
      expect(breakdown.outputMatch).toBe(false); // 0 vs 100k (100% diff)
    });
  });

  describe('Edge cases', () => {
    test('JSON zero but transcript has tokens - use transcript', () => {
      const json: DataPoint<ContextTokens> = {
        value: null as any,
        source: 'json',
        fetchedAt: Date.now()
      };
      const transcript = createDataPoint(createTokens(50000, 50000, 0), 'transcript');

      const result = validator.validate(json, [transcript]);

      expect(result.recommendedSource).toBe('transcript');
      expect(result.confidence).toBe(60);
    });

    test('Very small difference (<1%) - confidence 100%', () => {
      const json = createDataPoint(createTokens(100000, 0, 0), 'json');
      const transcript = createDataPoint(createTokens(99900, 0, 0), 'transcript'); // 0.1% diff

      const result = validator.validate(json, [transcript]);

      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0);
    });

    test('Negative tokens handled gracefully', () => {
      const json = createDataPoint(createTokens(-1000, 0, 0), 'json'); // Invalid
      const transcript = createDataPoint(createTokens(50000, 0, 0), 'transcript');

      const result = validator.validate(json, [transcript]);

      // Should reject negative tokens
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Invalid token counts');
    });
  });

  describe('Defensive Engineering - Error Handling', () => {
    test('Invalid primary data point (missing fetchedAt)', () => {
      const primary = { value: createTokens(100000, 0, 0), source: 'json' } as any;

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Invalid primary data point');
    });

    test('Invalid secondary (not an array)', () => {
      const primary = createDataPoint(createTokens(100000, 0, 0), 'json');

      const result = validator.validate(primary, {} as any);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('not array');
    });

    test('Malformed token structure (missing fields)', () => {
      const badTokens = { currentInputTokens: 100000 } as any; // Missing other fields
      const primary = createDataPoint(badTokens, 'json');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    test('Non-numeric token values', () => {
      const badTokens = createTokens('100000' as any, 0, 0);
      const primary = createDataPoint(badTokens, 'json');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    test('Infinity token values rejected', () => {
      const badTokens = createTokens(Infinity, 0, 0);
      const primary = createDataPoint(badTokens, 'json');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    test('NaN token values rejected', () => {
      const badTokens = createTokens(NaN, 0, 0);
      const primary = createDataPoint(badTokens, 'json');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    test('Negative tokens in comparison rejected', () => {
      const json = createDataPoint(createTokens(100000, -5000, 0), 'json');
      const transcript = createDataPoint(createTokens(100000, 0, 0), 'transcript');

      const result = validator.validate(json, [transcript]);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid token counts');
    });

    test('Division by zero handled (both sources zero)', () => {
      const json = createDataPoint(createTokens(0, 0, 0), 'json');
      const transcript = createDataPoint(createTokens(0, 0, 0), 'transcript');

      const result = validator.validate(json, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
    });

    test('Very large token counts handled', () => {
      const hugeTokens = createTokens(
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER,
        0
      );
      const primary = createDataPoint(hugeTokens, 'json');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBeGreaterThan(0);
    });

    test('Null token object handled', () => {
      const primary: DataPoint<ContextTokens> = {
        value: null as any,
        source: 'json',
        fetchedAt: Date.now()
      };

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    test('validateBreakdown with invalid inputs returns all false', () => {
      const badTokens = { currentInputTokens: -1 } as any;
      const goodTokens = createTokens(100000, 0, 0);

      const result = validator.validateBreakdown(badTokens, goodTokens);

      expect(result.inputMatch).toBe(false);
      expect(result.cacheMatch).toBe(false);
      expect(result.outputMatch).toBe(false);
    });

    test('formatTokens handles edge cases', () => {
      // Access private method through validation result warnings
      const json = createDataPoint(createTokens(1500000, 0, 0), 'json');
      const transcript = createDataPoint(createTokens(1000000, 0, 0), 'transcript');

      const result = validator.validate(json, [transcript]);

      // Check formatting in warning message
      if (result.warnings.length > 0) {
        expect(result.warnings[0]).toMatch(/\d+\.\d+M/);
      }
    });

    test('Secondary array with null entries handled gracefully', () => {
      const primary = createDataPoint(createTokens(100000, 0, 0), 'json');
      const secondary = [null, undefined, createDataPoint(createTokens(100000, 0, 0), 'transcript')] as any;

      const result = validator.validate(primary, secondary);

      expect(result.valid).toBe(true);
    });

    test('Error message truncation (very long errors)', () => {
      // Force an error with a very long message
      const primary = {
        value: null as any,
        source: 'json'.repeat(100), // Very long source name
        fetchedAt: Date.now()
      };

      const result = validator.validate(primary, []);

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].length).toBeLessThanOrEqual(200);
    });
  });
});
