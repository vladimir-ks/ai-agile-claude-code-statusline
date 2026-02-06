/**
 * FreshnessManager - Single authority for all data staleness decisions
 *
 * Replaces 6+ independent freshness mechanisms with one unified system.
 * File-based persistence for cross-process cooldown tracking.
 *
 * CATEGORIES define thresholds per data type:
 * - freshMs: Max age before data is considered stale
 * - cooldownMs: Min wait after failure before retrying (0 = no cooldown)
 * - staleMs: Optional threshold for "critical stale" (display 🔺)
 */

import { existsSync, statSync, writeFileSync, unlinkSync, mkdirSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { RefreshIntentManager } from './refresh-intent-manager';

// ---------------------------------------------------------------------------
// Category definitions
// ---------------------------------------------------------------------------

export interface FreshnessCategory {
  freshMs: number;       // Data considered fresh within this window
  cooldownMs: number;    // Wait after failure before retry (0 = no cooldown)
  staleMs?: number;      // Critical stale threshold (for 🔺 indicator)
}

export const CATEGORIES: Record<string, FreshnessCategory> = {
  billing_oauth:       { freshMs: 120_000,   cooldownMs: 300_000, staleMs: 600_000 },   // 2min fresh, 5min cooldown, 10min critical
  billing_ccusage:     { freshMs: 120_000,   cooldownMs: 120_000, staleMs: 600_000 },   // 2min fresh, 2min cooldown, 10min critical
  billing_local:       { freshMs: 300_000,   cooldownMs: 0,       staleMs: 600_000 },   // 5min fresh, no cooldown, 10min critical
  quota_hotswap:       { freshMs: 30_000,    cooldownMs: 0 },                            // 30s fresh, no cooldown
  quota_subscription:  { freshMs: 60_000,    cooldownMs: 0 },                            // 60s fresh, no cooldown
  git_status:          { freshMs: 30_000,    cooldownMs: 0,       staleMs: 300_000 },    // 30s fresh, 5min critical
  transcript:          { freshMs: 300_000,   cooldownMs: 0,       staleMs: 600_000 },    // 5min fresh, 10min critical
  model:               { freshMs: 300_000,   cooldownMs: 0 },                            // 5min fresh
  context:             { freshMs: 5_000,     cooldownMs: 0 },                            // 5s fresh (real-time from stdin)
  weekly_quota:        { freshMs: 300_000,   cooldownMs: 0,       staleMs: 86_400_000 }, // 5min fresh, 24h critical
  quota_broker:        { freshMs: 30_000,    cooldownMs: 0,       staleMs: 300_000 },    // 30s fresh, 5min critical
  version_check:       { freshMs: 14_400_000,cooldownMs: 0 },                            // 4h fresh
  auth_profile:        { freshMs: 300_000,   cooldownMs: 0 },                            // 5min fresh
  secrets_scan:        { freshMs: 300_000,   cooldownMs: 0 },                            // 5min fresh
  notifications:       { freshMs: 5_000,     cooldownMs: 0 },                            // 5s fresh
};

// ---------------------------------------------------------------------------
// Staleness status
// ---------------------------------------------------------------------------

export type StalenessStatus = 'fresh' | 'stale' | 'critical' | 'unknown';

export interface FieldFreshness {
  category: string;
  timestamp: number;         // When data was last fetched/updated
  ageMs: number;             // Current age in ms
  status: StalenessStatus;
  indicator: '' | '⚠' | '🔺';  // Display indicator
}

export interface FreshnessReport {
  generatedAt: number;
  fields: Record<string, FieldFreshness>;
}

// ---------------------------------------------------------------------------
// Cooldown file paths
// ---------------------------------------------------------------------------

const COOLDOWN_DIR = `${homedir()}/.claude/session-health/cooldowns`;

function cooldownPath(category: string): string {
  return `${COOLDOWN_DIR}/fm-${category}.cooldown`;
}

function ensureCooldownDir(): void {
  if (!existsSync(COOLDOWN_DIR)) {
    mkdirSync(COOLDOWN_DIR, { recursive: true, mode: 0o700 });
  }
}

// ---------------------------------------------------------------------------
// FreshnessManager
// ---------------------------------------------------------------------------

export class FreshnessManager {

  /**
   * Check if data with given timestamp is fresh for its category.
   * Returns true if within freshMs threshold.
   */
  static isFresh(timestamp: number | undefined | null, category: string): boolean {
    if (!timestamp || timestamp <= 0) return false;

    const cat = CATEGORIES[category];
    if (!cat) return false;

    return (Date.now() - timestamp) < cat.freshMs;
  }

  /**
   * Get age of data in milliseconds.
   */
  static getAge(timestamp: number | undefined | null): number {
    if (!timestamp || timestamp <= 0) return Infinity;
    return Math.max(0, Date.now() - timestamp);
  }

  /**
   * Get staleness status for a data point.
   */
  static getStatus(timestamp: number | undefined | null, category: string): StalenessStatus {
    if (!timestamp || timestamp <= 0) return 'unknown';

    const cat = CATEGORIES[category];
    if (!cat) return 'unknown';

    const age = Date.now() - timestamp;

    if (age < cat.freshMs) return 'fresh';
    if (cat.staleMs && age >= cat.staleMs) return 'critical';
    return 'stale';
  }

  /**
   * Get display indicator for staleness.
   */
  static getIndicator(timestamp: number | undefined | null, category: string): '' | '⚠' | '🔺' {
    const status = this.getStatus(timestamp, category);
    switch (status) {
      case 'fresh': return '';
      case 'stale': return '⚠';
      case 'critical': return '🔺';
      case 'unknown': return '⚠';
    }
  }

  /**
   * Context-aware indicator that considers refresh intent state.
   *
   * Unlike getIndicator() which shows ⚠ immediately on stale data,
   * this only shows indicators when something is ACTUALLY wrong:
   * - Fresh → '' (no indicator)
   * - Stale, no intent → '' (daemon will handle on next run)
   * - Stale, intent < 30s → '' (refresh pending, normal)
   * - Stale, intent 30s-5min → '⚠' (refresh overdue)
   * - Stale, in cooldown → '⚠' (failed, retrying)
   * - Critical age → '🔺'
   * - Intent > 5min → '🔺' (refresh broken)
   */
  static getContextAwareIndicator(
    timestamp: number | undefined | null,
    category: string
  ): '' | '⚠' | '🔺' {
    // No data or unknown category → silent (not an error to show)
    if (!timestamp || timestamp <= 0) return '';
    const cat = CATEGORIES[category];
    if (!cat) return '';

    const age = Date.now() - timestamp;

    // 1. Fresh → no indicator
    if (age < cat.freshMs) return '';

    // 2. Critical age → always 🔺
    if (cat.staleMs && age >= cat.staleMs) return '🔺';

    // 3. Check intent state for context
    const intentAge = RefreshIntentManager.getIntentAge(category);

    if (intentAge !== null) {
      // Intent exists — check how long it's been pending
      if (intentAge >= 5 * 60_000) return '🔺';  // > 5min: refresh broken
      if (intentAge >= 30_000) return '⚠';       // > 30s: overdue
      return '';                                   // < 30s: pending, normal
    }

    // 4. No intent — check if in cooldown (means previous fetch failed)
    if (this.isInCooldown(category)) return '⚠';

    // 5. Stale but no intent and no cooldown → daemon hasn't run yet, will handle
    return '';
  }

  /**
   * Check if a category should refetch (cooldown expired or never failed).
   * Combines freshness check + cooldown check.
   */
  static shouldRefetch(category: string): boolean {
    const cat = CATEGORIES[category];
    if (!cat || cat.cooldownMs <= 0) return true;

    return !this.isInCooldown(category);
  }

  /**
   * Record a fetch attempt result.
   * On failure: writes cooldown file to prevent retry storms.
   * On success: clears cooldown file.
   */
  static recordFetch(category: string, success: boolean): void {
    if (success) {
      this.clearCooldown(category);
    } else {
      const cat = CATEGORIES[category];
      if (cat && cat.cooldownMs > 0) {
        this.writeCooldown(category);
      }
    }
  }

  /**
   * Get comprehensive freshness report for all tracked fields.
   * Used by debug state writer.
   */
  static getReport(timestamps: Record<string, number | undefined | null>): FreshnessReport {
    const fields: Record<string, FieldFreshness> = {};

    for (const [category, timestamp] of Object.entries(timestamps)) {
      if (!CATEGORIES[category]) continue;

      const ts = timestamp || 0;
      const ageMs = this.getAge(ts);
      const status = this.getStatus(ts, category);
      const indicator = this.getIndicator(ts, category);

      fields[category] = {
        category,
        timestamp: ts,
        ageMs,
        status,
        indicator,
      };
    }

    return {
      generatedAt: Date.now(),
      fields,
    };
  }

  /**
   * Compute billing.isFresh from timestamp (replaces stored boolean).
   * This is the CRITICAL fix: isFresh is now DERIVED, not stored.
   */
  static isBillingFresh(lastFetched: number | undefined | null): boolean {
    // Check both OAuth and ccusage thresholds (use the more lenient one)
    return this.isFresh(lastFetched, 'billing_ccusage');
  }

  // -------------------------------------------------------------------------
  // Cooldown management (file-based, cross-process)
  // -------------------------------------------------------------------------

  private static isInCooldown(category: string): boolean {
    try {
      const path = cooldownPath(category);
      if (!existsSync(path)) return false;

      const cat = CATEGORIES[category];
      if (!cat || cat.cooldownMs <= 0) return false;

      const mtime = statSync(path).mtimeMs;
      if (Date.now() - mtime < cat.cooldownMs) return true;

      // Cooldown expired — clean up
      try { unlinkSync(path); } catch { /* ignore */ }
      return false;
    } catch {
      return false;
    }
  }

  private static writeCooldown(category: string): void {
    try {
      ensureCooldownDir();
      writeFileSync(cooldownPath(category), String(Date.now()), { mode: 0o600 });
    } catch { /* ignore */ }
  }

  private static clearCooldown(category: string): void {
    try {
      const path = cooldownPath(category);
      if (existsSync(path)) unlinkSync(path);
    } catch { /* ignore */ }
  }

  /**
   * Clear all FreshnessManager cooldowns (for testing or manual refresh).
   */
  static clearAllCooldowns(): void {
    try {
      if (existsSync(COOLDOWN_DIR)) {
        for (const file of readdirSync(COOLDOWN_DIR)) {
          if (file.startsWith('fm-') && file.endsWith('.cooldown')) {
            try { unlinkSync(`${COOLDOWN_DIR}/${file}`); } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
  }

  /**
   * Get cooldown remaining for a category (ms). 0 if not in cooldown.
   */
  static getCooldownRemaining(category: string): number {
    try {
      const path = cooldownPath(category);
      if (!existsSync(path)) return 0;

      const cat = CATEGORIES[category];
      if (!cat || cat.cooldownMs <= 0) return 0;

      const mtime = statSync(path).mtimeMs;
      const remaining = cat.cooldownMs - (Date.now() - mtime);
      return Math.max(0, remaining);
    } catch {
      return 0;
    }
  }
}

export default FreshnessManager;
