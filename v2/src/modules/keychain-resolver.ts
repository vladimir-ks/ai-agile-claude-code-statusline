/**
 * Keychain Resolver - Maps Claude Code sessions to their keychain credentials
 *
 * PROBLEM: With multiple Claude accounts, the statusline needs to know WHICH
 * keychain entry belongs to the current session. Previously it scanned all
 * entries and returned the first valid token (wrong for multi-account).
 *
 * SOLUTION: Derive CLAUDE_CONFIG_DIR from transcript_path, then compute the
 * exact keychain service name using the same SHA256 hash algorithm Claude Code uses.
 *
 * KEY INSIGHT:
 *   transcript_path = {CLAUDE_CONFIG_DIR}/projects/{encoded-project}/{session-id}.jsonl
 *   The "/projects/" segment is universal. Everything before it IS the config dir.
 *
 * KEYCHAIN NAMING:
 *   Default (~/.claude)  → "Claude Code-credentials" (bare, no hash)
 *   Custom path          → "Claude Code-credentials-{SHA256(path)[0:8]}"
 */

import { createHash } from 'crypto';
import { homedir } from 'os';
import { resolve } from 'path';
import { execSync } from 'child_process';

export interface KeychainResolution {
  configDir: string | null;
  keychainService: string | null;
}

export interface KeychainEntry {
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
  isExpired: boolean;
}

export class KeychainResolver {
  private static readonly PROJECTS_SEGMENT = '/projects/';
  private static readonly DEFAULT_CONFIG_DIR = resolve(homedir(), '.claude');
  private static readonly BARE_SERVICE = 'Claude Code-credentials';

  /**
   * Derive CLAUDE_CONFIG_DIR from a transcript path.
   *
   * Claude Code stores transcripts at:
   *   {CLAUDE_CONFIG_DIR}/projects/-{encoded-project-path}/{session-id}.jsonl
   *
   * We find "/projects/" and take everything before it.
   */
  static deriveConfigDir(transcriptPath: string | null): string | null {
    if (!transcriptPath) return null;

    const idx = transcriptPath.indexOf(this.PROJECTS_SEGMENT);
    if (idx < 0) return null;

    const raw = transcriptPath.substring(0, idx);
    // Normalize: resolve symlinks, remove trailing slashes
    return resolve(raw);
  }

  /**
   * Compute the keychain service name for a given config directory.
   *
   * Claude Code uses:
   *   - "Claude Code-credentials" for default ~/.claude
   *   - "Claude Code-credentials-{SHA256(configDir)[0:8]}" for custom dirs
   */
  static computeKeychainService(configDir: string): string {
    const normalized = resolve(configDir);

    if (normalized === this.DEFAULT_CONFIG_DIR) {
      return this.BARE_SERVICE;
    }

    const hash = createHash('sha256')
      .update(normalized)
      .digest('hex')
      .substring(0, 8);

    return `${this.BARE_SERVICE}-${hash}`;
  }

  /**
   * Resolve both configDir and keychainService from a transcript path.
   * Returns nulls if transcript path doesn't contain "/projects/".
   */
  static resolveFromTranscript(transcriptPath: string | null): KeychainResolution {
    const configDir = this.deriveConfigDir(transcriptPath);

    if (!configDir) {
      return { configDir: null, keychainService: null };
    }

    const keychainService = this.computeKeychainService(configDir);
    return { configDir, keychainService };
  }

  /**
   * Read and validate a specific keychain entry.
   * Returns structured result with token, expiry status, and refresh token.
   *
   * Does NOT perform refresh - caller handles that.
   */
  static readKeychainEntry(serviceName: string): KeychainEntry | null {
    try {
      const credJson = execSync(
        `security find-generic-password -s "${serviceName}" -w 2>/dev/null`,
        { encoding: 'utf-8', timeout: 2000, stdio: ['pipe', 'pipe', 'ignore'] }
      ).trim();

      if (!credJson) return null;

      const cred = JSON.parse(credJson);
      if (!cred.claudeAiOauth?.accessToken) return null;

      const oauth = cred.claudeAiOauth;
      const expiresAt = oauth.expiresAt || null;
      const now = Date.now();

      // Determine expiry: expired if expiresAt is set and in the past (with 60s buffer)
      const isExpired = expiresAt !== null && expiresAt < (now + 60000);

      return {
        accessToken: oauth.accessToken,
        refreshToken: oauth.refreshToken || null,
        expiresAt,
        subscriptionType: oauth.subscriptionType || null,
        rateLimitTier: oauth.rateLimitTier || null,
        isExpired: expiresAt !== null ? isExpired : false
      };
    } catch {
      return null;
    }
  }
}

export default KeychainResolver;
