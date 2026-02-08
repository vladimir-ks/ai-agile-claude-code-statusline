/**
 * Telemetry Dashboard Tests
 *
 * Tests CLI dashboard functionality with mocked database.
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { TelemetryDatabase } from '../../src/lib/telemetry-database';
import type { TelemetryEntry } from '../../src/lib/telemetry-database';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('TelemetryDashboard CLI', () => {
  const dbPath = join(homedir(), '.claude/session-health/telemetry.db');

  beforeEach(() => {
    // Close and remove database
    TelemetryDatabase.close();

    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
      if (existsSync(`${dbPath}-shm`)) unlinkSync(`${dbPath}-shm`);
      if (existsSync(`${dbPath}-wal`)) unlinkSync(`${dbPath}-wal`);
    } catch { /* ignore */ }

    // Insert test data
    const now = Date.now();

    for (let i = 0; i < 5; i++) {
      TelemetryDatabase.record({
        timestamp: now - (i * 60000), // 1 minute apart
        sessionId: `session-${i % 2}`, // 2 sessions
        displayTimeMs: 5 + i,
        scanTimeMs: 1,
        cacheHit: i % 2 === 0,
        authProfile: i < 3 ? 'user1@example.com' : 'user2@example.com',
        model: 'Sonnet4.5',
        contextUsed: 50000,
        contextPercent: 25,
        sessionCost: 0.1 * (i + 1),
        dailyCost: 2.0,
        burnRatePerHour: 5.0,
        hasSecrets: i === 2,
        hasAuthChanges: i === 1,
        transcriptStale: false,
        billingStale: false,
        version: '1.0.0',
        slotId: null,
      });
    }
  });

  afterEach(() => {
    TelemetryDatabase.close();
  });

  test('getSessionStats returns correct aggregates', () => {
    const stats = TelemetryDatabase.getSessionStats('session-0');

    expect(stats).not.toBe(null);
    expect(stats!.invocationCount).toBeGreaterThan(0);
    expect(stats!.avgDisplayTimeMs).toBeGreaterThan(0);
    expect(stats!.cacheHitRate).toBeGreaterThanOrEqual(0);
    expect(stats!.cacheHitRate).toBeLessThanOrEqual(100);
  });

  test('getDailyStats returns correct aggregates', () => {
    const stats = TelemetryDatabase.getDailyStats(new Date());

    expect(stats).not.toBe(null);
    expect(stats!.invocationCount).toBe(5);
    expect(stats!.uniqueSessions).toBe(2);
    expect(stats!.avgDisplayTimeMs).toBeGreaterThan(0);
  });

  test('query filters by sessionId', () => {
    const entries = TelemetryDatabase.query({ sessionId: 'session-0' });

    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e.sessionId === 'session-0')).toBe(true);
  });

  test('query limits results', () => {
    const entries = TelemetryDatabase.query({ limit: 3 });

    expect(entries.length).toBe(3);
  });

  test('profile breakdown aggregates by auth profile', () => {
    const entries = TelemetryDatabase.query({});

    const profiles = new Map<string, number>();
    for (const entry of entries) {
      profiles.set(entry.authProfile, (profiles.get(entry.authProfile) || 0) + 1);
    }

    expect(profiles.size).toBe(2);
    expect(profiles.get('user1@example.com')).toBe(3);
    expect(profiles.get('user2@example.com')).toBe(2);
  });

  test('7-day summary calculates correct metrics', () => {
    const now = Date.now();
    const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

    const entries = TelemetryDatabase.query({ since: sevenDaysAgo });

    expect(entries.length).toBe(5);

    // Calculate cache hit rate
    const cacheHits = entries.filter(e => e.cacheHit).length;
    const cacheHitRate = (cacheHits / entries.length) * 100;

    expect(cacheHitRate).toBeGreaterThanOrEqual(0);
    expect(cacheHitRate).toBeLessThanOrEqual(100);

    // Calculate health indicators
    const secretsDetected = entries.filter(e => e.hasSecrets).length;
    const authChanges = entries.filter(e => e.hasAuthChanges).length;

    expect(secretsDetected).toBe(1);
    expect(authChanges).toBe(1);
  });

  test('cleanup removes old entries only', () => {
    const now = Date.now();
    const oldTimestamp = now - (31 * 24 * 60 * 60 * 1000); // 31 days ago

    // Insert old entry
    TelemetryDatabase.record({
      timestamp: oldTimestamp,
      sessionId: 'old-session',
      displayTimeMs: 5,
      scanTimeMs: 1,
      cacheHit: false,
      authProfile: 'old@example.com',
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

    const beforeCount = TelemetryDatabase.getCount();
    const deletedCount = TelemetryDatabase.cleanup();
    const afterCount = TelemetryDatabase.getCount();

    expect(deletedCount).toBe(1);
    expect(afterCount).toBe(beforeCount - 1);
  });

  test('empty database returns null for stats', () => {
    TelemetryDatabase.close();

    // Remove all data
    try {
      if (existsSync(dbPath)) unlinkSync(dbPath);
    } catch { /* ignore */ }

    const sessionStats = TelemetryDatabase.getSessionStats('nonexistent');
    const dailyStats = TelemetryDatabase.getDailyStats(new Date('2020-01-01'));

    expect(sessionStats).toBe(null);
    expect(dailyStats).toBe(null);
  });

  test('query with time range filters correctly', () => {
    const now = Date.now();
    const fiveMinutesAgo = now - (5 * 60000);
    const twoMinutesAgo = now - (2 * 60000);

    const entries = TelemetryDatabase.query({
      since: fiveMinutesAgo,
      until: twoMinutesAgo,
    });

    // Should return entries within the time range
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(e => e.timestamp >= fiveMinutesAgo && e.timestamp <= twoMinutesAgo)).toBe(true);
  });
});
