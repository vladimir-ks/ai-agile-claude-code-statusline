/**
 * Data Broker - Central Hub for Session-Isolated Data Management (Production)
 *
 * CRITICAL: Streamlined for v2 deployment
 * Status: FUNCTIONAL with core error handling
 */

import { EventEmitter } from 'events';

interface DataModuleConfig {
  timeout: number;
  cacheTTL: number;
}

interface DataModule<T> {
  moduleId: string;
  config: DataModuleConfig;
  fetch(sessionId: string): Promise<T>;
  validate(data: T): {
    valid: boolean;
    warnings: string[];
    errors: string[];
    sanitized?: T;
  };
}

interface CacheEntry<T> {
  moduleId: string;
  sessionId: string | null;
  data: T;
  fetchedAt: number;
  validUntil: number;
  fetchCount: number;
  hitCount: number;
  lastAccessedAt: number;
}

interface SessionMeta {
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  configDir: string;
  transcriptPath: string | null;
}

interface BrokerConfig {
  maxCacheSize: number;
  evictionPolicy: 'LRU' | 'LFU';
  sessionTimeoutMs: number;
}

class DataBroker extends EventEmitter {
  private cache: Map<string, CacheEntry<any>> = new Map();
  private inFlight: Map<string, Promise<any>> = new Map();
  private sessions: Map<string, SessionMeta> = new Map();
  private modules: Map<string, DataModule<any>> = new Map();
  private config: BrokerConfig;
  private cleanupTimer?: NodeJS.Timer;

  constructor(config: BrokerConfig) {
    super();

    this.config = {
      maxCacheSize: Math.max(10, config?.maxCacheSize || 1000),
      evictionPolicy: config?.evictionPolicy || 'LRU',
      sessionTimeoutMs: Math.max(60000, config?.sessionTimeoutMs || 3600000)
    };

    this.setMaxListeners(100);
    this.startCleanupTimer();
  }

