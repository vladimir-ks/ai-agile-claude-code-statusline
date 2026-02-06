/**
 * DataCacheManager - Reader/writer for the global data cache
 *
 * Path: ~/.claude/session-health/data-cache.json
 *
 * Pattern: Memory cache (10s TTL) + file read + atomic write.
 * Same pattern as QuotaBrokerClient, FreshnessManager, etc.
 *
 * The global cache stores Tier 3 data (billing, quota, git, version)
 * that is shared across all sessions. Any daemon can write; all read.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname } from 'path';
import type { GlobalDataCache, GlobalDataCacheEntry } from './sources/types';
import { createEmptyGlobalCache } from './sources/types';
import { FreshnessManager } from './freshness-manager';

// In-memory cache
let cachedData: GlobalDataCache | null = null;
let cacheTimestamp = 0;
const MEMORY_TTL = 10_000; // 10 seconds

export class DataCacheManager {
  private static readonly CACHE_PATH = `${homedir()}/.claude/session-health/data-cache.json`;

  /**
   * Read the global data cache (with memory caching).
   *
   * Layer 1: Memory cache (10s TTL)
   * Layer 2: File read + JSON.parse
   * Returns empty cache if file missing or corrupt.
   */
  static read(): GlobalDataCache {
    const now = Date.now();

    // Layer 1: Memory cache
    if (cachedData && (now - cacheTimestamp) < MEMORY_TTL) {
      return cachedData;
    }

    // Layer 2: File read
    try {
      if (existsSync(this.CACHE_PATH)) {
        const content = readFileSync(this.CACHE_PATH, 'utf-8');
        const parsed = JSON.parse(content);

        // Validate minimal schema
        if (parsed && parsed.version === 2 && parsed.sources) {
          cachedData = parsed as GlobalDataCache;
          cacheTimestamp = now;
          return cachedData;
        }
      }
    } catch {
      // Parse error or read error — return empty
    }

    // Default: empty cache
    const empty = createEmptyGlobalCache();
    cachedData = empty;
    cacheTimestamp = now;
    return empty;
  }

  /**
   * Get cached data for a specific source.
   * Returns null if source not cached or data missing.
   */
  static getSourceData<T = any>(sourceId: string): GlobalDataCacheEntry | null {
    const cache = this.read();
    return cache.sources[sourceId] || null;
  }

  /**
   * Check if a source's cached data is fresh.
   * Uses FreshnessManager with the source's category.
   */
  static isSourceFresh(sourceId: string, freshnessCategory: string): boolean {
    const entry = this.getSourceData(sourceId);
    if (!entry) return false;
    return FreshnessManager.isFresh(entry.fetchedAt, freshnessCategory);
  }

  /**
   * Update cached data for one or more sources.
   * Reads existing cache, merges new entries, writes atomically.
   */
  static update(entries: Record<string, GlobalDataCacheEntry>): boolean {
    try {
      // Read current cache (bypasses memory cache to get latest from file)
      let cache: GlobalDataCache;
      try {
        if (existsSync(this.CACHE_PATH)) {
          const content = readFileSync(this.CACHE_PATH, 'utf-8');
          const parsed = JSON.parse(content);
          if (parsed && parsed.version === 2 && parsed.sources) {
            cache = parsed as GlobalDataCache;
          } else {
            cache = createEmptyGlobalCache();
          }
        } else {
          cache = createEmptyGlobalCache();
        }
      } catch {
        cache = createEmptyGlobalCache();
      }

      // Merge new entries
      for (const [sourceId, entry] of Object.entries(entries)) {
        cache.sources[sourceId] = entry;
      }
      cache.updatedAt = Date.now();

      // Atomic write
      const dir = dirname(this.CACHE_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      const tmpPath = `${this.CACHE_PATH}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
      try {
        renameSync(tmpPath, this.CACHE_PATH);
      } catch {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        return false;
      }

      // Update memory cache
      cachedData = cache;
      cacheTimestamp = Date.now();

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the cache file exists.
   */
  static isAvailable(): boolean {
    try {
      return existsSync(this.CACHE_PATH);
    } catch {
      return false;
    }
  }

  /**
   * Get age of a specific source's data in ms.
   * Returns Infinity if source not cached.
   */
  static getSourceAge(sourceId: string): number {
    const entry = this.getSourceData(sourceId);
    if (!entry) return Infinity;
    return Math.max(0, Date.now() - entry.fetchedAt);
  }

  /**
   * Clear in-memory cache (for testing).
   */
  static clearCache(): void {
    cachedData = null;
    cacheTimestamp = 0;
  }
}

export default DataCacheManager;
