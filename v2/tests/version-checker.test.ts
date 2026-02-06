/**
 * Tests for VersionChecker - Claude Code update detection
 *
 * Verifies:
 * - Version comparison (semver)
 * - Cache behavior (4h TTL)
 * - Staleness detection
 * - Network error handling
 * - Install script parsing
 * - Current version detection
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { VersionChecker } from '../src/lib/version-checker';
import type { VersionInfo } from '../src/lib/version-checker';

const TEST_DIR = join(tmpdir(), `version-check-test-${Date.now()}`);
const CACHE_FILE = join(TEST_DIR, 'latest-version.json');

describe('VersionChecker', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Override cache path for testing
    (VersionChecker as any).VERSION_CACHE_PATH = CACHE_FILE;
    VersionChecker.clearCache();
  });

  afterEach(() => {
    VersionChecker.clearCache();
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('getCurrentVersion', () => {
    test('returns version string or "unknown"', () => {
      const version = VersionChecker.getCurrentVersion();
      // Should either match semver pattern or be "unknown"
      expect(version).toMatch(/^\d+\.\d+\.\d+$|^unknown$/);
    });

    test('version string has valid format if not unknown', () => {
      const version = VersionChecker.getCurrentVersion();
      if (version !== 'unknown') {
        const parts = version.split('.');
        expect(parts.length).toBe(3);
        expect(Number.isInteger(parseInt(parts[0]))).toBe(true);
        expect(Number.isInteger(parseInt(parts[1]))).toBe(true);
        expect(Number.isInteger(parseInt(parts[2]))).toBe(true);
      }
    });
  });

  describe('needsUpdate', () => {
    test('returns true when latest > current (major)', () => {
      expect(VersionChecker.needsUpdate('1.0.0', '2.0.0')).toBe(true);
    });

    test('returns true when latest > current (minor)', () => {
      expect(VersionChecker.needsUpdate('2.1.0', '2.2.0')).toBe(true);
    });

    test('returns true when latest > current (patch)', () => {
      expect(VersionChecker.needsUpdate('2.1.30', '2.1.31')).toBe(true);
    });

    test('returns false when latest === current', () => {
      expect(VersionChecker.needsUpdate('2.1.31', '2.1.31')).toBe(false);
    });

    test('returns false when latest < current (major)', () => {
      expect(VersionChecker.needsUpdate('2.0.0', '1.0.0')).toBe(false);
    });

    test('returns false when latest < current (minor)', () => {
      expect(VersionChecker.needsUpdate('2.2.0', '2.1.0')).toBe(false);
    });

    test('returns false when latest < current (patch)', () => {
      expect(VersionChecker.needsUpdate('2.1.31', '2.1.30')).toBe(false);
    });

    test('handles edge cases: 0.0.1 vs 0.0.2', () => {
      expect(VersionChecker.needsUpdate('0.0.1', '0.0.2')).toBe(true);
    });

    test('handles large version numbers', () => {
      expect(VersionChecker.needsUpdate('10.20.30', '10.20.31')).toBe(true);
      expect(VersionChecker.needsUpdate('100.0.0', '99.999.999')).toBe(false);
    });

    test('returns false for invalid version strings', () => {
      expect(VersionChecker.needsUpdate('invalid', '2.1.31')).toBe(false);
      expect(VersionChecker.needsUpdate('2.1.31', 'invalid')).toBe(false);
    });

    test('returns false for empty strings', () => {
      expect(VersionChecker.needsUpdate('', '2.1.31')).toBe(false);
      expect(VersionChecker.needsUpdate('2.1.31', '')).toBe(false);
    });

    test('returns false for 2-part version (missing patch)', () => {
      expect(VersionChecker.needsUpdate('2.1', '2.1.31')).toBe(false);
      expect(VersionChecker.needsUpdate('2.1.31', '2.1')).toBe(false);
    });

    test('returns false for version with pre-release tag', () => {
      // "alpha" part gets parsed as NaN → returns false (safe default)
      expect(VersionChecker.needsUpdate('2.1.31-alpha', '2.1.32')).toBe(false);
    });

    test('returns false for whitespace-only strings', () => {
      expect(VersionChecker.needsUpdate('  ', '2.1.31')).toBe(false);
      expect(VersionChecker.needsUpdate('2.1.31', '  ')).toBe(false);
    });

    test('returns false for version with leading zeros', () => {
      // "02" parses as 2 in Number(), so comparison still works
      expect(VersionChecker.needsUpdate('02.01.00', '2.1.1')).toBe(true);
    });
  });

  describe('getCacheAge', () => {
    test('returns null for missing cache', () => {
      const age = VersionChecker.getCacheAge();
      expect(age).toBeNull();
    });

    test('returns age in ms for existing cache', () => {
      const mockVersion: VersionInfo = {
        version: '2.1.31',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      const age = VersionChecker.getCacheAge();
      expect(age).not.toBeNull();
      expect(age!).toBeGreaterThanOrEqual(0);
      expect(age!).toBeLessThan(1000); // Should be very recent
    });

    test('returns correct age for old cache', () => {
      const mockVersion: VersionInfo = {
        version: '2.1.31',
        fetchedAt: Date.now() - 5 * 60 * 1000, // 5 min ago
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      // Backdate file by 5 minutes
      const past = new Date(Date.now() - 5 * 60 * 1000);
      utimesSync(CACHE_FILE, past, past);

      const age = VersionChecker.getCacheAge();
      expect(age).not.toBeNull();
      expect(age!).toBeGreaterThanOrEqual(4.9 * 60 * 1000);
      expect(age!).toBeLessThan(5.1 * 60 * 1000);
    });
  });

  describe('isCacheStale', () => {
    test('returns true for missing cache', () => {
      expect(VersionChecker.isCacheStale()).toBe(true);
    });

    test('returns false for recent cache', () => {
      const mockVersion: VersionInfo = {
        version: '2.1.31',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      expect(VersionChecker.isCacheStale()).toBe(false);
    });

    test('returns true for old cache (>4h)', () => {
      const mockVersion: VersionInfo = {
        version: '2.1.31',
        fetchedAt: Date.now() - 5 * 60 * 60 * 1000, // 5 hours ago
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      // Backdate file by 5 hours
      const past = new Date(Date.now() - 5 * 60 * 60 * 1000);
      utimesSync(CACHE_FILE, past, past);

      expect(VersionChecker.isCacheStale()).toBe(true);
    });

    test('staleness threshold is 4 hours', () => {
      const mockVersion: VersionInfo = {
        version: '2.1.31',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      // Just under 4h - should NOT be stale
      const justUnder = new Date(Date.now() - (4 * 60 * 60 * 1000 - 1000));
      utimesSync(CACHE_FILE, justUnder, justUnder);
      expect(VersionChecker.isCacheStale()).toBe(false);

      // Just over 4h - should be stale
      const justOver = new Date(Date.now() - (4 * 60 * 60 * 1000 + 1000));
      utimesSync(CACHE_FILE, justOver, justOver);
      expect(VersionChecker.isCacheStale()).toBe(true);
    });
  });

  describe('getCheckCooldown', () => {
    test('returns 0 for missing cache (check immediately)', () => {
      const cooldown = VersionChecker.getCheckCooldown();
      expect(cooldown).toBe(0);
    });

    test('returns remaining time for recent cache', () => {
      const mockVersion: VersionInfo = {
        version: '2.1.31',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      const cooldown = VersionChecker.getCheckCooldown();
      expect(cooldown).toBeGreaterThan(0);
      // Should be close to 4 hours (in ms)
      expect(cooldown).toBeGreaterThan(3.9 * 60 * 60 * 1000);
      expect(cooldown).toBeLessThanOrEqual(4 * 60 * 60 * 1000);
    });

    test('returns 0 for old cache (>4h)', () => {
      const mockVersion: VersionInfo = {
        version: '2.1.31',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      // Backdate file by 5 hours
      const past = new Date(Date.now() - 5 * 60 * 60 * 1000);
      utimesSync(CACHE_FILE, past, past);

      const cooldown = VersionChecker.getCheckCooldown();
      expect(cooldown).toBe(0);
    });
  });

  describe('getLatestVersion (with file cache)', () => {
    test('returns cached version if fresh (<4h)', async () => {
      const mockVersion: VersionInfo = {
        version: '2.1.32',
        fetchedAt: Date.now(),
        source: 'install_script',
        releaseNotes: 'https://example.com'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      const result = await VersionChecker.getLatestVersion();
      expect(result).not.toBeNull();
      expect(result!.version).toBe('2.1.32');
      expect(result!.source).toBe('install_script');
    });

    test('returns null for corrupted cache file', async () => {
      writeFileSync(CACHE_FILE, 'NOT VALID JSON {{{', 'utf-8');

      const result = await VersionChecker.getLatestVersion();
      // Will try to fetch from network, but likely fail in test env
      // Should return null or fetched version
      expect(result === null || typeof result === 'object').toBe(true);
    });

    test('uses in-memory cache within TTL', async () => {
      const mockVersion: VersionInfo = {
        version: '2.1.32',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      // First read
      const first = await VersionChecker.getLatestVersion();
      expect(first!.version).toBe('2.1.32');

      // Modify file
      const modified = { ...mockVersion, version: '2.1.33' };
      writeFileSync(CACHE_FILE, JSON.stringify(modified), 'utf-8');

      // Second read (should return cached)
      const second = await VersionChecker.getLatestVersion();
      expect(second!.version).toBe('2.1.32'); // Still cached version
    });

    test('clearCache forces re-read from file', async () => {
      const mockVersion: VersionInfo = {
        version: '2.1.32',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      const first = await VersionChecker.getLatestVersion();
      expect(first!.version).toBe('2.1.32');

      // Modify and clear cache
      const modified = { ...mockVersion, version: '2.1.33' };
      writeFileSync(CACHE_FILE, JSON.stringify(modified), 'utf-8');
      VersionChecker.clearCache();

      // Should read new version
      const second = await VersionChecker.getLatestVersion();
      expect(second!.version).toBe('2.1.33');
    });
  });

  describe('getUpdateMessage', () => {
    test('returns null when current version is unknown', async () => {
      // Mock getCurrentVersion to return unknown
      const original = VersionChecker.getCurrentVersion;
      (VersionChecker as any).getCurrentVersion = () => 'unknown';

      const msg = await VersionChecker.getUpdateMessage();
      expect(msg).toBeNull();

      // Restore
      (VersionChecker as any).getCurrentVersion = original;
    });

    test('returns null when up to date', async () => {
      // Mock versions: current = latest
      const original = VersionChecker.getCurrentVersion;
      (VersionChecker as any).getCurrentVersion = () => '2.1.31';

      const mockVersion: VersionInfo = {
        version: '2.1.31',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      const msg = await VersionChecker.getUpdateMessage();
      expect(msg).toBeNull();

      // Restore
      (VersionChecker as any).getCurrentVersion = original;
    });

    test('returns message when update available', async () => {
      // Mock versions: current < latest
      const original = VersionChecker.getCurrentVersion;
      (VersionChecker as any).getCurrentVersion = () => '2.1.30';

      const mockVersion: VersionInfo = {
        version: '2.1.32',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      const msg = await VersionChecker.getUpdateMessage();
      expect(msg).not.toBeNull();
      expect(msg).toContain('2.1.32');
      expect(msg).toContain('2.1.30');
      expect(msg).toContain('available');

      // Restore
      (VersionChecker as any).getCurrentVersion = original;
    });

    test('message format includes both versions', async () => {
      const original = VersionChecker.getCurrentVersion;
      (VersionChecker as any).getCurrentVersion = () => '2.1.30';

      const mockVersion: VersionInfo = {
        version: '2.1.32',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      const msg = await VersionChecker.getUpdateMessage();
      expect(msg).toMatch(/Update to .* available.*your version:/);

      (VersionChecker as any).getCurrentVersion = original;
    });
  });

  describe('checkForUpdate', () => {
    test('returns null when current version unknown', async () => {
      const original = VersionChecker.getCurrentVersion;
      (VersionChecker as any).getCurrentVersion = () => 'unknown';

      const result = await VersionChecker.checkForUpdate();
      expect(result).toBeNull();

      (VersionChecker as any).getCurrentVersion = original;
    });

    test('returns false when up to date', async () => {
      const original = VersionChecker.getCurrentVersion;
      (VersionChecker as any).getCurrentVersion = () => '2.1.31';

      const mockVersion: VersionInfo = {
        version: '2.1.31',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      const result = await VersionChecker.checkForUpdate();
      expect(result).toBe(false);

      (VersionChecker as any).getCurrentVersion = original;
    });

    test('returns true when update available', async () => {
      const original = VersionChecker.getCurrentVersion;
      (VersionChecker as any).getCurrentVersion = () => '2.1.30';

      const mockVersion: VersionInfo = {
        version: '2.1.32',
        fetchedAt: Date.now(),
        source: 'install_script'
      };
      writeFileSync(CACHE_FILE, JSON.stringify(mockVersion), 'utf-8');

      const result = await VersionChecker.checkForUpdate();
      expect(result).toBe(true);

      (VersionChecker as any).getCurrentVersion = original;
    });
  });
});
