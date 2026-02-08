/**
 * CommandDetector Tests
 *
 * Tests for detecting slash commands in transcript.
 * Phase 0.3 - RED state (no implementation yet)
 *
 * Coverage:
 * - /login detection
 * - /swap-auth detection (with email arg)
 * - /clear detection
 * - Command argument parsing
 * - False positive prevention
 */

import { describe, test, expect } from 'bun:test';
import { CommandDetector } from '../../../src/lib/transcript-scanner/extractors/command-detector';
import { mockParsedLine, COMMAND_PATTERNS } from '../test-harness';
import type { ParsedLine } from '../../../src/lib/transcript-scanner/types';

describe('CommandDetector', () => {
  const detector = new CommandDetector();

  describe('Extractor Interface', () => {
    test('has correct id', () => {
      expect(detector.id).toBe('commands');
    });

    test('shouldCache is true', () => {
      expect(detector.shouldCache).toBe(true);
    });

    test('has cacheTTL defined', () => {
      expect(detector.cacheTTL).toBeGreaterThan(0);
    });

    test('extract method exists', () => {
      expect(typeof detector.extract).toBe('function');
    });
  });

  describe('extract() - /login Command', () => {
    test('detects /login command', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: '/login' }] }
          }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/login');
      expect(commands[0].args).toEqual([]);
    });

    test('detects /login with surrounding text', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: 'I want to /login now' }] }
          }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/login');
    });

    test('detects /login at start of line', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/login to continue' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/login');
    });

    test('reports correct line number for /login', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          lineNumber: 42,
          data: { text: '/login' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands[0].line).toBe(42);
    });

    test('extracts timestamp from message', () => {
      const timestamp = '2026-02-08T15:30:00.000Z';
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            timestamp,
            message: { content: [{ type: 'text', text: '/login' }] }
          }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands[0].timestamp).toBe(new Date(timestamp).getTime());
    });
  });

  describe('extract() - /swap-auth Command', () => {
    test('detects /swap-auth with email argument', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/swap-auth rimidalvk@gmail.com' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/swap-auth');
      expect(commands[0].args).toEqual(['rimidalvk@gmail.com']);
    });

    test('detects /swap-auth with domain-only email', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/swap-auth vladks.com' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].args).toEqual(['vladks.com']);
    });

    test('detects /swap-auth without arguments', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/swap-auth' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/swap-auth');
      expect(commands[0].args).toEqual([]);
    });

    test('parses multiple space-separated arguments', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/swap-auth user@example.com --force' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands[0].args).toEqual(['user@example.com', '--force']);
    });

    test('handles extra whitespace in arguments', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/swap-auth   user@example.com   ' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands[0].args).toEqual(['user@example.com']);
    });
  });

  describe('extract() - /clear Command', () => {
    test('detects /clear command', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/clear' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/clear');
      expect(commands[0].args).toEqual([]);
    });

    test('detects /clear with context text', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: 'Let me /clear the conversation' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/clear');
    });
  });

  describe('extract() - Multiple Commands', () => {
    test('detects multiple commands in same line', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/login then /swap-auth user@example.com' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands.length).toBeGreaterThanOrEqual(2);
      expect(commands.map(c => c.command)).toContain('/login');
      expect(commands.map(c => c.command)).toContain('/swap-auth');
    });

    test('detects commands across multiple lines', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          lineNumber: 10,
          data: { text: '/login' }
        }),
        mockParsedLine({
          lineNumber: 50,
          data: { text: '/swap-auth user@example.com' }
        }),
        mockParsedLine({
          lineNumber: 100,
          data: { text: '/clear' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(3);
      expect(commands[0].line).toBe(10);
      expect(commands[1].line).toBe(50);
      expect(commands[2].line).toBe(100);
    });

    test('preserves command order', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 1, data: { text: '/login' } }),
        mockParsedLine({ lineNumber: 2, data: { text: '/clear' } }),
        mockParsedLine({ lineNumber: 3, data: { text: '/swap-auth test' } })
      ];

      const commands = detector.extract(lines);

      expect(commands[0].command).toBe('/login');
      expect(commands[1].command).toBe('/clear');
      expect(commands[2].command).toBe('/swap-auth');
    });
  });

  describe('extract() - False Positive Prevention', () => {
    test('does not detect file paths as commands', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: COMMAND_PATTERNS.not_a_command }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toEqual([]);
    });

    test('does not detect URLs with slashes', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: 'Visit https://example.com/login for more info' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toEqual([]);
    });

    test('does not detect division operator /', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: 'Calculate 10/2 = 5' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toEqual([]);
    });

    test('does not detect markdown headers', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '# Heading\n## Subheading' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toEqual([]);
    });

    test('requires word boundary before command', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: 'not/login or pre/swap-auth' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toEqual([]);
    });

    test('detects only known commands', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/unknown-command /fake /not-real' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toEqual([]);
    });
  });

  describe('extract() - Timestamp Extraction', () => {
    test('extracts timestamp from message data', () => {
      const timestamp = '2026-02-08T12:00:00Z';
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            timestamp,
            message: { content: [{ type: 'text', text: '/login' }] }
          }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands[0].timestamp).toBe(new Date(timestamp).getTime());
    });

    test('uses current time if timestamp not available', () => {
      const before = Date.now();

      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/login' } // No timestamp field
        })
      ];

      const commands = detector.extract(lines);

      const after = Date.now();

      expect(commands[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(commands[0].timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('extract() - Edge Cases', () => {
    test('returns empty array for no commands', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: 'Regular conversation without commands' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toEqual([]);
    });

    test('returns empty array for empty input', () => {
      const commands = detector.extract([]);
      expect(commands).toEqual([]);
    });

    test('handles lines with null data', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: null, parseError: 'Invalid JSON' }),
        mockParsedLine({ data: { text: '/login' } })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/login');
    });

    test('handles nested message structures', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: {
              content: [
                { type: 'text', text: '/login' },
                { type: 'text', text: 'additional text' }
              ]
            }
          }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/login');
    });

    test('handles commands in string content format', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: { content: '/clear' } // String, not array
          }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/clear');
    });

    test('handles case sensitivity', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/LOGIN' } }),
        mockParsedLine({ data: { text: '/Login' } }),
        mockParsedLine({ data: { text: '/login' } })
      ];

      const commands = detector.extract(lines);

      // Commands should be case-sensitive (lowercase only)
      const loginCommands = commands.filter(c => c.command === '/login');
      expect(loginCommands).toHaveLength(1);
    });

    test('handles Unicode and emoji around commands', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '🔐 /login 世界' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/login');
    });

    test('handles very large transcript (1000+ lines)', () => {
      const lines: ParsedLine[] = Array.from({ length: 1000 }, (_, i) =>
        mockParsedLine({
          lineNumber: i + 1,
          data: i === 500
            ? { text: '/login' }
            : { text: `Regular message ${i}` }
        })
      );

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].line).toBe(501);
    });
  });

  describe('extract() - Result Structure', () => {
    test('each command has all required fields', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/login' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands[0]).toHaveProperty('command');
      expect(commands[0]).toHaveProperty('timestamp');
      expect(commands[0]).toHaveProperty('args');
      expect(commands[0]).toHaveProperty('line');

      expect(typeof commands[0].command).toBe('string');
      expect(typeof commands[0].timestamp).toBe('number');
      expect(Array.isArray(commands[0].args)).toBe(true);
      expect(typeof commands[0].line).toBe('number');
    });

    test('command starts with /', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } })
      ];

      const commands = detector.extract(lines);

      expect(commands[0].command).toMatch(/^\//);
    });

    test('args is always an array', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: '/swap-auth user@example.com' } })
      ];

      const commands = detector.extract(lines);

      for (const cmd of commands) {
        expect(Array.isArray(cmd.args)).toBe(true);
      }
    });

    test('args are strings', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/swap-auth user@example.com --flag' } })
      ];

      const commands = detector.extract(lines);

      for (const arg of commands[0].args) {
        expect(typeof arg).toBe('string');
      }
    });

    test('line number is positive integer', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          lineNumber: 42,
          data: { text: '/login' }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands[0].line).toBeGreaterThan(0);
      expect(Number.isInteger(commands[0].line)).toBe(true);
    });

    test('timestamp is positive integer', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            timestamp: '2026-02-08T12:00:00Z',
            text: '/login'
          }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands[0].timestamp).toBeGreaterThan(0);
      expect(Number.isInteger(commands[0].timestamp)).toBe(true);
    });
  });

  describe('extract() - Integration', () => {
    test('detects all known commands in mixed transcript', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: 'Start with /login' } }),
        mockParsedLine({ data: { text: 'Then /swap-auth user@example.com' } }),
        mockParsedLine({ data: { text: 'Finally /clear' } })
      ];

      const commands = detector.extract(lines);

      const commandTypes = commands.map(c => c.command);
      expect(commandTypes).toContain('/login');
      expect(commandTypes).toContain('/swap-auth');
      expect(commandTypes).toContain('/clear');
    });

    test('works with real-world message structures', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            timestamp: '2026-02-08T15:30:00Z',
            message: {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: 'I need to /swap-auth rimidalvk@gmail.com to continue'
                }
              ]
            }
          }
        })
      ];

      const commands = detector.extract(lines);

      expect(commands).toHaveLength(1);
      expect(commands[0].command).toBe('/swap-auth');
      expect(commands[0].args).toEqual(['rimidalvk@gmail.com']);
    });
  });
});
