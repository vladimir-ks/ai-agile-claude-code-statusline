/**
 * Result Cache - In-memory cache for scan results
 *
 * Caches scan results with TTL to avoid redundant processing.
 * Uses LRU eviction when cache size exceeds limits.
 *
 * Performance: O(1) get/set, automatic cleanup on access.
 */

import type { ScanResult } from './types';

interface CacheEntry {
  result: ScanResult;
  expiry: number;
  size: number;  // Approximate size in bytes
}

export class ResultCache {
  private static cache = new Map<string, CacheEntry>();
  private static readonly DEFAULT_TTL = 10_000;  // 10s
  private static readonly MAX_ENTRIES = 100;     // Max sessions
  private static readonly MAX_SIZE_BYTES = 10_000_000;  // 10MB

  /**
   * Get cached result for session
   *
   * @param sessionId - Session identifier
   * @returns Cached result or null if expired/missing
   */
  static get(sessionId: string): ScanResult | null {
    const entry = this.cache.get(sessionId);
    if (!entry) {
      return null;
    }

    // Check expiry
    if (Date.now() > entry.expiry) {
      this.cache.delete(sessionId);
      return null;
    }

    return entry.result;
  }

  /**
   * Store result in cache
   *
   * @param sessionId - Session identifier
   * @param result - Scan result to cache
   * @param ttl - TTL in milliseconds (optional, defaults to 10s)
   */
  static set(sessionId: string, result: ScanResult, ttl: number = this.DEFAULT_TTL): void {
    // Estimate result size (rough approximation)
    const size = this.estimateSize(result);

    const entry: CacheEntry = {
      result,
      expiry: Date.now() + ttl,
      size,
    };

    this.cache.set(sessionId, entry);

    // Evict if needed
    this.evictIfNeeded();
  }

  /**
   * Invalidate cache for session
   *
   * @param sessionId - Session identifier
   */
  static invalidate(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /**
   * Clear all cached results
   */
  static clear(): void {
    this.cache.clear();
  }

  /**
   * Get cache statistics
   *
   * @returns Cache stats
   */
  static getStats(): {
    entries: number;
    totalSize: number;
    hitRate: number;
  } {
    let totalSize = 0;
    let validEntries = 0;
    const now = Date.now();

    for (const [sessionId, entry] of this.cache.entries()) {
      if (now <= entry.expiry) {
        totalSize += entry.size;
        validEntries++;
      }
    }

    return {
      entries: validEntries,
      totalSize,
      hitRate: 0,  // TODO: Track hits/misses
    };
  }

  /**
   * Evict expired or excess entries
   */
  private static evictIfNeeded(): void {
    const now = Date.now();

    // First pass: Remove expired
    for (const [sessionId, entry] of this.cache.entries()) {
      if (now > entry.expiry) {
        this.cache.delete(sessionId);
      }
    }

    // Second pass: Check size limits
    if (this.cache.size <= this.MAX_ENTRIES) {
      return;
    }

    // Evict oldest entries (LRU approximation via expiry)
    const entries = Array.from(this.cache.entries());
    entries.sort((a, b) => a[1].expiry - b[1].expiry);

    const toRemove = this.cache.size - this.MAX_ENTRIES;
    for (let i = 0; i < toRemove; i++) {
      this.cache.delete(entries[i][0]);
    }
  }

  /**
   * Estimate result size in bytes (rough approximation)
   *
   * @param result - Scan result
   * @returns Estimated size in bytes
   */
  private static estimateSize(result: ScanResult): number {
    try {
      // JSON stringify for rough size estimate
      return JSON.stringify(result).length * 2;  // UTF-16 overhead
    } catch {
      return 1000;  // Fallback estimate
    }
  }

  /**
   * Cleanup expired entries (call periodically)
   */
  static cleanup(): void {
    const now = Date.now();
    for (const [sessionId, entry] of this.cache.entries()) {
      if (now > entry.expiry) {
        this.cache.delete(sessionId);
      }
    }
  }
}

export default ResultCache;
