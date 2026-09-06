/**
 * Unified Data Broker - Core Types
 *
 * DataSourceDescriptor: Typed, self-contained data source with fetch + merge.
 * GatherContext: Shared context passed to all sources during a gather cycle.
 * GlobalDataCache: Schema for ~/.claude/session-health/data-cache.json
 *
 * Tier classification:
 *   1 = Instant (stdin-derived, always fresh, zero cost)
 *   2 = Session (per-session files, no cross-process sharing)
 *   3 = Global  (shared across sessions, single-flight refresh)
 */

import type { SessionHealth, ClaudeCodeInput } from '../../types/session-health';

// ---------------------------------------------------------------------------
// Data Source Descriptor
// ---------------------------------------------------------------------------

export type DataSourceTier = 1 | 2 | 3;

export interface DataSourceDescriptor<T = any> {
  /** Unique identifier (e.g., "billing_oauth", "git_status") */
  id: string;

  /** Tier classification (1=instant, 2=session, 3=global) */
  tier: DataSourceTier;

  /** Key into FreshnessManager.CATEGORIES for TTL/cooldown/stale thresholds */
  freshnessCategory: string;

  /** Per-source timeout in ms (used for race against deadline) */
  timeoutMs: number;

  /** Source IDs that must complete before this one can run */
  dependencies?: string[];

  /**
   * Scope this source's global-cache entry to a context (project path, config
   * dir, ...). Sources without one share a single global entry.
   * Default mapping for sources that do not declare it: `defaultContextKey`.
   */
  contextKeyFor?(ctx: GatherContext): string | undefined;

  /**
   * Fetch fresh data for this source.
   * Should respect ctx.deadline and abort early if budget exceeded.
   */
  fetch(ctx: GatherContext): Promise<T>;

  /**
   * Merge fetched data into SessionHealth.
   * Mutates target in place (project convention).
   */
  merge(target: SessionHealth, data: T): void;
}

// ---------------------------------------------------------------------------
// Gather Context
// ---------------------------------------------------------------------------

export interface GatherContext {
  sessionId: string;
  transcriptPath: string | null;
  jsonInput: ClaudeCodeInput | null;
  configDir: string | null;
  keychainService: string | null;
  /** Absolute ms timestamp — hard time limit for this gather cycle */
  deadline: number;
  /** Previous health data for this session (if exists) */
  existingHealth: SessionHealth | null;
  /** Project path (from JSON input, cwd, or transcript path) */
  projectPath: string;
  /** Detected auth profile email (populated after Tier 2, used by Tier 3) */
  authEmail?: string;
}

// ---------------------------------------------------------------------------
// Global Data Cache
// ---------------------------------------------------------------------------

export interface GlobalDataCacheEntry {
  /** Source-specific data (type varies per source) */
  data: any;
  /** When this data was last fetched (Unix ms) */
  fetchedAt: number;
  /** PID of the process that fetched this data */
  fetchedBy: number;
  /** Optional context key for scoped data (e.g., repoPath for git) */
  contextKey?: string;
}

export const GLOBAL_CACHE_VERSION = 3;

export interface GlobalDataCache {
  /** Schema version */
  version: 3;
  /** When the cache was last written (Unix ms) */
  updatedAt: number;
  /** Per-source cached data, keyed by `cacheKeyFor(sourceId, contextKey)` */
  sources: Record<string, GlobalDataCacheEntry>;
}

/**
 * Create an empty GlobalDataCache
 */
export function createEmptyGlobalCache(): GlobalDataCache {
  return {
    version: GLOBAL_CACHE_VERSION,
    updatedAt: Date.now(),
    sources: {}
  };
}

// ---------------------------------------------------------------------------
// Context scoping
// ---------------------------------------------------------------------------

/**
 * Context key for sources that do not declare `contextKeyFor`.
 *
 * Per-account data (quota, billing, slot recommendation) is scoped to the
 * session's config dir; everything else is genuinely global.
 */
export function defaultContextKey(sourceId: string, ctx: GatherContext): string | undefined {
  switch (sourceId) {
    case 'quota':
    case 'billing':
    case 'slot_recommendation':
      return ctx.configDir || ctx.keychainService || undefined;
    default:
      return undefined;
  }
}

/**
 * Resolve the effective context key for a source.
 */
export function resolveContextKey(
  source: Pick<DataSourceDescriptor, 'id' | 'contextKeyFor'>,
  ctx: GatherContext,
): string | undefined {
  const key = source.contextKeyFor
    ? source.contextKeyFor(ctx)
    : defaultContextKey(source.id, ctx);
  return key && key.length > 0 ? key : undefined;
}

/**
 * Cache/lock key for a source in a context.
 *
 * The context key is hashed because it also names single-flight lock FILES
 * (RefreshIntentManager) — a raw path would not be filename-safe.
 */
export function cacheKeyFor(sourceId: string, contextKey?: string): string {
  if (!contextKey) return sourceId;
  const { createHash } = require('crypto') as typeof import('crypto');
  const digest = createHash('sha1').update(contextKey).digest('hex').slice(0, 12);
  return `${sourceId}::${digest}`;
}
