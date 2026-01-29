/**
 * Unit Tests - Timestamp Validator
 *
 * Tests system time consistency and clock skew detection
 */

import { describe, test, expect } from 'bun:test';
import TimestampValidator from '../../../src/validators/timestamp-validator';
import type { DataPoint } from '../../../src/types/validation';

interface TimestampData {
  systemTime: number;
  fileTime?: number;
  gitTime?: number;
  timezone: string;
}

describe('TimestampValidator', () => {
  const validator = new TimestampValidator();
  const now = Date.now();

  // Helper to create data points
  function createDataPoint(
    timestamp: TimestampData,
    source: string,
    age = 0
  ): DataPoint<TimestampData> {
    return {
      value: timestamp,
      source,
      fetchedAt: Date.now() - age
    };
  }

  // Helper to create timestamp data
  function createTimestamp(
    systemTime: number,
    fileTime?: number,
    gitTime?: number,
    timezone = 'UTC'
  ): TimestampData {
    return { systemTime, fileTime, gitTime, timezone };
  }

  describe('Clock skew detection', () => {
    test('No skew (<5 seconds) - confidence 100%', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 2000), 'file'); // 2s diff

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    test('Moderate skew (30 seconds) - confidence 80%, warning', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 30000), 'file'); // 30s diff

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(80);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Clock skew');
      expect(result.warnings[0]).toContain('30s');
    });

    test('Large skew (10 minutes) - confidence 50%, error, show 🔴', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 600000), 'file'); // 10 min diff

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(50);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Large clock skew');
      expect(result.errors[0]).toContain('10m');
      expect(result.showStaleIndicator).toBe(true);
    });

    test('Huge skew (2 hours) - error with formatted duration', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 7200000), 'file'); // 2h diff

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('2h');
    });

    test('Multi-day skew formatted correctly', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 172800000), 'file'); // 2 days

      const result = validator.validate(primary, [secondary]);

      expect(result.errors[0]).toContain('2d');
    });
  });

  describe('Future timestamp detection', () => {
    test('File 2 hours in future - error', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 7200000), 'file'); // 2 hours ahead

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Future timestamp'))).toBe(true);
      expect(result.showStaleIndicator).toBe(true);
    });

    test('File 30 seconds in future - acceptable (within threshold)', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 30000), 'file'); // 30s ahead

      const result = validator.validate(primary, [secondary]);

      // Should only be a warning, not error (within 1 min threshold)
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
    });

    test('Git commit 2 hours in future - error', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, undefined, now + 7200000), 'git'); // 2h ahead

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('Future git commit'))).toBe(true);
    });

    test('Git commit 30 minutes in future - warning from clock skew', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, undefined, now + 1800000), 'git'); // 30 min ahead

      const result = validator.validate(primary, [secondary]);

      // Within 1 hour tolerance, so no future error (but skew warning expected)
      expect(result.valid).toBe(false); // Invalid because skew >5 min
      expect(result.confidence).toBe(50); // Error level
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Large clock skew');
    });
  });

  describe('Multiple secondary sources', () => {
    test('All sources agree - confidence 100%', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const file = createDataPoint(createTimestamp(now, now + 1000), 'file'); // 1s diff
      const git = createDataPoint(createTimestamp(now, undefined, now + 2000), 'git'); // 2s diff

      const result = validator.validate(primary, [file, git]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0);
    });

    test('One source has large skew - error', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const file = createDataPoint(createTimestamp(now, now + 1000), 'file'); // 1s diff (good)
      const git = createDataPoint(createTimestamp(now, undefined, now + 400000), 'git'); // 6.6 min (bad)

      const result = validator.validate(primary, [file, git]);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Large clock skew');
    });

    test('Multiple sources with different skews - worst one determines confidence', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const file1 = createDataPoint(createTimestamp(now, now + 60000), 'file1'); // 1 min (warning)
      const file2 = createDataPoint(createTimestamp(now, now + 180000), 'file2'); // 3 min (warning)

      const result = validator.validate(primary, [file1, file2]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(80); // Warning level
      expect(result.warnings).toHaveLength(2); // Both sources warned
    });
  });

  describe('Timezone validation', () => {
    test('All sources same timezone - consistent', () => {
      const primary = createTimestamp(now, undefined, undefined, 'UTC');
      const file = createTimestamp(now, now, undefined, 'UTC');
      const git = createTimestamp(now, undefined, now, 'UTC');

      const result = validator.validateTimezone(primary, [
        { value: file, source: 'file', fetchedAt: now },
        { value: git, source: 'git', fetchedAt: now }
      ]);

      expect(result.consistent).toBe(true);
      expect(result.timezones).toHaveLength(1);
      expect(result.timezones[0]).toBe('UTC');
    });

    test('Different timezones - inconsistent', () => {
      const primary = createTimestamp(now, undefined, undefined, 'UTC');
      const file = createTimestamp(now, now, undefined, 'America/New_York');
      const git = createTimestamp(now, undefined, now, 'Europe/London');

      const result = validator.validateTimezone(primary, [
        { value: file, source: 'file', fetchedAt: now },
        { value: git, source: 'git', fetchedAt: now }
      ]);

      expect(result.consistent).toBe(false);
      expect(result.timezones).toHaveLength(3);
      expect(result.timezones).toContain('UTC');
      expect(result.timezones).toContain('America/New_York');
      expect(result.timezones).toContain('Europe/London');
    });
  });

  describe('Reasonable system time checks', () => {
    test('Current time is reasonable', () => {
      const reasonable = validator.isReasonableSystemTime(now);

      expect(reasonable).toBe(true);
    });

    test('1970 epoch not reasonable', () => {
      const epoch = new Date('1970-01-01').getTime();
      const reasonable = validator.isReasonableSystemTime(epoch);

      expect(reasonable).toBe(false);
    });

    test('Far future (2040) not reasonable', () => {
      const future = new Date('2040-01-01').getTime();
      const reasonable = validator.isReasonableSystemTime(future);

      expect(reasonable).toBe(false);
    });

    test('2025 is reasonable', () => {
      const reasonable2025 = new Date('2025-01-01').getTime();
      const reasonable = validator.isReasonableSystemTime(reasonable2025);

      expect(reasonable).toBe(true);
    });

    test('2030 is reasonable', () => {
      const reasonable2030 = new Date('2030-06-15').getTime();
      const reasonable = validator.isReasonableSystemTime(reasonable2030);

      expect(reasonable).toBe(true);
    });
  });

  describe('Skew tolerance boundaries (5s and 5min)', () => {
    test('Exactly 5 second skew - should be good (boundary)', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 5000), 'file'); // 5s diff

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0);
    });

    test('Exactly 5 minute skew - should warn (boundary)', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 300000), 'file'); // 5 min

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(80);
      expect(result.warnings).toHaveLength(1);
      expect(result.showStaleIndicator).toBe(false); // No 🔴 at exactly 5 min
    });

    test('Just above 5 minute skew - should error', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 301000), 'file'); // 5m 1s

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(50);
      expect(result.errors).toHaveLength(1);
      expect(result.showStaleIndicator).toBe(true);
    });
  });

  describe('Metadata validation', () => {
    test('Source agreement decreases with skew', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now + 150000), 'file'); // 2.5 min

      const result = validator.validate(primary, [secondary]);

      // Agreement should be 50% (150s / 300s threshold)
      expect(result.metadata.sourceAgreement).toBeGreaterThan(40);
      expect(result.metadata.sourceAgreement).toBeLessThan(60);
    });

    test('Staleness always zero (timestamps do not go stale)', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now), 'file');

      const result = validator.validate(primary, [secondary]);

      expect(result.metadata.staleness).toBe(0);
    });

    test('Sources checked count correct', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const file = createDataPoint(createTimestamp(now, now), 'file');
      const git = createDataPoint(createTimestamp(now, undefined, now), 'git');

      const result = validator.validate(primary, [file, git]);

      expect(result.metadata.sourcesChecked).toBe(3); // primary + 2 secondary
    });
  });

  describe('Edge cases', () => {
    test('System time unavailable - fail', () => {
      const primary: DataPoint<TimestampData> = {
        value: null as any,
        source: 'system',
        fetchedAt: now
      };

      const result = validator.validate(primary, []);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.errors[0]).toContain('System time unavailable');
    });

    test('Secondary source missing timestamps - ignored gracefully', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now), 'file'); // No fileTime or gitTime

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100); // No comparison = no error
    });

    test('Negative skew (clock behind) handled same as positive', () => {
      const primary = createDataPoint(createTimestamp(now), 'system');
      const secondary = createDataPoint(createTimestamp(now, now - 100000), 'file'); // 100s behind

      const result = validator.validate(primary, [secondary]);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('100s'); // Absolute value shown
    });

    test('Zero timestamps handled gracefully', () => {
      const primary = createDataPoint(createTimestamp(0), 'system');
      const secondary = createDataPoint(createTimestamp(0, 0), 'file');

      const result = validator.validate(primary, [secondary]);

      // Should complete without crashing
      expect(result).toBeDefined();
    });
  });
});
