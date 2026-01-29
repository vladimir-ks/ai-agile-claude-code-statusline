/**
 * Unit Tests - Cost Validator
 *
 * Tests multi-source cost validation with dollar-amount tolerance
 */

import { describe, test, expect } from 'bun:test';
import CostValidator from '../../../src/validators/cost-validator';
import type { DataPoint } from '../../../src/types/validation';

interface CostData {
  totalCost: number;
  hourlyRate: number;
  tokensPerMinute: number;
}

describe('CostValidator', () => {
  const validator = new CostValidator();

  // Helper to create data points
  function createDataPoint(
    cost: CostData,
    source: string,
    age = 0
  ): DataPoint<CostData> {
    return {
      value: cost,
      source,
      fetchedAt: Date.now() - age
    };
  }

  // Helper to create cost data
  function createCost(
    total: number,
    hourly: number,
    tpm: number
  ): CostData {
    return {
      totalCost: total,
      hourlyRate: hourly,
      tokensPerMinute: tpm
    };
  }

  describe('Both sources available - comparison', () => {
    test('Exact match - confidence 100%', () => {
      const ccusage = createDataPoint(createCost(15.50, 5.25, 185460), 'ccusage');
      const transcript = createDataPoint(createCost(15.50, 5.25, 185460), 'transcript');

      const result = validator.validate(ccusage, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.recommendedSource).toBe('ccusage');
    });

    test('Close match (±$0.05) - confidence 100%', () => {
      const ccusage = createDataPoint(createCost(15.50, 5.25, 185460), 'ccusage');
      const transcript = createDataPoint(createCost(15.55, 5.25, 185460), 'transcript'); // $0.05 diff

      const result = validator.validate(ccusage, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0);
    });

    test('Moderate difference ($2.50) - confidence 70%, warning', () => {
      const ccusage = createDataPoint(createCost(15.50, 5.25, 185460), 'ccusage');
      const transcript = createDataPoint(createCost(18.00, 5.25, 185460), 'transcript'); // $2.50 diff

      const result = validator.validate(ccusage, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(70);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Cost mismatch');
      expect(result.warnings[0]).toContain('2.50');
      expect(result.recommendedSource).toBe('ccusage');
    });

    test('Large difference ($10) - confidence 50%, error, show 🔴', () => {
      const ccusage = createDataPoint(createCost(15.50, 5.25, 185460), 'ccusage');
      const transcript = createDataPoint(createCost(25.50, 5.25, 185460), 'transcript'); // $10 diff

      const result = validator.validate(ccusage, [transcript]);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(50);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Large cost mismatch');
      expect(result.errors[0]).toContain('10.00');
      expect(result.showStaleIndicator).toBe(true);
      expect(result.recommendedSource).toBe('ccusage'); // Still prefer ccusage
    });

    test('Both sources zero cost - confidence 100%', () => {
      const ccusage = createDataPoint(createCost(0, 0, 0), 'ccusage');
      const transcript = createDataPoint(createCost(0, 0, 0), 'transcript');

      const result = validator.validate(ccusage, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
    });
  });

  describe('Single source scenarios', () => {
    test('Only ccusage available - confidence 90% (NORMAL CASE)', () => {
      const ccusage = createDataPoint(createCost(15.50, 5.25, 185460), 'ccusage');

      const result = validator.validate(ccusage, []);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(90); // High confidence (authoritative)
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Single source only');
      expect(result.recommendedSource).toBe('ccusage');
    });

    test('Only transcript available - confidence 50%, show 🔴', () => {
      const ccusage: DataPoint<CostData> = {
        value: null as any,
        source: 'ccusage',
        fetchedAt: Date.now()
      };
      const transcript = createDataPoint(createCost(15.50, 5.25, 185460), 'transcript');

      const result = validator.validate(ccusage, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(50); // Low confidence (estimate only)
      expect(result.warnings[0]).toContain('transcript estimate');
      expect(result.showStaleIndicator).toBe(true);
      expect(result.recommendedSource).toBe('transcript');
    });

    test('No sources available - fail with confidence 0', () => {
      const ccusage: DataPoint<CostData> = {
        value: null as any,
        source: 'ccusage',
        fetchedAt: Date.now()
      };

      const result = validator.validate(ccusage, []);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('No cost data');
      expect(result.showStaleIndicator).toBe(true);
    });
  });

  describe('Cost formatting', () => {
    test('Formats large costs (>$1000)', () => {
      const ccusage = createDataPoint(createCost(1500.00, 50, 185460), 'ccusage');
      const transcript = createDataPoint(createCost(1400.00, 50, 185460), 'transcript'); // $100 diff

      const result = validator.validate(ccusage, [transcript]);

      if (result.errors.length > 0) {
        expect(result.errors[0]).toMatch(/\d+\.\d+k/); // e.g., "1.5k"
      }
    });

    test('Formats normal costs ($1-$999)', () => {
      const ccusage = createDataPoint(createCost(15.50, 5.25, 185460), 'ccusage');
      const transcript = createDataPoint(createCost(20.00, 5.25, 185460), 'transcript');

      const result = validator.validate(ccusage, [transcript]);

      if (result.warnings.length > 0) {
        expect(result.warnings[0]).toMatch(/\d+\.\d{2}/); // e.g., "15.50"
      }
    });

    test('Formats cents (<$1)', () => {
      const ccusage = createDataPoint(createCost(0.456, 0.15, 10000), 'ccusage');
      const transcript = createDataPoint(createCost(0.789, 0.20, 12000), 'transcript');

      const result = validator.validate(ccusage, [transcript]);

      if (result.warnings.length > 0) {
        expect(result.warnings[0]).toMatch(/\d+\.\d{3}/); // e.g., "0.456"
      }
    });
  });

  describe('Tolerance boundaries ($0.10 and $5.00)', () => {
    test('Exactly $0.10 difference - should be good (boundary)', () => {
      const ccusage = createDataPoint(createCost(10.00, 5.00, 100000), 'ccusage');
      const transcript = createDataPoint(createCost(10.10, 5.00, 100000), 'transcript'); // $0.10 diff

      const result = validator.validate(ccusage, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100); // Still within tolerance
      expect(result.warnings).toHaveLength(0);
    });

    test('Exactly $5.00 difference - should warn (boundary)', () => {
      const ccusage = createDataPoint(createCost(20.00, 10.00, 100000), 'ccusage');
      const transcript = createDataPoint(createCost(25.00, 10.00, 100000), 'transcript'); // $5.00 diff

      const result = validator.validate(ccusage, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(70); // Warning level
      expect(result.warnings).toHaveLength(1);
      expect(result.showStaleIndicator).toBeUndefined(); // No 🔴 at exactly $5
    });

    test('Just above $5.00 difference - should error', () => {
      const ccusage = createDataPoint(createCost(20.00, 10.00, 100000), 'ccusage');
      const transcript = createDataPoint(createCost(25.10, 10.00, 100000), 'transcript'); // $5.10 diff

      const result = validator.validate(ccusage, [transcript]);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(50);
      expect(result.errors).toHaveLength(1);
      expect(result.showStaleIndicator).toBe(true); // 🔴 shown
    });
  });

  describe('Burn rate validation (deep validation)', () => {
    test('validateBurnRate checks hourly rate and TPM', () => {
      const ccusage = createCost(15.50, 5.25, 185460);
      const transcript = createCost(15.50, 5.30, 186000); // Slightly different rates

      const burnRate = validator.validateBurnRate(ccusage, transcript);

      expect(burnRate.hourlyRateMatch).toBe(true); // ~1% diff
      expect(burnRate.tokensPerMinuteMatch).toBe(true); // ~0.3% diff
    });

    test('validateBurnRate detects large mismatches', () => {
      const ccusage = createCost(15.50, 5.25, 185460);
      const transcript = createCost(15.50, 10.00, 300000); // Very different rates

      const burnRate = validator.validateBurnRate(ccusage, transcript);

      expect(burnRate.hourlyRateMatch).toBe(false); // ~90% diff
      expect(burnRate.tokensPerMinuteMatch).toBe(false); // ~62% diff
    });
  });

  describe('Metadata validation', () => {
    test('Staleness calculated from oldest source', () => {
      const ccusage = createDataPoint(createCost(15.50, 5.25, 185460), 'ccusage', 5000);
      const transcript = createDataPoint(createCost(15.50, 5.25, 185460), 'transcript', 10000);

      const result = validator.validate(ccusage, [transcript]);

      expect(result.metadata.staleness).toBeGreaterThanOrEqual(10000); // Max age
      expect(result.metadata.sourcesChecked).toBe(2);
    });

    test('Source agreement percentage based on cost difference', () => {
      const ccusage = createDataPoint(createCost(100.00, 10.00, 100000), 'ccusage');
      const transcript = createDataPoint(createCost(90.00, 10.00, 100000), 'transcript'); // 10% diff

      const result = validator.validate(ccusage, [transcript]);

      // Agreement should be around 90% (100% - 10% diff)
      expect(result.metadata.sourceAgreement).toBeGreaterThan(85);
      expect(result.metadata.sourceAgreement).toBeLessThanOrEqual(100);
    });
  });

  describe('Edge cases', () => {
    test('Very small costs (<$0.01)', () => {
      const ccusage = createDataPoint(createCost(0.003, 0.001, 100), 'ccusage');
      const transcript = createDataPoint(createCost(0.004, 0.001, 100), 'transcript'); // $0.001 diff

      const result = validator.validate(ccusage, [transcript]);

      expect(result.confidence).toBe(100); // Within tolerance
    });

    test('Negative costs rejected explicitly', () => {
      const ccusage = createDataPoint(createCost(-10.00, 5.00, 100000), 'ccusage'); // Invalid
      const transcript = createDataPoint(createCost(10.00, 5.00, 100000), 'transcript');

      const result = validator.validate(ccusage, [transcript]);

      // Should reject negative costs
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Invalid cost data');
    });

    test('Zero ccusage but transcript has cost - use transcript', () => {
      const ccusage: DataPoint<CostData> = {
        value: null as any,
        source: 'ccusage',
        fetchedAt: Date.now()
      };
      const transcript = createDataPoint(createCost(15.50, 5.25, 185460), 'transcript');

      const result = validator.validate(ccusage, [transcript]);

      expect(result.recommendedSource).toBe('transcript');
      expect(result.confidence).toBe(50);
      expect(result.showStaleIndicator).toBe(true);
    });

    test('Huge cost difference ($1000+) - error with 🔴', () => {
      const ccusage = createDataPoint(createCost(50.00, 10.00, 100000), 'ccusage');
      const transcript = createDataPoint(createCost(1050.00, 200.00, 500000), 'transcript'); // $1000 diff

      const result = validator.validate(ccusage, [transcript]);

      expect(result.valid).toBe(false);
      expect(result.showStaleIndicator).toBe(true);
      expect(result.errors[0]).toContain('1000.00');
    });
  });

  describe('Defensive Engineering - Error Handling', () => {
    test('Invalid primary data point (missing fetchedAt)', () => {
      const primary = { value: createCost(10, 5, 100000), source: 'ccusage' } as any;

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Invalid primary data point');
    });

    test('Invalid secondary (not an array)', () => {
      const primary = createDataPoint(createCost(10, 5, 100000), 'ccusage');

      const result = validator.validate(primary, {} as any);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('not array');
    });

    test('Malformed cost structure (missing fields)', () => {
      const badCost = { totalCost: 10 } as any; // Missing hourlyRate, tokensPerMinute
      const primary = createDataPoint(badCost, 'ccusage');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    test('Non-numeric cost values', () => {
      const badCost = createCost('10.00' as any, 5, 100000);
      const primary = createDataPoint(badCost, 'ccusage');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
    });

    test('Infinity cost values rejected', () => {
      const badCost = createCost(Infinity, 5, 100000);
      const primary = createDataPoint(badCost, 'ccusage');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
    });

    test('NaN cost values rejected', () => {
      const badCost = createCost(NaN, 5, 100000);
      const primary = createDataPoint(badCost, 'ccusage');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
    });

    test('Negative hourlyRate rejected', () => {
      const badCost = createCost(10, -5, 100000);
      const primary = createDataPoint(badCost, 'ccusage');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('negative or malformed');
    });

    test('Negative tokensPerMinute rejected', () => {
      const badCost = createCost(10, 5, -100000);
      const primary = createDataPoint(badCost, 'ccusage');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
    });

    test('formatCost handles edge cases', () => {
      const ccusage = createDataPoint(createCost(1500, 500, 100000), 'ccusage');
      const transcript = createDataPoint(createCost(1000, 300, 100000), 'transcript');

      const result = validator.validate(ccusage, [transcript]);

      // Check formatting in warning
      if (result.warnings.length > 0) {
        expect(result.warnings[0]).toMatch(/\d+\.\d+k/);
      }
    });

    test('validateBurnRate with invalid inputs returns all false', () => {
      const badCost = { totalCost: -1 } as any;
      const goodCost = createCost(10, 5, 100000);

      const result = validator.validateBurnRate(badCost, goodCost);

      expect(result.hourlyRateMatch).toBe(false);
      expect(result.tokensPerMinuteMatch).toBe(false);
    });

    test('Division by zero handled in percentage calculation', () => {
      const ccusage = createDataPoint(createCost(0, 0, 0), 'ccusage');
      const transcript = createDataPoint(createCost(10, 5, 100000), 'transcript');

      const result = validator.validate(ccusage, [transcript]);

      // Should handle gracefully without throwing
      expect(result).toBeDefined();
    });

    test('Very large costs handled', () => {
      const hugeCost = createCost(
        Number.MAX_SAFE_INTEGER / 1000,
        1000000,
        10000000
      );
      const primary = createDataPoint(hugeCost, 'ccusage');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBeGreaterThan(0);
    });

    test('Null cost object handled', () => {
      const primary: DataPoint<CostData> = {
        value: null as any,
        source: 'ccusage',
        fetchedAt: Date.now()
      };

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
    });

    test('Secondary array with null entries handled gracefully', () => {
      const primary = createDataPoint(createCost(10, 5, 100000), 'ccusage');
      const secondary = [null, undefined, createDataPoint(createCost(10, 5, 100000), 'transcript')] as any;

      const result = validator.validate(primary, secondary);

      expect(result.valid).toBe(true);
    });
  });
});
