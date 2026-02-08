/**
 * Secret Detector - Detect leaked secrets in transcript
 *
 * Scans for common secret patterns:
 * - GitHub Personal Access Tokens (PAT)
 * - AWS Access Keys
 * - Stripe API Keys
 * - Slack Tokens
 * - Private Keys
 * - Generic API keys
 *
 * Performance: O(n) single-pass with regex matching
 * Security: Redacts secrets in output (first4...last4 format)
 */

import type { ParsedLine, Secret } from '../types';
import type { DataExtractor } from '../types';
import { createHash } from 'crypto';

/**
 * Secret pattern definitions
 * Each pattern includes: regex, type label, minimum length
 */
interface SecretPattern {
  regex: RegExp;
  type: string;
  minLength?: number;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // GitHub Personal Access Tokens
  {
    regex: /\bghp_[A-Za-z0-9_]{36,}\b/g,
    type: 'GitHub Token'
  },
  // GitHub Fine-Grained Tokens
  {
    regex: /\bgithub_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9]{59}\b/g,
    type: 'GitHub Token'
  },
  // AWS Access Key ID
  {
    regex: /\b(AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
    type: 'AWS Key'
  },
  // AWS Secret Access Key (base64, 40 chars)
  {
    regex: /\b[A-Za-z0-9/+=]{40}\b/g,
    type: 'AWS Secret Key',
    minLength: 40
  },
  // Stripe API Keys
  {
    regex: /\bsk_(live|test)_[A-Za-z0-9]{24,}\b/g,
    type: 'Stripe API Key'
  },
  // Slack Tokens
  {
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    type: 'Slack Token'
  },
  // Generic API Keys (common patterns)
  {
    regex: /\b(api[_-]?key|apikey|auth[_-]?token|access[_-]?token)["\s:=]+([A-Za-z0-9_\-]{20,})\b/gi,
    type: 'API Key'
  },
  // RSA Private Keys
  {
    regex: /-----BEGIN\s+RSA\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+RSA\s+PRIVATE\s+KEY-----/g,
    type: 'Private Key'
  },
  // EC Private Keys
  {
    regex: /-----BEGIN\s+EC\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+EC\s+PRIVATE\s+KEY-----/g,
    type: 'Private Key'
  },
  // OpenSSH Private Keys
  {
    regex: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+OPENSSH\s+PRIVATE\s+KEY-----/g,
    type: 'Private Key'
  },
  // Generic Private Keys (fallback)
  {
    regex: /-----BEGIN\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+PRIVATE\s+KEY-----/g,
    type: 'Private Key'
  }
];

export class SecretDetector implements DataExtractor<Secret[]> {
  readonly id = 'secrets';
  readonly shouldCache = true;
  readonly cacheTTL = 300_000; // 5 minutes

  /**
   * Extract secrets from transcript lines
   *
   * @param lines - Parsed transcript lines
   * @returns Array of detected secrets
   *
   * Strategy:
   * 1. Stringify each line data (recursively handle nested objects)
   * 2. Apply all secret patterns via regex
   * 3. Generate fingerprints for deduplication
   * 4. Redact sensitive data in output
   *
   * Performance: O(n × p) where n=lines, p=patterns
   * Security: Never returns full secret values
   */
  extract(lines: ParsedLine[]): Secret[] {
    const secrets: Secret[] = [];
    const seen = new Set<string>(); // Fingerprint deduplication

    for (const line of lines) {
      if (!line.data) continue;

      // Stringify line data (handles nested objects)
      const text = this.stringifyData(line.data);

      // Apply all patterns
      for (const pattern of SECRET_PATTERNS) {
        // Reset regex state
        pattern.regex.lastIndex = 0;

        let match;
        while ((match = pattern.regex.exec(text)) !== null) {
          const secretValue = match[0];

          // Skip if too short (reduces false positives)
          if (pattern.minLength && secretValue.length < pattern.minLength) {
            continue;
          }

          // Generate fingerprint for deduplication
          const fingerprint = this.generateFingerprint(secretValue, pattern.type);

          if (seen.has(fingerprint)) {
            continue; // Skip duplicate
          }

          seen.add(fingerprint);

          secrets.push({
            type: pattern.type,
            fingerprint,
            line: line.lineNumber,
            match: this.redact(secretValue)
          });
        }
      }
    }

    return secrets;
  }

  /**
   * Stringify data structure recursively
   * Handles objects, arrays, primitives
   *
   * @param data - Any data structure
   * @returns String representation
   */
  private stringifyData(data: any): string {
    if (typeof data === 'string') {
      return data;
    }

    if (typeof data === 'number' || typeof data === 'boolean') {
      return String(data);
    }

    if (data === null || data === undefined) {
      return '';
    }

    if (Array.isArray(data)) {
      return data.map(item => this.stringifyData(item)).join(' ');
    }

    if (typeof data === 'object') {
      // Recursively stringify object values
      return Object.values(data)
        .map(value => this.stringifyData(value))
        .join(' ');
    }

    return '';
  }

  /**
   * Generate unique fingerprint for secret
   * Format: type-keyword_hash
   * Includes type keyword for easier identification
   *
   * @param secret - Secret value
   * @param type - Secret type label
   * @returns Fingerprint string
   */
  private generateFingerprint(secret: string, type?: string): string {
    const hash = createHash('sha256')
      .update(secret)
      .digest('hex')
      .slice(0, 12);

    // Extract type keyword (e.g., "GitHub Token" → "github")
    const typeKey = type ? type.toLowerCase().split(' ')[0] : 'unknown';

    return `${typeKey}_${hash}`;
  }

  /**
   * Redact secret for safe display
   * Format: first4...last4
   *
   * @param secret - Secret value
   * @returns Redacted string
   *
   * Examples:
   * - "ghp_abc123xyz789" → "ghp_...789"
   * - "AKIAIOSFODNN7EXAMPLE" → "AKIA...MPLE"
   */
  private redact(secret: string): string {
    if (secret.length <= 8) {
      // Too short to redact meaningfully
      return '***';
    }

    const first = secret.slice(0, 4);
    const last = secret.slice(-4);

    return `${first}...${last}`;
  }
}

export default SecretDetector;
