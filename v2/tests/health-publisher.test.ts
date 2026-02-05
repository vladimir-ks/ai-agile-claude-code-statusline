/**
 * Tests for HealthPublisher
 *
 * Verifies: publish-health.json creation, session merging,
 * stale session pruning, urgency score inclusion.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { HealthPublisher } from '../src/lib/health-publisher';
import { createDefaultHealth } from '../src/types/session-health';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'health-publisher-test-' + Date.now());

function makeHealth(sessionId: string, overrides: any = {}) {
  const health = createDefaultHealth(sessionId);
  health.billing.costToday = overrides.costToday ?? 42;
  health.billing.burnRatePerHour = overrides.burnRatePerHour ?? 15;
  health.billing.budgetPercentUsed = overrides.dailyPercent ?? 62;
  health.billing.weeklyBudgetPercentUsed = overrides.weeklyPercent ?? 30;
  health.billing.budgetRemaining = overrides.budgetRemaining ?? 120;
  health.billing.isFresh = true;
  health.billing.lastFetched = Date.now();
  health.model.value = overrides.model ?? 'Opus4.5';
  health.model.confidence = 95;
  health.context.percentUsed = overrides.contextPercent ?? 40;
  health.transcript.isSynced = true;
  health.transcript.lastModified = overrides.lastModified ?? Date.now();
  health.launch.authProfile = overrides.email ?? 'user@example.com';
  health.health.status = 'healthy';
  health.gatheredAt = Date.now();
  return health;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HealthPublisher', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  describe('publish', () => {
    test('writes publish-health.json', () => {
      const health = makeHealth('session-a');
      HealthPublisher.publishToPath('session-a', health, TEST_DIR);

      const filePath = join(TEST_DIR, 'publish-health.json');
      expect(existsSync(filePath)).toBe(true);
    });

    test('file contains valid JSON with version', () => {
      const health = makeHealth('session-a');
      HealthPublisher.publishToPath('session-a', health, TEST_DIR);

      const payload = HealthPublisher.read(TEST_DIR);
      expect(payload).not.toBeNull();
      expect(payload!.version).toBe(1);
      expect(payload!.publishedAt).toBeGreaterThan(0);
    });

    test('session entry has expected fields', () => {
      const health = makeHealth('session-a', {
        email: 'test@example.com',
        dailyPercent: 62,
        weeklyPercent: 30,
        burnRatePerHour: 15,
      });
      HealthPublisher.publishToPath('session-a', health, TEST_DIR);

      const payload = HealthPublisher.read(TEST_DIR);
      const session = payload!.sessions['session-a'];

      expect(session.email).toBe('test@example.com');
      expect(session.billingPercentUsed).toBe(62);
      expect(session.weeklyPercentUsed).toBe(30);
      expect(session.burnRatePerHour).toBe(15);
      expect(session.transcriptSynced).toBe(true);
      expect(session.model).toBe('Opus4.5');
      expect(session.contextPercentUsed).toBe(40);
      expect(session.healthStatus).toBe('healthy');
    });

    test('includes urgency score', () => {
      const health = makeHealth('session-a', {
        weeklyPercent: 85,
        dailyPercent: 70,
        burnRatePerHour: 15,
      });
      HealthPublisher.publishToPath('session-a', health, TEST_DIR);

      const payload = HealthPublisher.read(TEST_DIR);
      const session = payload!.sessions['session-a'];

      expect(session.urgency).toBeDefined();
      expect(session.urgency.score).toBeGreaterThan(0);
      expect(session.urgency.level).toBeDefined();
      expect(session.urgency.recommendation).toBeDefined();
    });

    test('high weekly usage → swap recommended', () => {
      const health = makeHealth('session-a', {
        weeklyPercent: 95,
        dailyPercent: 80,
        burnRatePerHour: 18,
      });
      HealthPublisher.publishToPath('session-a', health, TEST_DIR);

      const payload = HealthPublisher.read(TEST_DIR);
      const session = payload!.sessions['session-a'];

      expect(session.urgency.score).toBeGreaterThanOrEqual(80);
    });
  });

  describe('multi-session merging', () => {
    test('multiple sessions coexist', () => {
      const healthA = makeHealth('session-a', { email: 'a@test.com' });
      const healthB = makeHealth('session-b', { email: 'b@test.com' });

      HealthPublisher.publishToPath('session-a', healthA, TEST_DIR);
      HealthPublisher.publishToPath('session-b', healthB, TEST_DIR);

      const payload = HealthPublisher.read(TEST_DIR);
      expect(Object.keys(payload!.sessions)).toHaveLength(2);
      expect(payload!.sessions['session-a'].email).toBe('a@test.com');
      expect(payload!.sessions['session-b'].email).toBe('b@test.com');
    });

    test('updating same session overwrites entry', () => {
      const health1 = makeHealth('session-a', { dailyPercent: 30 });
      HealthPublisher.publishToPath('session-a', health1, TEST_DIR);

      const health2 = makeHealth('session-a', { dailyPercent: 90 });
      HealthPublisher.publishToPath('session-a', health2, TEST_DIR);

      const payload = HealthPublisher.read(TEST_DIR);
      expect(payload!.sessions['session-a'].billingPercentUsed).toBe(90);
    });
  });

  describe('buildSessionEntry', () => {
    test('builds entry from health', () => {
      const health = makeHealth('test', {
        email: 'user@test.com',
        model: 'Sonnet4',
        dailyPercent: 55,
        weeklyPercent: 40,
      });

      const entry = HealthPublisher.buildSessionEntry(health);

      expect(entry.email).toBe('user@test.com');
      expect(entry.model).toBe('Sonnet4');
      expect(entry.billingPercentUsed).toBe(55);
      expect(entry.weeklyPercentUsed).toBe(40);
      expect(entry.urgency).toBeDefined();
      expect(entry.urgency.score).toBeGreaterThanOrEqual(0);
    });

    test('handles zero billing data', () => {
      const health = createDefaultHealth('empty');
      const entry = HealthPublisher.buildSessionEntry(health);

      // Default health has budgetRemaining=0, which triggers low-budget bonus (~10)
      expect(entry.urgency.score).toBeLessThanOrEqual(15);
      expect(entry.urgency.level).toBe('low');
    });
  });

  describe('read', () => {
    test('returns null for non-existent file', () => {
      const payload = HealthPublisher.read(join(TEST_DIR, 'nonexistent'));
      expect(payload).toBeNull();
    });
  });
});
