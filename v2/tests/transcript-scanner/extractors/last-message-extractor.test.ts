/**
 * LastMessageExtractor Tests
 *
 * Tests for extracting last user message from transcript.
 * Phase 0.3 - RED state (no implementation yet)
 *
 * Coverage:
 * - Backward scan for last user message
 * - Text extraction from content formats
 * - Preview truncation (80 chars)
 * - Turn counting
 * - Edge cases (no messages, only assistant messages)
 */

import { describe, test, expect } from 'bun:test';
import { LastMessageExtractor } from '../../../src/lib/transcript-scanner/extractors/last-message-extractor';
import { mockParsedLine, mockParsedLines, assertValidMessageInfo } from '../test-harness';
import type { ParsedLine } from '../../../src/lib/transcript-scanner/types';

describe('LastMessageExtractor', () => {
  const extractor = new LastMessageExtractor();

  describe('Extractor Interface', () => {
    test('has correct id', () => {
      expect(extractor.id).toBe('last_message');
    });

    test('shouldCache is true', () => {
      expect(extractor.shouldCache).toBe(true);
    });

    test('has cacheTTL defined', () => {
      expect(extractor.cacheTTL).toBeGreaterThan(0);
    });

    test('extract method exists', () => {
      expect(typeof extractor.extract).toBe('function');
    });
  });

  describe('extract() - Basic Extraction', () => {
    test('extracts last user message from single line', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            timestamp: new Date('2026-02-08T12:00:00Z').toISOString(),
            message: { content: [{ type: 'text', text: 'What does this code do?' }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('What does this code do?');
      expect(result.sender).toBe('human');
      expect(result.turnNumber).toBe(1);
      expect(result.timestamp).toBeGreaterThan(0);
    });

    test('extracts last user message from multiple messages', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          lineNumber: 1,
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: 'First message' }] }
          }
        }),
        mockParsedLine({
          lineNumber: 2,
          data: {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'Response 1' }] }
          }
        }),
        mockParsedLine({
          lineNumber: 3,
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: 'Second message' }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Second message');
      expect(result.turnNumber).toBe(3); // Total turns
    });

    test('scans backward from end of array', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: 'Early message' }] }
          }
        }),
        mockParsedLine({ data: { type: 'tool_result', content: 'result' } }),
        mockParsedLine({ data: { type: 'tool_result', content: 'result' } }),
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: 'Latest message' }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Latest message');
    });

    test('parses timestamp correctly', () => {
      const timestampStr = '2026-02-08T15:30:00.000Z';
      const expectedTimestamp = new Date(timestampStr).getTime();

      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            timestamp: timestampStr,
            message: { content: [{ type: 'text', text: 'Test' }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.timestamp).toBe(expectedTimestamp);
    });
  });

  describe('extract() - Text Extraction', () => {
    test('extracts text from string content format', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: 'Hello world' } // String format
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Hello world');
    });

    test('extracts text from array content format', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: {
              content: [
                { type: 'text', text: 'What is this?' },
                { type: 'tool_use', id: 'abc', input: {} }
              ]
            }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('What is this?');
    });

    test('extracts first text block from multiple text blocks', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: {
              content: [
                { type: 'text', text: 'First block' },
                { type: 'text', text: 'Second block' }
              ]
            }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('First block');
    });

    test('skips non-text content blocks', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: {
              content: [
                { type: 'image', source: 'data:...' },
                { type: 'text', text: 'Found it!' },
                { type: 'tool_use', id: 'x' }
              ]
            }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Found it!');
    });

    test('handles empty text in content block', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: {
              content: [
                { type: 'text', text: '' },
                { type: 'text', text: 'Non-empty text' }
              ]
            }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Non-empty text');
    });

    test('handles whitespace-only text', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: {
              content: [
                { type: 'text', text: '   \n\t   ' },
                { type: 'text', text: 'Real content' }
              ]
            }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Real content');
    });
  });

  describe('extract() - Preview Truncation', () => {
    test('truncates long messages to 80 characters', () => {
      const longText = 'This is a very long message that exceeds the eighty character limit and should be truncated with two dots at the end to indicate truncation';

      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: longText }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toHaveLength(80);
      expect(result.preview).toEndWith('..');
    });

    test('does not truncate messages under 80 characters', () => {
      const shortText = 'Short message';

      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: shortText }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe(shortText);
      expect(result.preview).not.toEndWith('..');
    });

    test('truncates at exactly 80 characters (78 content + "..")', () => {
      const text = 'x'.repeat(100);

      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toHaveLength(80);
      expect(result.preview.slice(0, -2)).toBe('x'.repeat(78));
    });

    test('normalizes whitespace in preview', () => {
      const text = 'Multiple   spaces\n\nand\nnewlines\there';

      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Multiple spaces and newlines here');
    });

    test('trims leading and trailing whitespace', () => {
      const text = '   \n  Leading and trailing spaces  \n  ';

      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Leading and trailing spaces');
    });
  });

  describe('extract() - Turn Counting', () => {
    test('counts user and assistant messages', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { type: 'user', message: { content: 'Q1' } } }),
        mockParsedLine({ data: { type: 'assistant', message: { content: 'A1' } } }),
        mockParsedLine({ data: { type: 'user', message: { content: 'Q2' } } }),
        mockParsedLine({ data: { type: 'assistant', message: { content: 'A2' } } }),
        mockParsedLine({ data: { type: 'user', message: { content: 'Q3' } } })
      ];

      const result = extractor.extract(lines);

      expect(result.turnNumber).toBe(5);
    });

    test('does not count tool results or other line types', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { type: 'user', message: { content: 'Q1' } } }),
        mockParsedLine({ data: { type: 'tool_result', content: 'result' } }),
        mockParsedLine({ data: { type: 'tool_result', content: 'result' } }),
        mockParsedLine({ data: { type: 'assistant', message: { content: 'A1' } } })
      ];

      const result = extractor.extract(lines);

      expect(result.turnNumber).toBe(2); // Only user + assistant
    });

    test('counts messages before last user message', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { type: 'user', message: { content: 'Q1' } } }),
        mockParsedLine({ data: { type: 'assistant', message: { content: 'A1' } } }),
        mockParsedLine({ data: { type: 'user', message: { content: 'Q2' } } })
      ];

      const result = extractor.extract(lines);

      expect(result.turnNumber).toBe(3);
    });
  });

  describe('extract() - Edge Cases', () => {
    test('returns empty result for empty array', () => {
      const result = extractor.extract([]);

      expect(result.preview).toBe('');
      expect(result.sender).toBe('unknown');
      expect(result.turnNumber).toBe(0);
      expect(result.timestamp).toBe(0);
    });

    test('returns empty result if no user messages found', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { type: 'assistant', message: { content: 'Response' } } }),
        mockParsedLine({ data: { type: 'tool_result', content: 'result' } })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('');
      expect(result.sender).toBe('unknown');
      expect(result.turnNumber).toBe(0);
    });

    test('skips user messages with no text content', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: {
              content: [
                { type: 'tool_use', id: 'abc' }
              ]
            }
          }
        }),
        mockParsedLine({
          data: {
            type: 'user',
            message: {
              content: [{ type: 'text', text: 'Has text' }]
            }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Has text');
    });

    test('handles malformed message structure gracefully', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { type: 'user' } }), // No message field
        mockParsedLine({ data: { type: 'user', message: null } }), // Null message
        mockParsedLine({ data: { type: 'user', message: {} } }) // Empty message
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('');
      expect(result.sender).toBe('unknown');
    });

    test('handles lines with null data', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: null, parseError: 'Invalid JSON' }),
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: 'Valid' }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Valid');
    });

    test('handles very large transcript (1000+ lines)', () => {
      const lines = mockParsedLines(1000, { userMessages: 100 });

      const result = extractor.extract(lines);

      expect(result.turnNumber).toBeGreaterThan(0);
      expect(result.preview).toBeTruthy();
    });

    test('handles Unicode and emoji in message text', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: 'Hello 世界 🌍 emoji' }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview).toBe('Hello 世界 🌍 emoji');
    });
  });

  describe('extract() - Result Validation', () => {
    test('result passes assertValidMessageInfo', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            timestamp: new Date().toISOString(),
            message: { content: [{ type: 'text', text: 'Test' }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(() => assertValidMessageInfo(result)).not.toThrow();
    });

    test('empty result passes validation', () => {
      const result = extractor.extract([]);

      expect(() => assertValidMessageInfo(result)).not.toThrow();
    });

    test('preview never exceeds 80 characters', () => {
      const longText = 'x'.repeat(1000);
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: longText }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(result.preview.length).toBeLessThanOrEqual(80);
    });

    test('sender is always valid enum value', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: 'Test' }] }
          }
        })
      ];

      const result = extractor.extract(lines);

      expect(['human', 'assistant', 'unknown']).toContain(result.sender);
    });

    test('turnNumber is always non-negative', () => {
      const result1 = extractor.extract([]);
      expect(result1.turnNumber).toBeGreaterThanOrEqual(0);

      const lines = mockParsedLines(10);
      const result2 = extractor.extract(lines);
      expect(result2.turnNumber).toBeGreaterThanOrEqual(0);
    });

    test('timestamp is always non-negative', () => {
      const result1 = extractor.extract([]);
      expect(result1.timestamp).toBeGreaterThanOrEqual(0);

      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            timestamp: new Date().toISOString(),
            message: { content: [{ type: 'text', text: 'Test' }] }
          }
        })
      ];

      const result2 = extractor.extract(lines);
      expect(result2.timestamp).toBeGreaterThanOrEqual(0);
    });
  });
});
