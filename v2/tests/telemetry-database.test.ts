/**
 * Telemetry Database Tests
 *
 * Tests SQLite-based telemetry system for statusline invocations.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { TelemetryDatabase } from '../src/lib/telemetry-database';
import type { TelemetryEntry } from '../src/lib/telemetry-database';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('TelemetryDatabase', () => {
  const dbPath = join(homedir(), '.claude/session-health/telemetry.db');

  beforeEach(() => {
    // Close any existing connection
    TelemetryDatabase.close();

    // Remove existing database
    try {
      if (existsSync(dbPath)) {
        unlinkSync(dbPath);
      }
      if (existsSync(`${dbPath}-shm`)) {
        unlinkSync(`${dbPath}-shm`);
      }
      if (existsSync(`${dbPath}-wal`)) {
        unlinkSync(`${dbPath}-wal`);
      }
    } catch { /* ignore */ }
  });

  afterEach(() => {
    TelemetryDatabase.close();
  });

  test('record() creates database and inserts entry', () => {
    const entry: TelemetryEntry = {
      timestamp: Date.now(),
      sessionId: 'test-session',
      displayTimeMs: 5.2,
      scanTimeMs: 1.3,
      cacheHit: true,
      authProfile: 'test@example.com',
      model: 'Sonnet4.5',
      contextUsed: 50000,
      contextPercent: 25,
      sessionCost: 0.15,
      dailyCost: 2.5,
      burnRatePerHour: 10.0,
      hasSecrets: false,
      hasAuthChanges: true,
      transcriptStale: false,
      billingStale: false,
      version: '1.0.0',
      slotId: 'slot-123',
    };

    const success = TelemetryDatabase.record(entry);

    expect(success).toBe(true);
    expect(existsSync(dbPath)).toBe(true);
  });

  test('query() retrieves entries', () => {
    const now = Date.now();

    // Insert multiple entries
    for (let i = 0; i < 5; i++) {
      TelemetryDatabase.record({
        timestamp: now + i * 1000,
        sessionId: `session-${i}`,
        displayTimeMs: i + 1,
        scanTimeMs: 0.5,
        cacheHit: i % 2 === 0,
        authProfile: 'test@example.com',
        model: 'Sonnet4.5',
        contextUsed: 50000,
        contextPercent: 25,
        sessionCost: 0.1,
        dailyCost: 1.0,
        burnRatePerHour: 5.0,
        hasSecrets: false,
        hasAuthChanges: false,
        transcriptStale: false,
        billingStale: false,
        version: '1.0.0',
        slotId: null,
      });
    }

    const entries = TelemetryDatabase.query({});

    expect(entries.length).toBe(5);
    expect(entries[0].displayTimeMs).toBe(5); // Most recent first (DESC order)
  });

  test('query() filters by sessionId', () => {
    const now = Date.now();

    TelemetryDatabase.record({
      timestamp: now,
      sessionId: 'session-a',
      displayTimeMs: 1,
      scanTimeMs: 0.5,
      cacheHit: false,
      authProfile: 'test@example.com',
      model: 'Sonnet4.5',
      contextUsed: 50000,
      contextPercent: 25,
      sessionCost: 0.1,
      dailyCost: 1.0,
      burnRatePerHour: 5.0,
      hasSecrets: false,
      hasAuthChanges: false,
      transcriptStale: false,
      billingStale: false,
      version: '1.0.0',
      slotId: null,
    });

    TelemetryDatabase.record({
      timestamp: now + 1000,
      sessionId: 'session-b',
      displayTimeMs: 2,
      scanTimeMs: 0.5,
      cacheHit: false,
      authProfile: 'test@example.com',
      model: 'Sonnet4.5',
      contextUsed: 50000,
      contextPercent: 25,
      sessionCost: 0.1,
      dailyCost: 1.0,
      burnRatePerHour: 5.0,
      hasSecrets: false,
      hasAuthChanges: false,
      transcriptStale: false,
      billingStale: false,
      version: '1.0.0',
      slotId: null,
    });

    const entries = TelemetryDatabase.query({ sessionId: 'session-a' });

    expect(entries.length).toBe(1);
    expect(entries[0].sessionId).toBe('session-a');
  });

  test('query() filters by time range', () => {
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      TelemetryDatabase.record({
        timestamp: now + i * 60000, // 1 minute apart
        sessionId: 'test',
        displayTimeMs: 1,
        scanTimeMs: 0.5,
        cacheHit: false,
        authProfile: 'test@example.com',
        model: 'Sonnet4.5',
        contextUsed: 50000,
        contextPercent: 25,
        sessionCost: 0.1,
        dailyCost: 1.0,
        burnRatePerHour: 5.0,
        hasSecrets: false,
        hasAuthChanges: false,
        transcriptStale: false,
        billingStale: false,
        version: '1.0.0',
        slotId: null,
      });
    }

    const entries = TelemetryDatabase.query({
      since: now + 60000,
      until: now + 180000,
    });

    expect(entries.length).toBe(3); // Entries at +60s, +120s, +180s
  });

  test('query() limits results', () => {
    for (let i = 0; i < 10; i++) {
      TelemetryDatabase.record({
        timestamp: Date.now() + i,
        sessionId: 'test',
        displayTimeMs: 1,
        scanTimeMs: 0.5,
        cacheHit: false,
        authProfile: 'test@example.com',
        model: 'Sonnet4.5',
        contextUsed: 50000,
        contextPercent: 25,
        sessionCost: 0.1,
        dailyCost: 1.0,
        burnRatePerHour: 5.0,
        hasSecrets: false,
        hasAuthChanges: false,
        transcriptStale: false,
        billingStale: false,
        version: '1.0.0',
        slotId: null,
      });
    }

    const entries = TelemetryDatabase.query({ limit: 5 });

    expect(entries.length).toBe(5);
  });

  test('getSessionStats() calculates statistics', () => {
    const sessionId = 'test-session';

    for (let i = 0; i < 4; i++) {
      TelemetryDatabase.record({
        timestamp: Date.now() + i,
        sessionId,
        displayTimeMs: (i + 1) * 2, // 2, 4, 6, 8 (avg = 5)
        scanTimeMs: 0.5,
        cacheHit: i >= 2, // 2 cache hits out of 4
        authProfile: 'test@example.com',
        model: 'Sonnet4.5',
        contextUsed: 50000,
        contextPercent: 25,
        sessionCost: 0.1 * (i + 1), // 0.1, 0.2, 0.3, 0.4 (max = 0.4)
        dailyCost: 1.0,
        burnRatePerHour: 5.0,
        hasSecrets: false,
        hasAuthChanges: false,
        transcriptStale: false,
        billingStale: false,
        version: '1.0.0',
        slotId: null,
      });
    }

    const stats = TelemetryDatabase.getSessionStats(sessionId);

    expect(stats).not.toBe(null);
    expect(stats!.invocationCount).toBe(4);
    expect(stats!.avgDisplayTimeMs).toBe(5);
    expect(stats!.cacheHitRate).toBe(50);
    expect(stats!.totalCost).toBe(0.4);
  });

  test('getDailyStats() calculates daily statistics', () => {
    const now = new Date();

    // Insert entries for today
    for (let i = 0; i < 3; i++) {
      TelemetryDatabase.record({
        timestamp: now.getTime() + i * 1000,
        sessionId: `session-${i}`,
        displayTimeMs: (i + 1) * 3, // 3, 6, 9 (avg = 6)
        scanTimeMs: 0.5,
        cacheHit: false,
        authProfile: 'test@example.com',
        model: 'Sonnet4.5',
        contextUsed: 50000,
        contextPercent: 25,
        sessionCost: 0.1,
        dailyCost: 2.0,
        burnRatePerHour: 5.0,
        hasSecrets: false,
        hasAuthChanges: false,
        transcriptStale: false,
        billingStale: false,
        version: '1.0.0',
        slotId: null,
      });
    }

    const stats = TelemetryDatabase.getDailyStats(now);

    expect(stats).not.toBe(null);
    expect(stats!.invocationCount).toBe(3);
    expect(stats!.uniqueSessions).toBe(3);
    expect(stats!.avgDisplayTimeMs).toBe(6);
  });

  test('cleanup() removes old entries', () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - (31 * 24 * 60 * 60 * 1000);

    // Insert old entry
    TelemetryDatabase.record({
      timestamp: thirtyOneDaysAgo,
      sessionId: 'old-session',
      displayTimeMs: 1,
      scanTimeMs: 0.5,
      cacheHit: false,
      authProfile: 'test@example.com',
      model: 'Sonnet4.5',
      contextUsed: 50000,
      contextPercent: 25,
      sessionCost: 0.1,
      dailyCost: 1.0,
      burnRatePerHour: 5.0,
      hasSecrets: false,
      hasAuthChanges: false,
      transcriptStale: false,
      billingStale: false,
      version: '1.0.0',
      slotId: null,
    });

    // Insert recent entry
    TelemetryDatabase.record({
      timestamp: now,
      sessionId: 'recent-session',
      displayTimeMs: 1,
      scanTimeMs: 0.5,
      cacheHit: false,
      authProfile: 'test@example.com',
      model: 'Sonnet4.5',
      contextUsed: 50000,
      contextPercent: 25,
      sessionCost: 0.1,
      dailyCost: 1.0,
      burnRatePerHour: 5.0,
      hasSecrets: false,
      hasAuthChanges: false,
      transcriptStale: false,
      billingStale: false,
      version: '1.0.0',
      slotId: null,
    });

    const deletedCount = TelemetryDatabase.cleanup();

    expect(deletedCount).toBe(1);

    const remaining = TelemetryDatabase.query({});
    expect(remaining.length).toBe(1);
    expect(remaining[0].sessionId).toBe('recent-session');
  });

  test('getCount() returns entry count', () => {
    for (let i = 0; i < 5; i++) {
      TelemetryDatabase.record({
        timestamp: Date.now() + i,
        sessionId: 'test',
        displayTimeMs: 1,
        scanTimeMs: 0.5,
        cacheHit: false,
        authProfile: 'test@example.com',
        model: 'Sonnet4.5',
        contextUsed: 50000,
        contextPercent: 25,
        sessionCost: 0.1,
        dailyCost: 1.0,
        burnRatePerHour: 5.0,
        hasSecrets: false,
        hasAuthChanges: false,
        transcriptStale: false,
        billingStale: false,
        version: '1.0.0',
        slotId: null,
      });
    }

    const count = TelemetryDatabase.getCount();
    expect(count).toBe(5);
  });

  test('getSize() returns database file size', () => {
    TelemetryDatabase.record({
      timestamp: Date.now(),
      sessionId: 'test',
      displayTimeMs: 1,
      scanTimeMs: 0.5,
      cacheHit: false,
      authProfile: 'test@example.com',
      model: 'Sonnet4.5',
      contextUsed: 50000,
      contextPercent: 25,
      sessionCost: 0.1,
      dailyCost: 1.0,
      burnRatePerHour: 5.0,
      hasSecrets: false,
      hasAuthChanges: false,
      transcriptStale: false,
      billingStale: false,
      version: '1.0.0',
      slotId: null,
    });

    const size = TelemetryDatabase.getSize();
    expect(size).toBeGreaterThan(0);
  });
});
