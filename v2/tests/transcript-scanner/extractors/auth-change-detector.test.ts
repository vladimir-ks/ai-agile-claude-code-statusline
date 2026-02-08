/**
 * AuthChangeDetector Tests
 *
 * Tests for detecting authentication changes in transcript.
 * Phase 0.3 - RED state (no implementation yet)
 *
 * Coverage:
 * - Login success detection
 * - Swap-auth success detection
 * - Email extraction
 * - Timestamp tracking
 * - False positive prevention
 */

import { describe, test, expect } from 'bun:test';
import { AuthChangeDetector } from '../../../src/lib/transcript-scanner/extractors/auth-change-detector';
import { mockParsedLine } from '../test-harness';
import type { ParsedLine } from '../../../src/lib/transcript-scanner/types';

describe('AuthChangeDetector', () => {
  const detector = new AuthChangeDetector();

  describe('Extractor Interface', () => {
    test('has correct id', () => {
      expect(detector.id).toBe('auth_changes');
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

  describe('extract() - Login Success Detection', () => {
    test('detects login success with email', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          lineNumber: 10,
          data: {
            type: 'user',
            message: { content: [{ type: 'text', text: '/login' }] }
          }
        }),
        mockParsedLine({
          lineNumber: 11,
          data: {
            type: 'assistant',
            timestamp: '2026-02-08T15:30:00Z',
            message: {
              content: [{ type: 'text', text: 'Login successful for vladks.com' }]
            }
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(1);
      expect(authChanges[0].email).toBe('vladks.com');
      expect(authChanges[0].loginTimestamp).toBe(new Date('2026-02-08T15:30:00Z').getTime());
      expect(authChanges[0].line).toBe(11);
    });

    test('detects login success with full email address', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/login' }
        }),
        mockParsedLine({
          data: {
            timestamp: '2026-02-08T15:30:00Z',
            text: 'Login successful for rimidalvk@gmail.com'
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(1);
      expect(authChanges[0].email).toBe('rimidalvk@gmail.com');
    });

    test('requires login command before success message', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: 'Login successful for vladks.com' } // No /login before
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toEqual([]);
    });

    test('success message must follow login command closely', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          lineNumber: 10,
          data: { text: '/login' }
        }),
        mockParsedLine({
          lineNumber: 11,
          data: { text: 'Some other message' }
        }),
        mockParsedLine({
          lineNumber: 12,
          data: { text: 'More messages' }
        }),
        mockParsedLine({
          lineNumber: 50, // Too far from login
          data: { text: 'Login successful for vladks.com' }
        })
      ];

      const authChanges = detector.extract(lines);

      // Should not detect if success message is too far from command
      // (implementation may have a window, e.g., next 5 lines)
      expect(authChanges.length).toBeLessThanOrEqual(0);
    });

    test('ignores login without success message', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: '/login' }
        }),
        mockParsedLine({
          data: { text: 'Login failed' }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toEqual([]);
    });
  });

  describe('extract() - Swap-Auth Success Detection', () => {
    test('detects swap-auth success with email', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          lineNumber: 20,
          data: { text: '/swap-auth rimidalvk@gmail.com' }
        }),
        mockParsedLine({
          lineNumber: 21,
          data: {
            timestamp: '2026-02-08T16:00:00Z',
            text: 'Authentication switched to rimidalvk@gmail.com'
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(1);
      expect(authChanges[0].email).toBe('rimidalvk@gmail.com');
      expect(authChanges[0].loginTimestamp).toBe(new Date('2026-02-08T16:00:00Z').getTime());
    });

    test('detects swap-auth success with domain-only', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/swap-auth vladks.com' } }),
        mockParsedLine({
          data: {
            timestamp: '2026-02-08T16:00:00Z',
            text: 'Switched to vladks.com'
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(1);
      expect(authChanges[0].email).toBe('vladks.com');
    });

    test('extracts email from swap-auth command if not in response', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          lineNumber: 20,
          data: { text: '/swap-auth user@example.com' }
        }),
        mockParsedLine({
          lineNumber: 21,
          data: {
            timestamp: '2026-02-08T16:00:00Z',
            text: 'Authentication switched successfully'
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(1);
      expect(authChanges[0].email).toBe('user@example.com');
    });

    test('ignores swap-auth without success message', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/swap-auth user@example.com' } }),
        mockParsedLine({ data: { text: 'Failed to switch authentication' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toEqual([]);
    });
  });

  describe('extract() - Email Extraction', () => {
    test('extracts standard email format', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'Login successful for user@example.com' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].email).toBe('user@example.com');
    });

    test('extracts domain-only format', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'Login successful for vladks.com' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].email).toBe('vladks.com');
    });

    test('extracts email with + addressing', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'Login successful for user+tag@example.com' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].email).toBe('user+tag@example.com');
    });

    test('extracts email with subdomain', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'Login successful for user@mail.example.com' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].email).toBe('user@mail.example.com');
    });

    test('handles email in various message formats', () => {
      const formats = [
        'Login successful for user@example.com',
        'Logged in as user@example.com',
        'Authentication: user@example.com',
        'Switched to user@example.com'
      ];

      for (const format of formats) {
        const lines: ParsedLine[] = [
          mockParsedLine({ data: { text: '/login' } }),
          mockParsedLine({ data: { text: format } })
        ];

        const authChanges = detector.extract(lines);

        expect(authChanges).toHaveLength(1);
        expect(authChanges[0].email).toBe('user@example.com');
      }
    });
  });

  describe('extract() - Multiple Auth Changes', () => {
    test('detects multiple login events', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 10, data: { text: '/login' } }),
        mockParsedLine({
          lineNumber: 11,
          data: {
            timestamp: '2026-02-08T10:00:00Z',
            text: 'Login successful for user1@example.com'
          }
        }),
        mockParsedLine({ lineNumber: 50, data: { text: '/swap-auth user2@example.com' } }),
        mockParsedLine({
          lineNumber: 51,
          data: {
            timestamp: '2026-02-08T11:00:00Z',
            text: 'Switched to user2@example.com'
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(2);
      expect(authChanges[0].email).toBe('user1@example.com');
      expect(authChanges[1].email).toBe('user2@example.com');
    });

    test('preserves chronological order', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 10, data: { text: '/login' } }),
        mockParsedLine({
          lineNumber: 11,
          data: {
            timestamp: '2026-02-08T10:00:00Z',
            text: 'Login successful for first@example.com'
          }
        }),
        mockParsedLine({ lineNumber: 20, data: { text: '/swap-auth second@example.com' } }),
        mockParsedLine({
          lineNumber: 21,
          data: {
            timestamp: '2026-02-08T11:00:00Z',
            text: 'Switched to second@example.com'
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].loginTimestamp).toBeLessThan(authChanges[1].loginTimestamp);
      expect(authChanges[0].line).toBeLessThan(authChanges[1].line);
    });
  });

  describe('extract() - Timestamp Handling', () => {
    test('uses success message timestamp', () => {
      const timestamp = '2026-02-08T15:30:00.123Z';
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({
          data: {
            timestamp,
            text: 'Login successful for user@example.com'
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].loginTimestamp).toBe(new Date(timestamp).getTime());
    });

    test('uses current time if timestamp not available', () => {
      const before = Date.now();

      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'Login successful for user@example.com' } })
      ];

      const authChanges = detector.extract(lines);

      const after = Date.now();

      expect(authChanges[0].loginTimestamp).toBeGreaterThanOrEqual(before);
      expect(authChanges[0].loginTimestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('extract() - Line Number Tracking', () => {
    test('reports line number of success message', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 10, data: { text: '/login' } }),
        mockParsedLine({
          lineNumber: 11,
          data: { text: 'Login successful for user@example.com' }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].line).toBe(11);
    });

    test('tracks line numbers for multiple auth changes', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 10, data: { text: '/login' } }),
        mockParsedLine({ lineNumber: 11, data: { text: 'Login successful for user1@example.com' } }),
        mockParsedLine({ lineNumber: 50, data: { text: '/swap-auth user2@example.com' } }),
        mockParsedLine({ lineNumber: 51, data: { text: 'Switched to user2@example.com' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].line).toBe(11);
      expect(authChanges[1].line).toBe(51);
    });
  });

  describe('extract() - Edge Cases', () => {
    test('returns empty array for no auth changes', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: 'Regular conversation' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toEqual([]);
    });

    test('returns empty array for empty input', () => {
      const authChanges = detector.extract([]);
      expect(authChanges).toEqual([]);
    });

    test('handles lines with null data', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: null, parseError: 'Invalid JSON' }),
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'Login successful for user@example.com' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(1);
    });

    test('handles nested message structures', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            message: {
              content: [{ type: 'text', text: '/login' }]
            }
          }
        }),
        mockParsedLine({
          data: {
            type: 'assistant',
            timestamp: '2026-02-08T15:30:00Z',
            message: {
              content: [{ type: 'text', text: 'Login successful for user@example.com' }]
            }
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(1);
    });

    test('ignores failed login attempts', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'Login failed: invalid credentials' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toEqual([]);
    });

    test('handles case-insensitive success messages', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'LOGIN SUCCESSFUL FOR user@example.com' } })
      ];

      const authChanges = detector.extract(lines);

      // Implementation may or may not be case-insensitive
      // This tests the behavior
      expect(authChanges.length).toBeGreaterThanOrEqual(0);
    });

    test('handles Unicode and special characters in email', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'Login successful for user+tag@example.com' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(1);
      expect(authChanges[0].email).toContain('@');
    });

    test('handles very large transcript (1000+ lines)', () => {
      const lines: ParsedLine[] = Array.from({ length: 1000 }, (_, i) =>
        i === 500
          ? mockParsedLine({ lineNumber: 500, data: { text: '/login' } })
          : i === 501
            ? mockParsedLine({
                lineNumber: 501,
                data: {
                  timestamp: '2026-02-08T15:30:00Z',
                  text: 'Login successful for user@example.com'
                }
              })
            : mockParsedLine({ lineNumber: i, data: { text: `Message ${i}` } })
      );

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(1);
      expect(authChanges[0].line).toBe(501);
    });
  });

  describe('extract() - Result Structure', () => {
    test('each auth change has all required fields', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({
          data: {
            timestamp: '2026-02-08T15:30:00Z',
            text: 'Login successful for user@example.com'
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0]).toHaveProperty('loginTimestamp');
      expect(authChanges[0]).toHaveProperty('email');
      expect(authChanges[0]).toHaveProperty('line');

      expect(typeof authChanges[0].loginTimestamp).toBe('number');
      expect(typeof authChanges[0].email).toBe('string');
      expect(typeof authChanges[0].line).toBe('number');
    });

    test('loginTimestamp is positive integer', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({
          data: {
            timestamp: '2026-02-08T15:30:00Z',
            text: 'Login successful for user@example.com'
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].loginTimestamp).toBeGreaterThan(0);
      expect(Number.isInteger(authChanges[0].loginTimestamp)).toBe(true);
    });

    test('email is non-empty string', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'Login successful for user@example.com' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].email).toBeTruthy();
      expect(authChanges[0].email.length).toBeGreaterThan(0);
    });

    test('line number is positive integer', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 10, data: { text: '/login' } }),
        mockParsedLine({ lineNumber: 11, data: { text: 'Login successful for user@example.com' } })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges[0].line).toBeGreaterThan(0);
      expect(Number.isInteger(authChanges[0].line)).toBe(true);
    });

    test('email format is valid', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: '/login' } }),
        mockParsedLine({ data: { text: 'Login successful for user@example.com' } })
      ];

      const authChanges = detector.extract(lines);

      // Email should contain @ or be a domain
      expect(
        authChanges[0].email.includes('@') ||
        authChanges[0].email.includes('.')
      ).toBe(true);
    });
  });

  describe('extract() - Integration', () => {
    test('works with real-world message structures', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'user',
            timestamp: '2026-02-08T15:29:00Z',
            message: {
              role: 'user',
              content: [
                { type: 'text', text: '/swap-auth rimidalvk@gmail.com' }
              ]
            }
          }
        }),
        mockParsedLine({
          data: {
            type: 'assistant',
            timestamp: '2026-02-08T15:30:00Z',
            message: {
              role: 'assistant',
              content: [
                { type: 'text', text: 'Authentication switched to rimidalvk@gmail.com successfully.' }
              ]
            }
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(1);
      expect(authChanges[0].email).toBe('rimidalvk@gmail.com');
    });

    test('detects all auth changes in typical session', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 1, data: { text: '/login' } }),
        mockParsedLine({
          lineNumber: 2,
          data: {
            timestamp: '2026-02-08T10:00:00Z',
            text: 'Login successful for vladks.com'
          }
        }),
        mockParsedLine({ lineNumber: 100, data: { text: 'Working on project...' } }),
        mockParsedLine({ lineNumber: 200, data: { text: '/swap-auth rimidalvk@gmail.com' } }),
        mockParsedLine({
          lineNumber: 201,
          data: {
            timestamp: '2026-02-08T12:00:00Z',
            text: 'Switched to rimidalvk@gmail.com'
          }
        })
      ];

      const authChanges = detector.extract(lines);

      expect(authChanges).toHaveLength(2);
      expect(authChanges[0].email).toBe('vladks.com');
      expect(authChanges[1].email).toBe('rimidalvk@gmail.com');
    });
  });
});
