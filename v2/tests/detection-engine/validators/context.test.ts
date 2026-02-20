/**
 * Context Validator Tests
 */

import { describe, test, expect } from 'bun:test';
import { contextValidator } from '../../../src/lib/detection-engine/validators/context';

describe('contextValidator', () => {
  test('normal context returns 1.0', () => {
    expect(contextValidator('ghp_abc123', 'Here is my token: ghp_abc123')).toBe(1.0);
  });

  test('single code fence (inside block) returns 0.3', () => {
    // Odd number of ``` = likely inside a code block (only opening fence visible)
    const ctx = '```javascript\nconst token = "ghp_abc123"';
    expect(contextValidator('ghp_abc123', ctx)).toBe(0.3);
  });

  test('example keyword returns 0.4', () => {
    expect(contextValidator('ghp_abc123', 'This is an example token: ghp_abc123')).toBe(0.4);
  });

  test('test keyword returns 0.4', () => {
    expect(contextValidator('sk_live_xxx', 'test key: sk_live_xxx')).toBe(0.4);
  });

  test('sample keyword returns 0.4', () => {
    expect(contextValidator('AKIA...', 'Sample AWS key: AKIA...')).toBe(0.4);
  });

  test('placeholder keyword returns 0.4', () => {
    expect(contextValidator('key', 'Use a placeholder value like key')).toBe(0.4);
  });

  test('case insensitive keyword matching', () => {
    expect(contextValidator('key', 'EXAMPLE key value')).toBe(0.4);
  });

  test('two code fences (closed block) returns 1.0', () => {
    // Even number = outside code block
    const ctx = '```\ncode\n```\n\nghp_abc123';
    expect(contextValidator('ghp_abc123', ctx)).toBe(1.0);
  });
});
