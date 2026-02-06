/**
 * Tests for v2/src/lib/data-cache-manager.ts — DataCacheManager
 *
 * Memory cache (10s TTL) + file read/write + atomic writes.
 * Stores GlobalDataCache at ~/.claude/session-health/data-cache.json
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We need to override the CACHE_PATH for testing. The module uses a static readonly
// property derived from homedir(). We'll mock by overriding the file at the expected path.
// Actually, let's use a different approach: import and test with actual temp files.

// The DataCacheManager uses a hardcoded path. For isolated testing,
// we'll manipulate the actual cache file path or test the behavior patterns.
// Since it's a static class with private CACHE_PATH, we need to either:
// 1. Test against real path (risky, affects system)
// 2. Test indirectly through behavior
//
// Best approach: test the module's logic patterns with a temp directory
// and monkey-patch the CACHE_PATH for testing.

describe('DataCacheManager', () => {
  let tempDir: string;
  let tempCachePath: string;
  let DataCacheManager: any;
  let originalCachePath: string;

  beforeEach(async () => {
    // Create isolated temp dir
    tempDir = join(tmpdir(), `dcm-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
    tempCachePath = join(tempDir, 'data-cache.json');

    // Fresh import each time to reset module-level cache
    // We'll use a dynamic import trick with cache busting
    const mod = await import('../src/lib/data-cache-manager');
    DataCacheManager = mod.DataCacheManager;
    DataCacheManager.clearCache();

    // Override CACHE_PATH via Object.defineProperty
    originalCachePath = (DataCacheManager as any).CACHE_PATH;
    Object.defineProperty(DataCacheManager, 'CACHE_PATH', {
      value: tempCachePath,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    // Restore original path
    Object.defineProperty(DataCacheManager, 'CACHE_PATH', {
      value: originalCachePath,
      writable: true,
      configurable: true,
    });
    DataCacheManager.clearCache();

    // Cleanup temp dir
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // read()
  // -------------------------------------------------------------------------

  describe('read()', () => {
    test('returns empty cache when file does not exist', () => {
      const cache = DataCacheManager.read();
      expect(cache.version).toBe(2);
      expect(cache.sources).toEqual({});
    });

    test('returns empty cache for corrupted JSON', () => {
      writeFileSync(tempCachePath, 'NOT JSON{{{');
      const cache = DataCacheManager.read();
      expect(cache.version).toBe(2);
      expect(cache.sources).toEqual({});
    });

    test('returns empty cache for wrong version', () => {
      writeFileSync(tempCachePath, JSON.stringify({ version: 1, sources: {} }));
      const cache = DataCacheManager.read();
      expect(cache.version).toBe(2);
      expect(cache.sources).toEqual({});
    });

    test('returns empty cache for missing sources key', () => {
      writeFileSync(tempCachePath, JSON.stringify({ version: 2 }));
      const cache = DataCacheManager.read();
      expect(cache.version).toBe(2);
      expect(cache.sources).toEqual({});
    });

    test('reads valid cache from file', () => {
      const validCache = {
        version: 2,
        updatedAt: Date.now(),
        sources: {
          billing_oauth: {
            data: { daily_cost: 40.3 },
            fetchedAt: Date.now() - 30_000,
            fetchedBy: 1234,
          },
        },
      };
      writeFileSync(tempCachePath, JSON.stringify(validCache));
      const cache = DataCacheManager.read();
      expect(cache.version).toBe(2);
      expect(cache.sources.billing_oauth.data.daily_cost).toBe(40.3);
    });

    test('uses memory cache within TTL', () => {
      const validCache = {
        version: 2,
        updatedAt: Date.now(),
        sources: {
          billing: { data: { v: 1 }, fetchedAt: Date.now(), fetchedBy: 1 },
        },
      };
      writeFileSync(tempCachePath, JSON.stringify(validCache));

      // First read — from file
      const first = DataCacheManager.read();
      expect(first.sources.billing.data.v).toBe(1);

      // Modify file
      validCache.sources.billing.data.v = 2;
      writeFileSync(tempCachePath, JSON.stringify(validCache));

      // Second read within TTL — should return memory-cached v:1
      const second = DataCacheManager.read();
      expect(second.sources.billing.data.v).toBe(1);
    });

    test('refreshes from file after cache clear', () => {
      const cache1 = {
        version: 2,
        updatedAt: Date.now(),
        sources: {
          billing: { data: { v: 1 }, fetchedAt: Date.now(), fetchedBy: 1 },
        },
      };
      writeFileSync(tempCachePath, JSON.stringify(cache1));
      DataCacheManager.read(); // populate memory cache

      // Update file
      cache1.sources.billing.data.v = 2;
      writeFileSync(tempCachePath, JSON.stringify(cache1));

      // Clear memory cache
      DataCacheManager.clearCache();

      // Now reads from file
      const result = DataCacheManager.read();
      expect(result.sources.billing.data.v).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // getSourceData()
  // -------------------------------------------------------------------------

  describe('getSourceData()', () => {
    test('returns null for missing source', () => {
      expect(DataCacheManager.getSourceData('nonexistent')).toBeNull();
    });

    test('returns entry for existing source', () => {
      const validCache = {
        version: 2,
        updatedAt: Date.now(),
        sources: {
          git_status: {
            data: { branch: 'main', dirty: 3 },
            fetchedAt: Date.now(),
            fetchedBy: process.pid,
          },
        },
      };
      writeFileSync(tempCachePath, JSON.stringify(validCache));
      DataCacheManager.clearCache();

      const entry = DataCacheManager.getSourceData('git_status');
      expect(entry).not.toBeNull();
      expect(entry!.data.branch).toBe('main');
      expect(entry!.data.dirty).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // isSourceFresh()
  // -------------------------------------------------------------------------

  describe('isSourceFresh()', () => {
    test('returns false for missing source', () => {
      expect(DataCacheManager.isSourceFresh('nonexistent', 'billing_oauth')).toBe(false);
    });

    test('returns true for recently fetched data', () => {
      const cache = {
        version: 2,
        updatedAt: Date.now(),
        sources: {
          billing_oauth: {
            data: {},
            fetchedAt: Date.now() - 10_000, // 10s ago, within 2min freshMs
            fetchedBy: 1,
          },
        },
      };
      writeFileSync(tempCachePath, JSON.stringify(cache));
      DataCacheManager.clearCache();
      expect(DataCacheManager.isSourceFresh('billing_oauth', 'billing_oauth')).toBe(true);
    });

    test('returns false for stale data', () => {
      const cache = {
        version: 2,
        updatedAt: Date.now(),
        sources: {
          billing_oauth: {
            data: {},
            fetchedAt: Date.now() - 300_000, // 5min ago, > 2min freshMs
            fetchedBy: 1,
          },
        },
      };
      writeFileSync(tempCachePath, JSON.stringify(cache));
      DataCacheManager.clearCache();
      expect(DataCacheManager.isSourceFresh('billing_oauth', 'billing_oauth')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // update()
  // -------------------------------------------------------------------------

  describe('update()', () => {
    test('creates cache file if it does not exist', () => {
      const result = DataCacheManager.update({
        billing_oauth: {
          data: { cost: 10 },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
      });
      expect(result).toBe(true);
      expect(existsSync(tempCachePath)).toBe(true);

      const content = JSON.parse(readFileSync(tempCachePath, 'utf-8'));
      expect(content.version).toBe(2);
      expect(content.sources.billing_oauth.data.cost).toBe(10);
    });

    test('merges into existing cache', () => {
      // Write initial cache
      const initial = {
        version: 2,
        updatedAt: Date.now() - 60_000,
        sources: {
          billing_oauth: {
            data: { cost: 10 },
            fetchedAt: Date.now() - 60_000,
            fetchedBy: 1,
          },
        },
      };
      writeFileSync(tempCachePath, JSON.stringify(initial));
      DataCacheManager.clearCache();

      // Update with new source
      const result = DataCacheManager.update({
        git_status: {
          data: { branch: 'main' },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
      });
      expect(result).toBe(true);

      // Verify both sources exist
      DataCacheManager.clearCache();
      const cache = DataCacheManager.read();
      expect(cache.sources.billing_oauth.data.cost).toBe(10);
      expect(cache.sources.git_status.data.branch).toBe('main');
    });

    test('overwrites existing source entry', () => {
      const initial = {
        version: 2,
        updatedAt: Date.now(),
        sources: {
          billing_oauth: {
            data: { cost: 10 },
            fetchedAt: Date.now() - 60_000,
            fetchedBy: 1,
          },
        },
      };
      writeFileSync(tempCachePath, JSON.stringify(initial));
      DataCacheManager.clearCache();

      DataCacheManager.update({
        billing_oauth: {
          data: { cost: 25 },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
      });

      DataCacheManager.clearCache();
      const cache = DataCacheManager.read();
      expect(cache.sources.billing_oauth.data.cost).toBe(25);
    });

    test('updates multiple sources at once', () => {
      DataCacheManager.update({
        billing_oauth: {
          data: { cost: 10 },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
        git_status: {
          data: { branch: 'dev' },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
        version_check: {
          data: { latest: '2.0.0' },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
      });

      DataCacheManager.clearCache();
      const cache = DataCacheManager.read();
      expect(Object.keys(cache.sources)).toHaveLength(3);
    });

    test('updates memory cache after write', () => {
      DataCacheManager.update({
        billing: {
          data: { cost: 99 },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
      });

      // Should read from memory cache (no file read needed)
      const cache = DataCacheManager.read();
      expect(cache.sources.billing.data.cost).toBe(99);
    });

    test('sets updatedAt timestamp', () => {
      const before = Date.now();
      DataCacheManager.update({
        test: {
          data: {},
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
      });
      const after = Date.now();

      DataCacheManager.clearCache();
      const cache = DataCacheManager.read();
      expect(cache.updatedAt).toBeGreaterThanOrEqual(before);
      expect(cache.updatedAt).toBeLessThanOrEqual(after);
    });

    test('handles corrupted existing file gracefully', () => {
      writeFileSync(tempCachePath, 'CORRUPT{{{');
      const result = DataCacheManager.update({
        billing: {
          data: { cost: 1 },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
      });
      expect(result).toBe(true);

      DataCacheManager.clearCache();
      const cache = DataCacheManager.read();
      expect(cache.sources.billing.data.cost).toBe(1);
    });

    test('creates parent directory if missing', () => {
      const deepPath = join(tempDir, 'nested', 'deep', 'data-cache.json');
      Object.defineProperty(DataCacheManager, 'CACHE_PATH', {
        value: deepPath,
        writable: true,
        configurable: true,
      });

      const result = DataCacheManager.update({
        test: {
          data: {},
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
      });
      expect(result).toBe(true);
      expect(existsSync(deepPath)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // isAvailable()
  // -------------------------------------------------------------------------

  describe('isAvailable()', () => {
    test('returns false when file does not exist', () => {
      expect(DataCacheManager.isAvailable()).toBe(false);
    });

    test('returns true when file exists', () => {
      writeFileSync(tempCachePath, '{}');
      expect(DataCacheManager.isAvailable()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getSourceAge()
  // -------------------------------------------------------------------------

  describe('getSourceAge()', () => {
    test('returns Infinity for missing source', () => {
      expect(DataCacheManager.getSourceAge('nonexistent')).toBe(Infinity);
    });

    test('returns age in ms for existing source', () => {
      const fetchedAt = Date.now() - 5000;
      const cache = {
        version: 2,
        updatedAt: Date.now(),
        sources: {
          billing: {
            data: {},
            fetchedAt,
            fetchedBy: 1,
          },
        },
      };
      writeFileSync(tempCachePath, JSON.stringify(cache));
      DataCacheManager.clearCache();

      const age = DataCacheManager.getSourceAge('billing');
      // Should be roughly 5000ms (allow 500ms tolerance for test execution)
      expect(age).toBeGreaterThanOrEqual(4500);
      expect(age).toBeLessThan(10000);
    });
  });

  // -------------------------------------------------------------------------
  // clearCache()
  // -------------------------------------------------------------------------

  describe('clearCache()', () => {
    test('forces next read() to go to file', () => {
      const cache = {
        version: 2,
        updatedAt: Date.now(),
        sources: {
          billing: { data: { v: 1 }, fetchedAt: Date.now(), fetchedBy: 1 },
        },
      };
      writeFileSync(tempCachePath, JSON.stringify(cache));
      DataCacheManager.read(); // populate memory

      // Change file
      cache.sources.billing.data.v = 42;
      writeFileSync(tempCachePath, JSON.stringify(cache));

      // Without clear: still returns v:1
      expect(DataCacheManager.read().sources.billing.data.v).toBe(1);

      // After clear: reads v:42 from file
      DataCacheManager.clearCache();
      expect(DataCacheManager.read().sources.billing.data.v).toBe(42);
    });
  });

  // -------------------------------------------------------------------------
  // Atomic write correctness
  // -------------------------------------------------------------------------

  describe('atomic write', () => {
    test('file content is valid JSON after update', () => {
      DataCacheManager.update({
        billing: {
          data: { cost: 10 },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
      });

      const content = readFileSync(tempCachePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.version).toBe(2);
      expect(parsed.sources.billing).toBeDefined();
    });

    test('no temp files left after successful update', () => {
      DataCacheManager.update({
        test: { data: {}, fetchedAt: Date.now(), fetchedBy: process.pid },
      });

      // Check no .tmp files in the directory
      const { readdirSync } = require('fs');
      const files = readdirSync(tempDir);
      const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
      expect(tmpFiles).toHaveLength(0);
    });
  });
});
