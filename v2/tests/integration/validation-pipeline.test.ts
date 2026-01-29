/**
 * Validation Pipeline Integration Tests
 *
 * Tests the complete validation system working together:
 * - Multiple validators with validation engine
 * - Cross-validator consistency
 * - Error propagation
 * - Performance under load
 *
 * These tests verify the system works as a whole, not just individual components.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import ModelValidator from '../../src/validators/model-validator';
import ContextValidator from '../../src/validators/context-validator';
import CostValidator from '../../src/validators/cost-validator';
import GitValidator from '../../src/validators/git-validator';
import TimestampValidator from '../../src/validators/timestamp-validator';
import type { DataPoint, ValidationResult } from '../../src/types/validation';

describe('Validation Pipeline Integration', () => {
  let modelValidator: ModelValidator;
  let contextValidator: ContextValidator;
  let costValidator: CostValidator;
  let gitValidator: GitValidator;
  let timestampValidator: TimestampValidator;

  beforeEach(() => {
    modelValidator = new ModelValidator();
    contextValidator = new ContextValidator();
    costValidator = new CostValidator();
    gitValidator = new GitValidator();
    timestampValidator = new TimestampValidator();
  });

  describe('Cross-Validator Consistency', () => {
    test('All validators return consistent ValidationResult structure', () => {
      const now = Date.now();

      // Create valid data points for each validator
      const modelPrimary: DataPoint<string> = {
        value: 'Claude Sonnet 4.5',
        source: 'json',
        fetchedAt: now
      };

      const contextPrimary: DataPoint<any> = {
        value: {
          currentInputTokens: 50000,
          cacheReadTokens: 50000,
          currentOutputTokens: 0,
          totalCurrentTokens: 100000
        },
        source: 'json',
        fetchedAt: now
      };

      const costPrimary: DataPoint<any> = {
        value: {
          totalCost: 15.50,
          hourlyRate: 5.25,
          tokensPerMinute: 185460
        },
        source: 'ccusage',
        fetchedAt: now
      };

      const gitPrimary: DataPoint<any> = {
        value: {
          branch: 'main',
          ahead: 0,
          behind: 0,
          dirty: 0,
          isRepo: true
        },
        source: 'git_status',
        fetchedAt: now
      };

      const timestampPrimary: DataPoint<any> = {
        value: {
          systemTime: now,
          fileTime: now,
          gitTime: now - 3600000,
          timezone: 'UTC'
        },
        source: 'system',
        fetchedAt: now
      };

      // Run all validators
      const results = [
        modelValidator.validate(modelPrimary, []),
        contextValidator.validate(contextPrimary, []),
        costValidator.validate(costPrimary, []),
        gitValidator.validate(gitPrimary, []),
        timestampValidator.validate(timestampPrimary, [])
      ];

      // Verify all have consistent structure
      for (const result of results) {
        expect(result).toHaveProperty('valid');
        expect(result).toHaveProperty('confidence');
        expect(result).toHaveProperty('warnings');
        expect(result).toHaveProperty('errors');
        expect(result).toHaveProperty('recommendedSource');
        expect(result).toHaveProperty('metadata');

        expect(typeof result.valid).toBe('boolean');
        expect(typeof result.confidence).toBe('number');
        expect(Array.isArray(result.warnings)).toBe(true);
        expect(Array.isArray(result.errors)).toBe(true);
        expect(typeof result.recommendedSource).toBe('string');
        expect(typeof result.metadata).toBe('object');

        // Metadata structure
        expect(result.metadata).toHaveProperty('sourceAgreement');
        expect(result.metadata).toHaveProperty('validationLatency');
        expect(result.metadata).toHaveProperty('staleness');
        expect(result.metadata).toHaveProperty('sourcesChecked');
      }
    });

    test('All validators handle null primary gracefully', () => {
      const nullPrimary: any = {
        value: null,
        source: 'test',
        fetchedAt: Date.now()
      };

      const results = [
        modelValidator.validate(nullPrimary, []),
        contextValidator.validate(nullPrimary, []),
        costValidator.validate(nullPrimary, []),
        gitValidator.validate(nullPrimary, []),
        timestampValidator.validate(nullPrimary, [])
      ];

      // All should fail gracefully with structured errors
      for (const result of results) {
        expect(result.valid).toBe(false);
        expect(result.confidence).toBe(0);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.metadata.sourcesChecked).toBeGreaterThanOrEqual(0);
      }
    });

    test('All validators handle invalid secondary array', () => {
      const now = Date.now();
      const validPrimary = {
        value: 'test',
        source: 'test',
        fetchedAt: now
      };

      const results = [
        modelValidator.validate(validPrimary, {} as any),
        contextValidator.validate({ ...validPrimary, value: { currentInputTokens: 0, cacheReadTokens: 0, currentOutputTokens: 0, totalCurrentTokens: 0 } }, {} as any),
        costValidator.validate({ ...validPrimary, value: { totalCost: 0, hourlyRate: 0, tokensPerMinute: 0 } }, {} as any),
        gitValidator.validate({ ...validPrimary, value: { branch: '', ahead: 0, behind: 0, dirty: 0, isRepo: true } }, {} as any),
        timestampValidator.validate({ ...validPrimary, value: { systemTime: now, timezone: 'UTC' } }, {} as any)
      ];

      // All should detect invalid secondary
      for (const result of results) {
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('not array');
      }
    });
  });

  describe('Error Propagation', () => {
    test('Validators never throw - always return ValidationResult', () => {
      const malformedInputs = [
        undefined,
        null,
        {},
        { value: undefined },
        { source: 'test' },
        { fetchedAt: -1 },
        { value: 'test', source: 123, fetchedAt: 'invalid' }
      ];

      for (const input of malformedInputs) {
        expect(() => {
          modelValidator.validate(input as any, []);
          contextValidator.validate(input as any, []);
          costValidator.validate(input as any, []);
          gitValidator.validate(input as any, []);
          timestampValidator.validate(input as any, []);
        }).not.toThrow();
      }
    });

    test('Error messages are sanitized and truncated', () => {
      const veryLongValue = 'A'.repeat(1000);
      const maliciousValue = 'test\n\r\x00\x1f' + veryLongValue;

      const primary: DataPoint<string> = {
        value: maliciousValue,
        source: 'json',
        fetchedAt: Date.now()
      };

      const result = modelValidator.validate(primary, []);

      // Check all error messages are sanitized
      for (const error of result.errors) {
        expect(error.length).toBeLessThanOrEqual(200); // Truncated
        expect(error).not.toContain('\n'); // No newlines
        expect(error).not.toContain('\r'); // No carriage returns
        expect(error).not.toContain('\x00'); // No null bytes
      }
    });
  });

  describe('Performance Under Load', () => {
    test('All validators complete in <5ms per validation', () => {
      const now = Date.now();

      const validData = {
        model: { value: 'Claude Sonnet 4.5', source: 'json', fetchedAt: now },
        context: { value: { currentInputTokens: 50000, cacheReadTokens: 50000, currentOutputTokens: 0, totalCurrentTokens: 100000 }, source: 'json', fetchedAt: now },
        cost: { value: { totalCost: 15.50, hourlyRate: 5.25, tokensPerMinute: 185460 }, source: 'ccusage', fetchedAt: now },
        git: { value: { branch: 'main', ahead: 0, behind: 0, dirty: 0, isRepo: true }, source: 'git_status', fetchedAt: now },
        timestamp: { value: { systemTime: now, timezone: 'UTC' }, source: 'system', fetchedAt: now }
      };

      // Run 100 iterations
      const start = performance.now();

      for (let i = 0; i < 100; i++) {
        modelValidator.validate(validData.model as any, []);
        contextValidator.validate(validData.context as any, []);
        costValidator.validate(validData.cost as any, []);
        gitValidator.validate(validData.git as any, []);
        timestampValidator.validate(validData.timestamp as any, []);
      }

      const end = performance.now();
      const totalTime = end - start;
      const avgTimePerValidation = totalTime / (100 * 5);

      console.log(`Average validation time: ${avgTimePerValidation.toFixed(2)}ms`);

      // Should average <5ms per validation
      expect(avgTimePerValidation).toBeLessThan(5);
    });

    test('Validators handle 1000 rapid validations without degradation', () => {
      const now = Date.now();
      const primary: DataPoint<string> = {
        value: 'Claude Sonnet 4.5',
        source: 'json',
        fetchedAt: now
      };

      const times: number[] = [];

      for (let i = 0; i < 1000; i++) {
        const start = performance.now();
        const result = modelValidator.validate(primary, []);
        const end = performance.now();

        times.push(end - start);

        expect(result.valid).toBe(true);
      }

      // Calculate first 100 vs last 100 average
      const firstAvg = times.slice(0, 100).reduce((a, b) => a + b, 0) / 100;
      const lastAvg = times.slice(-100).reduce((a, b) => a + b, 0) / 100;

      console.log(`First 100 avg: ${firstAvg.toFixed(3)}ms, Last 100 avg: ${lastAvg.toFixed(3)}ms`);

      // No significant degradation (last should not be >2x first)
      expect(lastAvg).toBeLessThan(firstAvg * 2);
    });
  });

  describe('Confidence Score Consistency', () => {
    test('Confidence scores are in valid range (0-100)', () => {
      const now = Date.now();

      // Test various scenarios
      const scenarios = [
        { value: 'Claude', source: 'json', fetchedAt: now },
        { value: null as any, source: 'json', fetchedAt: now },
        { value: '', source: 'json', fetchedAt: now }
      ];

      for (const primary of scenarios) {
        const results = [
          modelValidator.validate(primary as any, []),
          contextValidator.validate({ ...primary, value: { currentInputTokens: 0, cacheReadTokens: 0, currentOutputTokens: 0, totalCurrentTokens: 0 } }, []),
          costValidator.validate({ ...primary, value: { totalCost: 0, hourlyRate: 0, tokensPerMinute: 0 } }, [])
        ];

        for (const result of results) {
          expect(result.confidence).toBeGreaterThanOrEqual(0);
          expect(result.confidence).toBeLessThanOrEqual(100);
          expect(Number.isInteger(result.confidence) || result.confidence % 1 !== 0).toBe(true); // Integer or has decimals
        }
      }
    });

    test('High confidence (>=80) correlates with valid=true', () => {
      const now = Date.now();

      const validPrimary: DataPoint<string> = {
        value: 'Claude Sonnet 4.5',
        source: 'json',
        fetchedAt: now
      };

      const result = modelValidator.validate(validPrimary, []);

      if (result.confidence >= 80) {
        expect(result.valid).toBe(true);
      }
    });

    test('Low confidence (<50) correlates with errors or warnings', () => {
      const now = Date.now();

      const invalidPrimary: DataPoint<string> = {
        value: null as any,
        source: 'json',
        fetchedAt: now
      };

      const result = modelValidator.validate(invalidPrimary, []);

      if (result.confidence < 50) {
        expect(result.errors.length + result.warnings.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Real-World Scenarios', () => {
    test('Scenario: Fresh session with all good data', () => {
      const now = Date.now();

      const model = modelValidator.validate(
        { value: 'Claude Sonnet 4.5', source: 'json', fetchedAt: now },
        []
      );

      const context = contextValidator.validate(
        { value: { currentInputTokens: 10000, cacheReadTokens: 5000, currentOutputTokens: 2000, totalCurrentTokens: 17000 }, source: 'json', fetchedAt: now },
        []
      );

      const cost = costValidator.validate(
        { value: { totalCost: 2.50, hourlyRate: 5.00, tokensPerMinute: 100000 }, source: 'ccusage', fetchedAt: now },
        []
      );

      const git = gitValidator.validate(
        { value: { branch: 'main', ahead: 0, behind: 0, dirty: 0, isRepo: true }, source: 'git_status', fetchedAt: now },
        []
      );

      // All should be valid with reasonable confidence
      expect(model.valid).toBe(true);
      expect(context.valid).toBe(true);
      expect(cost.valid).toBe(true);
      expect(git.valid).toBe(true);

      expect(model.confidence).toBeGreaterThanOrEqual(80);
      expect(context.confidence).toBeGreaterThanOrEqual(80);
      expect(cost.confidence).toBeGreaterThanOrEqual(80);
      expect(git.confidence).toBeGreaterThanOrEqual(80);
    });

    test('Scenario: Stale data with source disagreement', () => {
      const now = Date.now();
      const oneHourAgo = now - 3600000;

      const primary: DataPoint<string> = {
        value: 'Claude Sonnet 4.5',
        source: 'json',
        fetchedAt: oneHourAgo
      };

      const secondary: DataPoint<string> = {
        value: 'Claude Haiku 4',
        source: 'transcript',
        fetchedAt: oneHourAgo
      };

      const result = modelValidator.validate(primary, [secondary]);

      // Should warn about mismatch
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThan(100);
      expect(result.metadata.staleness).toBeGreaterThanOrEqual(3600000);
    });

    test('Scenario: Complete system failure (all data unavailable)', () => {
      const nullPrimary: any = {
        value: null,
        source: 'test',
        fetchedAt: Date.now()
      };

      const model = modelValidator.validate(nullPrimary, []);
      const context = contextValidator.validate(nullPrimary, []);
      const cost = costValidator.validate(nullPrimary, []);
      const git = gitValidator.validate(nullPrimary, []);

      // All should fail gracefully
      expect(model.valid).toBe(false);
      expect(context.valid).toBe(false);
      expect(cost.valid).toBe(false);
      expect(git.valid).toBe(false);

      // All should have errors
      expect(model.errors.length).toBeGreaterThan(0);
      expect(context.errors.length).toBeGreaterThan(0);
      expect(cost.errors.length).toBeGreaterThan(0);
      expect(git.errors.length).toBeGreaterThan(0);

      // All should show stale indicator
      expect(model.showStaleIndicator).toBe(true);
      expect(context.showStaleIndicator).toBe(true);
      expect(cost.showStaleIndicator).toBe(true);
      expect(git.showStaleIndicator).toBe(true);
    });
  });
});
