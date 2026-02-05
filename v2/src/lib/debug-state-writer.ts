/**
 * Debug State Writer - Post-gather diagnostic snapshot
 *
 * Writes {session-id}.debug.json after every gather cycle.
 * Contains: raw values, freshness report, fetch history, data quality assessment.
 *
 * PURPOSE: Troubleshoot data quality issues without guessing.
 * Read the debug file to see exactly what was fresh, stale, or missing.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { SessionHealth } from '../types/session-health';
import { FreshnessManager, FreshnessReport, StalenessStatus } from './freshness-manager';
import { sanitizeSessionId } from './sanitize';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FetchAttempt {
  category: string;
  timestamp: number;
  success: boolean;
  durationMs?: number;
  error?: string;
}

export interface DataQuality {
  overall: 'healthy' | 'warning' | 'critical';
  freshCount: number;
  staleCount: number;
  criticalCount: number;
  unknownCount: number;
  fieldFreshness: Record<string, {
    age: number;
    ageHuman: string;
    status: StalenessStatus;
    indicator: '' | '⚠' | '🔺';
  }>;
}

export interface DebugState {
  snapshotAt: number;
  sessionId: string;
  dataQuality: DataQuality;
  rawValues: {
    billing: {
      costToday: number;
      burnRatePerHour: number;
      budgetPercentUsed: number;
      weeklyPercentUsed?: number;
      isFresh: boolean;
      lastFetched: number;
      weeklyLastModified?: number;
      weeklyDataStale?: boolean;
    };
    model: {
      value: string;
      source: string;
      confidence: number;
      updatedAt?: number;
    };
    context: {
      tokensUsed: number;
      tokensLeft: number;
      percentUsed: number;
      windowSize: number;
      nearCompaction: boolean;
      updatedAt?: number;
    };
    git: {
      branch: string;
      dirty: number;
      lastChecked: number;
    };
    transcript: {
      exists: boolean;
      sizeBytes: number;
      messageCount: number;
      lastModified: number;
      isSynced: boolean;
    };
    alerts: {
      secretsDetected: boolean;
      transcriptStale: boolean;
      dataLossRisk: boolean;
    };
  };
  freshnessReport: FreshnessReport;
  fetchHistory: FetchAttempt[];
  performance?: {
    gatherDuration?: number;
    billingFetchDuration?: number;
    transcriptScanDuration?: number;
  };
}

// ---------------------------------------------------------------------------
// In-memory fetch history ring buffer (last 20 entries)
// ---------------------------------------------------------------------------

const MAX_HISTORY = 20;
const fetchHistory: FetchAttempt[] = [];

// ---------------------------------------------------------------------------
// DebugStateWriter
// ---------------------------------------------------------------------------

export class DebugStateWriter {

  /**
   * Record a fetch attempt (call from data-gatherer or billing modules).
   */
  static recordFetch(attempt: FetchAttempt): void {
    fetchHistory.push(attempt);
    if (fetchHistory.length > MAX_HISTORY) {
      fetchHistory.shift();
    }
  }

  /**
   * Get current fetch history (for testing/inspection).
   */
  static getFetchHistory(): FetchAttempt[] {
    return [...fetchHistory];
  }

  /**
   * Clear fetch history (for testing).
   */
  static clearHistory(): void {
    fetchHistory.length = 0;
  }

  /**
   * Write debug state file after gather.
   */
  static write(sessionId: string, health: SessionHealth, basePath?: string): void {
    const dir = basePath || join(homedir(), '.claude', 'session-health');

    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }

      const debugState = this.buildDebugState(sessionId, health);
      const filePath = join(dir, `${sanitizeSessionId(sessionId)}.debug.json`);
      const tempPath = `${filePath}.tmp`;

      writeFileSync(tempPath, JSON.stringify(debugState, null, 2), { encoding: 'utf-8', mode: 0o600 });
      renameSync(tempPath, filePath);
    } catch {
      // Debug file write is non-critical — never fail the gather
    }
  }

  /**
   * Read debug state file (for testing/inspection).
   */
  static read(sessionId: string, basePath?: string): DebugState | null {
    const dir = basePath || join(homedir(), '.claude', 'session-health');
    const filePath = join(dir, `${sanitizeSessionId(sessionId)}.debug.json`);

    try {
      if (!existsSync(filePath)) return null;
      const content = readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as DebugState;
    } catch {
      return null;
    }
  }

  /**
   * Build debug state from health data.
   */
  static buildDebugState(sessionId: string, health: SessionHealth): DebugState {
    // Collect timestamps for freshness report
    const timestamps: Record<string, number | undefined | null> = {
      billing_ccusage: health.billing.lastFetched,
      weekly_quota: health.billing.weeklyLastModified,
      git_status: health.git.lastChecked,
      model: health.model.updatedAt,
      context: health.context.updatedAt,
      transcript: health.transcript.lastModified,
    };

    const freshnessReport = FreshnessManager.getReport(timestamps);

    // Assess data quality
    const dataQuality = this.assessQuality(freshnessReport);

    return {
      snapshotAt: Date.now(),
      sessionId,
      dataQuality,
      rawValues: {
        billing: {
          costToday: health.billing.costToday,
          burnRatePerHour: health.billing.burnRatePerHour,
          budgetPercentUsed: health.billing.budgetPercentUsed,
          weeklyPercentUsed: health.billing.weeklyBudgetPercentUsed,
          isFresh: health.billing.isFresh,
          lastFetched: health.billing.lastFetched,
          weeklyLastModified: health.billing.weeklyLastModified,
          weeklyDataStale: health.billing.weeklyDataStale,
        },
        model: {
          value: health.model.value,
          source: health.model.source,
          confidence: health.model.confidence,
          updatedAt: health.model.updatedAt,
        },
        context: {
          tokensUsed: health.context.tokensUsed,
          tokensLeft: health.context.tokensLeft,
          percentUsed: health.context.percentUsed,
          windowSize: health.context.windowSize,
          nearCompaction: health.context.nearCompaction,
          updatedAt: health.context.updatedAt,
        },
        git: {
          branch: health.git.branch,
          dirty: health.git.dirty,
          lastChecked: health.git.lastChecked,
        },
        transcript: {
          exists: health.transcript.exists,
          sizeBytes: health.transcript.sizeBytes,
          messageCount: health.transcript.messageCount,
          lastModified: health.transcript.lastModified,
          isSynced: health.transcript.isSynced,
        },
        alerts: {
          secretsDetected: health.alerts.secretsDetected,
          transcriptStale: health.alerts.transcriptStale,
          dataLossRisk: health.alerts.dataLossRisk,
        },
      },
      freshnessReport,
      fetchHistory: [...fetchHistory],
      performance: health.performance ? {
        gatherDuration: health.performance.gatherDuration,
        billingFetchDuration: health.performance.billingFetchDuration,
        transcriptScanDuration: health.performance.transcriptScanDuration,
      } : undefined,
    };
  }

  /**
   * Assess overall data quality from freshness report.
   */
  private static assessQuality(report: FreshnessReport): DataQuality {
    let freshCount = 0;
    let staleCount = 0;
    let criticalCount = 0;
    let unknownCount = 0;

    const fieldFreshness: DataQuality['fieldFreshness'] = {};

    for (const [key, field] of Object.entries(report.fields)) {
      const ageHuman = this.formatAge(field.ageMs);
      fieldFreshness[key] = {
        age: field.ageMs,
        ageHuman,
        status: field.status,
        indicator: field.indicator,
      };

      switch (field.status) {
        case 'fresh': freshCount++; break;
        case 'stale': staleCount++; break;
        case 'critical': criticalCount++; break;
        case 'unknown': unknownCount++; break;
      }
    }

    let overall: DataQuality['overall'] = 'healthy';
    if (criticalCount > 0) {
      overall = 'critical';
    } else if (staleCount > 0 || unknownCount > 1) {
      overall = 'warning';
    }

    return {
      overall,
      freshCount,
      staleCount,
      criticalCount,
      unknownCount,
      fieldFreshness,
    };
  }

  /**
   * Format milliseconds as human-readable age.
   */
  private static formatAge(ms: number): string {
    if (!isFinite(ms) || ms < 0) return 'unknown';
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
    if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
    return `${Math.floor(ms / 86_400_000)}d`;
  }
}

export default DebugStateWriter;
