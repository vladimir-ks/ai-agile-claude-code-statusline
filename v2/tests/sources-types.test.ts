/**
 * Tests for v2/src/lib/sources/types.ts
 *
 * Validates: DataSourceDescriptor interface, GatherContext shape,
 * GlobalDataCache schema, createEmptyGlobalCache() factory.
 */

import { describe, test, expect } from 'bun:test';
import type {
  DataSourceDescriptor,
  DataSourceTier,
  GatherContext,
  GlobalDataCache,
  GlobalDataCacheEntry,
} from '../src/lib/sources/types';
import { createEmptyGlobalCache } from '../src/lib/sources/types';

describe('sources/types', () => {

  // -------------------------------------------------------------------------
  // createEmptyGlobalCache
  // -------------------------------------------------------------------------

  describe('createEmptyGlobalCache', () => {
    test('returns version 2', () => {
      const cache = createEmptyGlobalCache();
      expect(cache.version).toBe(2);
    });

    test('returns empty sources', () => {
      const cache = createEmptyGlobalCache();
      expect(cache.sources).toEqual({});
    });

    test('returns current timestamp for updatedAt', () => {
      const before = Date.now();
      const cache = createEmptyGlobalCache();
      const after = Date.now();
      expect(cache.updatedAt).toBeGreaterThanOrEqual(before);
      expect(cache.updatedAt).toBeLessThanOrEqual(after);
    });

    test('returns a new object each call (no shared reference)', () => {
      const a = createEmptyGlobalCache();
      const b = createEmptyGlobalCache();
      expect(a).not.toBe(b);
      expect(a.sources).not.toBe(b.sources);
    });

    test('returned object conforms to GlobalDataCache interface', () => {
      const cache: GlobalDataCache = createEmptyGlobalCache();
      expect(cache).toHaveProperty('version');
      expect(cache).toHaveProperty('updatedAt');
      expect(cache).toHaveProperty('sources');
      expect(typeof cache.version).toBe('number');
      expect(typeof cache.updatedAt).toBe('number');
      expect(typeof cache.sources).toBe('object');
    });
  });

  // -------------------------------------------------------------------------
  // DataSourceTier
  // -------------------------------------------------------------------------

  describe('DataSourceTier', () => {
    test('accepts tier 1, 2, 3', () => {
      const tiers: DataSourceTier[] = [1, 2, 3];
      expect(tiers).toHaveLength(3);
      expect(tiers).toContain(1);
      expect(tiers).toContain(2);
      expect(tiers).toContain(3);
    });
  });

  // -------------------------------------------------------------------------
  // DataSourceDescriptor conformance
  // -------------------------------------------------------------------------

  describe('DataSourceDescriptor', () => {
    test('can create a minimal descriptor', () => {
      const desc: DataSourceDescriptor<string> = {
        id: 'test_source',
        tier: 1,
        freshnessCategory: 'context',
        timeoutMs: 1000,
        fetch: async () => 'hello',
        merge: () => {},
      };
      expect(desc.id).toBe('test_source');
      expect(desc.tier).toBe(1);
    });

    test('can create a descriptor with dependencies', () => {
      const desc: DataSourceDescriptor<number> = {
        id: 'dependent_source',
        tier: 3,
        freshnessCategory: 'billing_oauth',
        timeoutMs: 5000,
        dependencies: ['auth_profile', 'context'],
        fetch: async () => 42,
        merge: () => {},
      };
      expect(desc.dependencies).toEqual(['auth_profile', 'context']);
    });

    test('fetch returns a promise', async () => {
      const desc: DataSourceDescriptor<{ count: number }> = {
        id: 'async_source',
        tier: 2,
        freshnessCategory: 'transcript',
        timeoutMs: 3000,
        fetch: async (ctx) => ({ count: 10 }),
        merge: (target, data) => {},
      };
      const result = await desc.fetch({} as GatherContext);
      expect(result).toEqual({ count: 10 });
    });

    test('merge mutates target in place', () => {
      const desc: DataSourceDescriptor<string> = {
        id: 'merge_test',
        tier: 1,
        freshnessCategory: 'context',
        timeoutMs: 100,
        fetch: async () => 'data',
        merge: (target, data) => {
          (target as any).custom = data;
        },
      };
      const target: any = {};
      desc.merge(target, 'injected');
      expect(target.custom).toBe('injected');
    });
  });

  // -------------------------------------------------------------------------
  // GatherContext conformance
  // -------------------------------------------------------------------------

  describe('GatherContext', () => {
    test('can create a full context', () => {
      const ctx: GatherContext = {
        sessionId: 'abc-123',
        transcriptPath: '/tmp/transcript.jsonl',
        jsonInput: null,
        configDir: '/home/user/.claude',
        keychainService: 'Claude Code-credentials',
        deadline: Date.now() + 5000,
        existingHealth: null,
        projectPath: '/home/user/project',
      };
      expect(ctx.sessionId).toBe('abc-123');
      expect(ctx.deadline).toBeGreaterThan(Date.now());
    });

    test('allows null for optional fields', () => {
      const ctx: GatherContext = {
        sessionId: 'test',
        transcriptPath: null,
        jsonInput: null,
        configDir: null,
        keychainService: null,
        deadline: Date.now() + 1000,
        existingHealth: null,
        projectPath: '.',
      };
      expect(ctx.transcriptPath).toBeNull();
      expect(ctx.configDir).toBeNull();
      expect(ctx.keychainService).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // GlobalDataCacheEntry conformance
  // -------------------------------------------------------------------------

  describe('GlobalDataCacheEntry', () => {
    test('can create a basic entry', () => {
      const entry: GlobalDataCacheEntry = {
        data: { usage: 75 },
        fetchedAt: Date.now(),
        fetchedBy: process.pid,
      };
      expect(entry.data.usage).toBe(75);
      expect(entry.fetchedBy).toBe(process.pid);
    });

    test('can include optional contextKey', () => {
      const entry: GlobalDataCacheEntry = {
        data: { branch: 'main' },
        fetchedAt: Date.now(),
        fetchedBy: 1234,
        contextKey: '/home/user/project',
      };
      expect(entry.contextKey).toBe('/home/user/project');
    });
  });

  // -------------------------------------------------------------------------
  // GlobalDataCache conformance
  // -------------------------------------------------------------------------

  describe('GlobalDataCache', () => {
    test('can create a populated cache', () => {
      const cache: GlobalDataCache = {
        version: 2,
        updatedAt: Date.now(),
        sources: {
          billing_oauth: {
            data: { daily_cost: 40.3 },
            fetchedAt: Date.now() - 60_000,
            fetchedBy: 1234,
          },
          git_status: {
            data: { branch: 'main', dirty: 3 },
            fetchedAt: Date.now() - 5_000,
            fetchedBy: 5678,
            contextKey: '/home/user/project',
          },
        },
      };
      expect(Object.keys(cache.sources)).toHaveLength(2);
      expect(cache.sources.billing_oauth.data.daily_cost).toBe(40.3);
      expect(cache.sources.git_status.contextKey).toBe('/home/user/project');
    });
  });
});
