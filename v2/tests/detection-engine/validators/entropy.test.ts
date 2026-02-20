/**
 * Shannon Entropy Validator Tests
 */

import { describe, test, expect } from 'bun:test';
import { shannonEntropy, entropyValidator } from '../../../src/lib/detection-engine/validators/entropy';

describe('shannonEntropy', () => {
  test('empty string has zero entropy', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  test('single character repeated has zero entropy', () => {
    expect(shannonEntropy('aaaaaaaaaa')).toBe(0);
  });

  test('two equal-probability characters has entropy 1.0', () => {
    expect(shannonEntropy('ababababab')).toBeCloseTo(1.0, 5);
  });

  test('random-looking string has high entropy (>4.0)', () => {
    // This is a high-entropy string (many unique chars)
    const entropy = shannonEntropy('aB3$xZ9!mK7@pQ2&wR5#');
    expect(entropy).toBeGreaterThan(4.0);
  });

  test('dictionary word has low entropy (<3.5)', () => {
    const entropy = shannonEntropy('password');
    expect(entropy).toBeLessThan(3.5);
  });

  test('real API key has high entropy', () => {
    const entropy = shannonEntropy('sk_live_51J4mR7kF2NpXqYzAbCdEfGh');
    expect(entropy).toBeGreaterThan(4.0);
  });
});

describe('entropyValidator', () => {
  test('short strings always get confidence 1.0', () => {
    expect(entropyValidator('abc', '', 3.5, 20)).toBe(1.0);
    expect(entropyValidator('test_key', '', 3.5, 20)).toBe(1.0);
  });

  test('high entropy long string gets confidence 1.0', () => {
    const conf = entropyValidator('aB3xZ9mK7pQ2wR5nT8vL4', '', 3.5, 20);
    expect(conf).toBe(1.0);
  });

  test('low entropy long string gets reduced confidence', () => {
    const conf = entropyValidator('aaaaaaaaaaaaaaaaaaaaa', '', 3.5, 20);
    expect(conf).toBe(0);
  });

  test('medium entropy returns proportional confidence', () => {
    // "abcabcabcabcabcabcabc" has entropy ~1.58 (3 chars)
    const conf = entropyValidator('abcabcabcabcabcabcabc', '', 3.5, 20);
    expect(conf).toBeGreaterThan(0);
    expect(conf).toBeLessThan(1.0);
  });
});
