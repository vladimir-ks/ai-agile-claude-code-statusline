/**
 * Unit Tests - Model Validator
 *
 * Tests multi-source model name validation logic
 */

import { describe, test, expect } from 'bun:test';
import ModelValidator from '../../../src/validators/model-validator';
import type { DataPoint } from '../../../src/types/validation';

describe('ModelValidator', () => {
  const validator = new ModelValidator();

  // Helper to create data points
  function createDataPoint(value: string, source: string, age = 0): DataPoint<string> {
    return {
      value,
      source,
      fetchedAt: Date.now() - age
    };
  }

  describe('Primary source available (JSON stdin)', () => {
    test('Exact match with transcript - confidence 100%', () => {
      const primary = createDataPoint('Claude Sonnet 4.5', 'json');
      const transcript = createDataPoint('Claude Sonnet 4.5', 'transcript');

      const result = validator.validate(primary, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.recommendedSource).toBe('json');
    });

    test('Mismatch with transcript - confidence 70%, warning', () => {
      const primary = createDataPoint('Claude Haiku 4', 'json');
      const transcript = createDataPoint('Claude Sonnet 4.5', 'transcript');

      const result = validator.validate(primary, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(70);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Model mismatch');
      expect(result.warnings[0]).toContain('Haiku');
      expect(result.warnings[0]).toContain('Sonnet');
      expect(result.recommendedSource).toBe('json');
    });

    test('Only JSON available - confidence 90%', () => {
      const primary = createDataPoint('Claude Opus 4', 'json');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(90);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Only one source');
      expect(result.recommendedSource).toBe('json');
    });

    test('JSON differs from settings.json - no penalty (expected)', () => {
      const primary = createDataPoint('Claude Haiku 4', 'json');
      const settings = createDataPoint('Claude Sonnet 4.5', 'settings.json');

      const result = validator.validate(primary, [settings]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBeGreaterThanOrEqual(90); // No penalty
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('No primary source (fallback scenarios)', () => {
    test('Fresh transcript (<1h) - confidence 80%', () => {
      const primary = createDataPoint('', 'json'); // Empty = unavailable
      const transcript = createDataPoint('Claude Sonnet 4.5', 'transcript', 0); // Fresh

      const result = validator.validate(primary, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(80);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('transcript as primary');
      expect(result.recommendedSource).toBe('transcript');
    });

    test('Stale transcript (>1h) - fallback to settings', () => {
      const primary = createDataPoint('', 'json'); // Empty = unavailable
      const transcript = createDataPoint('Claude Sonnet 4.5', 'transcript', 3700000); // 1h + 100s
      const settings = createDataPoint('Claude Haiku 4', 'settings.json');

      const result = validator.validate(primary, [transcript, settings]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(50);
      expect(result.recommendedSource).toBe('settings.json');
      expect(result.showStaleIndicator).toBe(true); // Low confidence
    });

    test('Only settings.json - confidence 50%, show 🔴', () => {
      const primary = createDataPoint('', 'json'); // Empty = unavailable
      const settings = createDataPoint('Claude Sonnet 4.5', 'settings.json');

      const result = validator.validate(primary, [settings]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(50);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('settings.json default');
      expect(result.showStaleIndicator).toBe(true);
    });

    test('No sources available - fail with confidence 0', () => {
      const primary = createDataPoint('', 'json'); // Empty = unavailable

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('No model data');
      expect(result.showStaleIndicator).toBe(true);
    });
  });

  describe('Metadata validation', () => {
    test('Metadata includes staleness and sources checked', () => {
      const primary = createDataPoint('Claude Sonnet 4.5', 'json', 5000);
      const transcript = createDataPoint('Claude Sonnet 4.5', 'transcript', 3000);

      const result = validator.validate(primary, [transcript]);

      expect(result.metadata.staleness).toBeGreaterThanOrEqual(5000); // Max age
      expect(result.metadata.sourcesChecked).toBe(2);
      expect(result.metadata.validationLatency).toBeGreaterThanOrEqual(0);
    });

    test('Source agreement tracked correctly', () => {
      const primary = createDataPoint('Claude Haiku 4', 'json');
      const transcript = createDataPoint('Claude Sonnet 4.5', 'transcript');

      const result = validator.validate(primary, [transcript]);

      expect(result.metadata.sourceAgreement).toBeLessThan(100); // Disagreement penalty
      expect(result.metadata.sourceAgreement).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Edge cases', () => {
    test('Empty model name in primary - treated as unavailable', () => {
      const primary = createDataPoint('', 'json');
      const settings = createDataPoint('Claude Sonnet 4.5', 'settings.json');

      const result = validator.validate(primary, [settings]);

      expect(result.valid).toBe(true);
      expect(result.recommendedSource).toBe('settings.json'); // Falls back
    });

    test('Null value in primary - treated as unavailable', () => {
      const primary = { value: null as any, source: 'json', fetchedAt: Date.now() };
      const settings = createDataPoint('Claude Sonnet 4.5', 'settings.json');

      const result = validator.validate(primary, [settings]);

      expect(result.valid).toBe(true);
      expect(result.recommendedSource).toBe('settings.json');
    });

    test('Very long model names handled gracefully', () => {
      const longName = 'Claude Sonnet 4.5 Extended Context Window Edition'.repeat(10);
      const primary = createDataPoint(longName, 'json');

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  describe('Defensive Engineering - Error Handling', () => {
    test('Invalid primary data point (missing fetchedAt)', () => {
      const primary = { value: 'Claude', source: 'json' } as any; // Missing fetchedAt

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Invalid primary data point');
    });

    test('Invalid primary data point (negative fetchedAt)', () => {
      const primary = { value: 'Claude', source: 'json', fetchedAt: -1 };

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    test('Invalid secondary (not an array)', () => {
      const primary = createDataPoint('Claude Sonnet 4.5', 'json');

      const result = validator.validate(primary, {} as any); // Not an array

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('not array');
    });

    test('Secondary array with null entries', () => {
      const primary = createDataPoint('Claude Sonnet 4.5', 'json');
      const secondary = [null, undefined, createDataPoint('Claude Haiku 4', 'transcript')] as any;

      const result = validator.validate(primary, secondary);

      // Should handle gracefully, ignoring null/undefined entries
      expect(result.valid).toBe(true);
    });

    test('Model name with newlines and control characters sanitized', () => {
      const maliciousName = 'Claude\nSonnet\r4.5\t\x00\x1f';
      const primary = createDataPoint(maliciousName, 'json');
      const transcript = createDataPoint('Claude Haiku 4', 'transcript');

      const result = validator.validate(primary, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      // Verify sanitized (no newlines in warning message)
      expect(result.warnings[0]).not.toContain('\n');
      expect(result.warnings[0]).not.toContain('\r');
    });

    test('Extremely long model name truncated in warnings', () => {
      const veryLongName = 'A'.repeat(500);
      const primary = createDataPoint(veryLongName, 'json');
      const transcript = createDataPoint('Claude Sonnet 4.5', 'transcript');

      const result = validator.validate(primary, [transcript]);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      // Warning message should be truncated (not 500 chars)
      expect(result.warnings[0].length).toBeLessThan(200);
      expect(result.warnings[0]).toContain('...');
    });

    test('Future fetchedAt timestamp handled gracefully', () => {
      const futureTime = Date.now() + 86400000; // 1 day in future
      const primary = createDataPoint('Claude Sonnet 4.5', 'json', -86400000); // Make it "future"

      const result = validator.validate(primary, []);

      // Should still work (negative staleness is valid, just unusual)
      expect(result.valid).toBe(true);
    });

    test('Zero fetchedAt rejected', () => {
      const primary = { value: 'Claude', source: 'json', fetchedAt: 0 };

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    test('Non-string model value converted to string', () => {
      const primary = { value: 12345 as any, source: 'json', fetchedAt: Date.now() };

      const result = validator.validate(primary, []);

      // Should handle gracefully (coerce to string)
      expect(result.valid).toBe(true);
    });
  });

  describe('TTL and freshness checks', () => {
    test('Transcript exactly at 1 hour boundary - should not be fresh', () => {
      const primary = createDataPoint('', 'json');
      const transcript = createDataPoint('Claude Sonnet 4.5', 'transcript', 3600000); // Exactly 1h
      const settings = createDataPoint('Claude Haiku 4', 'settings.json');

      const result = validator.validate(primary, [transcript, settings]);

      // Should fallback to settings (transcript not fresh)
      expect(result.recommendedSource).toBe('settings.json');
    });

    test('Transcript at 59 minutes - should be fresh', () => {
      const primary = createDataPoint('', 'json');
      const transcript = createDataPoint('Claude Sonnet 4.5', 'transcript', 3540000); // 59 min

      const result = validator.validate(primary, [transcript]);

      // Should use transcript (still fresh)
      expect(result.recommendedSource).toBe('transcript');
      expect(result.confidence).toBe(80);
    });
  });
});
