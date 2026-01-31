/**
 * Secrets Detector Module - Scan transcript for exposed secrets
 *
 * Purpose: Warn user if secrets (API keys, tokens, passwords) are detected
 * in the conversation history. Scans every 5 minutes.
 *
 * Output: "🔐 SECRETS EXPOSED!" if secrets detected, empty otherwise
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';

interface SecretsData {
  hasSecrets: boolean;
  secretTypes: string[];  // Which types of secrets found
  lastScanTime: number;
  transcriptPath: string | null;
}

interface SecretPattern {
  name: string;
  pattern: RegExp;
  severity: 'high' | 'medium' | 'low';
}

// Common secret patterns
const SECRET_PATTERNS: SecretPattern[] = [
  // API Keys - HIGH severity
  { name: 'OpenAI/Anthropic API Key', pattern: /sk-[a-zA-Z0-9]{20,}/g, severity: 'high' },
  { name: 'AWS Access Key', pattern: /AKIA[0-9A-Z]{16}/g, severity: 'high' },
  { name: 'AWS Secret Key', pattern: /[a-zA-Z0-9/+=]{40}/g, severity: 'medium' },  // Very generic, might false positive
  { name: 'Google API Key', pattern: /AIza[0-9A-Za-z_-]{35}/g, severity: 'high' },

  // Tokens - HIGH severity
  { name: 'GitHub Token', pattern: /gh[ps]_[a-zA-Z0-9]{36}/g, severity: 'high' },
  { name: 'GitHub OAuth', pattern: /gho_[a-zA-Z0-9]{36}/g, severity: 'high' },
  { name: 'GitLab Token', pattern: /glpat-[a-zA-Z0-9_-]{20,}/g, severity: 'high' },
  { name: 'Slack Token', pattern: /xox[baprs]-[a-zA-Z0-9-]+/g, severity: 'high' },
  { name: 'Discord Token', pattern: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}/g, severity: 'high' },

  // Private Keys - HIGH severity (must have BEGIN/END pair with content, capped at 4KB)
  { name: 'Private Key', pattern: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]{50,4096}?-----END[A-Z ]*PRIVATE KEY-----/g, severity: 'high' },
  { name: 'RSA Private Key', pattern: /-----BEGIN RSA PRIVATE KEY-----[\s\S]{50,4096}?-----END RSA PRIVATE KEY-----/g, severity: 'high' },
  { name: 'SSH Private Key', pattern: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]{50,4096}?-----END OPENSSH PRIVATE KEY-----/g, severity: 'high' },

  // Database Connection Strings - HIGH severity
  { name: 'PostgreSQL Connection', pattern: /postgres(ql)?:\/\/[^:]+:[^@]+@/gi, severity: 'high' },
  { name: 'MongoDB Connection', pattern: /mongodb(\+srv)?:\/\/[^:]+:[^@]+@/gi, severity: 'high' },
  { name: 'MySQL Connection', pattern: /mysql:\/\/[^:]+:[^@]+@/gi, severity: 'high' },
  { name: 'Redis Connection', pattern: /redis:\/\/[^:]+:[^@]+@/gi, severity: 'high' },

  // Passwords in Code - MEDIUM severity (more false positives)
  { name: 'Password Assignment', pattern: /password\s*[=:]\s*["'][^"']{8,}["']/gi, severity: 'medium' },
  { name: 'Secret Assignment', pattern: /secret\s*[=:]\s*["'][^"']{8,}["']/gi, severity: 'medium' },
  { name: 'API Key Assignment', pattern: /api[_-]?key\s*[=:]\s*["'][^"']{8,}["']/gi, severity: 'medium' },

  // Cloud Provider - HIGH severity
  { name: 'Azure Connection String', pattern: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+/gi, severity: 'high' },
  { name: 'Stripe Key', pattern: /sk_live_[a-zA-Z0-9]{24,}/g, severity: 'high' },
  { name: 'Stripe Test Key', pattern: /sk_test_[a-zA-Z0-9]{24,}/g, severity: 'medium' },
  { name: 'SendGrid Key', pattern: /SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}/g, severity: 'high' },
  { name: 'Twilio Key', pattern: /SK[a-f0-9]{32}/g, severity: 'high' },
];

// Cache for scan results
interface ScanCache {
  lastScanTime: number;
  lastMtime: number;
  result: SecretsData;
}

let scanCache: ScanCache | null = null;
const SCAN_INTERVAL_MS = 5 * 60 * 1000;  // 5 minutes

class SecretsDetectorModule {
  private transcriptPath: string | null = null;

  setTranscriptPath(path: string): void {
    this.transcriptPath = path;
  }

  /**
   * Check if we need to scan (5 minute interval, or file changed)
   */
  private shouldScan(): boolean {
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) {
      return false;
    }

    const now = Date.now();
    const mtime = statSync(this.transcriptPath).mtimeMs;

    // No cache - need to scan
    if (!scanCache) {
      return true;
    }

    // File changed - need to scan
    if (mtime > scanCache.lastMtime) {
      return true;
    }

    // 5 minutes passed - rescan
    if (now - scanCache.lastScanTime > SCAN_INTERVAL_MS) {
      return true;
    }

    return false;
  }

  /**
   * Scan transcript for secrets
   */
  async fetch(): Promise<SecretsData> {
    const defaultResult: SecretsData = {
      hasSecrets: false,
      secretTypes: [],
      lastScanTime: Date.now(),
      transcriptPath: this.transcriptPath
    };

    // Check if scan needed
    if (!this.shouldScan()) {
      return scanCache?.result || defaultResult;
    }

    // No transcript - nothing to scan
    if (!this.transcriptPath || !existsSync(this.transcriptPath)) {
      return defaultResult;
    }

    try {
      const content = readFileSync(this.transcriptPath, 'utf-8');
      const mtime = statSync(this.transcriptPath).mtimeMs;
      const secretTypes: string[] = [];

      // Scan for each pattern
      for (const pattern of SECRET_PATTERNS) {
        // Only check high severity patterns to reduce false positives
        if (pattern.severity !== 'high') continue;

        const matches = content.match(pattern.pattern);
        if (matches && matches.length > 0) {
          secretTypes.push(pattern.name);
        }
      }

      const result: SecretsData = {
        hasSecrets: secretTypes.length > 0,
        secretTypes,
        lastScanTime: Date.now(),
        transcriptPath: this.transcriptPath
      };

      // Update cache
      scanCache = {
        lastScanTime: Date.now(),
        lastMtime: mtime,
        result
      };

      return result;

    } catch (error) {
      return defaultResult;
    }
  }

  /**
   * Format secrets warning for statusline
   */
  format(data: SecretsData): string {
    if (!data.hasSecrets) {
      return '';
    }

    // Show warning with count of secret types
    const count = data.secretTypes.length;
    if (count === 1) {
      return `🔐SECRETS!(${data.secretTypes[0]})`;
    } else {
      return `🔐SECRETS!(${count} types)`;
    }
  }
}

export default SecretsDetectorModule;
export { SecretsData, SECRET_PATTERNS };
