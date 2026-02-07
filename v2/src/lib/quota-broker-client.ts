/**
 * Quota Broker Client - Single read-through cache for merged quota data
 *
 * Reads from: ~/.claude/session-health/merged-quota-cache.json
 * Written by: quota-broker.sh (single-flight, background refresh)
 *
 * Pattern: Instant read → trigger background refresh if stale
 * The statusline NEVER writes quota data — the broker is the sole writer.
 *
 * Fallback: If merged cache doesn't exist, caller falls back to HotSwapQuotaReader.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { spawn } from 'child_process';
import type { MergedQuotaData, MergedQuotaSlot } from '../types/session-health';
import type { SlotStatus } from './hot-swap-quota-reader';

// In-memory cache
let cachedData: MergedQuotaData | null = null;
let cacheTimestamp = 0;
const MEMORY_TTL = 10_000; // 10 seconds

// Stale threshold — matches broker's STALE_THRESHOLD
const STALE_THRESHOLD_S = 300; // 5 minutes

export class QuotaBrokerClient {
  private static readonly CACHE_PATH = `${homedir()}/.claude/session-health/merged-quota-cache.json`;
  private static readonly LOCK_PATH = `${homedir()}/.claude/session-health/.quota-fetch.lock`;
  private static readonly BROKER_SCRIPT = `${homedir()}/_claude-configs/hot-swap/scripts/quota-broker.sh`;

  /**
   * Read merged quota data (with memory caching)
   *
   * Layer 1: In-memory cache (10s TTL)
   * Layer 2: File read (merged-quota-cache.json)
   * Layer 3: If stale, spawn broker in background (fire-and-forget)
   */
  static read(): MergedQuotaData | null {
    const now = Date.now();

    // Layer 1: Memory cache
    if (cachedData && (now - cacheTimestamp) < MEMORY_TTL) {
      return cachedData;
    }

    // Layer 2: File read
    try {
      if (!existsSync(this.CACHE_PATH)) {
        return null;
      }

      const content = readFileSync(this.CACHE_PATH, 'utf-8');
      const parsed = JSON.parse(content) as MergedQuotaData;

      // Validate minimal schema
      if (!parsed || typeof parsed.ts !== 'number' || !parsed.slots) {
        return null;
      }

      // Compute freshness
      const nowSeconds = Math.floor(now / 1000);
      parsed.age_seconds = Math.max(0, nowSeconds - parsed.ts);
      parsed.is_fresh = parsed.age_seconds <= STALE_THRESHOLD_S;

      // Update memory cache
      cachedData = parsed;
      cacheTimestamp = now;

      // Layer 3: If stale, trigger background refresh
      if (!parsed.is_fresh && !this.isLockAlive()) {
        this.spawnBroker();
      }

      return parsed;
    } catch {
      return null;
    }
  }

  /**
   * Check if merged cache file exists
   */
  static isAvailable(): boolean {
    try {
      return existsSync(this.CACHE_PATH);
    } catch {
      return false;
    }
  }

  /**
   * Get quota for the active slot (broker-aware)
   *
   * Detection priority:
   * 1. configDir match (session-aware)
   * 2. active_slot from broker
   * 3. Single slot
   * 4. Lowest-rank (best available)
   */
  static getActiveQuota(configDir?: string): {
    dailyPercentUsed: number;
    weeklyPercentUsed: number;
    weeklyBudgetRemaining: number;
    weeklyResetDay: string;
    dailyResetTime: string;
    lastFetched: number;
    isStale: boolean;
    slotId?: string;
    email?: string;
    slotStatus?: SlotStatus;
    source: 'broker';
  } | null {
    const data = this.read();
    if (!data || !data.slots) return null;

    const slotEntries = Object.entries(data.slots);
    if (slotEntries.length === 0) return null;

    let matchedSlotId: string | undefined;
    let slot: MergedQuotaSlot | null = null;

    // Strategy 1: Match by configDir
    if (configDir) {
      for (const [id, s] of slotEntries) {
        if (s.config_dir && s.config_dir === configDir) {
          slot = s;
          matchedSlotId = id;
          break;
        }
      }
    }

    // Strategy 2: active_slot from broker
    if (!slot && data.active_slot && data.slots[data.active_slot]) {
      slot = data.slots[data.active_slot];
      matchedSlotId = data.active_slot;
    }

    // Strategy 3: Single slot
    if (!slot && slotEntries.length === 1) {
      slot = slotEntries[0][1];
      matchedSlotId = slotEntries[0][0];
    }

    // Strategy 4: Lowest rank (best available, skip inactive)
    if (!slot) {
      let bestRank = Infinity;
      for (const [id, s] of slotEntries) {
        if (s.status !== 'inactive' && s.rank < bestRank) {
          bestRank = s.rank;
          slot = s;
          matchedSlotId = id;
        }
      }
    }

    if (!slot) return null;

    // CRITICAL: Don't trust is_fresh field alone - validate actual data age
    // Defense against broker bugs where is_fresh=true but data is hours old
    const WEEKLY_QUOTA_FRESH_THRESHOLD = 300_000; // 5 minutes (matches FreshnessManager)
    const dataAge = Date.now() - (slot.last_fetched || 0);
    const actuallyStale = dataAge > WEEKLY_QUOTA_FRESH_THRESHOLD;

    // isStale is TRUE if:
    // 1. Broker says it's not fresh (data.is_fresh === false OR slot.is_fresh === false)
    // 2. OR actual age exceeds threshold (defense against broker data corruption)
    const isStale = data.is_fresh === false || !slot.is_fresh || actuallyStale;

    // Log warning if broker data contradicts actual age
    if (!actuallyStale && (data.is_fresh === false || !slot.is_fresh)) {
      // Broker says stale but data is actually fresh - unusual but not critical
    } else if (actuallyStale && slot.is_fresh !== false) {
      // CRITICAL: Broker says fresh but data is actually stale
      console.error(
        `[QuotaBrokerClient] WARNING: Broker data corruption detected for ${matchedSlotId}. ` +
        `is_fresh=${slot.is_fresh} but data age is ${Math.floor(dataAge / 60000)}min. Forcing isStale=true.`
      );
    }

    return {
      dailyPercentUsed: slot.five_hour_util,
      weeklyPercentUsed: slot.seven_day_util,
      weeklyBudgetRemaining: slot.weekly_budget_remaining_hours,
      weeklyResetDay: slot.weekly_reset_day,
      dailyResetTime: slot.daily_reset_time,
      lastFetched: slot.last_fetched,
      isStale,
      slotId: matchedSlotId,
      email: slot.email,
      slotStatus: (slot.status as SlotStatus) || 'unknown',
      source: 'broker'
    };
  }

  /**
   * Get slot status from merged cache
   */
  static getSlotStatus(slotId: string): SlotStatus {
    const data = this.read();
    if (!data || !data.slots[slotId]) return 'unknown';
    return (data.slots[slotId].status as SlotStatus) || 'unknown';
  }

  /**
   * Get switch recommendation message
   * Returns null if current slot IS the recommended slot
   */
  static getSwitchMessage(currentSlotId: string): string | null {
    const data = this.read();
    if (!data) return null;

    // No switch needed
    if (!data.recommended_slot || data.recommended_slot === currentSlotId || data.recommended_slot === 'none') {
      return null;
    }

    const recommended = data.slots[data.recommended_slot];
    if (!recommended) return null;

    // Build message
    const budgetHours = recommended.weekly_budget_remaining_hours;
    const email = recommended.email;
    const subType = recommended.subscription_type || '';
    const weeklyUtil = recommended.seven_day_util;

    return `Switch to ${data.recommended_slot} (${email}, ${subType}, ${weeklyUtil}% used, ${budgetHours}h budget)`;
  }

  /**
   * Get slot data by config_dir
   */
  static getSlotByConfigDir(configDir: string): (MergedQuotaSlot & { slotId: string }) | null {
    const data = this.read();
    if (!data || !data.slots) return null;

    for (const [slotId, slot] of Object.entries(data.slots)) {
      if (slot.config_dir && slot.config_dir === configDir) {
        return { ...slot, slotId };
      }
    }

    return null;
  }

  /**
   * Check if fetch lock file is alive (PID-based)
   */
  private static isLockAlive(): boolean {
    try {
      if (!existsSync(this.LOCK_PATH)) return false;
      const content = readFileSync(this.LOCK_PATH, 'utf-8').trim();
      const pid = parseInt(content, 10);
      if (isNaN(pid) || pid <= 0) return false;
      process.kill(pid, 0); // Throws if process dead
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Spawn broker script in background (fire-and-forget)
   * Only called when data is stale AND no lock is alive
   */
  private static spawnBroker(): void {
    try {
      if (!existsSync(this.BROKER_SCRIPT)) return;

      const child = spawn('bash', [this.BROKER_SCRIPT], {
        detached: true,
        stdio: 'ignore'
      });
      child.unref();
    } catch {
      // Non-critical — broker spawn failed, data stays stale
    }
  }

  /**
   * Clear in-memory cache (for testing)
   */
  static clearCache(): void {
    cachedData = null;
    cacheTimestamp = 0;
  }
}

export default QuotaBrokerClient;
