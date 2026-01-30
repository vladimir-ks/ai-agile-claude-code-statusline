/**
 * Health Store - Read/write session health JSON files
 *
 * Manages:
 * - Per-session health files ([sessionId].json)
 * - Global summary (sessions.json)
 * - User configuration (config.json)
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync
} from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import {
  SessionHealth,
  SessionsSummary,
  StatuslineConfig,
  SessionSummaryEntry,
  createDefaultConfig,
  createDefaultSummary
} from '../types/session-health';

class HealthStore {
  private basePath: string;

  constructor(basePath?: string) {
    this.basePath = basePath || join(homedir(), '.claude', 'session-health');
  }

  /**
   * Ensure the health store directory exists
   */
  ensureDirectory(): void {
    if (!existsSync(this.basePath)) {
      mkdirSync(this.basePath, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Get path for a session health file
   */
  private sessionPath(sessionId: string): string {
    return join(this.basePath, `${sessionId}.json`);
  }

  /**
   * Atomic write: write to temp file, then rename
   */
  private atomicWrite(filePath: string, data: string): void {
    const tempPath = `${filePath}.tmp`;
    try {
      writeFileSync(tempPath, data, { encoding: 'utf-8', mode: 0o600 });
      renameSync(tempPath, filePath);
    } catch (error) {
      // Clean up temp file if it exists
      if (existsSync(tempPath)) {
        try {
          unlinkSync(tempPath);
        } catch {
          // Ignore cleanup errors
        }
      }
      throw error;
    }
  }

  /**
   * Write session health to file
   */
  writeSessionHealth(sessionId: string, health: SessionHealth): void {
    this.ensureDirectory();
    const filePath = this.sessionPath(sessionId);
    const data = JSON.stringify(health, null, 2);
    this.atomicWrite(filePath, data);
  }

  /**
   * Read session health from file
   * Returns null if file doesn't exist or is invalid
   */
  readSessionHealth(sessionId: string): SessionHealth | null {
    const filePath = this.sessionPath(sessionId);

    if (!existsSync(filePath)) {
      return null;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      if (!content || content.trim() === '') {
        return null;
      }
      return JSON.parse(content) as SessionHealth;
    } catch (error) {
      // Invalid JSON or read error
      return null;
    }
  }

  /**
   * List all session IDs in the health store
   */
  listSessionIds(): string[] {
    if (!existsSync(this.basePath)) {
      return [];
    }

    const files = readdirSync(this.basePath);
    return files
      .filter(f => f.endsWith('.json'))
      .filter(f => f !== 'sessions.json' && f !== 'config.json' && f !== 'alerts.json')
      .map(f => f.replace('.json', ''));
  }

  /**
   * Read all sessions and create summary
   */
  readAllSessions(): SessionsSummary {
    const summaryPath = join(this.basePath, 'sessions.json');

    if (!existsSync(summaryPath)) {
      return createDefaultSummary();
    }

    try {
      const content = readFileSync(summaryPath, 'utf-8');
      return JSON.parse(content) as SessionsSummary;
    } catch {
      return createDefaultSummary();
    }
  }

  /**
   * Update the global sessions summary
   */
  updateSessionsSummary(): void {
    this.ensureDirectory();

    const sessionIds = this.listSessionIds();
    const sessions: SessionSummaryEntry[] = [];

    let totalCost = 0;
    let totalBurnRate = 0;
    let activeSessions = 0;
    const sessionsWithSecrets: string[] = [];
    const sessionsAtRisk: string[] = [];
    const sessionsNearCompaction: string[] = [];

    const oneHourAgo = Date.now() - 3600000;

    for (const sessionId of sessionIds) {
      const health = this.readSessionHealth(sessionId);
      if (!health) continue;

      // Calculate short name from project path
      const shortName = health.projectPath
        ? basename(health.projectPath)
        : sessionId.substring(0, 8);

      // Format last activity
      const lastActivityAgo = this.formatAgo(health.transcript.lastModified);

      sessions.push({
        sessionId: health.sessionId,
        projectPath: health.projectPath,
        shortName,
        health: health.health.status,
        lastActivity: health.transcript.lastModified,
        lastActivityAgo,
        model: health.model.value,
        transcriptSynced: health.transcript.isSynced
      });

      // Aggregate metrics
      if (health.billing.isFresh) {
        totalCost = Math.max(totalCost, health.billing.costToday);
        totalBurnRate = Math.max(totalBurnRate, health.billing.burnRatePerHour);
      }

      if (health.transcript.lastModified > oneHourAgo) {
        activeSessions++;
      }

      // Collect alerts
      if (health.alerts.secretsDetected) {
        sessionsWithSecrets.push(sessionId);
      }
      if (health.alerts.dataLossRisk) {
        sessionsAtRisk.push(sessionId);
      }
      if (health.context.nearCompaction) {
        sessionsNearCompaction.push(sessionId);
      }
    }

    // Sort by last activity (most recent first)
    sessions.sort((a, b) => b.lastActivity - a.lastActivity);

    const summary: SessionsSummary = {
      lastUpdated: Date.now(),
      activeSessions,
      totalSessions: sessions.length,
      sessions,
      global: {
        totalCostToday: totalCost,
        burnRatePerHour: totalBurnRate,
        budgetRemaining: 0 // Will be filled from billing data
      },
      alerts: {
        sessionsWithSecrets,
        sessionsAtRisk,
        sessionsNearCompaction
      }
    };

    const summaryPath = join(this.basePath, 'sessions.json');
    this.atomicWrite(summaryPath, JSON.stringify(summary, null, 2));
  }

  /**
   * Read user configuration
   */
  readConfig(): StatuslineConfig {
    const configPath = join(this.basePath, 'config.json');

    if (!existsSync(configPath)) {
      return createDefaultConfig();
    }

    try {
      const content = readFileSync(configPath, 'utf-8');
      const loaded = JSON.parse(content) as StatuslineConfig;

      // Merge with defaults (in case new fields added)
      const defaults = createDefaultConfig();
      return {
        components: { ...defaults.components, ...loaded.components },
        thresholds: { ...defaults.thresholds, ...loaded.thresholds },
        display: { ...defaults.display, ...loaded.display }
      };
    } catch {
      return createDefaultConfig();
    }
  }

  /**
   * Write user configuration
   */
  writeConfig(config: StatuslineConfig): void {
    this.ensureDirectory();
    const configPath = join(this.basePath, 'config.json');
    this.atomicWrite(configPath, JSON.stringify(config, null, 2));
  }

  /**
   * Format timestamp as "Xm ago", "Xh ago", etc.
   */
  private formatAgo(timestamp: number): string {
    if (!timestamp || timestamp === 0) {
      return 'unknown';
    }

    const seconds = Math.floor((Date.now() - timestamp) / 1000);

    if (seconds < 60) {
      return '<1m';
    } else if (seconds < 3600) {
      return `${Math.floor(seconds / 60)}m`;
    } else if (seconds < 86400) {
      return `${Math.floor(seconds / 3600)}h`;
    } else {
      return `${Math.floor(seconds / 86400)}d`;
    }
  }

  /**
   * Delete a session health file
   */
  deleteSession(sessionId: string): void {
    const filePath = this.sessionPath(sessionId);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  }

  /**
   * Check if health data is stale (older than maxAge ms)
   */
  isStale(sessionId: string, maxAgeMs: number = 30000): boolean {
    const health = this.readSessionHealth(sessionId);
    if (!health) {
      return true;
    }
    return (Date.now() - health.gatheredAt) > maxAgeMs;
  }
}

export default HealthStore;
