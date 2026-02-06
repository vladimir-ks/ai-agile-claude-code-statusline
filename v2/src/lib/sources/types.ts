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

export interface GlobalDataCache {
  /** Schema version */
  version: 2;
  /** When the cache was last written (Unix ms) */
  updatedAt: number;
  /** Per-source cached data */
  sources: Record<string, GlobalDataCacheEntry>;
}

/**
 * Create an empty GlobalDataCache
 */
export function createEmptyGlobalCache(): GlobalDataCache {
  return {
    version: 2,
    updatedAt: Date.now(),
    sources: {}
  };
}
