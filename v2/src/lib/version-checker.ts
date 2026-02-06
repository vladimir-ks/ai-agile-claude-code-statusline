/**
 * Version Checker - Detects available Claude Code updates
 *
 * Cache: ~/.claude/session-health/latest-version.json
 * Check frequency: Every 4 hours
 * Source: https://claude.ai/install.sh (parse version from script)
 *
 * Non-critical: All network/parse errors return safe defaults
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { dirname } from 'path';
import { execSync } from 'child_process';

export interface VersionInfo {
  version: string;           // Semantic version (e.g., "2.1.31")
  fetchedAt: number;        // Unix timestamp ms
  source: 'install_script' | 'npm' | 'manual';
  releaseNotes?: string;    // URL to changelog (if available)
}

// In-memory cache
let cachedVersion: VersionInfo | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

export class VersionChecker {
  private static readonly VERSION_CACHE_PATH = `${homedir()}/.claude/session-health/latest-version.json`;
  private static readonly INSTALL_SCRIPT_URL = 'https://claude.ai/install.sh';
  private static readonly CHECK_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

  /**
   * Get current Claude Code version (from CLI)
   * Returns "unknown" if detection fails
   */
  static getCurrentVersion(): string {
    try {
      const output = execSync('claude --version 2>&1', {
        encoding: 'utf-8',
        timeout: 2000,
        maxBuffer: 100 * 1024, // 100KB max
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Parse version from output (e.g., "claude 2.1.31" or "2.1.31")
      const match = output.match(/(\d+\.\d+\.\d+)/);
      return match ? match[1] : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Check if update is available
   * Returns: null (check in progress/failed), false (up to date), true (update available)
   */
  static async checkForUpdate(): Promise<boolean | null> {
    const current = this.getCurrentVersion();
    if (current === 'unknown') {
      return null; // Can't determine current version
    }

    const latest = await this.getLatestVersion();
    if (!latest) {
      return null; // Failed to fetch latest version
    }

    return this.needsUpdate(current, latest.version);
  }

  /**
   * Get latest version info (with caching)
   * Returns null if fetch fails
   */
  static async getLatestVersion(): Promise<VersionInfo | null> {
    const now = Date.now();

    // Return cached data if fresh
    if (cachedVersion && (now - cacheTimestamp) < CACHE_TTL) {
      return cachedVersion;
    }

    // Try to read from file cache
    try {
      if (existsSync(this.VERSION_CACHE_PATH)) {
        const stats = statSync(this.VERSION_CACHE_PATH);
        const ageMs = now - stats.mtimeMs;

        // Use file cache if <4h old
        if (ageMs < this.CHECK_INTERVAL) {
          const content = readFileSync(this.VERSION_CACHE_PATH, 'utf-8');
          const parsed = JSON.parse(content);

          if (parsed && parsed.version) {
            cachedVersion = parsed as VersionInfo;
            cacheTimestamp = now;
            return cachedVersion;
          }
        }
      }
    } catch {
      // File cache read error - will try fetching
    }

    // Fetch new version info
    const fetched = await this.fetchLatestVersion();
    if (fetched) {
      // Write to file cache (atomic)
      this.writeVersionCache(fetched);
      cachedVersion = fetched;
      cacheTimestamp = now;
      return fetched;
    }

    // Failed to fetch - return stale cache if available
    try {
      if (existsSync(this.VERSION_CACHE_PATH)) {
        const content = readFileSync(this.VERSION_CACHE_PATH, 'utf-8');
        const parsed = JSON.parse(content);
        if (parsed && parsed.version) {
          return parsed as VersionInfo;
        }
      }
    } catch {
      // Fall through to null
    }

    return null;
  }

  /**
   * Fetch latest version from install script
   * Returns null if fetch fails
   */
  private static async fetchLatestVersion(): Promise<VersionInfo | null> {
    try {
      // Fetch install script with 5s timeout
      const response = await fetch(this.INSTALL_SCRIPT_URL, {
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        return null;
      }

      const script = await response.text();

      // Parse version from install script
      // Look for patterns like: VERSION="2.1.31" or version=2.1.31 (line-anchored)
      const versionMatch = script.match(/^VERSION\s*=\s*["']?(\d+\.\d+\.\d+)["']?/im);
      if (!versionMatch) {
        return null;
      }

      return {
        version: versionMatch[1],
        fetchedAt: Date.now(),
        source: 'install_script',
        releaseNotes: 'https://docs.anthropic.com/en/docs/claude-code/getting-started'
      };
    } catch {
      return null;
    }
  }

  /**
   * Write version cache to disk (atomic)
   */
  private static writeVersionCache(info: VersionInfo): boolean {
    try {
      const dir = dirname(this.VERSION_CACHE_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Atomic write
      const tmpPath = `${this.VERSION_CACHE_PATH}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(info, null, 2), { mode: 0o600 });
      try {
        renameSync(tmpPath, this.VERSION_CACHE_PATH);
      } catch {
        // Clean up orphaned temp file
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        return false;
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Compare versions (semantic versioning)
   * Returns true if current < latest (update needed)
   */
  static needsUpdate(current: string, latest: string): boolean {
    try {
      // Validate input
      if (!current || !latest || current.trim() === '' || latest.trim() === '') {
        return false;
      }

      const [cMaj, cMin, cPatch] = current.split('.').map(Number);
      const [lMaj, lMin, lPatch] = latest.split('.').map(Number);

      // Check for invalid numbers
      if (isNaN(cMaj) || isNaN(cMin) || isNaN(cPatch) ||
          isNaN(lMaj) || isNaN(lMin) || isNaN(lPatch)) {
        return false;
      }

      if (lMaj > cMaj) return true;
      if (lMaj === cMaj && lMin > cMin) return true;
      if (lMaj === cMaj && lMin === cMin && lPatch > cPatch) return true;

      return false;
    } catch {
      return false; // Parse error - assume no update
    }
  }

  /**
   * Get age of version cache in ms
   * Returns null if cache missing
   */
  static getCacheAge(): number | null {
    try {
      if (!existsSync(this.VERSION_CACHE_PATH)) {
        return null;
      }

      const stats = statSync(this.VERSION_CACHE_PATH);
      return Date.now() - stats.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Check if cache is stale (>4h old)
   */
  static isCacheStale(): boolean {
    const age = this.getCacheAge();
    if (age === null) {
      return true; // Missing = stale
    }

    return age > this.CHECK_INTERVAL;
  }

  /**
   * Clear in-memory cache (for testing)
   */
  static clearCache(): void {
    cachedVersion = null;
    cacheTimestamp = 0;
  }

  /**
   * Format update message for display
   * Returns null if no update available
   */
  static async getUpdateMessage(): Promise<string | null> {
    const current = this.getCurrentVersion();
    if (current === 'unknown') {
      return null;
    }

    const latest = await this.getLatestVersion();
    if (!latest) {
      return null;
    }

    if (!this.needsUpdate(current, latest.version)) {
      return null; // Up to date
    }

    return `Update to ${latest.version} available (your version: ${current})`;
  }

  /**
   * Get version check cooldown remaining in ms
   * Returns 0 if check is due
   */
  static getCheckCooldown(): number {
    const age = this.getCacheAge();
    if (age === null) {
      return 0; // No cache = check immediately
    }

    const remaining = this.CHECK_INTERVAL - age;
    return Math.max(0, remaining);
  }
}

export default VersionChecker;
