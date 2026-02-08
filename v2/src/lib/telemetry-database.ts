/**
 * Telemetry Database - SQLite-based telemetry for statusline invocations
 *
 * Tracks every statusline invocation with:
 * - Performance metrics (scan duration, cache hits, data freshness)
 * - Session metadata (auth profile, model, context usage)
 * - Cost tracking (session cost, daily burn rate)
 * - Health indicators (secrets, auth changes, stale data)
 *
 * Database path: ~/.claude/session-health/telemetry.db
 * Retention: 30 days (auto-cleanup old entries)
 * Schema version: 1
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { SessionHealth } from '../types/session-health';

export interface TelemetryEntry {
  id?: number;
  timestamp: number;
  sessionId: string;

  // Performance
  displayTimeMs: number;
  scanTimeMs: number;
  cacheHit: boolean;

  // Session
  authProfile: string;
  model: string;
  contextUsed: number;
  contextPercent: number;

  // Cost
  sessionCost: number;
  dailyCost: number;
  burnRatePerHour: number;

  // Health
  hasSecrets: boolean;
  hasAuthChanges: boolean;
  transcriptStale: boolean;
  billingStale: boolean;

  // Metadata
  version: string;
  slotId: string | null;
}

export class TelemetryDatabase {
  private static instance: Database | null = null;
  private static readonly DB_PATH = join(homedir(), '.claude/session-health/telemetry.db');
  private static readonly RETENTION_DAYS = 30;

  /**
   * Get or create database connection (singleton)
   */
  private static getDb(): Database {
    if (this.instance) {
      return this.instance;
    }

    // Ensure directory exists
    const dir = join(homedir(), '.claude/session-health');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    // Open/create database
    this.instance = new Database(this.DB_PATH, { create: true });
    this.instance.exec('PRAGMA journal_mode = WAL'); // Write-ahead logging for concurrency
    this.instance.exec('PRAGMA synchronous = NORMAL'); // Balance safety/speed

    // Initialize schema
    this.initSchema();

    return this.instance;
  }

  /**
   * Initialize database schema
   */
  private static initSchema(): void {
    const db = this.instance!;

    db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        sessionId TEXT NOT NULL,

        -- Performance
        displayTimeMs REAL NOT NULL,
        scanTimeMs REAL NOT NULL,
        cacheHit INTEGER NOT NULL,

        -- Session
        authProfile TEXT NOT NULL,
        model TEXT NOT NULL,
        contextUsed INTEGER NOT NULL,
        contextPercent REAL NOT NULL,

        -- Cost
        sessionCost REAL NOT NULL,
        dailyCost REAL NOT NULL,
        burnRatePerHour REAL NOT NULL,

        -- Health
        hasSecrets INTEGER NOT NULL,
        hasAuthChanges INTEGER NOT NULL,
        transcriptStale INTEGER NOT NULL,
        billingStale INTEGER NOT NULL,

        -- Metadata
        version TEXT NOT NULL,
        slotId TEXT
      )
    `);

    // Indexes for common queries
    db.exec(`CREATE INDEX IF NOT EXISTS idx_timestamp ON telemetry(timestamp)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sessionId ON telemetry(sessionId)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_authProfile ON telemetry(authProfile)`);
  }

  /**
   * Record a telemetry entry
   * Non-critical operation - errors logged but not thrown
   */
  static record(entry: TelemetryEntry): boolean {
    try {
      const db = this.getDb();

      const stmt = db.prepare(`
        INSERT INTO telemetry (
          timestamp, sessionId,
          displayTimeMs, scanTimeMs, cacheHit,
          authProfile, model, contextUsed, contextPercent,
          sessionCost, dailyCost, burnRatePerHour,
          hasSecrets, hasAuthChanges, transcriptStale, billingStale,
          version, slotId
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        entry.timestamp,
        entry.sessionId,
        entry.displayTimeMs,
        entry.scanTimeMs,
        entry.cacheHit ? 1 : 0,
        entry.authProfile,
        entry.model,
        entry.contextUsed,
        entry.contextPercent,
        entry.sessionCost,
        entry.dailyCost,
        entry.burnRatePerHour,
        entry.hasSecrets ? 1 : 0,
        entry.hasAuthChanges ? 1 : 0,
        entry.transcriptStale ? 1 : 0,
        entry.billingStale ? 1 : 0,
        entry.version,
        entry.slotId
      );

      return true;
    } catch (error) {
      console.error('[TelemetryDatabase] Failed to record entry:', error);
      return false;
    }
  }

  /**
   * Record from SessionHealth object
   * Convenience wrapper for record()
   */
  static recordFromHealth(health: SessionHealth, displayTimeMs: number): boolean {
    const entry: TelemetryEntry = {
      timestamp: Date.now(),
      sessionId: health.sessionId,

      // Performance (extract from metrics if available)
      displayTimeMs,
      scanTimeMs: 0, // Not directly available in SessionHealth
      cacheHit: false, // Not directly available

      // Session
      authProfile: health.launch.authProfile || 'default',
      model: health.model.value,
      contextUsed: health.context.tokensUsed,
      contextPercent: health.context.percentUsed,

      // Cost
      sessionCost: health.billing.sessionCost || 0,
      dailyCost: health.billing.costToday,
      burnRatePerHour: health.billing.burnRatePerHour,

      // Health
      hasSecrets: health.alerts.secretsDetected,
      hasAuthChanges: false, // Not directly tracked in SessionHealth
      transcriptStale: health.alerts.transcriptStale,
      billingStale: !health.billing.isFresh,

      // Metadata
      version: health.status.claudeVersion || 'unknown',
      slotId: null, // Could be extracted from SessionLock
    };

    return this.record(entry);
  }

  /**
   * Query entries by time range
   */
  static query(options: {
    since?: number;
    until?: number;
    sessionId?: string;
    limit?: number;
  }): TelemetryEntry[] {
    try {
      const db = this.getDb();
      let sql = 'SELECT * FROM telemetry WHERE 1=1';
      const params: any[] = [];

      if (options.since) {
        sql += ' AND timestamp >= ?';
        params.push(options.since);
      }

      if (options.until) {
        sql += ' AND timestamp <= ?';
        params.push(options.until);
      }

      if (options.sessionId) {
        sql += ' AND sessionId = ?';
        params.push(options.sessionId);
      }

      sql += ' ORDER BY timestamp DESC';

      if (options.limit) {
        sql += ' LIMIT ?';
        params.push(options.limit);
      }

      const stmt = db.prepare(sql);
      const rows = stmt.all(...params) as any[];

      // Convert SQLite integers back to booleans
      return rows.map(row => ({
        ...row,
        cacheHit: row.cacheHit === 1,
        hasSecrets: row.hasSecrets === 1,
        hasAuthChanges: row.hasAuthChanges === 1,
        transcriptStale: row.transcriptStale === 1,
        billingStale: row.billingStale === 1,
      }));
    } catch (error) {
      console.error('[TelemetryDatabase] Query failed:', error);
      return [];
    }
  }

  /**
   * Get statistics for a session
   */
  static getSessionStats(sessionId: string): {
    invocationCount: number;
    avgDisplayTimeMs: number;
    cacheHitRate: number;
    totalCost: number;
  } | null {
    try {
      const db = this.getDb();
      const stmt = db.prepare(`
        SELECT
          COUNT(*) as invocationCount,
          AVG(displayTimeMs) as avgDisplayTimeMs,
          SUM(CASE WHEN cacheHit = 1 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as cacheHitRate,
          MAX(sessionCost) as totalCost
        FROM telemetry
        WHERE sessionId = ?
      `);

      const result = stmt.get(sessionId) as any;
      return result;
    } catch (error) {
      console.error('[TelemetryDatabase] Failed to get session stats:', error);
      return null;
    }
  }

  /**
   * Get daily statistics
   */
  static getDailyStats(date?: Date): {
    invocationCount: number;
    uniqueSessions: number;
    avgDisplayTimeMs: number;
    totalCost: number;
  } | null {
    try {
      const db = this.getDb();
      const targetDate = date || new Date();
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);

      const stmt = db.prepare(`
        SELECT
          COUNT(*) as invocationCount,
          COUNT(DISTINCT sessionId) as uniqueSessions,
          AVG(displayTimeMs) as avgDisplayTimeMs,
          SUM(dailyCost) / COUNT(*) as avgDailyCost
        FROM telemetry
        WHERE timestamp >= ? AND timestamp <= ?
      `);

      const result = stmt.get(startOfDay.getTime(), endOfDay.getTime()) as any;
      return {
        invocationCount: result.invocationCount,
        uniqueSessions: result.uniqueSessions,
        avgDisplayTimeMs: result.avgDisplayTimeMs,
        totalCost: result.avgDailyCost || 0,
      };
    } catch (error) {
      console.error('[TelemetryDatabase] Failed to get daily stats:', error);
      return null;
    }
  }

  /**
   * Cleanup old entries (retention policy)
   * Call periodically (e.g., on startup or cron)
   */
  static cleanup(): number {
    try {
      const db = this.getDb();
      const cutoff = Date.now() - (this.RETENTION_DAYS * 24 * 60 * 60 * 1000);

      const stmt = db.prepare('DELETE FROM telemetry WHERE timestamp < ?');
      const result = stmt.run(cutoff);

      const deletedCount = result.changes || 0;
      if (deletedCount > 0) {
        console.log(`[TelemetryDatabase] Cleaned up ${deletedCount} old entries`);
      }

      // Vacuum to reclaim space
      db.exec('VACUUM');

      return deletedCount;
    } catch (error) {
      console.error('[TelemetryDatabase] Cleanup failed:', error);
      return 0;
    }
  }

  /**
   * Close database connection
   */
  static close(): void {
    if (this.instance) {
      this.instance.close();
      this.instance = null;
    }
  }

  /**
   * Get database file size in bytes
   */
  static getSize(): number {
    try {
      const { statSync } = require('fs');
      const stat = statSync(this.DB_PATH);
      return stat.size;
    } catch {
      return 0;
    }
  }

  /**
   * Get entry count
   */
  static getCount(): number {
    try {
      const db = this.getDb();
      const stmt = db.prepare('SELECT COUNT(*) as count FROM telemetry');
      const result = stmt.get() as any;
      return result.count;
    } catch {
      return 0;
    }
  }
}

export default TelemetryDatabase;