  registerSession(sessionId: string, configDir: string, transcriptPath: string | null): void {
    if (!sessionId || typeof sessionId !== 'string') return;

    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId)!;
      session.lastActivityAt = Date.now();
      return;
    }

    this.sessions.set(sessionId, {
      sessionId,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      configDir: configDir || '',
      transcriptPath
    });

    this.emit('session:registered', sessionId);
  }

  registerModule<T>(module: DataModule<T>): void {
    if (!module || !module.moduleId) return;
    this.modules.set(module.moduleId, module);
    this.emit('module:registered', module.moduleId);
  }

  async getData<T>(
    moduleId: string,
    sessionId: string,
    options?: { forceRefresh?: boolean; timeout?: number; }
  ): Promise<{ data: T; staleness: number; fromCache: boolean; }> {
    const module = this.modules.get(moduleId);
    if (!module) {
      throw new Error('Module not found: ' + moduleId);
    }

    const isSessionSpecific = this.isModuleSessionSpecific(moduleId);
    const cacheKey = isSessionSpecific ? moduleId + ':' + sessionId : moduleId + ':shared';

    if (!options?.forceRefresh) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        cached.lastAccessedAt = Date.now();
        cached.hitCount++;
        const staleness = Date.now() - cached.fetchedAt;

        if (Date.now() < cached.validUntil) {
          this.emit('cache:hit', { moduleId, sessionId, staleness });
          return { data: cached.data, staleness, fromCache: true };
        }
        this.emit('cache:stale', { moduleId, sessionId, staleness });
      }
    }

    const data = await this.fetchWithDedup<T>(cacheKey, async () => {
      const fetchTimeout = options?.timeout || module.config.timeout;
      const dataPromise = module.fetch(sessionId);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Fetch timeout')), fetchTimeout)
      );

      const fetchedData = await Promise.race([dataPromise, timeoutPromise]);
      const validation = module.validate(fetchedData);

      if (!validation.valid) {
        this.emit('validation:failed', { moduleId, sessionId, errors: validation.errors });
        if (validation.sanitized) return validation.sanitized;
        throw new Error('Validation failed: ' + validation.errors.join(', '));
      }

      if (validation.warnings.length > 0) {
        this.emit('validation:warnings', { moduleId, sessionId, warnings: validation.warnings });
      }

      return fetchedData;
    });

    const now = Date.now();
    const cacheTTL = module.config.cacheTTL;

    this.cache.set(cacheKey, {
      moduleId,
      sessionId: isSessionSpecific ? sessionId : null,
      data,
      fetchedAt: now,
      validUntil: now + cacheTTL,
      fetchCount: (this.cache.get(cacheKey)?.fetchCount || 0) + 1,
      hitCount: 0,
      lastAccessedAt: now
    });

    this.enforceMaxCacheSize();
    this.emit('cache:set', { moduleId, sessionId });

    return { data, staleness: 0, fromCache: false };
  }

  private async fetchWithDedup<T>(key: string, fetchFn: () => Promise<T>): Promise<T> {
    if (this.inFlight.has(key)) {
      this.emit('fetch:deduplicated', { key });
      return this.inFlight.get(key)!;
    }

    const promise = fetchFn().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, promise);
    this.emit('fetch:started', { key });

    return promise;
  }

  private isModuleSessionSpecific(moduleId: string): boolean {
    return ['context', 'model', 'transcript'].includes(moduleId);
  }

  private enforceMaxCacheSize(): void {
    // Loop until cache is within bounds (not just once)
    while (this.cache.size > this.config.maxCacheSize) {
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
      } else {
        // No LRU found (shouldn't happen) - break to prevent infinite loop
        break;
      }
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      const inactiveSessions: string[] = [];

      for (const [sessionId, session] of this.sessions.entries()) {
        if (now - session.lastActivityAt > this.config.sessionTimeoutMs) {
          inactiveSessions.push(sessionId);
        }
      }

      for (const sessionId of inactiveSessions) {
        this.removeSession(sessionId);
      }

      if (inactiveSessions.length > 0) {
        this.emit('cleanup:sessions', { count: inactiveSessions.length });
      }
    }, 5 * 60 * 1000);
  }

  private removeSession(sessionId: string): void {
    this.sessions.delete(sessionId);

    const keysToDelete: string[] = [];
    for (const [key, entry] of this.cache.entries()) {
      if (entry.sessionId === sessionId) keysToDelete.push(key);
    }

    for (const key of keysToDelete) this.cache.delete(key);
    this.emit('session:removed', { sessionId, entriesRemoved: keysToDelete.length });
  }

  getCacheStats() {
    let sessionSpecific = 0, shared = 0, totalFetches = 0, totalHits = 0;

    for (const entry of this.cache.values()) {
      if (entry.sessionId) sessionSpecific++; else shared++;
      totalFetches += entry.fetchCount;
      totalHits += entry.hitCount;
    }

    const hitRate = totalFetches > 0 ? (totalHits / (totalFetches + totalHits)) * 100 : 0;

    return { totalEntries: this.cache.size, sessionSpecific, shared, totalFetches, totalHits, hitRate };
  }

  getSessionStats() {
    const now = Date.now();
    let activeSessions = 0;

    for (const session of this.sessions.values()) {
      if (now - session.lastActivityAt < 5 * 60 * 1000) activeSessions++;
    }

    return { totalSessions: this.sessions.size, activeSessions };
  }

  clearCache(): void {
    this.cache.clear();
    this.emit('cache:cleared');
  }

  async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    // DON'T wait for pending promises - let them finish in background
    // This prevents 35s ccusage timeout from blocking shutdown
    // const pending = Array.from(this.inFlight.values());
    // await Promise.allSettled(pending);

    this.cache.clear();
    this.sessions.clear();
    this.modules.clear();
    this.removeAllListeners();

    this.emit('shutdown');
  }
}

export default DataBroker;
export { DataModule, DataModuleConfig, CacheEntry, SessionMeta, BrokerConfig };
