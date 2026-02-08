/**
 * Telemetry Dashboard CLI Tests
 *
 * Tests actual CLI commands, argument parsing, and error handling.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { TelemetryDatabase } from '../../src/lib/telemetry-database';
import { runCLI } from '../../src/cli/telemetry-dashboard';
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('TelemetryDashboard CLI', () => {
  const dbPath = join(homedir(), '.claude/session-health/telemetry.db');
  let consoleErrorSpy: any;
  let consoleLogSpy: any;

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
        timestamp: now - (i * 60000),
        sessionId: `session-${i % 2}`,
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

    // Spy on console methods
    consoleErrorSpy = spyOn(console, 'error').mockImplementation(() => {});
    consoleLogSpy = spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    TelemetryDatabase.close();
    consoleErrorSpy?.mockRestore();
    consoleLogSpy?.mockRestore();
  });

  test('summary command (default) returns success', () => {
    const exitCode = runCLI([]);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('summary command (explicit) returns success', () => {
    const exitCode = runCLI(['summary']);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('session command with valid ID returns success', () => {
    const exitCode = runCLI(['session', 'session-0']);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('session command without ID returns error', () => {
    const exitCode = runCLI(['session']);
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Missing session ID'));
  });

  test('session command with nonexistent ID returns error', () => {
    const exitCode = runCLI(['session', 'nonexistent-session']);
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No data found'));
  });

  test('daily command (no args) returns success', () => {
    const exitCode = runCLI(['daily']);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('daily command with valid date returns success', () => {
    const exitCode = runCLI(['daily', '2026-02-08']);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('daily command with invalid date returns error', () => {
    const exitCode = runCLI(['daily', 'invalid-date']);
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid date format'));
  });

  test('profiles command returns success', () => {
    const exitCode = runCLI(['profiles']);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('cleanup command returns success', () => {
    const exitCode = runCLI(['cleanup']);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalled();
  });

  test('help command returns success', () => {
    const exitCode = runCLI(['help']);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  test('--help flag returns success', () => {
    const exitCode = runCLI(['--help']);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  test('-h flag returns success', () => {
    const exitCode = runCLI(['-h']);
    expect(exitCode).toBe(0);
    expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
  });

  test('unknown command returns error', () => {
    const exitCode = runCLI(['unknown-command']);
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown command'));
  });

  test('empty database shows appropriate error', () => {
    // Remove all test data
    TelemetryDatabase.close();
    try {
      unlinkSync(dbPath);
    } catch { /* ignore */ }

    const exitCode = runCLI(['summary']);
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No data available'));
  });

  test('profiles command handles multiple auth profiles', () => {
    const exitCode = runCLI(['profiles']);
    expect(exitCode).toBe(0);

    // Verify output contains both profiles
    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('user1@example.com');
    expect(output).toContain('user2@example.com');
  });

  test('session command shows recent invocations table', () => {
    const exitCode = runCLI(['session', 'session-0']);
    expect(exitCode).toBe(0);

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Recent Invocations');
    expect(output).toContain('Display');
    expect(output).toContain('Cache');
  });

  test('daily command with future date shows no data error', () => {
    const exitCode = runCLI(['daily', '2030-01-01']);
    expect(exitCode).toBe(1);
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('No data found'));
  });

  test('summary command shows 7-day metrics', () => {
    const exitCode = runCLI(['summary']);
    expect(exitCode).toBe(0);

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('7-Day Summary');
    expect(output).toContain('Invocations');
    expect(output).toContain('Unique Sessions');
  });

  test('cleanup command removes old entries', () => {
    // Insert old entry (31 days ago)
    const oldTimestamp = Date.now() - (31 * 24 * 60 * 60 * 1000);
    TelemetryDatabase.record({
      timestamp: oldTimestamp,
      sessionId: 'old-session',
      displayTimeMs: 1,
      scanTimeMs: 0.5,
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

    const exitCode = runCLI(['cleanup']);
    expect(exitCode).toBe(0);

    const output = consoleLogSpy.mock.calls.flat().join('\n');
    expect(output).toContain('Removed');
  });
});
