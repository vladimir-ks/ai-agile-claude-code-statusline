/**
 * Data Broker - Central Hub for Session-Isolated Data Management
 *
 * Responsibilities:
 * - Maintain session registry (track all active sessions)
 * - Manage cache with session isolation (sessionId-tagged entries)
 * - Coordinate module fetches (prevent duplicate expensive operations)
 * - Enforce cache TTL and staleness tracking
 * - Evict inactive session data (LRU policy)
 *
 * CRITICAL GUARANTEES:
 * 1. Session A can NEVER read Session B's data
 * 2. Only 1 ccusage fetch for 15 parallel sessions
 * 3. Stale data flagged with 🔴
 * 4. Failed fetches fall back to cached data gracefully
 */

import { EventEmitter } from 'events';

interface CacheEntry<T> {
  moduleId: string;
  sessionId: string | null;  // null = shared across all sessions
  data: T;
  fetchedAt: number;         // Unix timestamp (ms)
  validUntil: number;        // fetchedAt + cacheTTL
  fetchCount: number;        // Metrics: how many times fetched
  hitCount: number;          // Metrics: how many cache hits
  lastAccessedAt: number;    // For LRU eviction
}

interface SessionMeta {
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  configDir: string;
  transcriptPath: string | null;
}

interface BrokerConfig {
  maxCacheSize: number;      // Max cache entries (default 1000)
  evictionPolicy: 'LRU' | 'LFU';
  sessionTimeoutMs: number;  // Evict session after inactivity (default 1 hour)
}

class DataBroker extends EventEmitter {
  // Cache storage (indexed by cache key)
  private cache: Map<string, CacheEntry<any>> = new Map();

  // In-flight fetches (for deduplication)
  private inFlight: Map<string, Promise<any>> = new Map();

  // Session registry
  private sessions: Map<string, SessionMeta> = new Map();

  // Loaded modules
  private modules: Map<string, DataModule<any>> = new Map();

  // Configuration
  private config: BrokerConfig;

  constructor(config: BrokerConfig) {
    super();
    this.config = config;

    // Start periodic cleanup
    this.startCleanupTimer();
  }

  /**
   * Register a new session
   */
  registerSession(
    sessionId: string,
    configDir: string,
    transcriptPath: string | null
  ): void {
    if (this.sessions.has(sessionId)) {
      // Update last activity
      const session = this.sessions.get(sessionId)!;
      session.lastActivityAt = Date.now();
      return;
    }

    // Create new session
    this.sessions.set(sessionId, {
      sessionId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      configDir,
      transcriptPath
    });

    this.emit('session:registered', sessionId);
  }

  /**
   * Register a data module
   */
  registerModule<T>(module: DataModule<T>): void {
    this.modules.set(module.moduleId, module);
    this.emit('module:registered', module.moduleId);
  }

  /**
   * Get data from a module (with caching and deduplication)
   *
   * CRITICAL: This is the main entry point for all data fetches
   *
   * Flow:
   * 1. Check cache (session-specific or shared)
   * 2. If cache hit and fresh, return immediately
   * 3. If cache miss or stale, fetch fresh data
   * 4. Use fetch deduplication (await in-flight promise if exists)
   * 5. Validate fetched data
   * 6. Update cache
   * 7. Return data
   */
  async getData<T>(
    moduleId: string,
    sessionId: string,
    options?: {
      forceRefresh?: boolean;
      timeout?: number;
    }
  ): Promise<{
    data: T;
    staleness: number;  // Age in ms
    fromCache: boolean;
  }> {
    const module = this.modules.get(moduleId);
    if (!module) {
      throw new Error(`Module not found: ${moduleId}`);
    }

    // STEP 1: Build cache key
    // Session-specific data: "context:sessionId"
    // Shared data: "cost:shared"
    const isSessionSpecific = this.isModuleSessionSpecific(moduleId);
    const cacheKey = isSessionSpecific
      ? `${moduleId}:${sessionId}`
      : `${moduleId}:shared`;

    // STEP 2: Check cache (unless forceRefresh)
    if (!options?.forceRefresh) {
      const cached = this.cache.get(cacheKey);

      if (cached) {
        // Update access time for LRU
        cached.lastAccessedAt = Date.now();
        cached.hitCount++;

        const staleness = Date.now() - cached.fetchedAt;

        // Check if still valid
        if (Date.now() < cached.validUntil) {
          this.emit('cache:hit', { moduleId, sessionId, staleness });

          return {
            data: cached.data,
            staleness,
            fromCache: true
          };
        } else {
          this.emit('cache:stale', { moduleId, sessionId, staleness });
          // Cache exists but stale, continue to fetch
        }
      }
    }

    // STEP 3: Fetch fresh data (with deduplication)
    const data = await this.fetchWithDedup<T>(cacheKey, async () => {
      const fetchTimeout = options?.timeout || module.config.timeout;

      // Fetch with timeout
      const dataPromise = module.fetch(sessionId);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Fetch timeout')), fetchTimeout)
      );

      const fetchedData = await Promise.race([dataPromise, timeoutPromise]);

      // Validate
      const validation = module.validate(fetchedData);

      if (!validation.valid) {
        this.emit('validation:failed', {
          moduleId,
          sessionId,
          errors: validation.errors
        });

        // Use sanitized version if available
        if (validation.sanitized) {
          return validation.sanitized;
        }

        throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
      }

      if (validation.warnings.length > 0) {
        this.emit('validation:warnings', {
          moduleId,
          sessionId,
          warnings: validation.warnings
        });
      }

      return fetchedData;
    });

