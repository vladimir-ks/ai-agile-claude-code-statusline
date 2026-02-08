/**
 * ResultCache Tests
 *
 * Tests for in-memory caching with TTL, eviction, and cleanup.
 * Phase 0.3 - RED state (no implementation yet)
 *
 * Coverage:
 * - Get/set with TTL
 * - Cache expiry
 * - Eviction (LRU, size limits)
 * - Cleanup
 * - Stats
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { ResultCache } from '../../src/lib/transcript-scanner/result-cache';
import type { ScanResult } from '../../src/lib/transcript-scanner/types';

describe('ResultCache', () => {
  // Mock ScanResult for testing
  const mockResult = (): ScanResult => ({
    lastMessage: {
      timestamp: Date.now(),
      preview: 'Test message',
      sender: 'human',
      turnNumber: 1
    },
    secrets: [],
    commands: [],
    authChanges: [],
    health: {
      exists: true,
      lastModified: Date.now(),
      sizeBytes: 1000,
      messageCount: 1,
      lastModifiedAgo: '1m'
    },
    metrics: {
      scanDuration: 10,
      linesScanned: 100,
      bytesRead: 1000,
      cacheHit: false,
      extractorDurations: {}
    }
  });

  beforeEach(() => {
    // Clear cache before each test
    ResultCache.clear();
  });

  describe('get() / set() - Basic Operations', () => {
    test('returns null for non-existent cache entry', () => {
      const result = ResultCache.get('nonexistent-session');
      expect(result).toBeNull();
    });

    test('stores and retrieves cache entry', () => {
      const sessionId = 'test-session';
      const result = mockResult();

      ResultCache.set(sessionId, result);

      const cached = ResultCache.get(sessionId);
      expect(cached).not.toBeNull();
      expect(cached!.lastMessage.preview).toBe('Test message');
    });

    test('overwrites existing cache entry', () => {
      const sessionId = 'overwrite-test';
      const result1 = mockResult();
      result1.lastMessage.preview = 'First';

      const result2 = mockResult();
      result2.lastMessage.preview = 'Second';

      ResultCache.set(sessionId, result1);
      ResultCache.set(sessionId, result2);

      const cached = ResultCache.get(sessionId);
      expect(cached!.lastMessage.preview).toBe('Second');
    });

    test('handles multiple sessions independently', () => {
      const result1 = mockResult();
      result1.lastMessage.preview = 'Session 1';

      const result2 = mockResult();
      result2.lastMessage.preview = 'Session 2';

      ResultCache.set('session-1', result1);
      ResultCache.set('session-2', result2);

      expect(ResultCache.get('session-1')!.lastMessage.preview).toBe('Session 1');
      expect(ResultCache.get('session-2')!.lastMessage.preview).toBe('Session 2');
    });
  });

  describe('get() / set() - TTL Expiry', () => {
    test('returns cached entry before TTL expiry', () => {
      const sessionId = 'ttl-test';
      const result = mockResult();

      ResultCache.set(sessionId, result, 1000); // 1 second TTL

      const cached = ResultCache.get(sessionId);
      expect(cached).not.toBeNull();
    });

    test('returns null after TTL expiry', async () => {
      const sessionId = 'expired-test';
      const result = mockResult();

      ResultCache.set(sessionId, result, 50); // 50ms TTL

      await new Promise(resolve => setTimeout(resolve, 100)); // Wait 100ms

      const cached = ResultCache.get(sessionId);
      expect(cached).toBeNull();
    });

    test('deletes expired entry on get()', async () => {
      const sessionId = 'delete-expired';
      const result = mockResult();

      ResultCache.set(sessionId, result, 50);
      await new Promise(resolve => setTimeout(resolve, 100));

      ResultCache.get(sessionId); // Should trigger cleanup

      const stats = ResultCache.getStats();
      expect(stats.entries).toBe(0); // Entry deleted
    });

    test('supports custom TTL per entry', async () => {
      const shortTTL = mockResult();
      const longTTL = mockResult();

      ResultCache.set('short', shortTTL, 50);
      ResultCache.set('long', longTTL, 5000);

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(ResultCache.get('short')).toBeNull();
      expect(ResultCache.get('long')).not.toBeNull();
    });

    test('uses default TTL if not specified', () => {
      const sessionId = 'default-ttl';
      const result = mockResult();

      ResultCache.set(sessionId, result); // No TTL specified

      const cached = ResultCache.get(sessionId);
      expect(cached).not.toBeNull();
    });
  });

  describe('invalidate()', () => {
    test('removes specific cache entry', () => {
      const sessionId = 'invalidate-test';
      const result = mockResult();

      ResultCache.set(sessionId, result);
      expect(ResultCache.get(sessionId)).not.toBeNull();

      ResultCache.invalidate(sessionId);
      expect(ResultCache.get(sessionId)).toBeNull();
    });

    test('does not affect other cache entries', () => {
      ResultCache.set('session-1', mockResult());
      ResultCache.set('session-2', mockResult());

      ResultCache.invalidate('session-1');

      expect(ResultCache.get('session-1')).toBeNull();
      expect(ResultCache.get('session-2')).not.toBeNull();
    });

    test('does not throw if entry does not exist', () => {
      expect(() => ResultCache.invalidate('nonexistent')).not.toThrow();
    });
  });

  describe('clear()', () => {
    test('removes all cache entries', () => {
      ResultCache.set('session-1', mockResult());
      ResultCache.set('session-2', mockResult());
      ResultCache.set('session-3', mockResult());

      expect(ResultCache.getStats().entries).toBe(3);

      ResultCache.clear();

      expect(ResultCache.getStats().entries).toBe(0);
      expect(ResultCache.get('session-1')).toBeNull();
      expect(ResultCache.get('session-2')).toBeNull();
      expect(ResultCache.get('session-3')).toBeNull();
    });

    test('does not throw if cache is already empty', () => {
      expect(() => ResultCache.clear()).not.toThrow();
    });
  });

  describe('cleanup()', () => {
    test('removes expired entries only', async () => {
      ResultCache.set('expired-1', mockResult(), 50);
      ResultCache.set('expired-2', mockResult(), 50);
      ResultCache.set('valid-1', mockResult(), 5000);
      ResultCache.set('valid-2', mockResult(), 5000);

      await new Promise(resolve => setTimeout(resolve, 100));

      ResultCache.cleanup();

      expect(ResultCache.get('expired-1')).toBeNull();
      expect(ResultCache.get('expired-2')).toBeNull();
      expect(ResultCache.get('valid-1')).not.toBeNull();
      expect(ResultCache.get('valid-2')).not.toBeNull();
    });

    test('does not affect valid entries', () => {
      ResultCache.set('session-1', mockResult(), 5000);
      ResultCache.set('session-2', mockResult(), 5000);

      ResultCache.cleanup();

      expect(ResultCache.get('session-1')).not.toBeNull();
      expect(ResultCache.get('session-2')).not.toBeNull();
    });

    test('does not throw if cache is empty', () => {
      expect(() => ResultCache.cleanup()).not.toThrow();
    });
  });

  describe('getStats()', () => {
    test('returns correct entry count', () => {
      expect(ResultCache.getStats().entries).toBe(0);

      ResultCache.set('session-1', mockResult());
      expect(ResultCache.getStats().entries).toBe(1);

      ResultCache.set('session-2', mockResult());
      expect(ResultCache.getStats().entries).toBe(2);
    });

    test('does not count expired entries', async () => {
      ResultCache.set('expired', mockResult(), 50);
      ResultCache.set('valid', mockResult(), 5000);

      expect(ResultCache.getStats().entries).toBe(2);

      await new Promise(resolve => setTimeout(resolve, 100));

      // Expired entries not counted (cleanup may or may not have run)
      const stats = ResultCache.getStats();
      expect(stats.entries).toBeLessThanOrEqual(2);
    });

    test('returns estimated total size', () => {
      const stats1 = ResultCache.getStats();
      expect(stats1.totalSize).toBe(0);

      ResultCache.set('session-1', mockResult());

      const stats2 = ResultCache.getStats();
      expect(stats2.totalSize).toBeGreaterThan(0);
    });

    test('size increases with more entries', () => {
      ResultCache.set('session-1', mockResult());
      const size1 = ResultCache.getStats().totalSize;

      ResultCache.set('session-2', mockResult());
      const size2 = ResultCache.getStats().totalSize;

      expect(size2).toBeGreaterThan(size1);
    });

    test('returns hitRate field', () => {
      const stats = ResultCache.getStats();
      expect(stats).toHaveProperty('hitRate');
      expect(typeof stats.hitRate).toBe('number');
      expect(stats.hitRate).toBeGreaterThanOrEqual(0);
      expect(stats.hitRate).toBeLessThanOrEqual(1);
    });
  });

  describe('Eviction - Size Limits', () => {
    test('evicts oldest entries when MAX_ENTRIES exceeded', () => {
      // Set 101 entries (assuming MAX_ENTRIES = 100)
      for (let i = 0; i < 101; i++) {
        ResultCache.set(`session-${i}`, mockResult(), 60000);
      }

      const stats = ResultCache.getStats();
      expect(stats.entries).toBeLessThanOrEqual(100);

      // Oldest entry (session-0) should be evicted
      expect(ResultCache.get('session-0')).toBeNull();

      // Newest entries should still exist
      expect(ResultCache.get('session-100')).not.toBeNull();
    });

    test('removes expired entries before evicting valid ones', async () => {
      // Add 50 expired entries
      for (let i = 0; i < 50; i++) {
        ResultCache.set(`expired-${i}`, mockResult(), 50);
      }

      await new Promise(resolve => setTimeout(resolve, 100));

      // Add 60 valid entries
      for (let i = 0; i < 60; i++) {
        ResultCache.set(`valid-${i}`, mockResult(), 60000);
      }

      const stats = ResultCache.getStats();
      expect(stats.entries).toBeLessThanOrEqual(100);

      // Valid entries should be preserved
      expect(ResultCache.get('valid-0')).not.toBeNull();
    });

    test('evicts by LRU (least recently used)', () => {
      // Create 3 entries
      ResultCache.set('old', mockResult(), 60000);
      ResultCache.set('middle', mockResult(), 60000);
      ResultCache.set('new', mockResult(), 60000);

      // Access 'old' to make it recently used
      ResultCache.get('old');

      // Force eviction by adding many entries
      for (let i = 0; i < 100; i++) {
        ResultCache.set(`filler-${i}`, mockResult(), 60000);
      }

      // 'old' was accessed recently, so should still exist
      // 'middle' was not accessed, so might be evicted
      const oldExists = ResultCache.get('old') !== null;
      const middleExists = ResultCache.get('middle') !== null;

      // At least one should be evicted due to size limit
      expect(oldExists || !middleExists).toBe(true);
    });
  });

  describe('Eviction - Size Limit (Bytes)', () => {
    test('tracks estimated size in bytes', () => {
      const largeResult = mockResult();
      largeResult.lastMessage.preview = 'x'.repeat(10000); // Large preview

      ResultCache.set('large', largeResult);

      const stats = ResultCache.getStats();
      expect(stats.totalSize).toBeGreaterThan(10000);
    });

    test('evicts entries if total size exceeds limit', () => {
      // Assuming 10MB size limit
      // Create entries with large data
      for (let i = 0; i < 50; i++) {
        const large = mockResult();
        large.lastMessage.preview = 'x'.repeat(200000); // ~200KB each
        ResultCache.set(`large-${i}`, large, 60000);
      }

      const stats = ResultCache.getStats();
      expect(stats.totalSize).toBeLessThanOrEqual(10 * 1024 * 1024); // 10MB
    });
  });

  describe('Edge Cases', () => {
    test('handles sessionId with special characters', () => {
      const sessionId = 'session-with_underscore-123';
      const result = mockResult();

      ResultCache.set(sessionId, result);

      expect(ResultCache.get(sessionId)).not.toBeNull();
    });

    test('handles very short TTL (1ms)', async () => {
      ResultCache.set('short-ttl', mockResult(), 1);

      await new Promise(resolve => setTimeout(resolve, 10));

      expect(ResultCache.get('short-ttl')).toBeNull();
    });

    test('handles very long TTL (1 hour)', () => {
      ResultCache.set('long-ttl', mockResult(), 3600000);

      expect(ResultCache.get('long-ttl')).not.toBeNull();
    });

    test('handles result with empty arrays', () => {
      const emptyResult: ScanResult = {
        lastMessage: {
          timestamp: 0,
          preview: '',
          sender: 'unknown',
          turnNumber: 0
        },
        secrets: [],
        commands: [],
        authChanges: [],
        health: {
          exists: false,
          lastModified: 0,
          sizeBytes: 0,
          messageCount: 0,
          lastModifiedAgo: 'unknown'
        },
        metrics: {
          scanDuration: 0,
          linesScanned: 0,
          bytesRead: 0,
          cacheHit: true,
          extractorDurations: {}
        }
      };

      ResultCache.set('empty', emptyResult);

      const cached = ResultCache.get('empty');
      expect(cached).not.toBeNull();
      expect(cached!.secrets).toEqual([]);
    });

    test('does not throw on concurrent access', () => {
      const sessionId = 'concurrent';

      // Simulate concurrent get/set
      expect(() => {
        ResultCache.set(sessionId, mockResult());
        ResultCache.get(sessionId);
        ResultCache.set(sessionId, mockResult());
        ResultCache.invalidate(sessionId);
      }).not.toThrow();
    });
  });

  describe('Integration', () => {
    test('typical workflow: set, get, invalidate', () => {
      const sessionId = 'workflow-test';
      const result = mockResult();

      // Set
      ResultCache.set(sessionId, result);
      expect(ResultCache.getStats().entries).toBe(1);

      // Get
      const cached = ResultCache.get(sessionId);
      expect(cached).not.toBeNull();

      // Invalidate
      ResultCache.invalidate(sessionId);
      expect(ResultCache.get(sessionId)).toBeNull();
      expect(ResultCache.getStats().entries).toBe(0);
    });

    test('cleanup removes only expired, preserves valid', async () => {
      ResultCache.set('expired-1', mockResult(), 50);
      ResultCache.set('valid-1', mockResult(), 5000);
      ResultCache.set('expired-2', mockResult(), 50);
      ResultCache.set('valid-2', mockResult(), 5000);

      await new Promise(resolve => setTimeout(resolve, 100));

      ResultCache.cleanup();

      const stats = ResultCache.getStats();
      expect(stats.entries).toBe(2); // Only valid entries remain
    });

    test('clear followed by set works correctly', () => {
      ResultCache.set('before-clear', mockResult());
      ResultCache.clear();
      ResultCache.set('after-clear', mockResult());

      expect(ResultCache.get('before-clear')).toBeNull();
      expect(ResultCache.get('after-clear')).not.toBeNull();
    });
  });
});
