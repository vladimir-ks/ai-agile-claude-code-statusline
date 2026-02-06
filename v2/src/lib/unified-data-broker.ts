/**
 * UnifiedDataBroker - Orchestrates all data sources via registry
 *
 * Replaces the monolithic DataGatherer.gather() body with a clean pipeline:
 *
 *   1. Build GatherContext
 *   2. Tier 1 (sync): context, model — instant, from stdin
 *   3. Tier 2 (parallel): transcript, secrets, auth, session_cost
 *   4. Tier 3 (global): billing, quota, git, version, notifications
 *      → Read global cache → stale check → single-flight refresh → merge
 *   5. Post-process: health status, formatted output, writes
 *
 * Each source is independently cacheable, rate-controlled, extensible.
 * Adding a new source = create descriptor + register. No other files change.
 */

import { DataSourceRegistry } from './sources/registry';
import { DataCacheManager } from './data-cache-manager';
import { SingleFlightCoordinator } from './single-flight-coordinator';
import { FreshnessManager } from './freshness-manager';
import type { DataSourceDescriptor, GatherContext, GlobalDataCacheEntry } from './sources/types';
import type { SessionHealth, ClaudeCodeInput } from '../types/session-health';
import { createDefaultHealth } from '../types/session-health';

// -------------------------------------------------------------------------
// Registration: import all sources so they self-register
// -------------------------------------------------------------------------

import { contextSource } from './sources/context-source';
import { modelSource } from './sources/model-source';
import { transcriptSource } from './sources/transcript-source';
import { secretsSource } from './sources/secrets-source';
import { authSource } from './sources/auth-source';
import { sessionCostSource } from './sources/session-cost-source';
import { gitSource } from './sources/git-source';
import { billingSource } from './sources/billing-source';
import { quotaSource } from './sources/quota-source';
import { versionSource } from './sources/version-source';
import { notificationSource } from './sources/notification-source';
import { slotRecommendationSource } from './sources/slot-recommendation-source';

// Register all sources (idempotent — overwrites if already registered)
function ensureRegistered(): void {
  // Tier 1
  DataSourceRegistry.register(contextSource);
  DataSourceRegistry.register(modelSource);
  // Tier 2
  DataSourceRegistry.register(transcriptSource);
  DataSourceRegistry.register(secretsSource);
  DataSourceRegistry.register(authSource);
  DataSourceRegistry.register(sessionCostSource);
  // Tier 3
  DataSourceRegistry.register(gitSource);
  DataSourceRegistry.register(billingSource);
  DataSourceRegistry.register(quotaSource);
  DataSourceRegistry.register(versionSource);
  DataSourceRegistry.register(notificationSource);
  DataSourceRegistry.register(slotRecommendationSource);
}

// -------------------------------------------------------------------------
// Orchestrator
// -------------------------------------------------------------------------

export class UnifiedDataBroker {

