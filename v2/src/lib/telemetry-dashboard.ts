/**
 * TelemetryDashboard - Global session health view
 *
 * Writes ~/.claude/session-health/telemetry.json with:
 * - All active sessions and their data state
 * - What each session is displaying (ANSI-stripped)
 * - Data freshness per category
 * - Global refresh intent and cooldown state
 *
 * PURPOSE: Single file for humans/AI agents to debug data problems.
 * Read this file to see all 10-30 sessions, their data ages, and if
 * anything is wrong.
 *
 * PATTERN: Same as DebugStateWriter — static methods, atomic writes,
 * non-critical (never fails the gather).
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { FreshnessManager } from './freshness-manager';
import { RefreshIntentManager } from './refresh-intent-manager';
import type { SessionHealth } from '../types/session-health';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TelemetrySessionEntry {
  sessionId: string;
  projectName: string;
  model: string;
  lastDaemonRun: number;
  lastDaemonRunAgo: string;
  displayedLine: string;
  dataFreshness: Record<string, {
    ageMs: number;
    ageHuman: string;
    status: string;
    indicator?: string;
  }>;
  health: string;
  alerts: string[];
}

interface TelemetryGlobal {
  activeSessionCount: number;
  totalSessionCount: number;
  pendingRefreshIntents: string[];
  cooldownsActive: string[];
  sharedBillingAge: number;
  sharedBillingFresh: boolean;
}

interface TelemetryData {
  generatedAt: number;
  generatedBy: string;
  global: TelemetryGlobal;
  sessions: TelemetrySessionEntry[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let basePath = join(homedir(), '.claude/session-health');

function telemetryPath(): string {
  return join(basePath, 'telemetry.json');
}

/** Strip ANSI escape codes from string */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Format age in ms to human-readable */
function formatAge(ms: number): string {
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** Read shared billing cache age */
function getSharedBillingInfo(): { age: number; fresh: boolean } {
  try {
    const cachePath = join(basePath, 'billing-shared.json');
    if (!existsSync(cachePath)) return { age: Infinity, fresh: false };
    const data = JSON.parse(readFileSync(cachePath, 'utf-8'));
    const age = Date.now() - (data.lastFetched || 0);
    return { age, fresh: FreshnessManager.isFresh(data.lastFetched, 'billing_ccusage') };
  } catch {
    return { age: Infinity, fresh: false };
  }
}

/** Get active cooldowns from FreshnessManager */
function getActiveCooldowns(): string[] {
  const categories = ['billing_oauth', 'billing_ccusage', 'billing_local', 'git_status', 'transcript'];
  return categories.filter(cat => FreshnessManager.getCooldownRemaining(cat) > 0);
}

// ---------------------------------------------------------------------------
// TelemetryDashboard
// ---------------------------------------------------------------------------

export class TelemetryDashboard {

  static setBasePath(path: string): void {
    basePath = path;
  }

  /**
   * Update telemetry with data from a session gather.
   * Merges into existing telemetry, prunes stale sessions.
   */
  static update(sessionId: string, health: SessionHealth): void {
    try {
      const existing = this.read();
      const entry = this.buildEntry(sessionId, health);

      // Remove existing entry for this session (will be replaced)
      const sessions = existing.sessions.filter(s => s.sessionId !== sessionId);
      sessions.push(entry);

      // Auto-prune sessions inactive > 2h
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      const activeSessions = sessions.filter(s => s.lastDaemonRun > twoHoursAgo);

      const telemetry: TelemetryData = {
        generatedAt: Date.now(),
        generatedBy: sessionId,
        global: this.buildGlobal(activeSessions),
        sessions: activeSessions
      };

      this.write(telemetry);
    } catch { /* non-critical */ }
  }

  /**
   * Read existing telemetry data. Returns empty structure if missing/corrupt.
   */
  static read(): TelemetryData {
    try {
      const path = telemetryPath();
      if (!existsSync(path)) return this.empty();
      const content = readFileSync(path, 'utf-8');
      const data = JSON.parse(content);
      if (!data.sessions || !Array.isArray(data.sessions)) return this.empty();
      return data as TelemetryData;
    } catch {
      return this.empty();
    }
  }

  /**
   * Prune sessions inactive longer than maxAgeMs.
   */
  static pruneStale(maxAgeMs: number = 2 * 60 * 60 * 1000): void {
    try {
      const data = this.read();
      const cutoff = Date.now() - maxAgeMs;
      data.sessions = data.sessions.filter(s => s.lastDaemonRun > cutoff);
      data.global = this.buildGlobal(data.sessions);
      data.generatedAt = Date.now();
      this.write(data);
    } catch { /* non-critical */ }
  }

  /**
   * Build a telemetry entry from a SessionHealth object.
   */
  static buildEntry(sessionId: string, health: SessionHealth): TelemetrySessionEntry {
    // Extract displayed line from formattedOutput (prefer singleLine, strip ANSI)
    let displayedLine = '';
    if (health.formattedOutput) {
      const raw = health.formattedOutput.singleLine?.[0] ||
                  health.formattedOutput.width120?.[0] ||
                  health.formattedOutput.width80?.[0] || '';
      displayedLine = stripAnsi(raw);
    }

    // Compute data freshness per category
    const dataFreshness: TelemetrySessionEntry['dataFreshness'] = {};

    const timestamps: Record<string, number | undefined> = {
      billing: health.billing?.lastFetched,
      git: health.git?.lastChecked,
      transcript: health.transcript?.lastModified,
      quota: health.billing?.weeklyLastModified,
    };

    const categoryMap: Record<string, string> = {
      billing: 'billing_ccusage',
      git: 'git_status',
      transcript: 'transcript',
      quota: 'weekly_quota',
    };

    for (const [key, ts] of Object.entries(timestamps)) {
      const category = categoryMap[key] || key;
      const ageMs = ts ? Math.max(0, Date.now() - ts) : Infinity;
      const status = FreshnessManager.getStatus(ts || 0, category);
      const indicator = FreshnessManager.getContextAwareIndicator(ts || 0, category);

      dataFreshness[key] = {
        ageMs: ageMs === Infinity ? -1 : ageMs,
        ageHuman: ageMs === Infinity ? 'never' : formatAge(ageMs),
        status,
        ...(indicator ? { indicator } : {})
      };
    }

    return {
      sessionId,
      projectName: health.projectPath?.split('/').pop() || 'unknown',
      model: health.model?.value || 'unknown',
      lastDaemonRun: health.gatheredAt || Date.now(),
      lastDaemonRunAgo: formatAge(Date.now() - (health.gatheredAt || Date.now())),
      displayedLine,
      dataFreshness,
      health: health.health?.status || 'unknown',
      alerts: health.health?.issues || []
    };
  }

  /**
   * Build global summary from session entries.
   */
  static buildGlobal(sessions: TelemetrySessionEntry[]): TelemetryGlobal {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const activeCount = sessions.filter(s => s.lastDaemonRun > oneHourAgo).length;

    const billingInfo = getSharedBillingInfo();

    return {
      activeSessionCount: activeCount,
      totalSessionCount: sessions.length,
      pendingRefreshIntents: RefreshIntentManager.getPendingIntents(),
      cooldownsActive: getActiveCooldowns(),
      sharedBillingAge: billingInfo.age === Infinity ? -1 : billingInfo.age,
      sharedBillingFresh: billingInfo.fresh
    };
  }

  // -----------------------------------------------------------------------
  // Private
  // -----------------------------------------------------------------------

  private static empty(): TelemetryData {
    return {
      generatedAt: 0,
      generatedBy: '',
      global: {
        activeSessionCount: 0,
        totalSessionCount: 0,
        pendingRefreshIntents: [],
        cooldownsActive: [],
        sharedBillingAge: -1,
        sharedBillingFresh: false
      },
      sessions: []
    };
  }

  private static write(data: TelemetryData): void {
    try {
      if (!existsSync(basePath)) {
        mkdirSync(basePath, { recursive: true, mode: 0o700 });
      }

      const path = telemetryPath();
      const tmpPath = `${path}.${process.pid}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
      renameSync(tmpPath, path);
    } catch { /* non-critical */ }
  }
}

export default TelemetryDashboard;
