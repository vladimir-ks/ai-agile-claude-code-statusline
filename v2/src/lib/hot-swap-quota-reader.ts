/**
 * Hot-Swap Quota Reader - Reads shared quota cache from hot-swap system
 *
 * The hot-swap system maintains fresh quota data at:
 * ~/.claude/session-health/hot-swap-quota.json
 *
 * This is the PRIMARY source for weekly/daily quotas because:
 * 1. Hot-swap auto-refreshes OAuth tokens
 * 2. Data is shared across all systems (hot-swap + statusline)
 * 3. Reduces duplicate API calls
 *
 * Active slot detection:
 * - Reads claude-sessions.yaml → active_account field (authoritative)
 * - No keychain access needed — the hot-swap system tracks active slot
 *
 * Cache structure:
 * {
 *   "slot-1": {
 *     "email": "user@example.com",
 *     "five_hour_util": 64,
 *     "seven_day_util": 98,
 *     "weekly_budget_remaining_hours": 97,
 *     "weekly_reset_day": "Thu",
 *     "daily_reset_time": "17:00",
 *     "last_fetched": 1769961225000,
 *     "is_fresh": true
 *   }
 * }
 */

import { existsSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { homedir } from 'os';

export interface HotSwapSlotData {
  email: string;
  five_hour_util: number;           // Daily budget % used (0-100)
  seven_day_util: number;           // Weekly quota % used (0-100)
  five_hour_resets_at?: string;     // ISO 8601 timestamp
  seven_day_resets_at?: string;     // ISO 8601 timestamp
  weekly_budget_remaining_hours: number;
  weekly_reset_day: string;         // "Mon", "Tue", etc.
  daily_reset_time: string;         // "17:00" UTC
  last_fetched: number;             // Unix timestamp ms
  is_fresh: boolean;
  config_dir?: string;              // CLAUDE_CONFIG_DIR for this slot
  keychain_hash?: string;           // SHA256 hash prefix for keychain service
}

export type SlotStatus = 'active' | 'inactive' | 'unknown';

export interface HotSwapQuotaCache {
  [slotId: string]: HotSwapSlotData;
}

// Cache freshness threshold (2 minutes)
const CACHE_FRESH_MS = 120000;

// In-memory cache for quota data
let cachedData: HotSwapQuotaCache | null = null;
let cacheTimestamp = 0;
const MEMORY_CACHE_TTL = 30000; // 30 seconds

// In-memory cache for active slot (from claude-sessions.yaml)
let cachedActiveSlot: string | null = null;
let activeSlotCacheTimestamp = 0;
const ACTIVE_SLOT_CACHE_TTL = 60000; // 60 seconds

// In-memory cache for slot statuses (from claude-sessions.yaml)
let cachedSlotStatuses: Map<string, SlotStatus> | null = null;
let slotStatusesCacheTimestamp = 0;
const SLOT_STATUSES_CACHE_TTL = 60000; // 60 seconds

// Discoverable paths for claude-sessions.yaml
// The hot-swap system stores its registry here
const HOT_SWAP_SESSIONS_PATHS = [
  `${homedir()}/_claude-configs/hot-swap/claude-sessions.yaml`,
  `${homedir()}/.claude/hot-swap/claude-sessions.yaml`,
  `${homedir()}/.claude/config/claude-sessions.yaml`,
];

export class HotSwapQuotaReader {
  private static readonly CACHE_PATH = `${homedir()}/.claude/session-health/hot-swap-quota.json`;

  /**
   * Read hot-swap quota cache (with memory caching)
   */
  static read(): HotSwapQuotaCache | null {
    const now = Date.now();

    // Return memory cache if fresh
    if (cachedData && (now - cacheTimestamp) < MEMORY_CACHE_TTL) {
      return cachedData;
    }

    // Read from file
    try {
      if (!existsSync(this.CACHE_PATH)) {
        return null;
      }

      const content = readFileSync(this.CACHE_PATH, 'utf-8');
      cachedData = JSON.parse(content);
      cacheTimestamp = now;

      return cachedData;
    } catch {
      return null;
    }
  }

  /**
   * Get quota data for a specific slot by email (case-insensitive)
   */
  static getSlotByEmail(email: string): HotSwapSlotData | null {
    const cache = this.read();
    if (!cache) return null;

    const emailLower = email.toLowerCase();
    for (const slotData of Object.values(cache)) {
      if (slotData.email.toLowerCase() === emailLower) {
        return slotData;
      }
    }

    return null;
  }

  /**
   * Get quota data for a specific slot by slot ID
   */
  static getSlotById(slotId: string): HotSwapSlotData | null {
    const cache = this.read();
    if (!cache) return null;

    return cache[slotId] || null;
  }

  /**
   * Get slot data by config_dir (exact match)
   * Used to map a session's CLAUDE_CONFIG_DIR to its slot
   */
  static getSlotByConfigDir(configDir: string): (HotSwapSlotData & { slotId: string }) | null {
    const cache = this.read();
    if (!cache) return null;

    for (const [slotId, slotData] of Object.entries(cache)) {
      if (slotData.config_dir && slotData.config_dir === configDir) {
        return { ...slotData, slotId };
      }
    }

    // Fallback: check claude-sessions.yaml accounts for config_dir match
    for (const sessionsPath of HOT_SWAP_SESSIONS_PATHS) {
      try {
        if (!existsSync(sessionsPath)) continue;
        const content = readFileSync(sessionsPath, 'utf-8');

        // Match config_dir lines under accounts section
        // Format: "    config_dir: /path/to/dir" (indented under slot)
        const slotRegex = /^\s{2}(slot-\d+):\s*$/gm;
        const configDirRegex = /^\s{4}config_dir:\s*(.+)$/gm;
        const emailRegex = /^\s{4}email:\s*(.+)$/gm;

        let slotMatch;
        while ((slotMatch = slotRegex.exec(content)) !== null) {
          const slotId = slotMatch[1];
          const slotStart = slotMatch.index;
          // Find the next slot or end of accounts section
          const nextSlotIdx = content.indexOf(`  slot-`, slotStart + slotMatch[0].length);
          const slotSection = nextSlotIdx > 0
            ? content.substring(slotStart, nextSlotIdx)
            : content.substring(slotStart);

          const dirMatch = slotSection.match(/config_dir:\s*(.+)/);
          const emailMatch = slotSection.match(/email:\s*(.+)/);

          if (dirMatch && dirMatch[1].trim() === configDir && emailMatch) {
            // Found matching slot in sessions.yaml — return with email
            const matchedSlotData = cache[slotId];
            if (matchedSlotData) {
              return { ...matchedSlotData, slotId };
            }
            // Slot exists in yaml but not in quota cache — return minimal data
            return {
              email: emailMatch[1].trim(),
              five_hour_util: 0,
              seven_day_util: 0,
              weekly_budget_remaining_hours: 0,
              weekly_reset_day: '',
              daily_reset_time: '',
              last_fetched: 0,
              is_fresh: false,
              config_dir: configDir,
              slotId
            };
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Get the status of a slot from claude-sessions.yaml
   * Returns 'active', 'inactive', or 'unknown'
   */
  static getSlotStatus(slotId: string): SlotStatus {
    const statuses = this.getAllSlotStatuses();
    return statuses.get(slotId) || 'unknown';
  }

  /**
   * Read all slot statuses from claude-sessions.yaml (cached)
   */
  static getAllSlotStatuses(): Map<string, SlotStatus> {
    const now = Date.now();
    if (cachedSlotStatuses && (now - slotStatusesCacheTimestamp) < SLOT_STATUSES_CACHE_TTL) {
      return cachedSlotStatuses;
    }

    const statuses = new Map<string, SlotStatus>();

    for (const sessionsPath of HOT_SWAP_SESSIONS_PATHS) {
      try {
        if (!existsSync(sessionsPath)) continue;
        const content = readFileSync(sessionsPath, 'utf-8');

        // Parse slot statuses with regex (lightweight, no yaml dep)
        // Match: "  slot-N:" followed by "    status: active|inactive"
        const slotRegex = /^\s{2}(slot-\d+):\s*$/gm;
        let match;
        while ((match = slotRegex.exec(content)) !== null) {
          const slotId = match[1];
          const slotStart = match.index;
          const nextSlotIdx = content.indexOf('  slot-', slotStart + match[0].length);
          const slotSection = nextSlotIdx > 0
            ? content.substring(slotStart, nextSlotIdx)
            : content.substring(slotStart);

          const statusMatch = slotSection.match(/status:\s*(active|inactive)/);
          if (statusMatch) {
            statuses.set(slotId, statusMatch[1] as SlotStatus);
          }
        }

        if (statuses.size > 0) break; // Found data, stop searching paths
      } catch {
        continue;
      }
    }

    cachedSlotStatuses = statuses;
    slotStatusesCacheTimestamp = now;
    return statuses;
  }

  /**
   * Get the freshest slot (most recently fetched)
   * Fallback when active slot detection fails
   */
  static getFreshestSlot(): { slotId: string; data: HotSwapSlotData } | null {
    const cache = this.read();
    if (!cache) return null;

    let freshest: { slotId: string; data: HotSwapSlotData } | null = null;
    let maxTimestamp = 0;

    for (const [slotId, slotData] of Object.entries(cache)) {
      if (slotData.last_fetched > maxTimestamp && slotData.is_fresh) {
        maxTimestamp = slotData.last_fetched;
        freshest = { slotId, data: slotData };
      }
    }

    return freshest;
  }

  /**
   * Get quota for the ACTIVE slot
   *
   * Detection priority:
   * 1. configDir match (session-aware - matches slot by CLAUDE_CONFIG_DIR)
   * 2. claude-sessions.yaml → active_account (authoritative, no keychain needed)
   * 3. Single slot → use it
   * 4. Freshest slot (fallback)
   *
   * @param configDir - CLAUDE_CONFIG_DIR derived from transcript path (session-aware)
   * @returns Quota data with staleness info
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
    source: 'hot-swap';
  } | null {
    const cache = this.read();
    if (!cache) return null;

    let slot: HotSwapSlotData | null = null;
    let matchedSlotId: string | undefined;

    // Strategy 1: Match by configDir (session-aware, highest priority)
    // Uses getSlotByConfigDir which also checks claude-sessions.yaml as fallback
    // NOTE: configDir match always wins — even if slot is inactive, this session
    // IS running under that slot's config and the data is still meaningful
    if (configDir) {
      const matched = this.getSlotByConfigDir(configDir);
      if (matched) {
        slot = matched;
        matchedSlotId = matched.slotId;
      }
    }

    // Strategy 2: Read active_account from claude-sessions.yaml
    if (!slot) {
      const activeSlotId = this.getActiveSlotFromRegistry();
      if (activeSlotId && cache[activeSlotId]) {
        slot = cache[activeSlotId];
        matchedSlotId = activeSlotId;
      }
    }

    // Strategy 3: Single slot — use it (regardless of status, it's the only option)
    if (!slot) {
      const slots = Object.entries(cache);
      if (slots.length === 1) {
        slot = slots[0][1];
        matchedSlotId = slots[0][0];
      }
    }

    // Strategy 4: Freshest ACTIVE slot (skip inactive when falling back)
    if (!slot) {
      const freshest = this.getFreshestSlot();
      if (freshest) {
        const status = this.getSlotStatus(freshest.slotId);
        if (status !== 'inactive') {
          slot = freshest.data;
          matchedSlotId = freshest.slotId;
        }
      }
    }

    if (!slot) return null;

    // Check if data is stale (> 2 minutes old)
    const ageMs = Date.now() - slot.last_fetched;
    const isStale = ageMs > CACHE_FRESH_MS || !slot.is_fresh;

    // Get slot status from registry
    const slotStatus = matchedSlotId ? this.getSlotStatus(matchedSlotId) : 'unknown';

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
      slotStatus,
      source: 'hot-swap'
    };
  }

  /**
   * Read active_account from claude-sessions.yaml
   *
   * The hot-swap system maintains this file with an `active_account` field
   * that is updated every time a swap occurs. This is the authoritative
   * source for which slot is currently active.
   *
   * Uses a lightweight YAML parser (regex) to avoid requiring the yaml package.
   */
  private static getActiveSlotFromRegistry(): string | null {
    const now = Date.now();

    // Return memory cache if fresh
    if (cachedActiveSlot && (now - activeSlotCacheTimestamp) < ACTIVE_SLOT_CACHE_TTL) {
      return cachedActiveSlot;
    }

    // Try each known path for claude-sessions.yaml
    for (const sessionsPath of HOT_SWAP_SESSIONS_PATHS) {
      try {
        if (!existsSync(sessionsPath)) continue;

        const content = readFileSync(sessionsPath, 'utf-8');

        // Lightweight parse: extract active_account value
        // Format: "active_account: slot-2" (top-level YAML key)
        const match = content.match(/^active_account:\s*(.+)$/m);
        if (match) {
          const activeSlot = match[1].trim();
          if (activeSlot && activeSlot !== 'null' && activeSlot !== '~') {
            cachedActiveSlot = activeSlot;
            activeSlotCacheTimestamp = now;
            return activeSlot;
          }
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * Check if hot-swap cache file exists and is recent
   */
  static isAvailable(): boolean {
    try {
      if (!existsSync(this.CACHE_PATH)) {
        return false;
      }

      const stats = statSync(this.CACHE_PATH);
      const ageMs = Date.now() - stats.mtimeMs;

      // Consider available if file exists and < 10 minutes old
      return ageMs < 600000;
    } catch {
      return false;
    }
  }

  /**
   * Update hot-swap-quota.json with fresh data from OAuth API.
   * Called by data-gatherer when quota is stale and OAuth fetch succeeds.
   *
   * Atomic write (temp + rename) to prevent corruption from concurrent daemons.
   */
  static updateFromOAuth(slotId: string | undefined, quotaBilling: {
    budgetPercentUsed?: number;
    weeklyBudgetPercentUsed?: number;
    weeklyBudgetRemaining?: number;
    weeklyResetDay?: string;
  }): void {
    if (!slotId) return;

    try {
      // Read existing cache
      let cache: HotSwapQuotaCache = {};
      try {
        if (existsSync(this.CACHE_PATH)) {
          cache = JSON.parse(readFileSync(this.CACHE_PATH, 'utf-8')) || {};
        }
      } catch { /* start fresh */ }

      // Merge OAuth fields into slot entry (preserve existing fields)
      const existing = cache[slotId] || {} as Partial<HotSwapSlotData>;
      cache[slotId] = {
        ...existing,
        five_hour_util: quotaBilling.budgetPercentUsed ?? existing.five_hour_util ?? 0,
        seven_day_util: quotaBilling.weeklyBudgetPercentUsed ?? existing.seven_day_util ?? 0,
        weekly_budget_remaining_hours: quotaBilling.weeklyBudgetRemaining ?? existing.weekly_budget_remaining_hours ?? 0,
        weekly_reset_day: quotaBilling.weeklyResetDay ?? existing.weekly_reset_day ?? '',
        daily_reset_time: existing.daily_reset_time ?? '',
        email: existing.email ?? '',
        last_fetched: Date.now(),
        is_fresh: true,
      } as HotSwapSlotData;

      // Ensure parent directory exists
      const dir = dirname(this.CACHE_PATH);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      // Atomic write: temp file + rename
      const tmpPath = `${this.CACHE_PATH}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(cache, null, 2), { mode: 0o600 });
      renameSync(tmpPath, this.CACHE_PATH);

      // Invalidate memory cache so next read() picks up fresh data
      cachedData = null;
      cacheTimestamp = 0;
    } catch {
      // Non-critical — log but don't throw
      console.error('[HotSwapQuotaReader] Failed to update from OAuth');
    }
  }

  /**
   * Clear memory cache (for testing)
   */
  static clearCache(): void {
    cachedData = null;
    cacheTimestamp = 0;
    cachedActiveSlot = null;
    activeSlotCacheTimestamp = 0;
    cachedSlotStatuses = null;
    slotStatusesCacheTimestamp = 0;
  }
}

export default HotSwapQuotaReader;
