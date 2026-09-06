/**
 * Tests for v2/src/lib/unified-data-broker.ts
 *
 * Tests the orchestrator: source registration, tier pipeline,
 * gatherAll context building, and post-processing.
 *
 * NOTE: Most tests here verify the orchestration logic,
 * not individual source behavior (those have dedicated test files).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { UnifiedDataBroker } from '../src/lib/unified-data-broker';
import { DataSourceRegistry } from '../src/lib/sources/registry';
import { DataCacheManager } from '../src/lib/data-cache-manager';
import { cacheKeyFor, GLOBAL_CACHE_VERSION } from '../src/lib/sources/types';

describe('UnifiedDataBroker', () => {

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe('source registration', () => {
    test('registers all 12 sources', () => {
      const count = UnifiedDataBroker.getRegisteredSourceCount();
      expect(count).toBeGreaterThanOrEqual(12);
    });

    test('has Tier 1 sources (context, model)', () => {
      const tiers = UnifiedDataBroker.getSourcesByTier();
      expect(tiers[1]).toContain('context');
      expect(tiers[1]).toContain('model');
    });

    test('has Tier 2 sources (transcript, secrets, auth, session_cost)', () => {
      const tiers = UnifiedDataBroker.getSourcesByTier();
      expect(tiers[2]).toContain('transcript');
      expect(tiers[2]).toContain('secrets_scan');
      expect(tiers[2]).toContain('auth_profile');
      expect(tiers[2]).toContain('session_cost');
    });

    test('has Tier 3 sources (billing, quota, git, version, notifications, slot_recommendation)', () => {
      const tiers = UnifiedDataBroker.getSourcesByTier();
      expect(tiers[3]).toContain('billing');
      expect(tiers[3]).toContain('quota');
      expect(tiers[3]).toContain('git_status');
      expect(tiers[3]).toContain('version_check');
      expect(tiers[3]).toContain('notifications');
      expect(tiers[3]).toContain('slot_recommendation');
    });

    test('all source IDs are unique', () => {
      const tiers = UnifiedDataBroker.getSourcesByTier();
      const allIds = [...tiers[1], ...tiers[2], ...tiers[3]];
      expect(new Set(allIds).size).toBe(allIds.length);
    });
  });

  // -------------------------------------------------------------------------
  // getSourcesByTier
  // -------------------------------------------------------------------------

  describe('getSourcesByTier', () => {
    test('returns 3 tiers', () => {
      const tiers = UnifiedDataBroker.getSourcesByTier();
      expect(Object.keys(tiers)).toHaveLength(3);
    });

    test('tier 1 has fewest sources (instant)', () => {
      const tiers = UnifiedDataBroker.getSourcesByTier();
      expect(tiers[1].length).toBeLessThanOrEqual(tiers[2].length);
      expect(tiers[1].length).toBeLessThanOrEqual(tiers[3].length);
    });
  });

  // -------------------------------------------------------------------------
  // gatherAll — basic context
  // -------------------------------------------------------------------------

  describe('gatherAll — basic', () => {
    test('returns SessionHealth with sessionId', async () => {
      const health = await UnifiedDataBroker.gatherAll(
        'test-session',
        null,
        null,
      );
      expect(health.sessionId).toBe('test-session');
    }, 30_000); // full source pipeline (git/billing tiers) — 5s default too tight under suite load

    test('returns health with gatheredAt timestamp', async () => {
      const before = Date.now();
      const health = await UnifiedDataBroker.gatherAll(
        'test-session',
        null,
        null,
      );
      expect(health.gatheredAt).toBeGreaterThanOrEqual(before);
    });

    test('sets transcriptPath', async () => {
      const health = await UnifiedDataBroker.gatherAll(
        'test',
        '/tmp/transcript.jsonl',
        null,
      );
      expect(health.transcriptPath).toBe('/tmp/transcript.jsonl');
    });

    test('sets projectPath from options', async () => {
      const health = await UnifiedDataBroker.gatherAll(
        'test',
        null,
        null,
        { projectPath: '/home/user/project' }
      );
      expect(health.projectPath).toBe('/home/user/project');
    });

    test('sets projectPath from jsonInput.start_directory', async () => {
      const health = await UnifiedDataBroker.gatherAll(
        'test',
        null,
        { start_directory: '/home/user/project2', session_id: 'test' } as any,
      );
      expect(health.projectPath).toBe('/home/user/project2');
    });

    test('preserves firstSeen from existing health', async () => {
      const existingFirstSeen = Date.now() - 3600000; // 1 hour ago
      const health = await UnifiedDataBroker.gatherAll(
        'test',
        null,
        null,
        { existingHealth: { firstSeen: existingFirstSeen } as any }
      );
      expect(health.firstSeen).toBe(existingFirstSeen);
      expect(health.sessionDuration).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // gatherAll — Tier 1 (context, model)
  // -------------------------------------------------------------------------

  describe('gatherAll — Tier 1', () => {
    test('resolves context from jsonInput', async () => {
      const health = await UnifiedDataBroker.gatherAll(
        'test',
        null,
        {
          session_id: 'test',
          context_window: {
            context_window_size: 200000,
            current_usage: {
              input_tokens: 80000,
              output_tokens: 20000,
            },
          },
        } as any,
      );
      expect(health.context.tokensUsed).toBe(100000);
      expect(health.context.windowSize).toBe(200000);
    });

    test('resolves model from jsonInput', async () => {
      const health = await UnifiedDataBroker.gatherAll(
        'test',
        null,
        {
          session_id: 'test',
          model: { display_name: 'claude-opus-4-5-20250929' },
        } as any,
      );
      expect(health.model.value).toBe('Opus4.5');
      expect(health.model.source).toBe('jsonInput');
    });

    test('returns default context when no jsonInput', async () => {
      const health = await UnifiedDataBroker.gatherAll('test', null, null);
      expect(health.context.tokensUsed).toBe(0);
      expect(health.context.windowSize).toBe(200000);
    });
  });

  // -------------------------------------------------------------------------
  // gatherAll — post-processing
  // -------------------------------------------------------------------------

  describe('gatherAll — post-processing', () => {
    test('sets performance.gatherDuration', async () => {
      const health = await UnifiedDataBroker.gatherAll('test', null, null);
      expect(health.performance).toBeDefined();
      expect(health.performance!.gatherDuration).toBeGreaterThanOrEqual(0);
    });

    test('recomputes billing.isFresh from timestamp', async () => {
      const health = await UnifiedDataBroker.gatherAll('test', null, null);
      // With no billing data, lastFetched = 0, so isFresh should be false
      if (health.billing.lastFetched === 0) {
        expect(health.billing.isFresh).toBe(false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // gatherAll — time budget
  // -------------------------------------------------------------------------

  describe('gatherAll — time budget', () => {
    test('completes within 25 seconds (generous)', async () => {
      const start = Date.now();
      await UnifiedDataBroker.gatherAll('test', null, null);
      const duration = Date.now() - start;
      // Should be well under 25s in test environment
      // Most sources will return immediately (no transcript, no network)
      expect(duration).toBeLessThan(25000);
    });
  });

  // -------------------------------------------------------------------------
  // DataSourceRegistry integration
  // -------------------------------------------------------------------------

  describe('registry integration', () => {
    test('can add a custom source and find it', () => {
      DataSourceRegistry.register({
        id: 'custom_test',
        tier: 3,
        freshnessCategory: 'context',
        timeoutMs: 100,
        fetch: async () => ({ custom: true }),
        merge: () => {},
      });

      expect(DataSourceRegistry.has('custom_test')).toBe(true);

      // Cleanup
      DataSourceRegistry.remove('custom_test');
    });

    test('getDependents returns sources that depend on others', () => {
      DataSourceRegistry.register({
        id: 'dependent_test',
        tier: 3,
        freshnessCategory: 'context',
        timeoutMs: 100,
        dependencies: ['billing'],
        fetch: async () => ({}),
        merge: () => {},
      });

      const deps = DataSourceRegistry.getDependents('billing');
      expect(deps.some(d => d.id === 'dependent_test')).toBe(true);

      // Cleanup
      DataSourceRegistry.remove('dependent_test');
    });
  });
  // -------------------------------------------------------------------------
  // Tier 3 cache scoping + staleness gate
  // -------------------------------------------------------------------------

  describe('stampMergedTimestamp', () => {
    const stamp = (health: any, sourceId: string, fetchedAt: number) =>
      (UnifiedDataBroker as any).stampMergedTimestamp(health, sourceId, fetchedAt);

    const fetchedAt = Date.now() - 600_000;

    test('clamps git.lastChecked to the cache entry fetch time', () => {
      const health: any = { git: { lastChecked: Date.now() } };
      stamp(health, 'git_status', fetchedAt);
      expect(health.git.lastChecked).toBe(fetchedAt);
    });

    test('clamps billing.lastFetched to the cache entry fetch time', () => {
      const health: any = { billing: { lastFetched: Date.now() } };
      stamp(health, 'billing', fetchedAt);
      expect(health.billing.lastFetched).toBe(fetchedAt);
    });

    test('clamps billing.weeklyLastModified for the quota source', () => {
      const health: any = { billing: { weeklyLastModified: Date.now() } };
      stamp(health, 'quota', fetchedAt);
      expect(health.billing.weeklyLastModified).toBe(fetchedAt);
    });

    test('an already-older timestamp is left alone (clamp never moves time forward)', () => {
      const older = fetchedAt - 60_000;
      const health: any = { billing: { lastFetched: older } };
      stamp(health, 'billing', fetchedAt);
      expect(health.billing.lastFetched).toBe(older);
    });

    test('a missing timestamp is filled with the fetch time', () => {
      const health: any = { billing: {} };
      stamp(health, 'billing', fetchedAt);
      expect(health.billing.lastFetched).toBe(fetchedAt);
    });

    test('a zero/invalid fetchedAt is a no-op', () => {
      const now = Date.now();
      const health: any = { git: { lastChecked: now } };
      stamp(health, 'git_status', 0);
      expect(health.git.lastChecked).toBe(now);
    });
  });

  describe('Tier 3 global cache', () => {
    let tempDir: string;
    let cachePath: string;
    let originalPath: string;

    // A path that is definitely not a git repo — gitSource.fetch returns null
    // there, so nothing overwrites the seeded entry during the test.
    const NON_REPO = join(tmpdir(), 'udb-not-a-repo');

    function seedGitEntry(contextKey: string, ageMs: number, branch: string): void {
      const fetchedAt = Date.now() - ageMs;
      writeFileSync(cachePath, JSON.stringify({
        version: GLOBAL_CACHE_VERSION,
        updatedAt: Date.now(),
        sources: {
          [cacheKeyFor('git_status', contextKey)]: {
            data: { branch, ahead: 0, behind: 0, dirty: 7, fetchedAt },
            fetchedAt,
            fetchedBy: 1234,
            contextKey,
          },
        },
      }));
      DataCacheManager.clearCache();
    }

    beforeEach(() => {
      tempDir = join(tmpdir(), `udb-cache-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(tempDir, { recursive: true });
      mkdirSync(NON_REPO, { recursive: true });
      cachePath = join(tempDir, 'data-cache.json');
      originalPath = (DataCacheManager as any).CACHE_PATH;
      Object.defineProperty(DataCacheManager, 'CACHE_PATH', {
        value: cachePath, writable: true, configurable: true,
      });
      DataCacheManager.clearCache();
    });

    afterEach(() => {
      Object.defineProperty(DataCacheManager, 'CACHE_PATH', {
        value: originalPath, writable: true, configurable: true,
      });
      DataCacheManager.clearCache();
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('another project\'s git entry is never merged into this session', async () => {
      seedGitEntry('/repo/alpha', 60_000, 'alpha-branch');

      const health = await UnifiedDataBroker.gatherAll('t', null, null, {
        projectPath: NON_REPO,
      });

      expect(health.git.branch).not.toBe('alpha-branch');
      expect(health.git.dirty).not.toBe(7);
    }, 30_000);

    test('this project\'s own entry IS merged, with the cache entry\'s timestamp', async () => {
      const fetchedAt = Date.now() - 60_000;
      seedGitEntry(NON_REPO, 60_000, 'own-branch');

      const health = await UnifiedDataBroker.gatherAll('t', null, null, {
        projectPath: NON_REPO,
      });

      expect(health.git.branch).toBe('own-branch');
      // lastChecked must reflect when the data was fetched, not gatheredAt.
      expect(health.git.lastChecked).toBeLessThanOrEqual(fetchedAt + 2000);
      expect(health.gatheredAt - health.git.lastChecked).toBeGreaterThan(30_000);
    }, 30_000);

    test('a critically stale entry is NOT merged (git_status staleMs = 5min)', async () => {
      seedGitEntry(NON_REPO, 10 * 60_000, 'ancient-branch');

      const health = await UnifiedDataBroker.gatherAll('t', null, null, {
        projectPath: NON_REPO,
      });

      expect(health.git.branch).not.toBe('ancient-branch');
    }, 30_000);

    test('cache entries are written under a context-scoped key carrying contextKey', async () => {
      writeFileSync(cachePath, JSON.stringify({
        version: GLOBAL_CACHE_VERSION, updatedAt: Date.now(), sources: {},
      }));
      DataCacheManager.clearCache();

      await UnifiedDataBroker.gatherAll('t', null, null, {
        projectPath: process.cwd(),
        configDir: '/tmp/slots/S9/general',
      });

      const written = JSON.parse(readFileSync(cachePath, 'utf-8'));
      expect(written.version).toBe(GLOBAL_CACHE_VERSION);

      const scoped = Object.entries(written.sources as Record<string, any>)
        .filter(([key]) => key.includes('::'));
      expect(scoped.length).toBeGreaterThan(0);
      for (const [key, entry] of scoped) {
        expect(entry.contextKey).toBeTruthy();
        expect(key).toBe(cacheKeyFor(key.split('::')[0], entry.contextKey));
      }
      // Unscoped ids must never carry a contextKey.
      for (const [key, entry] of Object.entries(written.sources as Record<string, any>)) {
        if (!key.includes('::')) expect(entry.contextKey).toBeUndefined();
      }
    }, 30_000);
  });
});
