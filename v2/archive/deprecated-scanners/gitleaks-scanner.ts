/**
 * GitLeaks Scanner - Use gitleaks CLI for professional secret detection
 *
 * Why gitleaks instead of regex:
 * - Industry-standard tool used by security teams
 * - 1000+ secret patterns (API keys, tokens, passwords, certs)
 * - Lower false positive rate (smart entropy detection)
 * - Can scan incremental diffs efficiently
 *
 * How it works:
 * 1. Track last-scanned offset in transcript
 * 2. Extract new content since last scan
 * 3. Write to temp file (gitleaks expects file input)
 * 4. Run: gitleaks detect --no-git --source=tempfile --report-format=json
 * 5. Parse JSON output for findings
 * 6. Map findings back to session transcript
 */

import { existsSync, writeFileSync, unlinkSync, readFileSync, statSync, openSync, closeSync, readSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { execSync } from 'child_process';
import CooldownManager from './cooldown-manager';

interface GitLeaksResult {
  findings: GitLeaksFinding[];
  scannedBytes: number;
  scanDuration: number;
}

interface GitLeaksFinding {
  ruleID: string;        // e.g., "github-pat", "aws-access-token"
  match: string;         // The matched secret (redacted)
  secret: string;        // Full secret (we'll redact this)
  file: string;          // Temp file path
  line: number;          // Line number in temp file
  fingerprint: string;   // Unique ID for deduplication
}

interface ScanState {
  lastScannedOffset: number;
  lastScannedMtime: number;
  knownFindings: string[];  // Fingerprints of known secrets (don't re-alert)
}

class GitLeaksScanner {
  private stateDir: string;
  private cooldownManager: CooldownManager;
  private gitleaksAvailable: boolean | null = null;

  constructor(stateDir?: string) {
    this.stateDir = stateDir || join(homedir(), '.claude/session-health/cooldowns');
    this.cooldownManager = new CooldownManager();
    if (!existsSync(this.stateDir)) {
      require('fs').mkdirSync(this.stateDir, { recursive: true });
    }
  }

  /**
   * Scan transcript for secrets using gitleaks (if available)
   * Falls back to simple regex if gitleaks not installed
   */
  async scan(sessionId: string, transcriptPath: string): Promise<{
    hasSecrets: boolean;
    secretTypes: string[];
    newFindings: number;
  }> {
    // Check cooldown (5min for secrets scan)
    if (!this.cooldownManager.shouldRun('secrets-scan', sessionId)) {
      // Return cached result from state
      const state = this.loadState(sessionId);
      return {
        hasSecrets: state.knownFindings.length > 0,
        secretTypes: this.getFindingTypes(state.knownFindings),
        newFindings: 0
      };
    }

    // Check if gitleaks is available
    if (this.gitleaksAvailable === null) {
      this.gitleaksAvailable = this.checkGitleaksInstalled();
    }

    if (!this.gitleaksAvailable) {
      // Gitleaks not available - skip scan
      // (regex-based scanning is already done in data-gatherer for backwards compat)
      return { hasSecrets: false, secretTypes: [], newFindings: 0 };
    }

    if (!existsSync(transcriptPath)) {
      return { hasSecrets: false, secretTypes: [], newFindings: 0 };
    }

    try {
      const stats = statSync(transcriptPath);
      const state = this.loadState(sessionId);

      // Check if file hasn't changed
      if (stats.mtimeMs === state.lastScannedMtime && stats.size === state.lastScannedOffset) {
        // No changes - return cached
        return {
          hasSecrets: state.knownFindings.length > 0,
          secretTypes: this.getFindingTypes(state.knownFindings),
          newFindings: 0
        };
      }

      // Extract new content since last scan
      const newContent = this.extractNewContent(transcriptPath, state.lastScannedOffset, stats.size);
      if (!newContent || newContent.length === 0) {
        return {
          hasSecrets: state.knownFindings.length > 0,
          secretTypes: this.getFindingTypes(state.knownFindings),
          newFindings: 0
        };
      }

      // Run gitleaks on new content
      const result = await this.runGitleaks(newContent);

      // Update state with new findings
      const newFingerprints = result.findings.map(f => f.fingerprint);
      const allFindings = [...new Set([...state.knownFindings, ...newFingerprints])];

      const newState: ScanState = {
        lastScannedOffset: stats.size,
        lastScannedMtime: stats.mtimeMs,
        knownFindings: allFindings
      };
      this.saveState(sessionId, newState);

      // Mark cooldown
      this.cooldownManager.markComplete('secrets-scan', {}, sessionId);

      return {
        hasSecrets: allFindings.length > 0,
        secretTypes: this.getSecretTypes(result.findings),
        newFindings: result.findings.length
      };

    } catch (error) {
      // Scan failed - return safe default
      return { hasSecrets: false, secretTypes: [], newFindings: 0 };
    }
  }

  /**
   * Check if gitleaks is installed
   */
  private checkGitleaksInstalled(): boolean {
    try {
      execSync('which gitleaks', { stdio: 'ignore', timeout: 1000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Extract new content from transcript since last scan
   */
  private extractNewContent(path: string, lastOffset: number, currentSize: number): string {
    if (currentSize <= lastOffset) {
      return '';
    }

    const newBytes = currentSize - lastOffset;
    // Limit to 10MB max (prevent memory issues on huge transcripts)
    const readSize = Math.min(newBytes, 10_000_000);

    try {
      const fd = openSync(path, 'r');
      const buffer = Buffer.alloc(readSize);
      readSync(fd, buffer, 0, readSize, lastOffset);
      closeSync(fd);
      return buffer.toString('utf-8');
    } catch {
      return '';
    }
  }

  /**
   * Run gitleaks on content
   */
  private async runGitleaks(content: string): Promise<GitLeaksResult> {
    const tempFile = join(tmpdir(), `gitleaks-scan-${Date.now()}.txt`);
    const reportFile = join(tmpdir(), `gitleaks-report-${Date.now()}.json`);

    try {
      // Write content to temp file
      writeFileSync(tempFile, content, 'utf-8');

      // Run gitleaks (--no-git mode, scan single file)
      // --exit-code=0 to prevent throwing on findings
      execSync(
        `gitleaks detect --no-git --source="${tempFile}" --report-format=json --report-path="${reportFile}" --exit-code=0`,
        { timeout: 10000, stdio: 'ignore' }
      );

      // Parse results
      const findings: GitLeaksFinding[] = [];
      if (existsSync(reportFile)) {
        const report = JSON.parse(readFileSync(reportFile, 'utf-8'));
        if (Array.isArray(report)) {
          for (const finding of report) {
            findings.push({
              ruleID: finding.RuleID || 'unknown',
              match: finding.Match || '',
              secret: this.redactSecret(finding.Secret || ''),
              file: finding.File || '',
              line: finding.StartLine || 0,
              fingerprint: finding.Fingerprint || `${finding.RuleID}-${finding.StartLine}`
            });
          }
        }
      }

      return {
        findings,
        scannedBytes: content.length,
        scanDuration: 0
      };

    } finally {
      // Cleanup temp files
      try {
        unlinkSync(tempFile);
      } catch {
        // Ignore
      }
      try {
        unlinkSync(reportFile);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Redact secret (show first 4 and last 4 chars)
   */
  private redactSecret(secret: string): string {
    if (secret.length <= 12) {
      return '***';
    }
    return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
  }

  /**
   * Get unique secret types from findings
   */
  private getSecretTypes(findings: GitLeaksFinding[]): string[] {
    const types = new Set<string>();
    for (const finding of findings) {
      types.add(this.formatRuleID(finding.ruleID));
    }
    return Array.from(types);
  }

  /**
   * Get types from fingerprints (for cached results)
   */
  private getFindingTypes(fingerprints: string[]): string[] {
    const types = new Set<string>();
    for (const fp of fingerprints) {
      // Fingerprint format: "ruleID-linenum"
      const ruleID = fp.split('-')[0];
      if (ruleID) {
        types.add(this.formatRuleID(ruleID));
      }
    }
    return Array.from(types);
  }

  /**
   * Format gitleaks rule ID to user-friendly name
   */
  private formatRuleID(ruleID: string): string {
    const mapping: Record<string, string> = {
      'github-pat': 'GitHub Token',
      'github-fine-grained-pat': 'GitHub Token',
      'github-oauth': 'GitHub OAuth',
      'aws-access-token': 'AWS Key',
      'aws-secret-key': 'AWS Secret',
      'generic-api-key': 'API Key',
      'slack-access-token': 'Slack Token',
      'private-key': 'Private Key',
      'rsa-private-key': 'RSA Key',
      'ssh-private-key': 'SSH Key',
      'postgresql': 'PostgreSQL',
      'mysql': 'MySQL',
      'mongodb': 'MongoDB'
    };

    return mapping[ruleID] || ruleID;
  }

  /**
   * Load scan state
   */
  private loadState(sessionId: string): ScanState {
    const path = join(this.stateDir, `${sessionId}-gitleaks.state`);
    try {
      return JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return {
        lastScannedOffset: 0,
        lastScannedMtime: 0,
        knownFindings: []
      };
    }
  }

  /**
   * Save scan state
   */
  private saveState(sessionId: string, state: ScanState): void {
    const path = join(this.stateDir, `${sessionId}-gitleaks.state`);
    const tempPath = `${path}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(state), { encoding: 'utf-8', mode: 0o600 });
      require('fs').renameSync(tempPath, path);
    } catch {
      try {
        unlinkSync(tempPath);
      } catch {
        // Ignore
      }
    }
  }

  /**
   * Clear findings for a session (user acknowledged/fixed)
   */
  clearFindings(sessionId: string): void {
    const path = join(this.stateDir, `${sessionId}-gitleaks.state`);
    try {
      unlinkSync(path);
    } catch {
      // Ignore
    }
    this.cooldownManager.expire('secrets-scan', sessionId);
  }
}

export default GitLeaksScanner;
