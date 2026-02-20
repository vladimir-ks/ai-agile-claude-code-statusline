/**
 * DetectionEngine — Integration Tests
 *
 * Tests the full engine: config, allowlist, multi-rule interaction,
 * public API methods, and performance.
 */

import { describe, test, expect } from 'bun:test';
import { DetectionEngine, detect } from '../../src/lib/detection-engine';

describe('DetectionEngine', () => {
  describe('Constructor & Config', () => {
    test('creates with default config', () => {
      const engine = new DetectionEngine();
      expect(engine.ruleCount).toBeGreaterThan(0);
    });

    test('filters rules by category', () => {
      const secretsOnly = new DetectionEngine({ categories: ['secret'] });
      const piiOnly = new DetectionEngine({ categories: ['pii'] });

      expect(secretsOnly.ruleCount).toBeGreaterThan(0);
      expect(piiOnly.ruleCount).toBeGreaterThan(0);
      expect(secretsOnly.ruleCount).not.toBe(piiOnly.ruleCount);
    });

    test('filters rules by minSeverity', () => {
      const critOnly = new DetectionEngine({ minSeverity: 'critical' });
      const allSev = new DetectionEngine({ minSeverity: 'low' });

      expect(critOnly.ruleCount).toBeLessThan(allSev.ruleCount);
    });

    test('respects maxFindings cap', () => {
      const engine = new DetectionEngine({ maxFindings: 1, minSeverity: 'low', minConfidence: 0 });
      // Text with multiple detectable items
      const text = 'ghp_1234567890abcdefghijklmnopqrstuvwxyz and AKIAIOSFODNN7EXAMPLE';
      const f = engine.detect(text);
      expect(f.length).toBeLessThanOrEqual(1);
    });
  });

  describe('detect() — Basic', () => {
    const engine = new DetectionEngine({ minSeverity: 'high' });

    test('returns empty for empty string', () => {
      expect(engine.detect('')).toEqual([]);
    });

    test('returns empty for clean text', () => {
      expect(engine.detect('Hello, world! This is normal text.')).toEqual([]);
    });

    test('detects GitHub token', () => {
      const f = engine.detect('my token: ghp_1234567890abcdefghijklmnopqrstuvwxyz');
      expect(f).toHaveLength(1);
      expect(f[0].rule).toBe('github_pat_classic');
      expect(f[0].category).toBe('secret');
    });

    test('finding has all required fields', () => {
      const f = engine.detect('AKIAIOSFODNN7EXAMPLE');
      expect(f).toHaveLength(1);
      expect(f[0]).toHaveProperty('rule');
      expect(f[0]).toHaveProperty('type');
      expect(f[0]).toHaveProperty('category');
      expect(f[0]).toHaveProperty('severity');
      expect(f[0]).toHaveProperty('match');
      expect(f[0]).toHaveProperty('offset');
      expect(f[0]).toHaveProperty('length');
      expect(f[0]).toHaveProperty('confidence');
    });

    test('findings sorted by offset', () => {
      const text = 'AKIAIOSFODNN7EXAMPLE and ghp_1234567890abcdefghijklmnopqrstuvwxyz';
      const f = engine.detect(text);
      expect(f.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < f.length; i++) {
        expect(f[i].offset).toBeGreaterThanOrEqual(f[i - 1].offset);
      }
    });

    test('match is redacted', () => {
      const f = engine.detect('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
      expect(f[0].match).toContain('...');
      expect(f[0].match.length).toBeLessThan(20);
    });
  });

  describe('detect() — Context', () => {
    test('includeContext adds context field', () => {
      const engine = new DetectionEngine({ includeContext: true, minSeverity: 'high' });
      const f = engine.detect('prefix AKIAIOSFODNN7EXAMPLE suffix');
      expect(f[0].context).toBeDefined();
      expect(f[0].context).toContain('prefix');
      expect(f[0].context).toContain('suffix');
    });

    test('no context field by default', () => {
      const engine = new DetectionEngine({ minSeverity: 'high' });
      const f = engine.detect('AKIAIOSFODNN7EXAMPLE');
      expect(f[0].context).toBeUndefined();
    });
  });

  describe('detectSecrets()', () => {
    test('returns only secret category', () => {
      const engine = new DetectionEngine({ minSeverity: 'low', minConfidence: 0 });
      const f = engine.detectSecrets('AKIAIOSFODNN7EXAMPLE and user@example.com');
      expect(f.every(x => x.category === 'secret')).toBe(true);
    });
  });

  describe('detectPII()', () => {
    test('returns only PII category', () => {
      const engine = new DetectionEngine({ minSeverity: 'low', minConfidence: 0 });
      const f = engine.detectPII('AKIAIOSFODNN7EXAMPLE and user@example.com');
      expect(f.every(x => x.category === 'pii')).toBe(true);
    });
  });

  describe('hasFindings()', () => {
    const engine = new DetectionEngine({ minSeverity: 'high' });

    test('returns true when findings exist', () => {
      expect(engine.hasFindings('ghp_1234567890abcdefghijklmnopqrstuvwxyz')).toBe(true);
    });

    test('returns false for clean text', () => {
      expect(engine.hasFindings('no secrets here')).toBe(false);
    });
  });

  describe('redactAll()', () => {
    const engine = new DetectionEngine({ minSeverity: 'high' });

    test('replaces findings with [REDACTED]', () => {
      const result = engine.redactAll('my token: ghp_1234567890abcdefghijklmnopqrstuvwxyz end');
      expect(result).toContain('[REDACTED]');
      expect(result).not.toContain('ghp_');
      expect(result).toContain('my token: ');
      expect(result).toContain(' end');
    });

    test('returns unchanged text when no findings', () => {
      const text = 'clean text here';
      expect(engine.redactAll(text)).toBe(text);
    });

    test('handles multiple findings', () => {
      const text = 'AKIAIOSFODNN7EXAMPLE and ghp_1234567890abcdefghijklmnopqrstuvwxyz';
      const result = engine.redactAll(text);
      const count = (result.match(/\[REDACTED\]/g) || []).length;
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Allowlist', () => {
    test('allowlisted patterns are skipped', () => {
      const engine = new DetectionEngine({
        minSeverity: 'high',
        allowlist: [/AKIAIOSFODNN7EXAMPLE/],
      });
      expect(engine.detect('AKIAIOSFODNN7EXAMPLE')).toEqual([]);
    });

    test('non-allowlisted patterns still detected', () => {
      const engine = new DetectionEngine({
        minSeverity: 'high',
        allowlist: [/AKIAIOSFODNN7EXAMPLE/],
      });
      const f = engine.detect('ghp_1234567890abcdefghijklmnopqrstuvwxyz');
      expect(f).toHaveLength(1);
    });

    test('setAllowlist updates patterns', () => {
      const engine = new DetectionEngine({ minSeverity: 'high' });
      engine.setAllowlist([/AKIAIOSFODNN7EXAMPLE/]);
      expect(engine.detect('AKIAIOSFODNN7EXAMPLE')).toEqual([]);
    });
  });

  describe('addRule()', () => {
    test('custom rule is applied', () => {
      const engine = new DetectionEngine({ minSeverity: 'high' });
      engine.addRule({
        id: 'custom_test',
        type: 'Custom Secret',
        category: 'secret',
        severity: 'high',
        pattern: /CUSTOM_[A-Z]{10}/g,
        description: 'Test custom rule',
      });

      const f = engine.detect('CUSTOM_ABCDEFGHIJ');
      expect(f.some(x => x.rule === 'custom_test')).toBe(true);
    });

    test('custom rule respects severity filter', () => {
      const engine = new DetectionEngine({ minSeverity: 'critical' });
      engine.addRule({
        id: 'low_rule',
        type: 'Low Secret',
        category: 'secret',
        severity: 'low',
        pattern: /LOW_[A-Z]+/g,
        description: 'Low severity rule',
      });

      // Should not be added (below minSeverity)
      expect(engine.detect('LOW_ABCDEF')).toEqual([]);
    });
  });

  describe('Standalone detect()', () => {
    test('works without config', () => {
      const f = detect('AKIAIOSFODNN7EXAMPLE');
      expect(f).toHaveLength(1);
    });

    test('works with config', () => {
      const f = detect('AKIAIOSFODNN7EXAMPLE', { categories: ['secret'] });
      expect(f).toHaveLength(1);
    });

    test('reuses default engine on repeated calls', () => {
      const f1 = detect('AKIAIOSFODNN7EXAMPLE');
      const f2 = detect('AKIAIOSFODNN7EXAMPLE');
      expect(f1[0].rule).toBe(f2[0].rule);
    });
  });

  describe('Performance', () => {
    test('processes 5KB text in <5ms', () => {
      const engine = new DetectionEngine();
      const text = 'Normal text without secrets. '.repeat(200); // ~5.6KB

      const start = performance.now();
      engine.detect(text);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5);
    });

    test('processes 50KB text in <50ms', () => {
      const engine = new DetectionEngine();
      const text = 'Normal text without secrets. '.repeat(2000); // ~56KB

      const start = performance.now();
      engine.detect(text);
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(50);
    });
  });
});
