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

// Structured logging for observability
interface LogContext {
  component: string;
  operation?: string;
  sessionId?: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
}

function logError(message: string, context: LogContext): void {
  const timestamp = new Date().toISOString();
  const { component, operation, sessionId, error, metadata } = context;

  const logEntry = {
    timestamp,
    level: 'ERROR',
    component,
    message,
    ...(operation && { operation }),
    ...(sessionId && { sessionId }),
    ...(error && { error: error instanceof Error ? error.message : String(error) }),
    ...(metadata && { metadata }),
  };

  console.error(JSON.stringify(logEntry));
}

function logInfo(message: string, context: LogContext): void {
  const timestamp = new Date().toISOString();
  const { component, operation, sessionId, metadata } = context;

  const logEntry = {
    timestamp,
    level: 'INFO',
    component,
    message,
    ...(operation && { operation }),
    ...(sessionId && { sessionId }),
    ...(metadata && { metadata }),
  };

  console.log(JSON.stringify(logEntry));
}

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
  private static readonly SCHEMA_VERSION = 1;

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
   * Initialize database schema with version tracking
   */
  private static initSchema(): void {
    const db = this.instance!;

    // Create schema_version table for migrations
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    // Check current schema version
    let currentVersion = 0;
    try {
      const result = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as any;
      currentVersion = result?.version || 0;
    } catch {
      // Table doesn't exist yet, version = 0
    }

    // Apply migrations if needed
    if (currentVersion < this.SCHEMA_VERSION) {
      this.migrate(db, currentVersion, this.SCHEMA_VERSION);
    }
  }

  /**
   * Apply database migrations
   */
  private static migrate(db: Database, fromVersion: number, toVersion: number): void {
    if (fromVersion < 1 && toVersion >= 1) {
      // Migration 1: Initial schema
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

      // Record migration
      db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (1, ${Date.now()})`);

      logInfo('Database schema initialized', {
        component: 'TelemetryDatabase',
        operation: 'migrate',
        metadata: { version: 1 },
      });
    }

    // Future migrations go here (if fromVersion < 2 && toVersion >= 2)
    // Example:
    // if (fromVersion < 2 && toVersion >= 2) {
    //   db.exec('ALTER TABLE telemetry ADD COLUMN newField TEXT');
    //   db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (2, ${Date.now()})`);
    // }
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
      logError('Failed to record telemetry entry', {
        component: 'TelemetryDatabase',
        operation: 'record',
        error,
      });
      return false;
    }
  }

  /**
   * Record from SessionHealth object
   * Convenience wrapper for record()
   */
  static recordFromHealth(health: SessionHealth, displayTimeMs: number): boolean {
    // Extract scanTimeMs from performance metrics if available
    const scanTimeMs = health.performance?.gatherDuration || 0;

    // Extract cacheHit from transcript metadata if available
    const cacheHit = health.transcript?.exists === true &&
                     health.transcript?.messageCount > 0;

    // Detect auth changes by comparing launch profile with current state
    // (if they differ, an auth change occurred during this session)
    const hasAuthChanges = false; // Default to false, will be updated by auth-changes-source

    // Extract slotId from SessionLock if available
    let slotId: string | null = null;
    try {
      const { SessionLockManager } = require('./session-lock-manager');
      const lock = SessionLockManager.read(health.sessionId);
      slotId = lock?.slotId || null;
    } catch {
      // SessionLock not available - not critical
    }

    const entry: TelemetryEntry = {
      timestamp: Date.now(),
      sessionId: health.sessionId,

      // Performance
      displayTimeMs,
      scanTimeMs,
      cacheHit,

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
      hasAuthChanges,
      transcriptStale: health.alerts.transcriptStale,
      billingStale: !health.billing.isFresh,

      // Metadata
      version: health.status.claudeVersion || 'unknown',
      slotId,
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

      // Validate timestamp ranges
      if (options.since !== undefined) {
        if (!Number.isInteger(options.since) || options.since < 0) {
          logError('Invalid since parameter', {
            component: 'TelemetryDatabase',
            operation: 'query',
            metadata: { since: options.since },
          });
          return [];
        }
        sql += ' AND timestamp >= ?';
        params.push(options.since);
      }

      if (options.until !== undefined) {
        if (!Number.isInteger(options.until) || options.until < 0) {
          logError('Invalid until parameter', {
            component: 'TelemetryDatabase',
            operation: 'query',
            metadata: { until: options.until },
          });
          return [];
        }
        sql += ' AND timestamp <= ?';
        params.push(options.until);
      }

      // Validate sessionId (prevent injection)
      if (options.sessionId !== undefined) {
        if (typeof options.sessionId !== 'string' || options.sessionId.length === 0) {
          logError('Invalid sessionId parameter', {
            component: 'TelemetryDatabase',
            operation: 'query',
            metadata: { sessionId: options.sessionId },
          });
          return [];
        }
        sql += ' AND sessionId = ?';
        params.push(options.sessionId);
      }

      sql += ' ORDER BY timestamp DESC';

      // Validate limit (prevent DoS)
      if (options.limit !== undefined) {
        if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 10000) {
          logError('Invalid limit parameter (must be 1-10000)', {
            component: 'TelemetryDatabase',
            operation: 'query',
            metadata: { limit: options.limit },
          });
          return [];
        }
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
      logError('Query failed', {
        component: 'TelemetryDatabase',
        operation: 'query',
        error,
      });
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
      logError('Failed to get session stats', {
        component: 'TelemetryDatabase',
        operation: 'getSessionStats',
        error,
      });
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
      logError('Failed to get daily stats', {
        component: 'TelemetryDatabase',
        operation: 'getDailyStats',
        error,
      });
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
        logInfo('Cleaned up old entries', {
          component: 'TelemetryDatabase',
          operation: 'cleanup',
          metadata: { deletedCount },
        });
      }

      // Vacuum to reclaim space
      db.exec('VACUUM');

      return deletedCount;
    } catch (error) {
      logError('Cleanup failed', {
        component: 'TelemetryDatabase',
        operation: 'cleanup',
        error,
      });
      return 0;
    }
  }

  /**
   * Close database connection
   * Should be called on shutdown to release resources
   */
  static close(): void {
    if (this.instance) {
      try {
        this.instance.close();
        logInfo('Database connection closed', {
          component: 'TelemetryDatabase',
          operation: 'close',
        });
      } catch (error) {
        logError('Failed to close database', {
          component: 'TelemetryDatabase',
          operation: 'close',
          error,
        });
      } finally {
        this.instance = null;
      }
    }
  }

  /**
   * Get current schema version
   * Useful for debugging and migration verification
   */
  static getSchemaVersion(): number {
    try {
      const db = this.getDb();
      const result = db.prepare('SELECT MAX(version) as version FROM schema_version').get() as any;
      return result?.version || 0;
    } catch {
      return 0;
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
