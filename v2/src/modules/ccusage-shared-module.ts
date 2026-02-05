/**
 * Shared ccusage Module - Single Source for Cost/Budget/Usage
 *
 * CRITICAL: This module is called ONCE and provides data for:
 * - CostModule (💰)
 * - BudgetModule (⌛)
 * - UsageModule (📊)
 *
 * ARCHITECTURE:
 * 1. Check shared cache - if fresh (<2min), return it
 * 2. If stale, acquire lock and fetch from ccusage
 * 3. Write to shared cache for other sessions
 *
 * NO COOLDOWN GATE - freshness is determined by cache timestamp only!
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';
import type { ValidationResult } from '../types/validation';
import { promisify } from 'util';
import { exec } from 'child_process';
import { existsSync, readFileSync, writeFileSync, renameSync } from 'fs';
import { homedir } from 'os';
import ProcessLock from '../lib/process-lock';
import { FreshnessManager } from '../lib/freshness-manager';

const execAsync = promisify(exec);

// Shared cache path - ALL sessions read/write here
const SHARED_CACHE_PATH = `${homedir()}/.claude/session-health/billing-shared.json`;

// Lock for preventing concurrent ccusage calls
const ccusageLock = new ProcessLock({
  lockPath: `${process.env.HOME}/.claude/.ccusage.lock`,
  timeout: 15000,         // 15s stale lock timeout (was 60s — daemon killed at 30s)
  retryInterval: 2000,    // Wait 2s between retries
  maxRetries: 5           // Total ~10s (was 20×2s=40s — exceeded daemon budget)
});

interface CCUsageData {
  // Raw block data
  blockId: string;
  startTime: Date;
  endTime: Date;
  isActive: boolean;

  // Cost data
  costUSD: number;
  costPerHour: number | null;

  // Budget data
  hoursLeft: number;
  minutesLeft: number;
  percentageUsed: number;
  resetTime: string;  // HH:MM format

  // Usage data
  totalTokens: number;
  tokensPerMinute: number | null;

  // Metadata
  isFresh: boolean;
  lastFetched?: number;  // Timestamp when data was fetched
}

interface SharedCache {
  costToday: number;
  burnRatePerHour: number;
  budgetRemaining: number;
  budgetPercentUsed: number;
  resetTime: string;
  totalTokens: number;
  tokensPerMinute: number | null;
  isFresh: boolean;
  lastFetched: number;
}

class CCUsageSharedModule implements DataModule<CCUsageData> {
  readonly moduleId = 'ccusage';

  config: DataModuleConfig = {
    timeout: 35000,      // 35s (ccusage can take 20-30s)
    cacheTTL: 120000     // 2min cache freshness
  };

  constructor(config?: Partial<DataModuleConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
  }

  /**
   * Main fetch method - checks cache first, fetches if stale
   *
   * IMPORTANT: No cooldown gate! Freshness is determined by cache timestamp.
   */
  async fetch(sessionId: string): Promise<CCUsageData> {
    // STEP 1: Check shared cache via FreshnessManager (replaces manual CACHE_FRESH_MS check)
    const cache = this.readSharedCache();
    const cacheAgeMs = FreshnessManager.getAge(cache?.lastFetched);
    const cacheIsFresh = FreshnessManager.isFresh(cache?.lastFetched, 'billing_ccusage') && cache?.costToday >= 0;

    if (cacheIsFresh) {
      // Cache is fresh - return it without fetching
      console.error(`[CCUsage] Using fresh cache (age: ${Math.floor(cacheAgeMs/1000)}s)`);
      return this.cacheToData(cache!);
    }

    // STEP 2: Cache is stale - check cooldown via FreshnessManager
    // Prevents retry storms when ccusage is broken (persisted across daemon invocations)
    if (!FreshnessManager.shouldRefetch('billing_ccusage')) {
      console.error(`[CCUsage] Cache stale but ccusage in cooldown, using stale cache`);
      return cache ? this.cacheToData(cache) : this.getDefaultData();
    }

    console.error(`[CCUsage] Cache stale (age: ${Math.floor(cacheAgeMs/1000)}s), fetching from ccusage...`);

    // STEP 3: Try to acquire lock
    const lockResult = await ccusageLock.acquire();

    if (!lockResult.acquired) {
      // Another process is fetching - wait briefly and check cache again
      console.error('[CCUsage] Lock held by another process, waiting for fresh cache...');
      await this.sleep(3000);

      // Check if the other process updated the cache
      const updatedCache = this.readSharedCache();
      const updatedAgeMs = Date.now() - (updatedCache?.lastFetched || 0);

      if (updatedAgeMs < 10000 && updatedCache?.isFresh) {
        // Cache was just updated - use it
        console.error('[CCUsage] Another process updated cache, using it');
        return this.cacheToData(updatedCache);
      }

      // Still stale - return what we have (will show stale indicator)
      console.error('[CCUsage] Cache still stale after waiting');
      return cache ? this.cacheToData(cache) : this.getDefaultData();
    }

    // STEP 4: We have the lock - fetch from ccusage
    try {
      const freshData = await this.runCcusage();

      if (freshData.isFresh) {
        // Write to shared cache for other sessions
        this.writeSharedCache(freshData);
        FreshnessManager.recordFetch('billing_ccusage', true);
        console.error('[CCUsage] Fetch successful, cache updated');
        return freshData;
      } else {
        // Fetch failed - use stale cache if available (better than empty)
        console.error('[CCUsage] Fetch returned empty data, using stale cache');
        if (cache && cache.costToday >= 0) {
          // Return stale cache with isFresh: false
          const staleData = this.cacheToData(cache);
          staleData.isFresh = false;
          return staleData;
        }
        return freshData;
      }
    } finally {
      // Always release lock
      ccusageLock.release();
    }
  }

  /**
   * Read shared cache file
   */
  private readSharedCache(): SharedCache | null {
    try {
      if (!existsSync(SHARED_CACHE_PATH)) {
        return null;
      }
      const content = readFileSync(SHARED_CACHE_PATH, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Write to shared cache (atomic write)
   */
  private writeSharedCache(data: CCUsageData): void {
    try {
      const cache: SharedCache = {
        costToday: data.costUSD,
        burnRatePerHour: data.costPerHour || 0,
        budgetRemaining: data.hoursLeft * 60 + data.minutesLeft,
        budgetPercentUsed: data.percentageUsed,
        resetTime: data.resetTime,
        totalTokens: data.totalTokens,
        tokensPerMinute: data.tokensPerMinute,
        isFresh: data.isFresh,
        lastFetched: Date.now()
      };

      const tempPath = `${SHARED_CACHE_PATH}.tmp`;
      writeFileSync(tempPath, JSON.stringify(cache), { encoding: 'utf-8', mode: 0o600 });
      renameSync(tempPath, SHARED_CACHE_PATH);
    } catch (error) {
      console.error('[CCUsage] Failed to write cache:', error);
    }
  }

  /**
   * Convert cache format to CCUsageData format
   */
  private cacheToData(cache: SharedCache): CCUsageData {
    const totalMinutes = cache.budgetRemaining || 0;
    return {
      blockId: '',
      startTime: new Date(),
      endTime: new Date(),
      isActive: true,
      costUSD: cache.costToday,
      costPerHour: cache.burnRatePerHour,
      hoursLeft: Math.floor(totalMinutes / 60),
      minutesLeft: totalMinutes % 60,
      percentageUsed: cache.budgetPercentUsed,
      resetTime: cache.resetTime,
      totalTokens: cache.totalTokens,
      tokensPerMinute: cache.tokensPerMinute,
      isFresh: cache.isFresh,
      lastFetched: cache.lastFetched
    };
  }

  /**
   * Run ccusage CLI and parse output
   *
   * IMPORTANT: Uses explicit `timeout` command wrapper because Node's execAsync timeout
   * doesn't reliably kill child processes on macOS. Also adds:
   * - --offline: Use cached pricing data (avoids network delay)
   * - --since: Limit to today only (avoids parsing hundreds of old transcript files)
   */
  private async runCcusage(): Promise<CCUsageData> {
    try {
      // Build command with timeout wrapper and performance flags
      // The `timeout` command reliably kills the process on macOS
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const timeoutSec = Math.floor(this.config.timeout / 1000);
      const cmd = `timeout ${timeoutSec} ccusage blocks --json --active --offline --since ${today}`;

      console.error(`[CCUsage] Running: ${cmd}`);
      const startTime = Date.now();

      const { stdout, stderr } = await execAsync(cmd, {
        timeout: this.config.timeout + 5000, // Extra buffer for timeout command
        maxBuffer: 1024 * 1024,
        env: { ...process.env, NO_COLOR: '1' } // Disable color codes in output
      });

      const elapsed = Date.now() - startTime;
      console.error(`[CCUsage] Command completed in ${elapsed}ms`);

      // Check if timeout command killed the process (exit code 124)
      // This is caught as an error, but let's also check stderr
      if (stderr && stderr.includes('timed out')) {
        console.error('[CCUsage] ccusage timed out');
        FreshnessManager.recordFetch('billing_ccusage', false);
        return this.getDefaultData();
      }

      const parsed = JSON.parse(stdout);
      const activeBlock = parsed.blocks?.find((b: any) => b.isActive === true);

      if (!activeBlock) {
        console.error('[CCUsage] No active block found');
        return this.getDefaultData();
      }

      return this.parseActiveBlock(activeBlock);
    } catch (error: any) {
      const msg = error instanceof Error ? error.message : String(error);

      // Detect timeout (exit code 124 from `timeout` command)
      if (msg.includes('124') || msg.includes('SIGTERM') || msg.includes('killed')) {
        console.error(`[CCUsage] ccusage TIMED OUT after ${this.config.timeout}ms`);
      } else {
        console.error(`[CCUsage] ccusage failed: ${msg}`);
      }

      // Record failure via FreshnessManager to prevent retry storms
      FreshnessManager.recordFetch('billing_ccusage', false);
      return this.getDefaultData();
    }
  }

  /**
   * Parse ccusage active block into CCUsageData
   */
  private parseActiveBlock(activeBlock: any): CCUsageData {
    const costUSD = Math.max(0, Number(activeBlock.costUSD) || 0);
    const costPerHour = activeBlock.burnRate?.costPerHour != null
      ? Math.max(0, Number(activeBlock.burnRate.costPerHour))
      : null;

    const totalTokens = Math.max(0, Number(activeBlock.totalTokens) || 0);
    const tokensPerMinute = activeBlock.burnRate?.tokensPerMinute != null
      ? Math.max(0, Number(activeBlock.burnRate.tokensPerMinute))
      : null;

    const resetTimeStr = activeBlock.usageLimitResetTime || activeBlock.endTime;
    const startTimeStr = activeBlock.startTime;

    let hoursLeft = 0;
    let minutesLeft = 0;
    let percentageUsed = 0;
    let resetTime = '00:00';

    if (resetTimeStr && startTimeStr) {
      const startTime = new Date(startTimeStr);
      const endTime = new Date(resetTimeStr);
      const now = new Date();

      if (!isNaN(startTime.getTime()) && !isNaN(endTime.getTime())) {
        const totalMs = endTime.getTime() - startTime.getTime();
        const elapsedMs = now.getTime() - startTime.getTime();
        const remainingMs = Math.max(0, endTime.getTime() - now.getTime());

        if (totalMs > 0) {
          percentageUsed = Math.min(100, Math.max(0, Math.floor((elapsedMs / totalMs) * 100)));
        }

        hoursLeft = Math.max(0, Math.floor(remainingMs / (1000 * 60 * 60)));
        minutesLeft = Math.max(0, Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60)));
        resetTime = `${String(endTime.getUTCHours()).padStart(2, '0')}:${String(endTime.getUTCMinutes()).padStart(2, '0')}`;
      }
    }

    // Check if data looks valid (not all zeros)
    const dataLooksEmpty = costUSD === 0 && hoursLeft === 0 && minutesLeft === 0 && totalTokens === 0;

    return {
      blockId: activeBlock.id || '',
      startTime: new Date(startTimeStr || Date.now()),
      endTime: new Date(resetTimeStr || Date.now()),
      isActive: true,
      costUSD,
      costPerHour,
      hoursLeft,
      minutesLeft,
      percentageUsed,
      resetTime,
      totalTokens,
      tokensPerMinute,
      isFresh: !dataLooksEmpty,
      lastFetched: Date.now()
    };
  }

  private getDefaultData(): CCUsageData {
    return {
      blockId: '',
      startTime: new Date(),
      endTime: new Date(),
      isActive: false,
      costUSD: 0,
      costPerHour: null,
      hoursLeft: 0,
      minutesLeft: 0,
      percentageUsed: 0,
      resetTime: '00:00',
      totalTokens: 0,
      tokensPerMinute: null,
      isFresh: false
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  validate(data: CCUsageData): ValidationResult {
    if (!data || !data.isFresh) {
      return {
        valid: false,
        confidence: 0,
        errors: ['ccusage data unavailable']
      };
    }

    return {
      valid: true,
      confidence: 100,
      warnings: []
    };
  }

  format(data: CCUsageData): string {
    return '';
  }

  formatCost(costUSD: number): string {
    if (costUSD >= 100) {
      return `$${costUSD.toFixed(0)}`;
    } else if (costUSD >= 10) {
      return `$${costUSD.toFixed(1)}`;
    } else {
      return `$${costUSD.toFixed(2)}`;
    }
  }

  formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
      return `${Math.floor(tokens / 1000)}k`;
    }
    return String(tokens);
  }
}

export default CCUsageSharedModule;
export { CCUsageData };
