/**
 * Tests for Durable Object Data Model
 *
 * Covers: type encoding/decoding, serialization round-trip,
 * size constraint (<5KB), hash stability, delta encoding,
 * change detection.
 */

import { describe, test, expect } from 'bun:test';
import {
  DurableSessionState,
  ALERT_FLAGS,
  encodeAlerts,
  decodeAlerts,
  encodeStatus,
  decodeStatus,
  deltaEncode,
  deltaDecode,
} from '../src/types/durable-state';
import { StateSerializer } from '../src/lib/state-serializer';
import { ChangeDetector } from '../src/lib/change-detector';
import { createDefaultHealth, SessionHealth } from '../src/types/session-health';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTypicalHealth(): SessionHealth {
  const health = createDefaultHealth('session-abc-123');
  health.projectPath = '/Users/vmks/projects/my-app';
  health.transcriptPath = '/Users/vmks/.claude/projects/-Users-vmks-projects-my-app/session-abc-123.jsonl';
  health.launch.authProfile = 'user@example.com';
  health.launch.detectionMethod = 'path';
  health.launch.configDir = '/Users/vmks/.claude-slot-2';

  health.health.status = 'warning';
  health.health.issues = ['Billing data stale', 'Context window 75% full'];

  health.billing.costToday = 42.50;
  health.billing.burnRatePerHour = 15.10;
  health.billing.budgetPercentUsed = 62;
  health.billing.budgetRemaining = 120;
  health.billing.resetTime = '14:00';
  health.billing.lastFetched = Date.now() - 60_000;
  health.billing.isFresh = true;
  health.billing.weeklyBudgetPercentUsed = 35;
  health.billing.weeklyBudgetRemaining = 85;
  health.billing.weeklyResetDay = 'Thu';
  health.billing.weeklyLastModified = Date.now() - 120_000;

  health.model.value = 'Opus4.5';
  health.model.source = 'jsonInput';
  health.model.confidence = 95;

  health.context.tokensUsed = 80000;
  health.context.tokensLeft = 76000;
  health.context.percentUsed = 51;
  health.context.windowSize = 200000;

  health.git.branch = 'feature/deep-review';
  health.git.dirty = 3;
  health.git.lastChecked = Date.now();

  health.transcript.exists = true;
  health.transcript.sizeBytes = 150000;
  health.transcript.messageCount = 42;
  health.transcript.lastModified = Date.now() - 30_000;
  health.transcript.lastMessageTime = Date.now() - 30_000;
  health.transcript.isSynced = true;

  health.alerts.secretsDetected = false;
  health.alerts.transcriptStale = false;
  health.alerts.dataLossRisk = false;

  health.firstSeen = Date.now() - 3_600_000;
  health.gatheredAt = Date.now();
  health.sessionDuration = 3_600_000;

  return health;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Durable Object Data Model', () => {

  // =========================================================================
  // Alert encoding
  // =========================================================================

  describe('alert flags', () => {
    test('no alerts → 0', () => {
      expect(encodeAlerts({
        secretsDetected: false,
        transcriptStale: false,
        dataLossRisk: false,
      })).toBe(0);
    });

    test('all alerts → 7', () => {
      expect(encodeAlerts({
        secretsDetected: true,
        transcriptStale: true,
        dataLossRisk: true,
      })).toBe(7);
    });

    test('secrets only → 1', () => {
      expect(encodeAlerts({
        secretsDetected: true,
        transcriptStale: false,
        dataLossRisk: false,
      })).toBe(1);
    });

    test('round-trip preservation', () => {
      const original = { secretsDetected: true, transcriptStale: false, dataLossRisk: true };
      const encoded = encodeAlerts(original);
      const decoded = decodeAlerts(encoded);
      expect(decoded).toEqual(original);
    });
  });

  // =========================================================================
  // Status encoding
  // =========================================================================

  describe('status encoding', () => {
    test('healthy → h', () => expect(encodeStatus('healthy')).toBe('h'));
    test('warning → w', () => expect(encodeStatus('warning')).toBe('w'));
    test('critical → c', () => expect(encodeStatus('critical')).toBe('c'));
    test('unknown → u', () => expect(encodeStatus('unknown')).toBe('u'));
    test('invalid → u', () => expect(encodeStatus('bogus')).toBe('u'));

    test('round-trip', () => {
      for (const s of ['healthy', 'warning', 'critical', 'unknown']) {
        expect(decodeStatus(encodeStatus(s))).toBe(s);
      }
    });
  });

  // =========================================================================
  // Delta encoding
  // =========================================================================

  describe('delta encoding', () => {
    test('encode simple ascending', () => {
      expect(deltaEncode([100, 105, 103, 110])).toEqual([100, 5, -2, 7]);
    });

    test('decode reverses encode', () => {
      const original = [100, 105, 103, 110, 108, 120];
      expect(deltaDecode(deltaEncode(original))).toEqual(original);
    });

    test('empty array', () => {
      expect(deltaEncode([])).toEqual([]);
      expect(deltaDecode([])).toEqual([]);
    });

    test('single value', () => {
      expect(deltaEncode([42])).toEqual([42]);
      expect(deltaDecode([42])).toEqual([42]);
    });

    test('constant values → all zeros after first', () => {
      expect(deltaEncode([50, 50, 50, 50])).toEqual([50, 0, 0, 0]);
    });
  });

  // =========================================================================
  // Serialization
  // =========================================================================

  describe('StateSerializer', () => {
    test('serialize produces valid DurableSessionState', () => {
      const health = makeTypicalHealth();
      const state = StateSerializer.serialize(health);

      expect(state.v).toBe(1);
      expect(state.sid).toBe('session-abc-123');
      expect(state.aid).toBe('user@example.com');
    });

    test('dollar → cents conversion', () => {
      const health = makeTypicalHealth();
      const state = StateSerializer.serialize(health);

      expect(state.bd.ct).toBe(4250); // $42.50 → 4250 cents
      expect(state.bd.br).toBe(1510); // $15.10 → 1510 cents/hr
    });

    test('weekly billing included when present', () => {
      const health = makeTypicalHealth();
      const state = StateSerializer.serialize(health);

      expect(state.bw).toBeDefined();
      expect(state.bw!.wp).toBe(35);
      expect(state.bw!.wh).toBe(85);
      expect(state.bw!.rd).toBe('Thu');
    });

    test('weekly billing omitted when absent', () => {
      const health = makeTypicalHealth();
      delete (health.billing as any).weeklyBudgetPercentUsed;
      const state = StateSerializer.serialize(health);

      expect(state.bw).toBeUndefined();
    });

    test('git included when branch exists', () => {
      const health = makeTypicalHealth();
      const state = StateSerializer.serialize(health);

      expect(state.gt).toBeDefined();
      expect(state.gt!.br).toBe('feature/deep-review');
      expect(state.gt!.dt).toBe(3);
    });

    test('git omitted when no branch', () => {
      const health = makeTypicalHealth();
      health.git.branch = '';
      const state = StateSerializer.serialize(health);

      expect(state.gt).toBeUndefined();
    });

    test('issue truncation', () => {
      const health = makeTypicalHealth();
      health.health.issues = [
        'A'.repeat(60), // >50 chars
        'B'.repeat(40), // <50 chars
        'C'.repeat(100),
        'D'.repeat(20), // 4th issue (should be dropped)
      ];
      const state = StateSerializer.serialize(health);

      expect(state.hs.is).toHaveLength(3);
      expect(state.hs.is[0]).toHaveLength(51); // 50 + '…'
      expect(state.hs.is[1]).toHaveLength(40);
      expect(state.hs.is[0].endsWith('…')).toBe(true);
    });

    test('model and context combined', () => {
      const health = makeTypicalHealth();
      const state = StateSerializer.serialize(health);

      expect(state.mc.mv).toBe('Opus4.5');
      expect(state.mc.cf).toBe(95);
      expect(state.mc.tu).toBe(80000);
      expect(state.mc.tl).toBe(76000);
      expect(state.mc.cp).toBe(51);
      expect(state.mc.nc).toBe(false);
    });
  });

  // =========================================================================
  // Deserialization (round-trip)
  // =========================================================================

  describe('round-trip', () => {
    test('serialize → deserialize preserves key fields', () => {
      const original = makeTypicalHealth();
      const state = StateSerializer.serialize(original);
      const restored = StateSerializer.deserialize(state);

      // Identity
      expect(restored.sessionId).toBe(original.sessionId);
      expect(restored.launch.authProfile).toBe(original.launch.authProfile);

      // Health
      expect(restored.health.status).toBe(original.health.status);

      // Billing (cents → dollars may have rounding)
      expect(restored.billing.costToday).toBeCloseTo(original.billing.costToday, 1);
      expect(restored.billing.burnRatePerHour).toBeCloseTo(original.billing.burnRatePerHour, 1);
      expect(restored.billing.budgetPercentUsed).toBe(original.billing.budgetPercentUsed);

      // Weekly
      expect(restored.billing.weeklyBudgetPercentUsed).toBe(original.billing.weeklyBudgetPercentUsed);

      // Transcript
      expect(restored.transcript.sizeBytes).toBe(original.transcript.sizeBytes);
      expect(restored.transcript.messageCount).toBe(original.transcript.messageCount);
      expect(restored.transcript.isSynced).toBe(original.transcript.isSynced);

      // Model + Context
      expect(restored.model.value).toBe(original.model.value);
      expect(restored.model.confidence).toBe(original.model.confidence);
      expect(restored.context.tokensUsed).toBe(original.context.tokensUsed);
      expect(restored.context.percentUsed).toBe(original.context.percentUsed);

      // Git
      expect(restored.git.branch).toBe(original.git.branch);
      expect(restored.git.dirty).toBe(original.git.dirty);

      // Alerts
      expect(restored.alerts.secretsDetected).toBe(original.alerts.secretsDetected);
      expect(restored.alerts.transcriptStale).toBe(original.alerts.transcriptStale);
      expect(restored.alerts.dataLossRisk).toBe(original.alerts.dataLossRisk);
    });

    test('default health round-trips', () => {
      const original = createDefaultHealth('minimal');
      const state = StateSerializer.serialize(original);
      const restored = StateSerializer.deserialize(state);

      expect(restored.sessionId).toBe('minimal');
      expect(restored.billing.costToday).toBe(0);
    });
  });

  // =========================================================================
  // Size constraint
  // =========================================================================

  describe('size constraint', () => {
    test('typical session < 5KB', () => {
      const health = makeTypicalHealth();
      const state = StateSerializer.serialize(health);
      const size = StateSerializer.estimateSize(state);

      expect(size).toBeLessThan(5120); // 5KB
    });

    test('minimal session < 1KB', () => {
      const health = createDefaultHealth('min');
      const state = StateSerializer.serialize(health);
      const size = StateSerializer.estimateSize(state);

      expect(size).toBeLessThan(1024); // 1KB
    });

    test('worst case (max issues, long branch) < 5KB', () => {
      const health = makeTypicalHealth();
      health.health.issues = [
        'A'.repeat(50),
        'B'.repeat(50),
        'C'.repeat(50),
      ];
      health.git.branch = 'feature/' + 'x'.repeat(100);
      const state = StateSerializer.serialize(health);
      const size = StateSerializer.estimateSize(state);

      expect(size).toBeLessThan(5120);
    });
  });

  // =========================================================================
  // Change Detection
  // =========================================================================

  describe('ChangeDetector', () => {
    test('same data → same hash', () => {
      const health = makeTypicalHealth();
      const state1 = StateSerializer.serialize(health);
      const state2 = StateSerializer.serialize(health);

      const hash1 = ChangeDetector.computeHash(state1);
      const hash2 = ChangeDetector.computeHash(state2);

      expect(hash1).toBe(hash2);
    });

    test('different cost → different hash', () => {
      const health1 = makeTypicalHealth();
      const health2 = makeTypicalHealth();
      health2.billing.costToday = 99.99;

      const hash1 = ChangeDetector.computeHash(StateSerializer.serialize(health1));
      const hash2 = ChangeDetector.computeHash(StateSerializer.serialize(health2));

      expect(hash1).not.toBe(hash2);
    });

    test('different model → different hash', () => {
      const health1 = makeTypicalHealth();
      const health2 = makeTypicalHealth();
      health2.model.value = 'Sonnet4';

      const hash1 = ChangeDetector.computeHash(StateSerializer.serialize(health1));
      const hash2 = ChangeDetector.computeHash(StateSerializer.serialize(health2));

      expect(hash1).not.toBe(hash2);
    });

    test('hasChanged returns true for new state', () => {
      const state = StateSerializer.serialize(makeTypicalHealth());
      // Hash is empty string initially
      expect(ChangeDetector.hasChanged(state)).toBe(true);
    });

    test('stamp sets hash and returns true on change', () => {
      const state = StateSerializer.serialize(makeTypicalHealth());
      const changed = ChangeDetector.stamp(state);

      expect(changed).toBe(true);
      expect(state.meta.hash).toMatch(/^[0-9a-f]{8}$/);
      expect(state.meta.uc).toBe(1);
    });

    test('stamp returns false when unchanged', () => {
      const state = StateSerializer.serialize(makeTypicalHealth());
      ChangeDetector.stamp(state);

      // Stamp again with no changes
      const changed = ChangeDetector.stamp(state);
      expect(changed).toBe(false);
      expect(state.meta.uc).toBe(1); // Not incremented
    });

    test('hash is 8-character hex', () => {
      const state = StateSerializer.serialize(makeTypicalHealth());
      const hash = ChangeDetector.computeHash(state);
      expect(hash).toMatch(/^[0-9a-f]{8}$/);
    });

    test('alert change detected', () => {
      const health1 = makeTypicalHealth();
      const health2 = makeTypicalHealth();
      health2.alerts.secretsDetected = true;

      const hash1 = ChangeDetector.computeHash(StateSerializer.serialize(health1));
      const hash2 = ChangeDetector.computeHash(StateSerializer.serialize(health2));

      expect(hash1).not.toBe(hash2);
    });
  });
});
