/**
 * Quota Broker Client - Single read-through cache for merged quota data
 *
 * Reads from: $CLAUDE_HS_HOME/session-health/merged-quota-cache.json
 *             (default: ~/.claude-hs/session-health/; legacy: ~/.claude/session-health/)
 * Written by: quota-broker.sh (single-flight, background refresh)
 *
 * Pattern: Instant read → trigger background refresh if stale
 * The statusline NEVER writes quota data — the broker is the sole writer.
 *
 * Fallback: If merged cache doesn't exist, caller falls back to HotSwapQuotaReader.
 *
 * Path-resolution (Apr 2026 CLAUDE_HS_HOME contract —
 *   see _claude-configs/tests/contracts/statusline-contract.md):
 *   1. $CLAUDE_HS_HOME/session-health/ if env var set (authoritative)
 *   2. ~/.claude-hs/session-health/ if directory exists (current default)
 *   3. ~/.claude/session-health/ (LEGACY; removed in v2.2)
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { spawn } from 'child_process';
import type { MergedQuotaData, MergedQuotaSlot } from '../types/session-health';
import type { SlotStatus } from './hot-swap-quota-reader';
import { validateMergedCache, readWithLkg } from './quota-schema';

// In-memory cache
let cachedData: MergedQuotaData | null = null;
let cacheTimestamp = 0;
const MEMORY_TTL = 10_000; // 10 seconds

// Stale threshold — matches broker's STALE_THRESHOLD
const STALE_THRESHOLD_S = 300; // 5 minutes

// Resolve the hot-swap session-health directory per the CLAUDE_HS_HOME contract.
// Hot-swap moved add-on state out of ~/.claude/ (statusline-owned) into ~/.claude-hs/
// to eliminate dual-ownership of the directory. Consumers honor this split via
// the env var + default, falling back to the legacy path only when neither exists.
function resolveSessionHealthDir(): string {
  const envHome = process.env.CLAUDE_HS_HOME;
  if (envHome && envHome.length > 0) {
    return `${envHome.replace(/\/+$/, '')}/session-health`;
  }
  const hsDir = `${homedir()}/.claude-hs/session-health`;
  if (existsSync(hsDir)) {
    return hsDir;
  }
  return `${homedir()}/.claude/session-health`;
}

export class QuotaBrokerClient {
  private static readonly SESSION_HEALTH_DIR = resolveSessionHealthDir();
  private static readonly CACHE_PATH = `${QuotaBrokerClient.SESSION_HEALTH_DIR}/merged-quota-cache.json`;
  private static readonly LOCK_PATH = `${QuotaBrokerClient.SESSION_HEALTH_DIR}/.quota-fetch.lock`;

  // Configurable broker script path for cloud configs migration
  // Priority: ENV var → cloud_configs → legacy _claude-configs
  private static getBrokerScript(): string {
    // 1. Environment variable (highest priority)
    if (process.env.QUOTA_BROKER_SCRIPT) {
      return process.env.QUOTA_BROKER_SCRIPT;
    }

    // 2. cloud_configs path (new standard after migration)
    const cloudConfigsPath = `${homedir()}/cloud_configs/hot-swap/scripts/quota-broker.sh`;
    if (existsSync(cloudConfigsPath)) {
      return cloudConfigsPath;
    }

    // 3. _claude-configs path (legacy, backward compat)
    return `${homedir()}/_claude-configs/hot-swap/scripts/quota-broker.sh`;
  }

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

    // Layer 2: File read with schema validation + LKG fallback
    const lkgPath = `${this.CACHE_PATH}.lkg`;
    const readResult = readWithLkg<MergedQuotaData>(this.CACHE_PATH, validateMergedCache, lkgPath);

    if (readResult.fromLkg) {
      console.error(
        `[QuotaBrokerClient] Using LKG fallback (bad read #N). isStale=true`
      );
    }

    const parsed = readResult.data;
    if (!parsed) {
      return null;
    }

    // Annotate stale flag from LKG path (merged with freshness below)
    const fromLkg = readResult.fromLkg;

    try {
      // Compute freshness of merged cache file
      const nowSeconds = Math.floor(now / 1000);
      parsed.age_seconds = Math.max(0, nowSeconds - parsed.ts);
      parsed.is_fresh = !fromLkg && parsed.age_seconds <= STALE_THRESHOLD_S;

      // CRITICAL: Also check if ANY slot data is stale
      // The merged cache `ts` can be fresh (broker ran recently) while slot data is old
      let anySlotStale = false;
      let allSlotsInactive = true;
      if (parsed.slots) {
        for (const [slotId, slot] of Object.entries(parsed.slots)) {
          // Check if slot is active
          if (slot.status !== 'inactive') {
            allSlotsInactive = false;
          }

          // Check slot data freshness — age + reset-boundary (spec §11.2)
          const slotAge = nowSeconds - Math.floor((slot.last_fetched || 0) / 1000);
          const ageStale = slotAge > STALE_THRESHOLD_S;
          const boundaryPassed = QuotaBrokerClient.resetBoundaryPassed(slot, now);

          if (ageStale || boundaryPassed) {
            anySlotStale = true;
            // Per spec §11.2: a passed five_hour_resets_at boundary with a pre-reset
            // last_fetched forces consumers to treat the row as stale, regardless of
            // last_fetched age. Mark slot.is_fresh=false so getActiveQuota's isStale
            // logic and the broker-spawn trigger both pick it up.
            if (boundaryPassed && slot.is_fresh !== false) {
              slot.is_fresh = false;
            }
            console.warn(
              `[QuotaBrokerClient] Slot ${slotId} (${slot.email}) data is stale ` +
              `(age: ${Math.floor(slotAge / 60)}min, status: ${slot.status || 'unknown'}` +
              `${boundaryPassed ? ', boundary_passed=true' : ''})`
            );
          }
        }
      }

      // CRITICAL: All accounts inactive = authentication failure
      if (allSlotsInactive && Object.keys(parsed.slots || {}).length > 0) {
        console.error(
          `[QuotaBrokerClient] ⚠️  CRITICAL: All quota accounts are INACTIVE! ` +
          `Quota data cannot be refreshed. Re-authenticate via hot-swap CLI or 'claude[N]' commands.`
        );
      }

      // Update memory cache
      cachedData = parsed;
      cacheTimestamp = now;

      // Layer 3: If merged cache OR any slot is stale, trigger background refresh
      // Skip spawn if all slots are in rate-limit backoff (avoids wasteful subprocesses)
      if ((!parsed.is_fresh || anySlotStale) && !this.isLockAlive() && !this.allSlotsInBackoff()) {
        const staleSlots = Object.entries(parsed.slots || {})
          .filter(([, s]) => {
            const age = Math.floor(now / 1000) - Math.floor((s.last_fetched || 0) / 1000);
            return age > STALE_THRESHOLD_S;
          })
          .map(([id, s]) => `${id}(${Math.floor((Math.floor(now / 1000) - Math.floor((s.last_fetched || 0) / 1000)) / 60)}min)`);
        console.error(
          `[QuotaBrokerClient] Triggering background refresh ` +
          `(merged_cache_stale=${!parsed.is_fresh}, stale_slots=[${staleSlots.join(',')}])`
        );
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
   * 0. keychainService match (most reliable for hot-swap)
   * 0.5. email match (when auth profile detected)
   * 1. configDir match (session-aware)
   * 2. active_slot from broker (last resort)
   * 3. Single slot
   * 4. Lowest-rank (best available)
   */
  static getActiveQuota(configDir?: string, keychainService?: string, authEmail?: string): {
    dailyPercentUsed: number;
    weeklyPercentUsed: number;
    weeklyBudgetRemaining: number;
    weeklyResetDay: string;
    dailyResetTime: string;
    dailyResetAt?: string;
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
    let matchStrategy: string = 'none';

    // Strategy 0: Match by keychainService (MOST RELIABLE for hot-swap)
    // When multiple accounts share ~/.claude, keychain service name uniquely identifies the account
    if (keychainService) {
      for (const [id, s] of slotEntries) {
        if (s.keychain_service && s.keychain_service === keychainService) {
          slot = s;
          matchedSlotId = id;
          matchStrategy = 'keychain_service';
          console.error(
            `[QuotaBrokerClient] ✓ Matched slot ${id} by keychainService="${keychainService}" ` +
            `(email: ${s.email}, util: ${s.seven_day_util}%)`
          );
          break;
        }
      }
    }

    // Strategy 0.5: Match by email (when auth profile was detected)
    // This is the key fix for hot-swap scenarios where all accounts share ~/.claude
    if (!slot && authEmail) {
      for (const [id, s] of slotEntries) {
        if (s.email && s.email.toLowerCase() === authEmail.toLowerCase()) {
          slot = s;
          matchedSlotId = id;
          matchStrategy = 'email';
          console.error(
            `[QuotaBrokerClient] ✓ Matched slot ${id} by authEmail="${authEmail}" ` +
            `(util: ${s.seven_day_util}%)`
          );
          break;
        }
      }
    }

    // Strategy 1: Match by configDir (works when accounts have separate config directories)
    if (!slot && configDir) {
      for (const [id, s] of slotEntries) {
        if (s.config_dir && s.config_dir === configDir) {
          slot = s;
          matchedSlotId = id;
          matchStrategy = 'config_dir';
          console.error(
            `[QuotaBrokerClient] ✓ Matched slot ${id} by configDir="${configDir}" ` +
            `(email: ${s.email}, util: ${s.seven_day_util}%)`
          );
          break;
        }
      }
    }

    // Strategy 2: active_slot from broker - REMOVED (unreliable)
    // This fallback was causing wrong quota data in multi-account scenarios.
    // Better to return null and force explicit matching than to show wrong data.
    // OLD CODE: Used data.active_slot when keychain/email/configDir didn't match

    // Strategy 3: Single slot
    if (!slot && slotEntries.length === 1) {
      slot = slotEntries[0][1];
      matchedSlotId = slotEntries[0][0];
      matchStrategy = 'single_slot';
    }

    // Strategy 4: Lowest rank (best available, skip inactive)
    if (!slot) {
      let bestRank = Infinity;
      for (const [id, s] of slotEntries) {
        if (s.status !== 'inactive' && s.rank < bestRank) {
          bestRank = s.rank;
          slot = s;
          matchedSlotId = id;
          matchStrategy = 'lowest_rank';
        }
      }
    }

    if (!slot) {
      console.error(
        `[QuotaBrokerClient] ❌ NO MATCH FOUND for quota slot. ` +
        `keychainService="${keychainService}", ` +
        `authEmail="${authEmail}", ` +
        `configDir="${configDir}". ` +
        `Available slots: ${slotEntries.map(([id, s]) => `${id}(${s.email})`).join(', ')}. ` +
        `This indicates a configuration mismatch - broker data doesn't match current session.`
      );
      return null;
    }

    // Log final match result (all strategies)
    if (matchStrategy !== 'keychain_service' && matchStrategy !== 'email' && matchStrategy !== 'config_dir') {
      // Strategies 0/0.5/1 already log individually above
      console.error(
        `[QuotaBrokerClient] ✓ Matched slot ${matchedSlotId} by ${matchStrategy} ` +
        `(email: ${slot.email}, util: ${slot.seven_day_util}%)`
      );
    }

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
      dailyResetAt: slot.five_hour_resets_at || undefined,
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

    // Rich format: S3|email|⌛:Xh(Y%)|📅:Zh(W%)@Day
    const slotMatch = data.recommended_slot.match(/slot-(\d+)/);
    const slotNum = slotMatch ? slotMatch[1] : '?';
    const pct5h = Math.round(recommended.five_hour_util || 0);
    const h5 = Math.floor(((100 - pct5h) / 100) * 5);
    const m5 = Math.round((((100 - pct5h) / 100) * 5 - h5) * 60);
    const dailyBudget = m5 > 0 ? `${h5}h${m5}m(${pct5h}%)` : `${h5}h(${pct5h}%)`;
    const resetDay = recommended.weekly_reset_day || '';
    const weeklyQuota = resetDay
      ? `${budgetHours}h(${weeklyUtil}%)@${resetDay}`
      : `${budgetHours}h(${weeklyUtil}%)`;

    return `Switch to S${slotNum}|${email}|⌛:${dailyBudget}|📅:${weeklyQuota}`;
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
   * Reset-boundary freshness check — spec §11.2 (07_quota-pipeline.md).
   *
   * Returns true when an ACTIVE slot's `five_hour_resets_at` moment has
   * already passed but `last_fetched` still reflects pre-reset utilization.
   * Such a row is effectively stale: the cache says "98% used" but the new
   * 5h window has reset to 0%. Force-refresh is mandatory.
   *
   * Mirrors the broker's `_reset_boundary_passed` helper covered by T12a-T12f
   * fixtures in `_claude-configs/tests/unit/test-quota-broker.sh`.
   *
   * Thrash guard: if last_fetched ≥ reset moment, a post-reset fetch already
   * happened — return false so we don't keep re-staling a freshly-refreshed row.
   *
   * Inactive slots are ignored (status !== "active" → false).
   * Millisecond-epoch `last_fetched` (>1e12) is normalized to seconds.
   */
  private static resetBoundaryPassed(slot: MergedQuotaSlot, nowMs: number): boolean {
    if ((slot.status || '') !== 'active') return false;
    const resetIso = slot.five_hour_resets_at;
    if (!resetIso) return false;
    const resetMs = Date.parse(resetIso);
    if (isNaN(resetMs)) return false;
    if (resetMs > nowMs) return false; // reset still in future
    const lf = slot.last_fetched;
    if (lf == null) return false;
    const lfMs = lf > 1_000_000_000_000 ? lf : lf * 1000;
    return lfMs < resetMs;
  }

  /**
   * Check if ALL active slots are in rate-limit backoff.
   * When true, spawning the broker is wasteful — the API won't serve us.
   * Reads per-slot backoff state files written by fetch-quotas.sh.
   */
  private static allSlotsInBackoff(): boolean {
    try {
      const { readdirSync } = require('fs') as typeof import('fs');
      const stateDir = QuotaBrokerClient.SESSION_HEALTH_DIR;
      const files = readdirSync(stateDir).filter(f => f.startsWith('.fetch-rate-limit-state.'));
      if (files.length === 0) return false; // No backoff files = not backed off

      const nowEpoch = Math.floor(Date.now() / 1000);
      let sawCleanFile = false;
      for (const file of files) {
        try {
          const content = readFileSync(`${stateDir}/${file}`, 'utf-8');
          const state = JSON.parse(content);
          const backoffUntil = state.backoff_until_epoch || 0;
          sawCleanFile = true;
          if (backoffUntil <= nowEpoch) return false; // At least one slot's backoff expired
        } catch {
          // Corrupt state — fail CLOSED (don't assume clear). Skip this file; if
          // any OTHER slot has a readable cleared backoff we still return false.
          // If every file is corrupt or backed off we err on the side of NOT
          // spawning the broker to avoid extending a ban on guesswork.
          continue;
        }
      }
      // No readable file cleared backoff. If we never saw a parsable file,
      // treat as "state unknown → fail closed" so we don't blindly spawn.
      return sawCleanFile; // true = at least one slot readable + still in backoff
    } catch {
      return false;
    }
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
   * Spawn broker script in background with error detection
   * Only called when data is stale AND no lock is alive
   */
  private static spawnBroker(): void {
    try {
      const brokerScript = this.getBrokerScript();

      if (!existsSync(brokerScript)) {
        console.warn(
          `[QuotaBrokerClient] Broker script not found at ${brokerScript}. ` +
          `Checked: ENV:QUOTA_BROKER_SCRIPT, ~/cloud_configs/, ~/_claude-configs/`
        );
        return;
      }

      // Layer 5: Wrap with 45s timeout to prevent infinite hangs on API calls
      // timeout -k sends SIGKILL after 5s grace period if SIGTERM is ignored
      const child = spawn('timeout', ['-k', '5', '45', 'bash', brokerScript], {
        detached: true,
        stdio: ['ignore', 'ignore', 'pipe']  // Capture stderr for error detection
      });

      // Capture stderr to detect silent failures (OAuth expiry, script errors)
      // Cap at 10KB to prevent unbounded memory growth if broker fails verbosely
      if (child.stderr) {
        let stderrData = '';
        const MAX_STDERR = 10 * 1024;
        child.stderr.on('data', (data) => {
          if (stderrData.length < MAX_STDERR) {
            stderrData += data.toString();
            if (stderrData.length > MAX_STDERR) {
              stderrData = stderrData.substring(0, MAX_STDERR);
              child.stderr?.removeAllListeners('data');
            }
          }
        });

        child.on('exit', (code) => {
          if (code !== 0 && stderrData) {
            console.error(
              `[QuotaBrokerClient] Broker script failed (exit ${code}): ${stderrData.trim().substring(0, 200)}`
            );
          }
        });
      }

      child.unref();
    } catch (error) {
      // Non-critical — broker spawn failed, data stays stale
      console.warn(`[QuotaBrokerClient] Failed to spawn broker:`, error);
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
