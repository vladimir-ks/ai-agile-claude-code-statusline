/**
 * Unit Tests - Validation Engine
 *
 * Tests the validation orchestration layer
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import ValidationEngine from '../../../src/lib/validation-engine';
import ModelValidator from '../../../src/validators/model-validator';
import ContextValidator from '../../../src/validators/context-validator';
import type { DataPoint, ValidationConfig, ValidationMetrics } from '../../../src/types/validation';

describe('ValidationEngine', () => {
  let engine: ValidationEngine;
  const defaultConfig: ValidationConfig = {
    throttleInterval: 0, // No throttling for tests
    confidenceThreshold: 70,
    alerts: []
  };

  beforeEach(() => {
    engine = new ValidationEngine(defaultConfig);
  });

  describe('Validator Registration', () => {
    test('Register validator successfully', () => {
      const validator = new ModelValidator();

      engine.registerValidator('model', validator);

      expect(engine.hasValidator('model')).toBe(true);
      expect(engine.getValidators()).toContain('model');
    });

    test('Register multiple validators', () => {
      const modelValidator = new ModelValidator();
      const contextValidator = new ContextValidator();

      engine.registerValidator('model', modelValidator);
      engine.registerValidator('context', contextValidator);

      expect(engine.getValidators()).toHaveLength(2);
      expect(engine.hasValidator('model')).toBe(true);
      expect(engine.hasValidator('context')).toBe(true);
    });

    test('Emit event when validator registered', (done) => {
      const validator = new ModelValidator();

      engine.on('validator:registered', ({ dataType }) => {
        expect(dataType).toBe('model');
        done();
      });

      engine.registerValidator('model', validator);
    });

    test('Reject invalid dataType (empty string)', (done) => {
      const validator = new ModelValidator();

      engine.on('validator:error', ({ error }) => {
        expect(error).toContain('Invalid dataType');
        done();
      });

      engine.registerValidator('', validator);
    });

    test('Reject invalid validator (no validate method)', (done) => {
      const badValidator = { notValidate: () => {} } as any;

      engine.on('validator:error', ({ error }) => {
        expect(error).toContain('Invalid validator');
        done();
      });

      engine.registerValidator('test', badValidator);
    });
  });

  describe('Validation Execution', () => {
    test('Validate with registered validator', async () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const primary: DataPoint<string> = {
        value: 'Claude Sonnet 4.5',
        source: 'json',
        fetchedAt: Date.now()
      };

      const result = await engine.validate('model', primary, []);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.metadata.validationLatency).toBeGreaterThanOrEqual(0);
    });

    test('Return error when validator not registered', async () => {
      const primary: DataPoint<string> = {
        value: 'test',
        source: 'json',
        fetchedAt: Date.now()
      };

      const result = await engine.validate('nonexistent', primary, []);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('No validator registered');
    });

    test('Add validation metadata', async () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const primary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      const secondary: DataPoint<string> = {
        value: 'Claude',
        source: 'transcript',
        fetchedAt: Date.now()
      };

      const result = await engine.validate('model', primary, [secondary]);

      expect(result.metadata.validationLatency).toBeGreaterThanOrEqual(0);
      expect(result.metadata.sourcesChecked).toBe(2); // primary + secondary
      expect(result.metadata.staleness).toBeGreaterThanOrEqual(0);
    });

    test('Update metrics after validation', async () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const primary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      await engine.validate('model', primary, []);

      const metrics = engine.getMetrics('model');
      expect(metrics).not.toBeNull();
      expect(metrics!.totalValidations).toBe(1);
      expect(metrics!.successRate).toBeGreaterThan(0);
    });
  });

  describe('Throttling', () => {
    test('Throttle validation when interval not elapsed', async () => {
      const throttledEngine = new ValidationEngine({
        throttleInterval: 10000, // 10 seconds
        confidenceThreshold: 70,
        alerts: []
      });

      const validator = new ModelValidator();
      throttledEngine.registerValidator('model', validator);

      const primary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      // First validation
      await throttledEngine.validate('model', primary, []);

      // Second validation (should be throttled)
      const result = await throttledEngine.validate('model', primary, []);

      // Throttled results have 90% confidence, 0 latency
      expect(result.confidence).toBe(90);
      expect(result.metadata.validationLatency).toBe(0);
    });

    test('No throttling when interval is 0', async () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const primary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      // Run 3 validations rapidly
      await engine.validate('model', primary, []);
      await engine.validate('model', primary, []);
      const result = await engine.validate('model', primary, []);

      // Should NOT be throttled (latency > 0)
      expect(result.metadata.validationLatency).toBeGreaterThan(0);
    });
  });

  describe('Event Emissions', () => {
    test('Emit validation:failed when validation fails', (done) => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      engine.on('validation:failed', ({ dataType, result }) => {
        expect(dataType).toBe('model');
        expect(result.valid).toBe(false);
        done();
      });

      const primary: DataPoint<string> = {
        value: null as any,
        source: 'json',
        fetchedAt: Date.now()
      };

      engine.validate('model', primary, []);
    });

    test('Emit validation:low-confidence when confidence below threshold', (done) => {
      // Set threshold to 80% so we can trigger low-confidence event
      const lowThresholdEngine = new ValidationEngine({
        throttleInterval: 0,
        confidenceThreshold: 80,
        alerts: []
      });

      const validator = new ModelValidator();
      lowThresholdEngine.registerValidator('model', validator);

      lowThresholdEngine.on('validation:low-confidence', ({ dataType, confidence }) => {
        expect(dataType).toBe('model');
        expect(confidence).toBeLessThan(80);
        done();
      });

      const primary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      const secondary: DataPoint<string> = {
        value: 'Haiku',
        source: 'transcript',
        fetchedAt: Date.now()
      };

      lowThresholdEngine.validate('model', primary, [secondary]); // Mismatch = confidence 70%
    });

    test('Emit validation:warnings when warnings present', (done) => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      engine.on('validation:warnings', ({ dataType, warnings }) => {
        expect(dataType).toBe('model');
        expect(warnings.length).toBeGreaterThan(0);
        done();
      });

      const primary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      engine.validate('model', primary, []); // Single source = warning
    });
  });

  describe('Metrics Tracking', () => {
    test('Initialize metrics when validator registered', () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const metrics = engine.getMetrics('model');

      expect(metrics).not.toBeNull();
      expect(metrics!.successRate).toBe(100);
      expect(metrics!.sourceAgreementRate).toBe(100);
      expect(metrics!.totalValidations).toBe(0);
    });

    test('Update metrics after multiple validations', async () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const primary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      // Run 5 validations
      for (let i = 0; i < 5; i++) {
        await engine.validate('model', primary, []);
      }

      const metrics = engine.getMetrics('model');
      expect(metrics!.totalValidations).toBe(5);
    });

    test('Rolling average for success rate', async () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const goodPrimary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      const badPrimary: DataPoint<string> = {
        value: null as any,
        source: 'json',
        fetchedAt: Date.now()
      };

      // 9 good, 1 bad
      for (let i = 0; i < 9; i++) {
        await engine.validate('model', goodPrimary, []);
      }
      await engine.validate('model', badPrimary, []);

      const metrics = engine.getMetrics('model');
      // Should be around 90% (but smoothed by rolling average)
      expect(metrics!.successRate).toBeLessThan(100);
      expect(metrics!.successRate).toBeGreaterThan(80);
    });

    test('Reset metrics', async () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const primary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      await engine.validate('model', primary, []);

      engine.resetMetrics('model');

      const metrics = engine.getMetrics('model');
      expect(metrics!.totalValidations).toBe(0);
      expect(metrics!.successRate).toBe(100);
    });
  });

  describe('Overall Health', () => {
    test('Get overall health with no validators', () => {
      const health = engine.getOverallHealth();

      expect(health.avgSuccessRate).toBe(100);
      expect(health.avgLatency).toBe(0);
      expect(health.totalValidations).toBe(0);
      expect(health.worstPerformer).toBeNull();
    });

    test('Get overall health with multiple validators', async () => {
      const modelValidator = new ModelValidator();
      const contextValidator = new ContextValidator();

      engine.registerValidator('model', modelValidator);
      engine.registerValidator('context', contextValidator);

      const modelPrimary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      const contextPrimary: DataPoint<any> = {
        value: {
          currentInputTokens: 10000,
          cacheReadTokens: 5000,
          currentOutputTokens: 2000,
          totalCurrentTokens: 17000
        },
        source: 'json',
        fetchedAt: Date.now()
      };

      await engine.validate('model', modelPrimary, []);
      await engine.validate('context', contextPrimary, []);

      const health = engine.getOverallHealth();

      expect(health.avgSuccessRate).toBeGreaterThan(0);
      expect(health.avgLatency).toBeGreaterThanOrEqual(0);
      expect(health.totalValidations).toBe(2);
    });

    test('Identify worst performer', async () => {
      const modelValidator = new ModelValidator();
      const contextValidator = new ContextValidator();

      engine.registerValidator('model', modelValidator);
      engine.registerValidator('context', contextValidator);

      const goodPrimary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      const badContextPrimary: DataPoint<any> = {
        value: null as any,
        source: 'json',
        fetchedAt: Date.now()
      };

      // Model: all good
      await engine.validate('model', goodPrimary, []);
      await engine.validate('model', goodPrimary, []);

      // Context: all bad
      await engine.validate('context', badContextPrimary, []);
      await engine.validate('context', badContextPrimary, []);

      const health = engine.getOverallHealth();

      expect(health.worstPerformer).toBe('context');
    });
  });

  describe('Defensive Engineering', () => {
    test('Handle invalid config gracefully', () => {
      const badConfig = null as any;
      const engine = new ValidationEngine(badConfig);

      // Should use defaults
      expect(engine).toBeDefined();
    });

    test('Handle invalid dataType in validate', async () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const primary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      const result = await engine.validate('' as any, primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid dataType');
    });

    test('Handle invalid primary data point', async () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const badPrimary = { value: 'test' } as any; // Missing fetchedAt

      const result = await engine.validate('model', badPrimary, []);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid primary data point');
    });

    test('Handle non-array secondary', async () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      const primary: DataPoint<string> = {
        value: 'Claude',
        source: 'json',
        fetchedAt: Date.now()
      };

      const result = await engine.validate('model', primary, {} as any);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('not an array');
    });

    test('Sanitize error messages', async () => {
      const badPrimary = {
        value: 'test\n\rmalicious\\x00',
        source: 'json',
        fetchedAt: Date.now()
      } as any;

      const result = await engine.validate('nonexistent', badPrimary, []);

      expect(result.errors[0]).not.toContain('\n');
      expect(result.errors[0]).not.toContain('\r');
      expect(result.errors[0]).not.toContain('\x00');
    });

    test('Destroy cleanup', () => {
      const validator = new ModelValidator();
      engine.registerValidator('model', validator);

      engine.destroy();

      expect(engine.hasValidator('model')).toBe(false);
      expect(engine.getValidators()).toHaveLength(0);
    });

    test('hasValidator with non-string dataType', () => {
      const result = engine.hasValidator(123 as any);

      expect(result).toBe(false);
    });

    test('getMetrics with non-string dataType', () => {
      const result = engine.getMetrics(null as any);

      expect(result).toBeNull();
    });
  });
});