  /**
   * Gather all data for a session using the registered source pipeline.
   *
   * This is the main entry point — replaces DataGatherer.gather() body.
   */
  static async gatherAll(
    sessionId: string,
    transcriptPath: string | null,
    jsonInput: ClaudeCodeInput | null,
    options?: {
      healthStorePath?: string;
      existingHealth?: SessionHealth | null;
      projectPath?: string;
      configDir?: string | null;
      keychainService?: string | null;
    }
  ): Promise<SessionHealth> {
    ensureRegistered();

    const startTime = Date.now();
    const DEADLINE_MS = 20000;
    const deadline = startTime + DEADLINE_MS;
    const health = createDefaultHealth(sessionId);
    health.gatheredAt = startTime;
    health.transcriptPath = transcriptPath || '';
    health.projectPath = options?.projectPath ||
      jsonInput?.start_directory ||
      process.cwd() || '';

    // Build gather context
    const ctx: GatherContext = {
      sessionId,
      transcriptPath,
      jsonInput,
      configDir: options?.configDir || null,
      keychainService: options?.keychainService || null,
      deadline,
      existingHealth: options?.existingHealth || null,
      projectPath: health.projectPath,
    };

    // Preserve firstSeen from existing health
    if (ctx.existingHealth?.firstSeen) {
      health.firstSeen = ctx.existingHealth.firstSeen;
      health.sessionDuration = Date.now() - ctx.existingHealth.firstSeen;
    } else {
      health.firstSeen = Date.now();
      health.sessionDuration = 0;
    }

    // -----------------------------------------------------------------------
    // TIER 1: Sync, instant (context, model)
    // -----------------------------------------------------------------------
    const tier1Sources = DataSourceRegistry.getByTier(1);
    for (const source of tier1Sources) {
      try {
        const data = await source.fetch(ctx);
        source.merge(health, data);
      } catch (err) {
        console.error(`[UDB] Tier 1 source ${source.id} failed:`, err);
      }
    }

    // -----------------------------------------------------------------------
    // TIER 2: Parallel, session-scoped (transcript, secrets, auth, session_cost)
    // -----------------------------------------------------------------------
    const tier2Sources = DataSourceRegistry.getByTier(2);
    const tier2Results = await Promise.allSettled(
      tier2Sources.map(async (source) => {
        const timeoutMs = Math.min(source.timeoutMs, deadline - Date.now());
        if (timeoutMs <= 0) return { source, data: null, error: 'deadline' };

        const fetchPromise = source.fetch(ctx);
        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), timeoutMs)
        );

        const data = await Promise.race([fetchPromise, timeoutPromise]);
        return { source, data, error: null };
      })
    );

    // Merge Tier 2 results
    for (const result of tier2Results) {
      if (result.status === 'fulfilled' && result.value.data !== null) {
        try {
          result.value.source.merge(health, result.value.data);
        } catch (err) {
          console.error(`[UDB] Tier 2 merge ${result.value.source.id} failed:`, err);
        }
      }
    }

    // -----------------------------------------------------------------------
    // TIER 3: Global cache → stale check → single-flight refresh → merge
    // -----------------------------------------------------------------------
    const tier3Sources = DataSourceRegistry.getByTier(3);
    const globalCache = DataCacheManager.read();

    // Determine which sources need refresh
    const staleCategories: string[] = [];
    const staleSources: DataSourceDescriptor[] = [];

    for (const source of tier3Sources) {
      const entry = globalCache.sources[source.id];
      const isFresh = entry
        ? FreshnessManager.isFresh(entry.fetchedAt, source.freshnessCategory)
        : false;

      if (!isFresh) {
        staleCategories.push(source.id);
        staleSources.push(source);
      }
    }

    // Single-flight: acquire locks for stale sources
    if (staleSources.length > 0) {
      const acquiredCategories = SingleFlightCoordinator.tryAcquireMany(
        staleCategories
      );

      // Fetch only the sources we acquired locks for
      const acquiredSources = staleSources.filter(
        s => acquiredCategories.includes(s.id)
      );

      if (acquiredSources.length > 0) {
        const refreshResults = await Promise.allSettled(
          acquiredSources.map(async (source) => {
            const timeoutMs = Math.min(source.timeoutMs, deadline - Date.now());
            if (timeoutMs <= 0) return { source, data: null };

            try {
              const fetchPromise = source.fetch(ctx);
              const timeoutPromise = new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), timeoutMs)
              );

              const data = await Promise.race([fetchPromise, timeoutPromise]);
              return { source, data };
            } catch {
              return { source, data: null };
            }
          })
        );

        // Write fresh data to global cache + merge into health
        const cacheUpdates: Record<string, GlobalDataCacheEntry> = {};
        const successfulIds: string[] = [];
        const failedIds: string[] = [];

        for (const result of refreshResults) {
          if (result.status === 'fulfilled' && result.value.data !== null) {
            const { source, data } = result.value;
            cacheUpdates[source.id] = {
              data,
              fetchedAt: Date.now(),
              fetchedBy: process.pid,
            };
            successfulIds.push(source.id);
          } else if (result.status === 'fulfilled') {
            failedIds.push(result.value.source.id);
          } else {
            failedIds.push('unknown');
          }
        }

        // Write to global cache
        if (Object.keys(cacheUpdates).length > 0) {
          DataCacheManager.update(cacheUpdates);
        }

        // Release locks
        for (const id of successfulIds) {
          SingleFlightCoordinator.release(id, true);
        }
        for (const id of failedIds) {
          SingleFlightCoordinator.release(id, false);
        }
      }
    }

    // Merge all Tier 3 data into health (from cache or fresh)
    const updatedCache = DataCacheManager.read();
    for (const source of tier3Sources) {
      const entry = updatedCache.sources[source.id];
      if (entry) {
        try {
          source.merge(health, entry.data);
        } catch (err) {
          console.error(`[UDB] Tier 3 merge ${source.id} failed:`, err);
        }
      } else {
        // No cached data — try fetching directly (for sources not using cache)
        try {
          const data = await source.fetch(ctx);
          source.merge(health, data);
        } catch (err) {
          console.error(`[UDB] Tier 3 direct fetch ${source.id} failed:`, err);
        }
      }
    }

    // -----------------------------------------------------------------------
    // POST-PROCESSING
    // -----------------------------------------------------------------------

    // Recompute billing freshness from timestamp
    health.billing.isFresh = FreshnessManager.isBillingFresh(health.billing.lastFetched);

    // Performance metrics
    health.performance = {
      gatherDuration: Date.now() - startTime,
      billingFetchDuration: health.billing.isFresh
        ? (Date.now() - startTime)
        : undefined,
    };

    return health;
  }

  /**
   * Get the count of registered sources.
   */
  static getRegisteredSourceCount(): number {
    ensureRegistered();
    return DataSourceRegistry.size();
  }

  /**
   * Get all registered source IDs grouped by tier.
   */
  static getSourcesByTier(): Record<number, string[]> {
    ensureRegistered();
    return {
      1: DataSourceRegistry.getByTier(1).map(s => s.id),
      2: DataSourceRegistry.getByTier(2).map(s => s.id),
      3: DataSourceRegistry.getByTier(3).map(s => s.id),
    };
  }
}

export default UnifiedDataBroker;
