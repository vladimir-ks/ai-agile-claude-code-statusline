/**
 * Slot Recommendation Reader - Reads slot rankings from hot-swap system
 *
 * Source: ~/.claude/session-health/slot-recommendation.json
 * Updated by: select-account.sh (single writer, atomic writes)
 * Frequency: Every launch + every health check (~5min)
 *
 * Schema v1.1 (41 contract tests in hot-swap repo)
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { homedir } from 'os';
import type { SlotRecommendation, SlotRanking } from '../types/session-health';

// In-memory cache
let cachedRecommendation: SlotRecommendation | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60000; // 1 minute (same as HotSwapQuotaReader)

export class SlotRecommendationReader {
  private static readonly RECOMMENDATION_PATH = `${homedir()}/.claude/session-health/slot-recommendation.json`;
  private static readonly STALENESS_THRESHOLD = 15 * 60 * 1000; // 15 minutes

  /**
   * Read slot recommendation data (with caching)
   * Returns null if file missing or corrupted
   */
  static read(): SlotRecommendation | null {
    const now = Date.now();

    // Return cached data if fresh
    if (cachedRecommendation && (now - cacheTimestamp) < CACHE_TTL) {
      return cachedRecommendation;
    }

    // Read from file
    try {
      if (!existsSync(this.RECOMMENDATION_PATH)) {
        return null;
      }

      const content = readFileSync(this.RECOMMENDATION_PATH, 'utf-8');
      const parsed = JSON.parse(content);

      // Validate schema (defensive)
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      if (!parsed.recommended || !Array.isArray(parsed.rankings)) {
        return null;
      }

      cachedRecommendation = parsed as SlotRecommendation;
      cacheTimestamp = now;

      return cachedRecommendation;
    } catch {
      // Corrupted JSON or read error
      return null;
    }
  }

  /**
   * Get recommended slot ID
   * Returns "none" if no recommendation, null if file missing
   */
  static getRecommendedSlot(): string | null {
    const data = this.read();
    return data?.recommended || null;
  }

  /**
   * Get all slot rankings (sorted by rank ascending)
   * Returns empty array if file missing or no rankings
   */
  static getRankings(): SlotRanking[] {
    const data = this.read();
    return data?.rankings || [];
  }

  /**
   * Get specific slot's ranking info
   * Returns null if slot not found
   */
  static getSlotRanking(slotId: string): SlotRanking | null {
    const rankings = this.getRankings();
    return rankings.find(r => r.slot === slotId) || null;
  }

  /**
   * Check if recommendation data is stale (>15min old)
   * Returns true if stale, missing, or timestamp invalid
   */
  static isStale(): boolean {
    try {
      if (!existsSync(this.RECOMMENDATION_PATH)) {
        return true;
      }

      const stats = statSync(this.RECOMMENDATION_PATH);
      const ageMs = Date.now() - stats.mtimeMs;

      return ageMs > this.STALENESS_THRESHOLD;
    } catch {
      return true;
    }
  }

  /**
   * Get age of recommendation data in ms
   * Returns null if file missing
   */
  static getAge(): number | null {
    try {
      if (!existsSync(this.RECOMMENDATION_PATH)) {
        return null;
      }

      const stats = statSync(this.RECOMMENDATION_PATH);
      return Date.now() - stats.mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Check if failover is needed (all slots exhausted)
   */
  static isFailoverNeeded(): boolean {
    const data = this.read();
    return data?.failover_needed || false;
  }

  /**
   * Check if all slots are exhausted
   */
  static areAllSlotsExhausted(): boolean {
    const data = this.read();
    return data?.all_exhausted || false;
  }

  /**
   * Compare session slot vs recommended slot
   * Returns true if session should switch slots
   */
  static shouldSwitchSlot(currentSlotId: string): boolean {
    const recommended = this.getRecommendedSlot();

    // No recommendation = don't switch
    if (!recommended || recommended === 'none') {
      return false;
    }

    // Current slot matches recommended = don't switch
    if (currentSlotId === recommended) {
      return false;
    }

    // Recommended slot is different = should switch
    return true;
  }

  /**
   * Get switch recommendation message
   * Returns null if no switch recommended
   */
  static getSwitchMessage(currentSlotId: string): string | null {
    if (!this.shouldSwitchSlot(currentSlotId)) {
      return null;
    }

    const recommended = this.getRecommendedSlot();
    const recommendedRanking = this.getSlotRanking(recommended!);
    const currentRanking = this.getSlotRanking(currentSlotId);

    if (!recommendedRanking) {
      return null;
    }

    // Build message: "Switch to slot-3 (rank 1, urgency: 538)"
    let msg = `Switch to ${recommended} (rank ${recommendedRanking.rank}`;

    if (recommendedRanking.urgency) {
      msg += `, urgency: ${recommendedRanking.urgency}`;
    }

    if (currentRanking) {
      msg += ` | current: rank ${currentRanking.rank}`;
    }

    msg += ')';

    return msg;
  }

  /**
   * Clear cache (for testing or force refresh)
   */
  static clearCache(): void {
    cachedRecommendation = null;
    cacheTimestamp = 0;
  }
}

export default SlotRecommendationReader;
