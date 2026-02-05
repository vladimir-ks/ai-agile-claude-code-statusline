/**
 * Failover Subscriber - Reads failover events from cloud_configs/hot-swap
 *
 * Reads: ~/_claude-configs/hot-swap/failover-events.jsonl
 *
 * This file is the INBOUND handshake:
 * - cloud_configs/hot-swap writes failover events when swaps occur
 * - Statusline reads them to display swap notifications
 *
 * Event format (JSONL - one JSON object per line):
 * { "timestamp": 1234567890, "type": "swap", "fromSlot": "slot-1", "toSlot": "slot-2", "reason": "quota_exhausted" }
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FailoverEvent {
  timestamp: number;
  type: 'swap' | 'failover' | 'restore' | 'manual';
  fromSlot?: string;
  toSlot?: string;
  fromEmail?: string;
  toEmail?: string;
  reason?: string;
}

export interface FailoverStatus {
  hasRecentSwap: boolean;        // Swap in last 5 minutes
  lastSwap: FailoverEvent | null;
  recentEvents: FailoverEvent[]; // Events in last 30 minutes
  displayNotification: string | null; // One-line notification for statusline
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FAILOVER_PATHS = [
  `${homedir()}/_claude-configs/hot-swap/failover-events.jsonl`,
  `${homedir()}/.claude/hot-swap/failover-events.jsonl`,
];

const RECENT_THRESHOLD_MS = 300_000;   // 5 minutes for "recent swap"
const HISTORY_THRESHOLD_MS = 1_800_000; // 30 minutes for event history

// In-memory cache
let cachedEvents: FailoverEvent[] | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 10_000; // 10 seconds

// ---------------------------------------------------------------------------
// FailoverSubscriber
// ---------------------------------------------------------------------------

export class FailoverSubscriber {

  /**
   * Get current failover status.
   */
  static getStatus(): FailoverStatus {
    const events = this.readEvents();
    const now = Date.now();

    const recentEvents = events.filter(e => (now - e.timestamp) < HISTORY_THRESHOLD_MS);
    const lastSwap = recentEvents.length > 0 ? recentEvents[recentEvents.length - 1] : null;
    const hasRecentSwap = lastSwap !== null && (now - lastSwap.timestamp) < RECENT_THRESHOLD_MS;

    let displayNotification: string | null = null;
    if (hasRecentSwap && lastSwap) {
      const agoSec = Math.floor((now - lastSwap.timestamp) / 1000);
      const agoStr = agoSec < 60 ? `${agoSec}s` : `${Math.floor(agoSec / 60)}m`;
      const target = lastSwap.toEmail || lastSwap.toSlot || '?';
      displayNotification = `🔄 Swapped → ${target} (${agoStr} ago)`;
    }

    return {
      hasRecentSwap,
      lastSwap,
      recentEvents,
      displayNotification,
    };
  }

  /**
   * Read failover events from JSONL file (cached).
   */
  static readEvents(customPath?: string): FailoverEvent[] {
    const now = Date.now();

    // Return cache if fresh (and no custom path)
    if (!customPath && cachedEvents && (now - cacheTimestamp) < CACHE_TTL_MS) {
      return cachedEvents;
    }

    const events: FailoverEvent[] = [];
    const paths = customPath ? [customPath] : FAILOVER_PATHS;

    for (const path of paths) {
      try {
        if (!existsSync(path)) continue;

        // Skip if file is older than history threshold
        const stats = statSync(path);
        if ((now - stats.mtimeMs) > HISTORY_THRESHOLD_MS * 2) continue;

        const content = readFileSync(path, 'utf-8');
        const lines = content.trim().split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const event = JSON.parse(line) as FailoverEvent;
            if (event.timestamp && event.type) {
              events.push(event);
            }
          } catch {
            // Skip malformed lines
          }
        }

        if (events.length > 0) break; // Found events, stop searching
      } catch {
        continue;
      }
    }

    // Sort by timestamp ascending
    events.sort((a, b) => a.timestamp - b.timestamp);

    // Cache result
    if (!customPath) {
      cachedEvents = events;
      cacheTimestamp = now;
    }

    return events;
  }

  /**
   * Check if there's a recent swap (within 5 minutes).
   */
  static hasRecentSwap(): boolean {
    return this.getStatus().hasRecentSwap;
  }

  /**
   * Get display notification string (or null if no recent events).
   */
  static getNotification(): string | null {
    return this.getStatus().displayNotification;
  }

  /**
   * Clear memory cache (for testing).
   */
  static clearCache(): void {
    cachedEvents = null;
    cacheTimestamp = 0;
  }
}

export default FailoverSubscriber;
