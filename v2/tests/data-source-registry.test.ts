/**
 * Tests for v2/src/lib/sources/registry.ts — DataSourceRegistry
 *
 * Static class with register, get, getAll, getByTier, getDependents,
 * size, has, remove, clear.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { DataSourceRegistry } from '../src/lib/sources/registry';
import type { DataSourceDescriptor, GatherContext } from '../src/lib/sources/types';

// Helper: create a descriptor stub
function makeSource(overrides: Partial<DataSourceDescriptor> = {}): DataSourceDescriptor {
  return {
    id: overrides.id ?? 'test_source',
    tier: overrides.tier ?? 1,
    freshnessCategory: overrides.freshnessCategory ?? 'context',
    timeoutMs: overrides.timeoutMs ?? 1000,
    dependencies: overrides.dependencies,
    fetch: overrides.fetch ?? (async () => null),
    merge: overrides.merge ?? (() => {}),
  };
}

describe('DataSourceRegistry', () => {
  beforeEach(() => {
    DataSourceRegistry.clear();
  });

  // -------------------------------------------------------------------------
  // register + get
  // -------------------------------------------------------------------------

  describe('register / get', () => {
    test('registers and retrieves a source by ID', () => {
      const src = makeSource({ id: 'billing_oauth' });
      DataSourceRegistry.register(src);
      expect(DataSourceRegistry.get('billing_oauth')).toBe(src);
    });

    test('returns undefined for unregistered ID', () => {
      expect(DataSourceRegistry.get('nonexistent')).toBeUndefined();
    });

    test('overwrites existing source with same ID', () => {
      const v1 = makeSource({ id: 'billing_oauth', timeoutMs: 1000 });
      const v2 = makeSource({ id: 'billing_oauth', timeoutMs: 5000 });
      DataSourceRegistry.register(v1);
      DataSourceRegistry.register(v2);
      expect(DataSourceRegistry.get('billing_oauth')?.timeoutMs).toBe(5000);
      expect(DataSourceRegistry.size()).toBe(1);
    });

    test('registers multiple sources', () => {
      DataSourceRegistry.register(makeSource({ id: 'a' }));
      DataSourceRegistry.register(makeSource({ id: 'b' }));
      DataSourceRegistry.register(makeSource({ id: 'c' }));
      expect(DataSourceRegistry.size()).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // getAll
  // -------------------------------------------------------------------------

  describe('getAll', () => {
    test('returns empty array when no sources registered', () => {
      expect(DataSourceRegistry.getAll()).toEqual([]);
    });

    test('returns all registered sources', () => {
      DataSourceRegistry.register(makeSource({ id: 'a' }));
      DataSourceRegistry.register(makeSource({ id: 'b' }));
      const all = DataSourceRegistry.getAll();
      expect(all).toHaveLength(2);
      expect(all.map(s => s.id).sort()).toEqual(['a', 'b']);
    });
  });

  // -------------------------------------------------------------------------
  // getByTier
  // -------------------------------------------------------------------------

  describe('getByTier', () => {
    test('returns only sources matching the tier', () => {
      DataSourceRegistry.register(makeSource({ id: 'context', tier: 1 }));
      DataSourceRegistry.register(makeSource({ id: 'model', tier: 1 }));
      DataSourceRegistry.register(makeSource({ id: 'transcript', tier: 2 }));
      DataSourceRegistry.register(makeSource({ id: 'billing', tier: 3 }));

      const tier1 = DataSourceRegistry.getByTier(1);
      expect(tier1).toHaveLength(2);
      expect(tier1.map(s => s.id).sort()).toEqual(['context', 'model']);

      const tier2 = DataSourceRegistry.getByTier(2);
      expect(tier2).toHaveLength(1);
      expect(tier2[0].id).toBe('transcript');

      const tier3 = DataSourceRegistry.getByTier(3);
      expect(tier3).toHaveLength(1);
      expect(tier3[0].id).toBe('billing');
    });

    test('returns empty array for tier with no sources', () => {
      DataSourceRegistry.register(makeSource({ id: 'a', tier: 1 }));
      expect(DataSourceRegistry.getByTier(3)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // getDependents
  // -------------------------------------------------------------------------

  describe('getDependents', () => {
    test('returns sources that depend on given ID', () => {
      DataSourceRegistry.register(makeSource({ id: 'auth_profile', tier: 2 }));
      DataSourceRegistry.register(makeSource({
        id: 'billing_oauth',
        tier: 3,
        dependencies: ['auth_profile'],
      }));
      DataSourceRegistry.register(makeSource({
        id: 'quota_broker',
        tier: 3,
        dependencies: ['auth_profile', 'billing_oauth'],
      }));
      DataSourceRegistry.register(makeSource({ id: 'git_status', tier: 3 }));

      const authDeps = DataSourceRegistry.getDependents('auth_profile');
      expect(authDeps).toHaveLength(2);
      expect(authDeps.map(s => s.id).sort()).toEqual(['billing_oauth', 'quota_broker']);
    });

    test('returns empty array when no dependents', () => {
      DataSourceRegistry.register(makeSource({ id: 'standalone' }));
      expect(DataSourceRegistry.getDependents('standalone')).toEqual([]);
    });

    test('returns empty for unregistered source ID', () => {
      expect(DataSourceRegistry.getDependents('ghost')).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // size / has
  // -------------------------------------------------------------------------

  describe('size / has', () => {
    test('size returns 0 initially', () => {
      expect(DataSourceRegistry.size()).toBe(0);
    });

    test('has returns false for missing source', () => {
      expect(DataSourceRegistry.has('billing')).toBe(false);
    });

    test('has returns true after registration', () => {
      DataSourceRegistry.register(makeSource({ id: 'billing' }));
      expect(DataSourceRegistry.has('billing')).toBe(true);
    });

    test('size increments on registration', () => {
      DataSourceRegistry.register(makeSource({ id: 'a' }));
      expect(DataSourceRegistry.size()).toBe(1);
      DataSourceRegistry.register(makeSource({ id: 'b' }));
      expect(DataSourceRegistry.size()).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // remove
  // -------------------------------------------------------------------------

  describe('remove', () => {
    test('removes a registered source', () => {
      DataSourceRegistry.register(makeSource({ id: 'billing' }));
      expect(DataSourceRegistry.remove('billing')).toBe(true);
      expect(DataSourceRegistry.has('billing')).toBe(false);
      expect(DataSourceRegistry.size()).toBe(0);
    });

    test('returns false when removing non-existent source', () => {
      expect(DataSourceRegistry.remove('nonexistent')).toBe(false);
    });

    test('does not affect other sources', () => {
      DataSourceRegistry.register(makeSource({ id: 'a' }));
      DataSourceRegistry.register(makeSource({ id: 'b' }));
      DataSourceRegistry.remove('a');
      expect(DataSourceRegistry.has('a')).toBe(false);
      expect(DataSourceRegistry.has('b')).toBe(true);
      expect(DataSourceRegistry.size()).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // clear
  // -------------------------------------------------------------------------

  describe('clear', () => {
    test('removes all sources', () => {
      DataSourceRegistry.register(makeSource({ id: 'a' }));
      DataSourceRegistry.register(makeSource({ id: 'b' }));
      DataSourceRegistry.register(makeSource({ id: 'c' }));
      DataSourceRegistry.clear();
      expect(DataSourceRegistry.size()).toBe(0);
      expect(DataSourceRegistry.getAll()).toEqual([]);
    });

    test('is safe to call on empty registry', () => {
      DataSourceRegistry.clear();
      expect(DataSourceRegistry.size()).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Integration: typed fetch + merge
  // -------------------------------------------------------------------------

  describe('typed descriptor integration', () => {
    test('typed descriptor preserves fetch/merge types', async () => {
      interface BillingData { dailyCost: number; hourlyRate: number }

      const billingSource: DataSourceDescriptor<BillingData> = {
        id: 'billing_test',
        tier: 3,
        freshnessCategory: 'billing_oauth',
        timeoutMs: 5000,
        fetch: async (ctx: GatherContext) => ({
          dailyCost: 40.3,
          hourlyRate: 15.1,
        }),
        merge: (target, data) => {
          // Type-safe: data.dailyCost is known to be number
          (target as any).billing = data;
        },
      };

      DataSourceRegistry.register(billingSource);
      const retrieved = DataSourceRegistry.get('billing_test');
      expect(retrieved).toBeDefined();

      // Fetch produces typed data
      const data = await retrieved!.fetch({} as GatherContext);
      expect(data.dailyCost).toBe(40.3);
    });
  });
});
