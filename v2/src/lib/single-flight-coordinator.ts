/**
 * SingleFlightCoordinator - Generalized single-flight lock for data sources
 *
 * Wraps RefreshIntentManager to provide a clean acquire/release API
 * for any category of data. Ensures only one daemon refreshes stale
 * global data at a time; others read cached.
 *
 * Pattern (from quota-broker.sh):
 *   1. tryAcquire(category) → true if we own the lock
 *   2. ... do fetch ...
 *   3. release(category, success)
 *
 * PID-based liveness: if the owning process dies, the lock auto-expires
 * on next isRefreshInProgress() call (dead PID detection).
 */

import { RefreshIntentManager } from './refresh-intent-manager';

export interface AcquireResult {
  acquired: boolean;
  /** If not acquired, the reason */
  reason?: 'already_in_progress' | 'cooldown';
}

export class SingleFlightCoordinator {

  /**
   * Try to acquire exclusive refresh rights for a category.
   *
   * Returns { acquired: true } if this process now owns the refresh.
   * Returns { acquired: false, reason } if another process is refreshing
   * or if the category is in cooldown.
   *
   * Side effects:
   * - Signals refresh needed (intent file)
   * - Signals refresh in progress (inprogress file with PID)
   */
  static tryAcquire(category: string): AcquireResult {
    // Signal that refresh is desired (idempotent)
    RefreshIntentManager.signalRefreshNeeded(category);

    // Check if another process is already refreshing
    if (RefreshIntentManager.isRefreshInProgress(category)) {
      return { acquired: false, reason: 'already_in_progress' };
    }

    // We claim the refresh
    RefreshIntentManager.signalRefreshInProgress(category);
    return { acquired: true };
  }

  /**
   * Release the refresh lock for a category.
   *
   * On success: clears both intent and inprogress files.
   * On failure: clears only inprogress (leaves intent for next daemon).
   */
  static release(category: string, success: boolean): void {
    if (success) {
      RefreshIntentManager.clearIntent(category);
    } else {
      RefreshIntentManager.clearInProgress(category);
    }
  }

  /**
   * Try to acquire multiple categories at once.
   * Returns only the categories that were successfully acquired.
   *
   * Useful for batch refresh: daemon detects 3 stale sources,
   * acquires locks for whichever ones aren't already being refreshed.
   */
  static tryAcquireMany(categories: string[]): string[] {
    const acquired: string[] = [];
    for (const cat of categories) {
      const result = this.tryAcquire(cat);
      if (result.acquired) {
        acquired.push(cat);
      }
    }
    return acquired;
  }

  /**
   * Release multiple categories at once.
   */
  static releaseMany(categories: string[], success: boolean): void {
    for (const cat of categories) {
      this.release(cat, success);
    }
  }

  /**
   * Check if a category refresh is currently in progress (by any process).
   */
  static isInProgress(category: string): boolean {
    return RefreshIntentManager.isRefreshInProgress(category);
  }

  /**
   * Check if any of the given categories are currently being refreshed.
   */
  static getInProgressCategories(categories: string[]): string[] {
    return categories.filter(cat => this.isInProgress(cat));
  }
}

export default SingleFlightCoordinator;
