/**
 * Tests for display-only.ts data-cache.json fallback
 *
 * Phase 5: When no session health exists, display-only reads from
 * data-cache.json for billing/quota data (richer initial display).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('display-only data-cache.json fallback', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `display-cache-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // DataCacheManager can create valid cache files
  // -------------------------------------------------------------------------

  test('DataCacheManager.update creates valid cache for display fallback', async () => {
    const { DataCacheManager } = await import('../src/lib/data-cache-manager');

    // Override CACHE_PATH
    const cachePath = join(tempDir, 'data-cache.json');
    const origPath = (DataCacheManager as any).CACHE_PATH;
    Object.defineProperty(DataCacheManager, 'CACHE_PATH', {
      value: cachePath, writable: true, configurable: true,
    });
    DataCacheManager.clearCache();

    try {
      // Write billing data
      DataCacheManager.update({
        billing: {
          data: {
            billing: {
              costToday: 40.3,
              burnRatePerHour: 15.1,
              isFresh: true,
            },
            source: 'oauth',
            fetchedAt: Date.now(),
          },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
        quota: {
          data: {
            weeklyBudgetRemaining: 42,
            weeklyBudgetPercentUsed: 16,
            weeklyResetDay: 'Thu',
            source: 'broker',
            fetchedAt: Date.now(),
          },
          fetchedAt: Date.now(),
          fetchedBy: process.pid,
        },
      });

      expect(existsSync(cachePath)).toBe(true);

      // Verify the file can be parsed by display-only logic
      const content = JSON.parse(require('fs').readFileSync(cachePath, 'utf-8'));
      expect(content.version).toBe(2);
      expect(content.sources.billing.data.billing.costToday).toBe(40.3);
      expect(content.sources.quota.data.weeklyBudgetRemaining).toBe(42);
    } finally {
      Object.defineProperty(DataCacheManager, 'CACHE_PATH', {
        value: origPath, writable: true, configurable: true,
      });
      DataCacheManager.clearCache();
    }
  });

  // -------------------------------------------------------------------------
  // Data cache structure matches display-only expectations
  // -------------------------------------------------------------------------

  test('data-cache.json structure is parseable by display-only fallback', () => {
    const cachePath = join(tempDir, 'data-cache.json');
    const cache = {
      version: 2,
      updatedAt: Date.now(),
      sources: {
        billing: {
          data: {
            billing: { costToday: 25.5, burnRatePerHour: 10.2, isFresh: true },
            source: 'ccusage',
            fetchedAt: Date.now(),
          },
          fetchedAt: Date.now(),
          fetchedBy: 1234,
        },
        quota: {
          data: {
            weeklyBudgetRemaining: 30,
            weeklyBudgetPercentUsed: 58,
            weeklyResetDay: 'Mon',
            source: 'broker',
            fetchedAt: Date.now(),
          },
          fetchedAt: Date.now(),
          fetchedBy: 1234,
        },
      },
    };
    writeFileSync(cachePath, JSON.stringify(cache, null, 2));

    // Simulate the display-only fallback logic
    const dataCache = JSON.parse(require('fs').readFileSync(cachePath, 'utf-8'));
    expect(dataCache.version).toBe(2);
    expect(dataCache.sources).toBeDefined();

    // Billing extraction (matches display-only.ts logic)
    const billingEntry = dataCache.sources.billing;
    expect(billingEntry?.data?.billing?.costToday).toBe(25.5);

    // Quota extraction
    const quotaEntry = dataCache.sources.quota;
    expect(quotaEntry?.data?.weeklyBudgetRemaining).toBe(30);
    expect(quotaEntry?.data?.weeklyBudgetPercentUsed).toBe(58);
  });

  test('handles missing data-cache.json gracefully', () => {
    const cachePath = join(tempDir, 'nonexistent.json');
    expect(existsSync(cachePath)).toBe(false);

    // Simulate display-only logic
    let gotBilling = false;
    try {
      if (existsSync(cachePath)) {
        // Would never enter this branch
        const dataCache = JSON.parse(require('fs').readFileSync(cachePath, 'utf-8'));
        gotBilling = true;
      }
    } catch { /* ignore */ }
    expect(gotBilling).toBe(false);
  });

  test('handles corrupted data-cache.json gracefully', () => {
    const cachePath = join(tempDir, 'data-cache.json');
    writeFileSync(cachePath, 'NOT VALID JSON{{{');

    let gotBilling = false;
    try {
      if (existsSync(cachePath)) {
        const dataCache = JSON.parse(require('fs').readFileSync(cachePath, 'utf-8'));
        gotBilling = true;
      }
    } catch { /* ignore */ }
    expect(gotBilling).toBe(false);
  });

  test('handles wrong version gracefully', () => {
    const cachePath = join(tempDir, 'data-cache.json');
    writeFileSync(cachePath, JSON.stringify({ version: 1, sources: {} }));

    let gotBilling = false;
    try {
      if (existsSync(cachePath)) {
        const dataCache = JSON.parse(require('fs').readFileSync(cachePath, 'utf-8'));
        if (dataCache?.version === 2 && dataCache?.sources) {
          gotBilling = true;
        }
      }
    } catch { /* ignore */ }
    expect(gotBilling).toBe(false);
  });

  test('handles missing billing entry gracefully', () => {
    const cachePath = join(tempDir, 'data-cache.json');
    writeFileSync(cachePath, JSON.stringify({
      version: 2,
      updatedAt: Date.now(),
      sources: {
        git_status: { data: { branch: 'main' }, fetchedAt: Date.now(), fetchedBy: 1 },
      },
    }));

    const dataCache = JSON.parse(require('fs').readFileSync(cachePath, 'utf-8'));
    const billingEntry = dataCache.sources.billing;
    expect(billingEntry).toBeUndefined();
    // Should not crash
    expect(billingEntry?.data?.billing?.costToday > 0).toBeFalsy();
  });
});