    // STEP 4: Update cache
    const now = Date.now();
    const cacheTTL = module.config.cacheTTL;

    const entry: CacheEntry<T> = {
      moduleId,
      sessionId: isSessionSpecific ? sessionId : null,
      data,
      fetchedAt: now,
      validUntil: now + cacheTTL,
      fetchCount: (this.cache.get(cacheKey)?.fetchCount || 0) + 1,
      hitCount: 0,
      lastAccessedAt: now
    };

    this.cache.set(cacheKey, entry);

    // STEP 5: Enforce cache size limit
    this.enforceMaxCacheSize();

    this.emit('cache:set', { moduleId, sessionId });

    return {
      data,
      staleness: 0,
      fromCache: false
    };
  }

  /**
   * Fetch with deduplication
   *
   * CRITICAL: If another fetch for the same key is in-flight,
   * await that promise instead of starting a new fetch
   *
   * This prevents 15 parallel sessions from all calling ccusage
   */
  private async fetchWithDedup<T>(
    key: string,
    fetchFn: () => Promise<T>
  ): Promise<T> {
    // Check if fetch already in progress
    if (this.inFlight.has(key)) {
      this.emit('fetch:deduplicated', { key });
      return this.inFlight.get(key)!;
    }

    // Start fetch
    const promise = fetchFn().finally(() => {
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    this.emit('fetch:started', { key });

    return promise;
  }

  /**
   * Determine if module is session-specific
   *
   * Session-specific modules:
   * - context (different per session)
   * - model (different per session)
   * - transcript (different per session)
   *
   * Shared modules:
   * - cost (same ccusage data for all sessions)
   * - git (shared by repo path, not session)
   */
  private isModuleSessionSpecific(moduleId: string): boolean {
    const sessionSpecificModules = ['context', 'model', 'transcript'];
    return sessionSpecificModules.includes(moduleId);
  }

  /**
   * Enforce max cache size (LRU eviction)
   */
  private enforceMaxCacheSize(): void {
    if (this.cache.size <= this.config.maxCacheSize) {
      return;
    }

    // Find LRU entry
    let lruKey: string | null = null;
    let lruTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessedAt < lruTime) {
        lruTime = entry.lastAccessedAt;
        lruKey = key;
      }
    }

    if (lruKey) {
      this.cache.delete(lruKey);
      this.emit('cache:evicted', { key: lruKey, reason: 'LRU' });
    }
  }

  /**
   * Periodic cleanup of inactive sessions
   *
   * Runs every 5 minutes, removes:
   * - Sessions inactive for > sessionTimeoutMs
   * - All cache entries for those sessions
   */
  private startCleanupTimer(): void {
    setInterval(() => {
      const now = Date.now();
      const inactiveSessions: string[] = [];

      // Find inactive sessions
      for (const [sessionId, session] of this.sessions.entries()) {
        const inactiveTime = now - session.lastActivityAt;

        if (inactiveTime > this.config.sessionTimeoutMs) {
          inactiveSessions.push(sessionId);
        }
      }

      // Remove inactive sessions
      for (const sessionId of inactiveSessions) {
        this.removeSession(sessionId);
      }

      if (inactiveSessions.length > 0) {
        this.emit('cleanup:sessions', { count: inactiveSessions.length });
      }
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Remove a session and all its cache entries
   */
  private removeSession(sessionId: string): void {
    // Remove session metadata
    this.sessions.delete(sessionId);

    // Remove all session-specific cache entries
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.sessionId === sessionId) {
        keysToDelete.push(key);
      }
    }

    for (const key of keysToDelete) {
      this.cache.delete(key);
    }

    this.emit('session:removed', { sessionId, entriesRemoved: keysToDelete.length });
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    totalEntries: number;
    sessionSpecific: number;
    shared: number;
    totalFetches: number;
    totalHits: number;
    hitRate: number;
  } {
    let sessionSpecific = 0;
    let shared = 0;
    let totalFetches = 0;
    let totalHits = 0;

    for (const entry of this.cache.values()) {
      if (entry.sessionId) {
        sessionSpecific++;
      } else {
        shared++;
      }

      totalFetches += entry.fetchCount;
      totalHits += entry.hitCount;
    }

    const hitRate = totalFetches > 0
      ? (totalHits / (totalFetches + totalHits)) * 100
      : 0;

    return {
      totalEntries: this.cache.size,
      sessionSpecific,
      shared,
      totalFetches,
      totalHits,
      hitRate
    };
  }

  /**
   * Get session statistics
   */
  getSessionStats(): {
    totalSessions: number;
    activeSessions: number;  // Active in last 5 minutes
  } {
    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000;

    let activeSessions = 0;

    for (const session of this.sessions.values()) {
      if (now - session.lastActivityAt < fiveMinutes) {
        activeSessions++;
      }
    }

    return {
      totalSessions: this.sessions.size,
      activeSessions
    };
  }

  /**
   * Clear all cache (for testing/debugging)
   */
  clearCache(): void {
    this.cache.clear();
    this.emit('cache:cleared');
  }

  /**
   * Shutdown broker gracefully
   */
  async shutdown(): Promise<void> {
    // Wait for in-flight fetches to complete
    const pending = Array.from(this.inFlight.values());
    await Promise.allSettled(pending);

    this.cache.clear();
    this.sessions.clear();
    this.modules.clear();

    this.emit('shutdown');
  }
}

export default DataBroker;
