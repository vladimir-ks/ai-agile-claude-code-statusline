/**
 * Subscription Reader - Reads user-managed subscription data
 *
 * User edits ~/.claude/config/subscription.yaml with data from:
 * https://claude.ai/settings/usage
 *
 * Supports multiple accounts with active account selection.
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { parse as parseYaml } from 'yaml';

export interface AccountData {
  label: string;
  credentialHash?: string;
  currentSession?: {
    percentUsed: number;
    resetsIn: string;
  };
  weeklyAllModels?: {
    percentUsed: number;
    resetDay: string;
    resetTime: string;
  };
  weeklySonnetOnly?: {
    percentUsed: number;
    resetDay: string;
    resetTime: string;
  };
  extraUsage?: {
    spent: number;
    currency: string;
    monthlyLimit: number;
    percentUsed: number;
    resetsDate: string;
  };
}

export interface SubscriptionData {
  activeAccount: string;
  accounts: Record<string, AccountData>;
  notes?: string;
  lastRead: number;
}

// Day name to number (0=Sunday, 1=Monday, ..., 6=Saturday)
const DAY_MAP: Record<string, number> = {
  'sunday': 0, 'sun': 0,
  'monday': 1, 'mon': 1,
  'tuesday': 2, 'tue': 2,
  'wednesday': 3, 'wed': 3,
  'thursday': 4, 'thu': 4,
  'friday': 5, 'fri': 5,
  'saturday': 6, 'sat': 6
};

// In-memory cache
let cachedSubscription: SubscriptionData | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 60000; // 1 minute

export class SubscriptionReader {
  private static readonly CONFIG_PATH = `${homedir()}/.claude/config/subscription.yaml`;

  /**
   * Read subscription data (with caching)
   */
  static read(): SubscriptionData | null {
    const now = Date.now();

    // Return cached data if fresh
    if (cachedSubscription && (now - cacheTimestamp) < CACHE_TTL) {
      return cachedSubscription;
    }

    // Read from file
    try {
      if (!existsSync(this.CONFIG_PATH)) {
        return null;
      }

      const content = readFileSync(this.CONFIG_PATH, 'utf-8');
      const parsed = parseYaml(content);

      if (!parsed || !parsed.accounts) {
        return null;
      }

      cachedSubscription = {
        activeAccount: parsed.activeAccount || Object.keys(parsed.accounts)[0],
        accounts: parsed.accounts || {},
        notes: parsed.notes,
        lastRead: now
      };
      cacheTimestamp = now;

      return cachedSubscription;
    } catch {
      return null;
    }
  }

  /**
   * Get active account data
   */
  static getActiveAccount(): AccountData | null {
    const sub = this.read();
    if (!sub || !sub.accounts) return null;

    const activeId = sub.activeAccount;
    return sub.accounts[activeId] || null;
  }

  /**
   * Calculate hours until weekly reset
   */
  static calculateHoursUntilReset(resetDay: string, resetTime: string): number {
    const now = new Date();
    const resetDayNum = DAY_MAP[resetDay.toLowerCase()] ?? -1;

    if (resetDayNum < 0) return 0;

    // Parse reset time (HH:MM format, local time)
    const [hours, minutes] = (resetTime || '00:00').split(':').map(Number);

    // Current day (0-6, where 0=Sunday)
    const currentDay = now.getDay();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    // Calculate days until reset
    let daysUntilReset = resetDayNum - currentDay;
    if (daysUntilReset < 0) {
      daysUntilReset += 7;
    } else if (daysUntilReset === 0) {
      // Same day - check if reset already happened today
      const resetMinutes = hours * 60 + minutes;
      const currentMinutes = currentHour * 60 + currentMinute;
      if (currentMinutes >= resetMinutes) {
        daysUntilReset = 7; // Next week
      }
    }

    // Calculate total hours
    const resetMinutesOfDay = hours * 60 + minutes;
    const currentMinutesOfDay = currentHour * 60 + currentMinute;
    const minutesUntilReset = (daysUntilReset * 24 * 60) + (resetMinutesOfDay - currentMinutesOfDay);

    return Math.max(0, Math.floor(minutesUntilReset / 60));
  }

  /**
   * Get weekly quota info for display (uses "All models" limit)
   */
  static getWeeklyQuota(): {
    hoursRemaining: number;
    percentUsed: number;
    resetDay: string;
    accountLabel?: string;
  } | null {
    const account = this.getActiveAccount();
    if (!account) return null;

    const weekly = account.weeklyAllModels;
    if (!weekly) return null;

    const hoursUntilReset = this.calculateHoursUntilReset(
      weekly.resetDay,
      weekly.resetTime
    );

    return {
      hoursRemaining: hoursUntilReset,
      percentUsed: weekly.percentUsed || 0,
      resetDay: weekly.resetDay?.substring(0, 3) || '?', // "Thu", "Sat", etc.
      accountLabel: account.label
    };
  }

  /**
   * Get current session quota info (daily budget percentage)
   */
  static getCurrentSessionQuota(): {
    percentUsed: number;
  } | null {
    const account = this.getActiveAccount();
    if (!account) return null;

    const session = account.currentSession;
    if (!session) return null;

    return {
      percentUsed: session.percentUsed || 0
    };
  }

  /**
   * Get all accounts (for multi-account display)
   */
  static getAllAccounts(): Record<string, AccountData> | null {
    const sub = this.read();
    return sub?.accounts || null;
  }

  /**
   * Clear cache (for testing or when user edits file)
   */
  static clearCache(): void {
    cachedSubscription = null;
    cacheTimestamp = 0;
  }
}

export default SubscriptionReader;
