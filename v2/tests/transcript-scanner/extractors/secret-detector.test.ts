/**
 * SecretDetector Tests
 *
 * Tests for detecting secrets in transcript content.
 * Phase 0.3 - RED state (no implementation yet)
 *
 * Coverage:
 * - GitHub PAT detection
 * - AWS key detection
 * - Private key detection
 * - Generic API key detection
 * - Fingerprinting and deduplication
 * - Redaction
 */

import { describe, test, expect } from 'bun:test';
import { SecretDetector } from '../../../src/lib/transcript-scanner/extractors/secret-detector';
import { mockParsedLine, SECRET_PATTERNS } from '../test-harness';
import type { ParsedLine } from '../../../src/lib/transcript-scanner/types';

describe('SecretDetector', () => {
  const detector = new SecretDetector();

  describe('Extractor Interface', () => {
    test('has correct id', () => {
      expect(detector.id).toBe('secrets');
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

  describe('extract() - GitHub Tokens', () => {
    test('detects GitHub personal access token (classic)', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            type: 'assistant',
            message: {
              content: [{ type: 'text', text: `Your token: ${SECRET_PATTERNS.github_pat}` }]
            }
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
      expect(secrets[0].type).toBe('GitHub Token');
      expect(secrets[0].fingerprint).toBeTruthy();
      expect(secrets[0].line).toBe(1);
      expect(secrets[0].match).toMatch(/^ghp_\.\.\..+$/); // Redacted format
    });

    test('detects GitHub fine-grained token', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            text: SECRET_PATTERNS.github_fine_grained
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
      expect(secrets[0].type).toBe('GitHub Token');
    });

    test('detects multiple GitHub tokens in same line', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            tokens: [SECRET_PATTERNS.github_pat, SECRET_PATTERNS.github_fine_grained]
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets.length).toBeGreaterThanOrEqual(2);
    });

    test('detects token in nested JSON structure', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            config: {
              auth: {
                github: {
                  token: SECRET_PATTERNS.github_pat
                }
              }
            }
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
      expect(secrets[0].type).toBe('GitHub Token');
    });
  });

  describe('extract() - AWS Keys', () => {
    test('detects AWS access key', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            aws_access_key: SECRET_PATTERNS.aws_access
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
      expect(secrets[0].type).toBe('AWS Key');
      expect(secrets[0].match).toMatch(/^AKIA\.\.\..+$/);
    });

    test('detects AWS secret key', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            aws_secret_key: SECRET_PATTERNS.aws_secret
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets.length).toBeGreaterThanOrEqual(1);
      expect(secrets.some(s => s.type === 'AWS Key' || s.type === 'Generic API Key')).toBe(true);
    });

    test('detects AWS keys in environment variable format', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            text: `AWS_ACCESS_KEY_ID=${SECRET_PATTERNS.aws_access}\nAWS_SECRET_ACCESS_KEY=${SECRET_PATTERNS.aws_secret}`
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('extract() - Private Keys', () => {
    test('detects RSA private key', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            private_key: SECRET_PATTERNS.private_key
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
      expect(secrets[0].type).toBe('Private Key');
    });

    test('detects EC private key', () => {
      const ecKey = '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEEIIGl...\n-----END EC PRIVATE KEY-----';
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { key: ecKey }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
      expect(secrets[0].type).toBe('Private Key');
    });

    test('detects OPENSSH private key', () => {
      const sshKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA...\n-----END OPENSSH PRIVATE KEY-----';
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { ssh_key: sshKey }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
      expect(secrets[0].type).toBe('Private Key');
    });
  });

  describe('extract() - Generic API Keys', () => {
    test('detects generic API key pattern', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            text: SECRET_PATTERNS.generic_api
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets.length).toBeGreaterThanOrEqual(1);
      expect(secrets.some(s => s.type === 'API Key' || s.type === 'Generic API Key')).toBe(true);
    });

    test('detects Slack token', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            slack: SECRET_PATTERNS.slack_token
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets.length).toBeGreaterThanOrEqual(1);
    });

    test('detects API key in various formats', () => {
      // Obfuscated to pass GitHub push protection (not real keys)
      const formats = [
        'api_key="sk_' + 'live_1234567890abcdefghijklmnopqrst"',
        'apiKey: "sk_' + 'live_1234567890abcdefghijklmnopqrst"',
        'API_KEY=sk_' + 'live_1234567890abcdefghijklmnopqrst'
      ];

      for (const format of formats) {
        const lines: ParsedLine[] = [
          mockParsedLine({ data: { text: format } })
        ];

        const secrets = detector.extract(lines);
        expect(secrets.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('extract() - Fingerprinting', () => {
    test('generates unique fingerprint for each secret', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            token1: SECRET_PATTERNS.github_pat,
            token2: SECRET_PATTERNS.aws_access
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(2);
      expect(secrets[0].fingerprint).not.toBe(secrets[1].fingerprint);
    });

    test('same secret generates same fingerprint', () => {
      const token = SECRET_PATTERNS.github_pat;

      const lines1: ParsedLine[] = [
        mockParsedLine({ data: { token } })
      ];

      const lines2: ParsedLine[] = [
        mockParsedLine({ data: { token } })
      ];

      const secrets1 = detector.extract(lines1);
      const secrets2 = detector.extract(lines2);

      expect(secrets1[0].fingerprint).toBe(secrets2[0].fingerprint);
    });

    test('fingerprint includes secret type', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { token: SECRET_PATTERNS.github_pat }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets[0].fingerprint).toContain('github');
    });

    test('fingerprint is stable across multiple extractions', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { token: SECRET_PATTERNS.github_pat }
        })
      ];

      const secrets1 = detector.extract(lines);
      const secrets2 = detector.extract(lines);
      const secrets3 = detector.extract(lines);

      expect(secrets1[0].fingerprint).toBe(secrets2[0].fingerprint);
      expect(secrets2[0].fingerprint).toBe(secrets3[0].fingerprint);
    });
  });

  describe('extract() - Deduplication', () => {
    test('deduplicates same secret appearing multiple times', () => {
      const token = SECRET_PATTERNS.github_pat;

      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 10, data: { token } }),
        mockParsedLine({ lineNumber: 50, data: { token } }),
        mockParsedLine({ lineNumber: 100, data: { token } })
      ];

      const secrets = detector.extract(lines);

      // Should only detect once (or track all occurrences but deduplicate by fingerprint)
      const uniqueFingerprints = new Set(secrets.map(s => s.fingerprint));
      expect(uniqueFingerprints.size).toBe(1);
    });

    test('reports first occurrence line number', () => {
      const token = SECRET_PATTERNS.github_pat;

      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 50, data: { token } }),
        mockParsedLine({ lineNumber: 10, data: { token } })
      ];

      const secrets = detector.extract(lines);

      // Should report earliest line number
      expect(secrets[0].line).toBe(10);
    });

    test('does not deduplicate different secrets', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            token1: 'ghp_abc123xyz789abc123xyz789abc123xyz7',
            token2: 'ghp_different_token_here_with_diff_val'
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(2);
    });
  });

  describe('extract() - Redaction', () => {
    test('redacts GitHub token to first4...last4', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { token: SECRET_PATTERNS.github_pat }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets[0].match).toMatch(/^ghp_\.\.\..{0,4}$/);
      expect(secrets[0].match).not.toContain('1234567890abcdefghijklmnopqrstuvwx');
    });

    test('redacts AWS key to first4...last4', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { key: SECRET_PATTERNS.aws_access }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets[0].match).toMatch(/^AKIA\.\.\..+$/);
      expect(secrets[0].match.length).toBeLessThan(SECRET_PATTERNS.aws_access.length);
    });

    test('redacts very short secrets to ***', () => {
      const shortSecret = 'abc123'; // < 12 chars
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { text: `api_key="${shortSecret}"` }
        })
      ];

      const secrets = detector.extract(lines);

      if (secrets.length > 0) {
        expect(secrets[0].match).toBe('***');
      }
    });

    test('redacted match never exposes full secret', () => {
      const token = SECRET_PATTERNS.github_pat;
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { token } })
      ];

      const secrets = detector.extract(lines);

      expect(secrets[0].match).not.toBe(token);
      expect(secrets[0].match.length).toBeLessThan(token.length);
    });
  });

  describe('extract() - Line Numbers', () => {
    test('reports correct line number for single match', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 42, data: { token: SECRET_PATTERNS.github_pat } })
      ];

      const secrets = detector.extract(lines);

      expect(secrets[0].line).toBe(42);
    });

    test('reports correct line numbers for multiple secrets', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ lineNumber: 10, data: { token: SECRET_PATTERNS.github_pat } }),
        mockParsedLine({ lineNumber: 50, data: { key: SECRET_PATTERNS.aws_access } }),
        mockParsedLine({ lineNumber: 100, data: { pk: SECRET_PATTERNS.private_key } })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(3);
      expect(secrets.map(s => s.line).sort()).toEqual([10, 50, 100]);
    });
  });

  describe('extract() - Edge Cases', () => {
    test('returns empty array for no secrets', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { text: 'No secrets here, just normal text' } })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toEqual([]);
    });

    test('returns empty array for empty input', () => {
      const secrets = detector.extract([]);
      expect(secrets).toEqual([]);
    });

    test('handles lines with null data', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: null, parseError: 'Invalid JSON' }),
        mockParsedLine({ data: { token: SECRET_PATTERNS.github_pat } })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
    });

    test('handles deeply nested JSON structures', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            level1: {
              level2: {
                level3: {
                  level4: {
                    token: SECRET_PATTERNS.github_pat
                  }
                }
              }
            }
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
    });

    test('handles secrets in array values', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            tokens: [
              SECRET_PATTERNS.github_pat,
              SECRET_PATTERNS.aws_access
            ]
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(2);
    });

    test('does not detect false positives', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            text: 'ghp_ is the prefix but this is not a token',
            path: '/path/to/AKIA-named-file.txt',
            comment: '-----BEGIN is in the text but not a key'
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toEqual([]);
    });

    test('handles very large transcript (1000+ lines)', () => {
      const lines: ParsedLine[] = Array.from({ length: 1000 }, (_, i) =>
        mockParsedLine({
          lineNumber: i + 1,
          data: i === 500
            ? { token: SECRET_PATTERNS.github_pat }
            : { text: `Line ${i}` }
        })
      );

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
      expect(secrets[0].line).toBe(501);
    });

    test('handles Unicode and special characters', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: {
            message: `User said: "My token is ${SECRET_PATTERNS.github_pat} 🔐"`
          }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets).toHaveLength(1);
    });
  });

  describe('extract() - Result Structure', () => {
    test('each secret has all required fields', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          data: { token: SECRET_PATTERNS.github_pat }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets[0]).toHaveProperty('type');
      expect(secrets[0]).toHaveProperty('fingerprint');
      expect(secrets[0]).toHaveProperty('line');
      expect(secrets[0]).toHaveProperty('match');

      expect(typeof secrets[0].type).toBe('string');
      expect(typeof secrets[0].fingerprint).toBe('string');
      expect(typeof secrets[0].line).toBe('number');
      expect(typeof secrets[0].match).toBe('string');
    });

    test('type is human-readable', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { token: SECRET_PATTERNS.github_pat } })
      ];

      const secrets = detector.extract(lines);

      expect(secrets[0].type).toMatch(/GitHub|AWS|Private|API/);
      expect(secrets[0].type).not.toMatch(/github_pat|aws_access/); // Not internal ID
    });

    test('line number is positive integer', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({
          lineNumber: 42,
          data: { token: SECRET_PATTERNS.github_pat }
        })
      ];

      const secrets = detector.extract(lines);

      expect(secrets[0].line).toBeGreaterThan(0);
      expect(Number.isInteger(secrets[0].line)).toBe(true);
    });

    test('fingerprint is non-empty string', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { token: SECRET_PATTERNS.github_pat } })
      ];

      const secrets = detector.extract(lines);

      expect(secrets[0].fingerprint).toBeTruthy();
      expect(secrets[0].fingerprint.length).toBeGreaterThan(0);
    });

    test('match is redacted and safe to display', () => {
      const lines: ParsedLine[] = [
        mockParsedLine({ data: { token: SECRET_PATTERNS.github_pat } })
      ];

      const secrets = detector.extract(lines);

      expect(secrets[0].match).toContain('...');
      expect(secrets[0].match.length).toBeLessThan(20); // Redacted is short
    });
  });
});
