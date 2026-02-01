/**
 * Smart Refresh Manager - Ultra-fast selective refresh with in-memory caching
 *
 * Architecture:
 * 1. In-memory cache with per-category TTL (shared across invocations in same process)
 * 2. File read throttling (prevents 30 agents all reading at once)
 * 3. Selective refresh (only fetch stale categories)
 * 4. Thundering herd protection (queue concurrent fetches)
 *
 * Performance Target:
 * - <5ms if all categories fresh
 * - No memory leaks even with 30 concurrent agents
 * - No orphan processes
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import { BillingInfo, GitInfo, SessionHealth } from '../types/session-health';
import { SubscriptionReader } from './subscription-reader';

// ============================================================================
// Types
// ============================================================================

interface CategoryState<T = any> {
  lastFetched: number;
  data: T;
}

interface RefreshCategory<T = any> {
  name: string;
  ttlMs: number;
  fetch: () => Promise<T>;
}

// ============================================================================
// Global State (Singleton)
// ============================================================================

// In-memory cache - shared across all invocations in same process
const globalCache = new Map<string, CategoryState>();

// File read throttling - prevents 30 agents all reading at once
let lastFileRead = 0;
const FILE_READ_COOLDOWN = 2000; // 2 seconds

// Thundering herd protection
let fetchInProgress = false;
const fetchQueue: Array<() => void> = [];

// ============================================================================
// Smart Refresh Manager
// ============================================================================

export class SmartRefreshManager {
  private static readonly BILLING_PATH = `${homedir()}/.claude/session-health/billing-shared.json`;

  // Category definitions with TTLs
  private static readonly CATEGORIES: RefreshCategory[] = [
    {
      name: 'billing',
      ttlMs: 300000, // 5 minutes
      fetch: async () => SmartRefreshManager.fetchBilling()
    },
    {
      name: 'subscription',
      ttlMs: 60000, // 1 minute (file-based, fast)
      fetch: async () => SmartRefreshManager.fetchSubscription()
    }
    // Git is handled separately via GitModule with per-repo cooldowns
  ];

  /**
   * Get fresh billing data (ultra-fast path if cached)
   *
   * @returns BillingInfo or null if no data available
   */
  static async getBilling(): Promise<BillingInfo | null> {
    // Step 1: Check in-memory cache (fastest - <1ms)
    const cached = globalCache.get('billing');
    if (cached && this.isFresh(cached, 300000)) {
      // Merge subscription data into billing
      return this.mergeBillingWithSubscription(cached.data);
    }

    // Step 2: Throttle file reads
    const now = Date.now();
    if (now - lastFileRead < FILE_READ_COOLDOWN) {
      // Too soon - return cached (possibly stale) or read file
      if (cached) {
        return this.mergeBillingWithSubscription(cached.data);
      }
      // Must read file
      const fileData = this.readBillingFile();
      if (fileData) {
        globalCache.set('billing', { lastFetched: fileData.lastFetched || now, data: fileData });
        return this.mergeBillingWithSubscription(fileData);
      }
      return null;
    }
    lastFileRead = now;

    // Step 3: Read from file (check if refresh needed)
    const fileData = this.readBillingFile();
    if (fileData) {
      globalCache.set('billing', { lastFetched: fileData.lastFetched || now, data: fileData });

      // Check if file data is fresh enough
      if (fileData.lastFetched && (now - fileData.lastFetched) < 300000) {
        return this.mergeBillingWithSubscription(fileData);
      }
    }

    // Step 4: Need fresh fetch - but use thundering herd protection
    if (fetchInProgress) {
      // Another fetch is running - wait for it
      return new Promise(resolve => {
        fetchQueue.push(() => {
          const data = globalCache.get('billing')?.data;
          resolve(data ? this.mergeBillingWithSubscription(data) : null);
        });
      });
    }

    // Step 5: Perform fetch
    fetchInProgress = true;
    try {
      const freshBilling = await this.fetchBilling();
      if (freshBilling) {
        globalCache.set('billing', { lastFetched: now, data: freshBilling });

        // Write to shared file (atomic)
        try {
          const tempPath = `${this.BILLING_PATH}.tmp`;
          writeFileSync(tempPath, JSON.stringify(freshBilling), { encoding: 'utf-8', mode: 0o600 });
          renameSync(tempPath, this.BILLING_PATH);
        } catch { /* ignore write errors */ }

        return this.mergeBillingWithSubscription(freshBilling);
      }

      // Fetch failed - return whatever we have
      return fileData ? this.mergeBillingWithSubscription(fileData) : null;
    } finally {
      fetchInProgress = false;
      // Notify all waiters
      fetchQueue.forEach(resolve => resolve());
      fetchQueue.length = 0;
    }
  }

  /**
   * Check if all categories are fresh (for fast path)
   */
  static allCategoriesFresh(): boolean {
    for (const cat of this.CATEGORIES) {
      const state = globalCache.get(cat.name);
      if (!state || !this.isFresh(state, cat.ttlMs)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get stale categories
   */
  static getStaleCategories(): string[] {
    return this.CATEGORIES
      .filter(cat => {
        const state = globalCache.get(cat.name);
        return !state || !this.isFresh(state, cat.ttlMs);
      })
      .map(cat => cat.name);
  }

  /**
   * Clear all caches (for testing)
   */
  static clearCache(): void {
    globalCache.clear();
    lastFileRead = 0;
    SubscriptionReader.clearCache();
  }

  // ============================================================================
  // Private Methods
  // ============================================================================

  private static isFresh(state: CategoryState, ttlMs: number): boolean {
    return Date.now() - state.lastFetched < ttlMs;
  }

  private static readBillingFile(): BillingInfo | null {
    try {
      if (!existsSync(this.BILLING_PATH)) return null;
      return JSON.parse(readFileSync(this.BILLING_PATH, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Fetch billing from ccusage (via existing module)
   * This is called by data-daemon, not by display-only
   */
  private static async fetchBilling(): Promise<BillingInfo | null> {
    // Note: Actual ccusage fetch is done by data-daemon.ts
    // This method is for when we need to read existing data
    return this.readBillingFile();
  }

  /**
   * Fetch subscription data from YAML file
   */
  private static async fetchSubscription(): Promise<ReturnType<typeof SubscriptionReader.getWeeklyQuota>> {
    return SubscriptionReader.getWeeklyQuota();
  }

  /**
   * Merge billing data with subscription (weekly quota)
   */
  private static mergeBillingWithSubscription(billing: BillingInfo): BillingInfo {
    // Get subscription data for weekly quota
    const subscription = SubscriptionReader.getWeeklyQuota();

    if (!subscription) {
      return billing;
    }

    // Merge weekly quota from subscription into billing
    return {
      ...billing,
      weeklyBudgetRemaining: subscription.hoursRemaining,
      weeklyBudgetPercentUsed: subscription.percentUsed,
      weeklyResetDay: subscription.resetDay
    };
  }
}

export default SmartRefreshManager;
