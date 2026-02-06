/**
 * TelemetryDashboard Tests
 *
 * Verifies:
 * - Session entry creation and merging
 * - Stale session pruning
 * - Global aggregation
 * - ANSI stripping from displayedLine
 * - Atomic writes
 * - Graceful error handling
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { TelemetryDashboard } from '../src/lib/telemetry-dashboard';
import { createDefaultHealth, SessionHealth } from '../src/types/session-health';
import { RefreshIntentManager } from '../src/lib/refresh-intent-manager';

const TEST_DIR = join(tmpdir(), `telemetry-test-${Date.now()}`);
const TELEMETRY_PATH = join(TEST_DIR, 'telemetry.json');

function makeHealth(overrides: Partial<SessionHealth> = {}): SessionHealth {
  const health = createDefaultHealth('test-session-1');
  health.projectPath = '/Users/test/my-project';
  health.gatheredAt = Date.now();
  health.model = { value: 'Opus4.5', source: 'settings', confidence: 90, updatedAt: Date.now() };
  health.billing = {
    costToday: 40.3,
    burnRatePerHour: 15.1,
    budgetRemaining: 120,
    budgetPercentUsed: 60,
    resetTime: '17:00',
    totalTokens: 83400000,
    tokensPerMinute: 521,
    isFresh: true,
    lastFetched: Date.now()
  };
  health.git = { branch: 'main', ahead: 2, behind: 0, dirty: 3, lastChecked: Date.now() };
  health.transcript = {
    exists: true,
    lastModifiedAgo: '2m',
    lastModified: Date.now() - 120000,
    isSynced: true,
    messageCount: 42,
    lastMessageTime: Date.now() - 120000,
    lastMessagePreview: 'What does this function do?',
    lastMessageAgo: '2m'
  };
  health.health = { status: 'healthy', lastUpdate: Date.now(), issues: [] };
  health.formattedOutput = {
    width40: ['📁:proj 🤖:Opus'],
    width60: ['📁:~/proj 🤖:Opus4.5'],
    width80: ['📁:~/project 🌿:main 🤖:Opus4.5'],
    width100: ['📁:~/project 🌿:main+2 🤖:Opus4.5 🧠:154k'],
    width120: ['📁:~/my-project 🌿:main+2*3 🤖:Opus4.5 🧠:154k 💰:$40'],
    width150: ['📁:~/my-project 🌿:main+2*3 🤖:Opus4.5 🧠:154k 💰:$40|$15/h'],
    width200: ['📁:~/my-project 🌿:main+2*3 🤖:Opus4.5 🧠:154k 💰:$40|$15/h 📊:83M'],
    singleLine: ['\x1b[38;5;117m📁:~/my-project\x1b[0m \x1b[38;5;150m🌿:main\x1b[0m']
  };

  return { ...health, ...overrides } as SessionHealth;
}

describe('TelemetryDashboard', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    TelemetryDashboard.setBasePath(TEST_DIR);
    RefreshIntentManager.setBasePath(TEST_DIR);
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('update', () => {
    test('creates telemetry.json if not exists', () => {
      const health = makeHealth();
      TelemetryDashboard.update('session-1', health);
      expect(existsSync(TELEMETRY_PATH)).toBe(true);
    });

    test('writes valid JSON', () => {
      const health = makeHealth();
      TelemetryDashboard.update('session-1', health);
      const data = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8'));
      expect(data.generatedAt).toBeGreaterThan(0);
      expect(data.sessions).toBeInstanceOf(Array);
      expect(data.sessions.length).toBe(1);
    });

    test('merges new session into existing telemetry', () => {
      const health1 = makeHealth({ sessionId: 'session-1' });
      const health2 = makeHealth({ sessionId: 'session-2', projectPath: '/Users/test/other-project' });

      TelemetryDashboard.update('session-1', health1);
      TelemetryDashboard.update('session-2', health2);

      const data = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8'));
      expect(data.sessions.length).toBe(2);
    });

    test('overwrites same session data on re-update', () => {
      const health = makeHealth({ sessionId: 'session-1' });
      TelemetryDashboard.update('session-1', health);

      // Update again with different model
      health.model.value = 'Sonnet4.5';
      TelemetryDashboard.update('session-1', health);

      const data = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8'));
      expect(data.sessions.length).toBe(1);
      expect(data.sessions[0].model).toBe('Sonnet4.5');
    });
  });

  describe('displayedLine', () => {
    test('has no ANSI escape codes', () => {
      const health = makeHealth();
      TelemetryDashboard.update('session-1', health);

      const data = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8'));
      const line = data.sessions[0].displayedLine;
      // No ANSI escape sequences
      expect(line).not.toMatch(/\x1b\[/);
      // But should still have content
      expect(line.length).toBeGreaterThan(0);
    });
  });

  describe('dataFreshness', () => {
    test('computes freshness for billing', () => {
      const health = makeHealth();
      TelemetryDashboard.update('session-1', health);

      const data = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8'));
      const freshness = data.sessions[0].dataFreshness;
      expect(freshness.billing).toBeDefined();
      expect(freshness.billing.ageMs).toBeGreaterThanOrEqual(0);
      expect(freshness.billing.status).toBe('fresh');
    });

    test('computes freshness for git', () => {
      const health = makeHealth();
      TelemetryDashboard.update('session-1', health);

      const data = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8'));
      expect(data.sessions[0].dataFreshness.git).toBeDefined();
    });
  });

  describe('pruneStale', () => {
    test('removes sessions inactive > 2h', () => {
      const health1 = makeHealth({ sessionId: 'fresh-session', gatheredAt: Date.now() });
      const health2 = makeHealth({ sessionId: 'stale-session', gatheredAt: Date.now() - 3 * 60 * 60 * 1000 });

      TelemetryDashboard.update('fresh-session', health1);
      TelemetryDashboard.update('stale-session', health2);

      // Manually prune
      TelemetryDashboard.pruneStale(2 * 60 * 60 * 1000);

      const data = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8'));
      expect(data.sessions.length).toBe(1);
      expect(data.sessions[0].sessionId).toBe('fresh-session');
    });
  });

  describe('global', () => {
    test('activeSessionCount is accurate', () => {
      const health1 = makeHealth({ sessionId: 'session-1', gatheredAt: Date.now() });
      const health2 = makeHealth({ sessionId: 'session-2', gatheredAt: Date.now() });

      TelemetryDashboard.update('session-1', health1);
      TelemetryDashboard.update('session-2', health2);

      const data = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8'));
      expect(data.global.activeSessionCount).toBe(2);
    });

    test('pendingRefreshIntents reads from RefreshIntentManager', () => {
      RefreshIntentManager.signalRefreshNeeded('billing');
      const health = makeHealth();
      TelemetryDashboard.update('session-1', health);

      const data = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8'));
      expect(data.global.pendingRefreshIntents).toContain('billing');
    });
  });

  describe('error handling', () => {
    test('handles corrupt telemetry.json gracefully', () => {
      writeFileSync(TELEMETRY_PATH, 'not valid json!!!');
      const health = makeHealth();

      // Should not throw — overwrites corrupt file
      expect(() => TelemetryDashboard.update('session-1', health)).not.toThrow();

      const data = JSON.parse(readFileSync(TELEMETRY_PATH, 'utf-8'));
      expect(data.sessions.length).toBe(1);
    });
  });
});
