/**
 * LineParser Tests
 *
 * Tests for JSONL parsing, malformed line handling, and edge cases.
 * Phase 0.3 - RED state (no implementation yet)
 *
 * Coverage:
 * - Valid JSONL parsing
 * - Malformed JSON handling
 * - Empty lines, whitespace
 * - UTF-8 encoding
 * - Edge cases (empty content, no newlines)
 * - Performance (<5ms for 1000 lines)
 */

import { describe, test, expect } from 'bun:test';
import { LineParser } from '../../src/lib/transcript-scanner/line-parser';
import { assertValidParsedLine, assertUnderTime } from './test-harness';

describe('LineParser', () => {
  describe('parse() - Valid JSONL', () => {
    test('parses single valid JSON line', () => {
      const content = '{"type":"user","text":"hello"}';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].lineNumber).toBe(1);
      expect(lines[0].rawLine).toBe('{"type":"user","text":"hello"}');
      expect(lines[0].data).toEqual({ type: 'user', text: 'hello' });
      expect(lines[0].parseError).toBeNull();
    });

    test('parses multiple valid JSON lines', () => {
      const content = `{"type":"user","text":"hello"}
{"type":"assistant","text":"hi"}
{"type":"tool_result","content":"done"}`;

      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(3);
      expect(lines[0].data?.type).toBe('user');
      expect(lines[1].data?.type).toBe('assistant');
      expect(lines[2].data?.type).toBe('tool_result');
      expect(lines[0].lineNumber).toBe(1);
      expect(lines[1].lineNumber).toBe(2);
      expect(lines[2].lineNumber).toBe(3);
    });

    test('parses complex nested JSON structures', () => {
      const content = JSON.stringify({
        type: 'user',
        message: {
          content: [
            { type: 'text', text: 'What does this do?' },
            { type: 'tool_use', id: 'abc', input: { file: 'test.ts' } }
          ]
        }
      });

      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data?.message?.content).toHaveLength(2);
      expect(lines[0].data?.message?.content[1].input.file).toBe('test.ts');
      expect(lines[0].parseError).toBeNull();
    });

    test('preserves Unicode/UTF-8 content', () => {
      const content = '{"text":"Hello 世界 🌍 emoji"}';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data?.text).toBe('Hello 世界 🌍 emoji');
      expect(lines[0].parseError).toBeNull();
    });

    test('handles escaped characters in JSON strings', () => {
      const content = '{"text":"Line 1\\nLine 2\\tTabbed"}';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data?.text).toBe('Line 1\nLine 2\tTabbed');
    });

    test('respects startLine parameter for line numbering', () => {
      const content = `{"a":1}
{"b":2}
{"c":3}`;

      const lines = LineParser.parse(content, 100);

      expect(lines[0].lineNumber).toBe(100);
      expect(lines[1].lineNumber).toBe(101);
      expect(lines[2].lineNumber).toBe(102);
    });
  });

  describe('parse() - Malformed JSON', () => {
    test('handles invalid JSON with parseError', () => {
      const content = '{"invalid json without closing brace';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBeNull();
      expect(lines[0].parseError).toBeTruthy();
      // Bun returns "Unterminated string", Node returns "Unexpected"
      expect(lines[0].parseError?.toLowerCase()).toMatch(/unexpected|unterminated/);
      expect(lines[0].rawLine).toBe(content);
    });

    test('continues parsing after malformed line', () => {
      const content = `{"type":"user","text":"hello"}
{"invalid json
{"type":"assistant","text":"hi"}`;

      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(3);
      expect(lines[0].data).toBeTruthy();
      expect(lines[0].parseError).toBeNull();
      expect(lines[1].data).toBeNull();
      expect(lines[1].parseError).toBeTruthy();
      expect(lines[2].data).toBeTruthy();
      expect(lines[2].parseError).toBeNull();
    });

    test('handles multiple consecutive malformed lines', () => {
      const content = `{"invalid 1
not json at all
another bad line
{"type":"valid","data":"ok"}`;

      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(4);
      expect(lines[0].data).toBeNull();
      expect(lines[1].data).toBeNull();
      expect(lines[2].data).toBeNull();
      expect(lines[3].data).toBeTruthy();
      expect(lines.filter(l => l.parseError !== null)).toHaveLength(3);
    });

    test('handles completely non-JSON content', () => {
      const content = 'This is not JSON at all, just plain text';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBeNull();
      expect(lines[0].parseError).toBeTruthy();
    });

    test('handles JSON with trailing garbage', () => {
      const content = '{"type":"user"} extra stuff here';
      const lines = LineParser.parse(content, 1);

      // JSON.parse() fails on trailing garbage (doesn't accept partial parse)
      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBeNull();
      expect(lines[0].parseError).toBeTruthy();
    });
  });

  describe('parse() - Empty Lines & Whitespace', () => {
    test('skips empty lines', () => {
      const content = `{"type":"user"}

{"type":"assistant"}`;

      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(2); // Empty line not included
      expect(lines[0].data?.type).toBe('user');
      expect(lines[1].data?.type).toBe('assistant');
    });

    test('skips lines with only whitespace', () => {
      const content = `{"type":"user"}

\t
{"type":"assistant"}`;

      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(2);
    });

    test('skips multiple consecutive empty lines', () => {
      const content = `{"a":1}



{"b":2}`;

      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(2);
      expect(lines[0].lineNumber).toBe(1);
      expect(lines[1].lineNumber).toBe(2); // Sequential after filtering empty lines
    });

    test('trims whitespace before parsing', () => {
      const content = '  {"type":"user"}  ';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data?.type).toBe('user');
    });

    test('handles content with trailing newlines', () => {
      const content = '{"a":1}\n{"b":2}\n\n\n';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(2);
    });

    test('handles content with leading newlines', () => {
      const content = '\n\n{"a":1}\n{"b":2}';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(2);
    });
  });

  describe('parse() - Edge Cases', () => {
    test('returns empty array for empty content', () => {
      const lines = LineParser.parse('', 1);
      expect(lines).toEqual([]);
    });

    test('returns empty array for whitespace-only content', () => {
      const lines = LineParser.parse('   \n\t\n   ', 1);
      expect(lines).toEqual([]);
    });

    test('handles single newline', () => {
      const lines = LineParser.parse('\n', 1);
      expect(lines).toEqual([]);
    });

    test('handles content without trailing newline', () => {
      const content = '{"a":1}';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data).toEqual({ a: 1 });
    });

    test('handles very long lines (>10KB)', () => {
      const largeObject = { data: 'x'.repeat(20000) };
      const content = JSON.stringify(largeObject);
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data?.data).toHaveLength(20000);
      expect(lines[0].parseError).toBeNull();
    });

    test('handles lines with only numbers', () => {
      const content = '123';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBe(123);
      expect(lines[0].parseError).toBeNull();
    });

    test('handles lines with null value', () => {
      const content = 'null';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBeNull();
      expect(lines[0].parseError).toBeNull();
    });

    test('handles lines with boolean values', () => {
      const content = 'true\nfalse';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(2);
      expect(lines[0].data).toBe(true);
      expect(lines[1].data).toBe(false);
    });

    test('handles arrays as JSON lines', () => {
      const content = '[1,2,3]';
      const lines = LineParser.parse(content, 1);

      expect(lines).toHaveLength(1);
      expect(lines[0].data).toEqual([1, 2, 3]);
    });
  });

  describe('parse() - ParsedLine Structure', () => {
    test('all ParsedLine objects have required fields', () => {
      const content = `{"a":1}
{"invalid
{"b":2}`;

      const lines = LineParser.parse(content, 1);

      for (const line of lines) {
        expect(line).toHaveProperty('lineNumber');
        expect(line).toHaveProperty('rawLine');
        expect(line).toHaveProperty('data');
        expect(line).toHaveProperty('parseError');
        expect(typeof line.lineNumber).toBe('number');
        expect(typeof line.rawLine).toBe('string');
      }
    });

    test('ParsedLine with valid data has null parseError', () => {
      const content = '{"valid":true}';
      const lines = LineParser.parse(content, 1);

      expect(lines[0].data).toBeTruthy();
      expect(lines[0].parseError).toBeNull();
    });

    test('ParsedLine with invalid data has null data', () => {
      const content = '{invalid}';
      const lines = LineParser.parse(content, 1);

      expect(lines[0].data).toBeNull();
      expect(lines[0].parseError).toBeTruthy();
    });

    test('rawLine preserves original content exactly', () => {
      const original = '  {"type":"user"}  ';
      const content = original + '\n';
      const lines = LineParser.parse(content, 1);

      // rawLine should preserve original (before trim)
      expect(lines[0].rawLine).toBe(original);
    });
  });

  describe('parse() - Performance', () => {
    test('parses 100 lines in <5ms', async () => {
      const lines100 = Array.from({ length: 100 }, (_, i) =>
        JSON.stringify({ line: i, data: 'test data' })
      ).join('\n');

      await assertUnderTime(
        () => LineParser.parse(lines100, 1),
        5,
        'Parse 100 lines'
      );
    });

    test('parses 1000 lines in <5ms', async () => {
      const lines1000 = Array.from({ length: 1000 }, (_, i) =>
        JSON.stringify({ line: i, data: 'test' })
      ).join('\n');

      await assertUnderTime(
        () => LineParser.parse(lines1000, 1),
        5,
        'Parse 1000 lines'
      );
    });

    test('handles mixed valid/invalid lines without performance degradation', async () => {
      const content = Array.from({ length: 1000 }, (_, i) =>
        i % 10 === 0
          ? '{invalid json'  // 10% invalid
          : JSON.stringify({ line: i })
      ).join('\n');

      await assertUnderTime(
        () => LineParser.parse(content, 1),
        10, // Slightly higher due to error handling
        'Parse 1000 mixed lines'
      );
    });
  });

  describe('parse() - Integration Validation', () => {
    test('parsed lines pass assertValidParsedLine for valid data', () => {
      const content = '{"type":"user","text":"hello"}';
      const lines = LineParser.parse(content, 1);

      expect(() => assertValidParsedLine(lines[0])).not.toThrow();
    });

    test('parsed lines pass assertValidParsedLine for invalid data', () => {
      const content = '{invalid}';
      const lines = LineParser.parse(content, 1);

      expect(() => assertValidParsedLine(lines[0])).not.toThrow();
    });

    test('all ParsedLine objects are valid according to test harness', () => {
      const content = `{"a":1}
{"invalid
{"b":2}
{"c":3}`;

      const lines = LineParser.parse(content, 1);

      for (const line of lines) {
        expect(() => assertValidParsedLine(line)).not.toThrow();
      }
    });
  });
});
