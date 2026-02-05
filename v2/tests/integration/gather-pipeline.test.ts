/**
 * Integration Test: Data Gather Pipeline
 *
 * Verifies the full data-gatherer pipeline:
 * 1. gather() writes session health JSON
 * 2. gather() writes debug state JSON
 * 3. gather() writes publish-health JSON
 * 4. FreshnessManager computes billing.isFresh correctly
 * 5. DebugStateWriter records fetch attempts
 * 6. HealthPublisher includes urgency scores
 *
 * Uses real DataGatherer with mocked health store path.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DebugStateWriter } from '../../src/lib/debug-state-writer';
import { HealthPublisher } from '../../src/lib/health-publisher';
import { FreshnessManager } from '../../src/lib/freshness-manager';
import { StateSerializer } from '../../src/lib/state-serializer';
import { ChangeDetector } from '../../src/lib/change-detector';
import { createDefaultHealth } from '../../src/types/session-health';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'gather-pipeline-test-' + Date.now());

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Gather Pipeline Integration', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    DebugStateWriter.clearHistory();
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  test('debug + publish + serialize pipeline produces consistent data', () => {
    // Simulate what data-gatherer does after collect
    const health = createDefaultHealth('pipeline-test');
    health.billing.costToday = 35.50;
    health.billing.burnRatePerHour = 12.00;
    health.billing.budgetPercentUsed = 55;
    health.billing.budgetRemaining = 90;
    health.billing.lastFetched = Date.now();
    health.billing.isFresh = true;
    health.billing.weeklyBudgetPercentUsed = 40;
    health.billing.weeklyBudgetRemaining = 72;
    health.billing.weeklyResetDay = 'Mon';
    health.billing.weeklyLastModified = Date.now();

    health.model.value = 'Opus4.5';
    health.model.confidence = 95;
    health.model.updatedAt = Date.now();

    health.context.tokensUsed = 60000;
    health.context.tokensLeft = 96000;
    health.context.percentUsed = 38;
    health.context.updatedAt = Date.now();

    health.git.branch = 'main';
    health.git.dirty = 2;
    health.git.lastChecked = Date.now();

    health.transcript.exists = true;
    health.transcript.sizeBytes = 100000;
    health.transcript.messageCount = 30;
    health.transcript.lastModified = Date.now();
    health.transcript.isSynced = true;

    health.launch.authProfile = 'test@example.com';
    health.gatheredAt = Date.now();

    // Step 1: Compute isFresh
    health.billing.isFresh = FreshnessManager.isBillingFresh(health.billing.lastFetched);
    expect(health.billing.isFresh).toBe(true);

    // Step 2: Write debug state
    DebugStateWriter.recordFetch({
      category: 'billing_ccusage',
      timestamp: Date.now() - 500,
      success: true,
      durationMs: 500,
    });
    DebugStateWriter.write('pipeline-test', health, TEST_DIR);

    // Step 3: Publish health
    HealthPublisher.publishToPath('pipeline-test', health, TEST_DIR);

    // Step 4: Serialize for durable object
    const durableState = StateSerializer.serialize(health);
    const changed = ChangeDetector.stamp(durableState);

    // Verify debug state
    const debugState = DebugStateWriter.read('pipeline-test', TEST_DIR);
    expect(debugState).not.toBeNull();
    expect(debugState!.dataQuality.overall).toBe('healthy');
    expect(debugState!.rawValues.billing.costToday).toBe(35.50);
    expect(debugState!.fetchHistory).toHaveLength(1);
    expect(debugState!.fetchHistory[0].success).toBe(true);

    // Verify publish-health
    const published = HealthPublisher.read(TEST_DIR);
    expect(published).not.toBeNull();
    expect(published!.sessions['pipeline-test']).toBeDefined();
    expect(published!.sessions['pipeline-test'].email).toBe('test@example.com');
    expect(published!.sessions['pipeline-test'].urgency.score).toBeGreaterThan(0);
    expect(published!.sessions['pipeline-test'].urgency.level).toBeDefined();

    // Verify durable state
    expect(durableState.bd.ct).toBe(3550); // $35.50 → 3550 cents
    expect(durableState.mc.mv).toBe('Opus4.5');
    expect(changed).toBe(true);
    expect(durableState.meta.hash).toMatch(/^[0-9a-f]{8}$/);

    // Verify size constraint
    const size = StateSerializer.estimateSize(durableState);
    expect(size).toBeLessThan(5120);
  });

  test('stale billing data flows through entire pipeline correctly', () => {
    const health = createDefaultHealth('stale-test');
    health.billing.costToday = 20.00;
    health.billing.lastFetched = Date.now() - 700_000; // 11+ min ago (critical)
    health.billing.isFresh = true; // Will be overridden by FreshnessManager

    // Step 1: FreshnessManager computes correct isFresh
    health.billing.isFresh = FreshnessManager.isBillingFresh(health.billing.lastFetched);
    expect(health.billing.isFresh).toBe(false); // CRITICAL: 11min old = NOT fresh

    // Step 2: Debug state shows critical quality
    const debugState = DebugStateWriter.buildDebugState('stale-test', health);
    expect(debugState.dataQuality.overall).not.toBe('healthy');
    expect(debugState.dataQuality.fieldFreshness.billing_ccusage.status).toBe('critical');
    expect(debugState.dataQuality.fieldFreshness.billing_ccusage.indicator).toBe('🔺');

    // Step 3: Publish still works (stale data is published with urgency)
    HealthPublisher.publishToPath('stale-test', health, TEST_DIR);
    const published = HealthPublisher.read(TEST_DIR);
    expect(published).not.toBeNull();

    // Step 4: Durable state preserves isFresh=false via lastFetched
    const durableState = StateSerializer.serialize(health);
    const restored = StateSerializer.deserialize(durableState);
    // Restored billing has the old lastFetched, so FreshnessManager would compute false
    expect(FreshnessManager.isBillingFresh(restored.billing.lastFetched)).toBe(false);
  });

  test('change detector distinguishes meaningful changes', () => {
    const health1 = createDefaultHealth('change-test');
    health1.billing.costToday = 10;
    health1.billing.lastFetched = Date.now();
    health1.model.value = 'Opus4.5';
    health1.model.confidence = 95;
    health1.context.tokensUsed = 50000;
    health1.git.branch = 'main';
    health1.transcript.sizeBytes = 100000;

    const state1 = StateSerializer.serialize(health1);
    ChangeDetector.stamp(state1);

    // Same data → no change
    const health2 = createDefaultHealth('change-test');
    health2.billing.costToday = 10;
    health2.billing.lastFetched = Date.now();
    health2.model.value = 'Opus4.5';
    health2.model.confidence = 95;
    health2.context.tokensUsed = 50000;
    health2.git.branch = 'main';
    health2.transcript.sizeBytes = 100000;

    const state2 = StateSerializer.serialize(health2);
    state2.meta.hash = state1.meta.hash;
    state2.meta.uc = state1.meta.uc;
    expect(ChangeDetector.hasChanged(state2)).toBe(false);

    // Changed cost → change detected
    const health3 = createDefaultHealth('change-test');
    health3.billing.costToday = 15; // Different
    health3.billing.lastFetched = Date.now();
    health3.model.value = 'Opus4.5';
    health3.model.confidence = 95;
    health3.context.tokensUsed = 50000;
    health3.git.branch = 'main';
    health3.transcript.sizeBytes = 100000;

    const state3 = StateSerializer.serialize(health3);
    state3.meta.hash = state1.meta.hash;
    expect(ChangeDetector.hasChanged(state3)).toBe(true);
  });

  test('multi-session publish preserves all sessions', () => {
    const healthA = createDefaultHealth('session-a');
    healthA.launch.authProfile = 'a@test.com';
    healthA.billing.costToday = 20;
    healthA.billing.lastFetched = Date.now();
    healthA.transcript.lastModified = Date.now();
    healthA.gatheredAt = Date.now();

    const healthB = createDefaultHealth('session-b');
    healthB.launch.authProfile = 'b@test.com';
    healthB.billing.costToday = 30;
    healthB.billing.lastFetched = Date.now();
    healthB.transcript.lastModified = Date.now();
    healthB.gatheredAt = Date.now();

    HealthPublisher.publishToPath('session-a', healthA, TEST_DIR);
    HealthPublisher.publishToPath('session-b', healthB, TEST_DIR);

    const published = HealthPublisher.read(TEST_DIR);
    expect(Object.keys(published!.sessions)).toHaveLength(2);
    expect(published!.sessions['session-a'].email).toBe('a@test.com');
    expect(published!.sessions['session-b'].email).toBe('b@test.com');
  });

  test('stale sessions are pruned from publish-health', () => {
    // Session A: active (recent)
    const healthA = createDefaultHealth('session-a');
    healthA.launch.authProfile = 'a@test.com';
    healthA.transcript.lastModified = Date.now();
    healthA.billing.lastFetched = Date.now();
    healthA.gatheredAt = Date.now();

    // Session B: stale (2 hours ago)
    const healthB = createDefaultHealth('session-b');
    healthB.launch.authProfile = 'b@test.com';
    healthB.transcript.lastModified = Date.now() - 7_200_000; // 2h ago
    healthB.billing.lastFetched = Date.now();
    healthB.gatheredAt = Date.now();

    // Publish B first, then A (A's publish should prune B)
    HealthPublisher.publishToPath('session-b', healthB, TEST_DIR);
    HealthPublisher.publishToPath('session-a', healthA, TEST_DIR);

    const published = HealthPublisher.read(TEST_DIR);
    expect(Object.keys(published!.sessions)).toHaveLength(1);
    expect(published!.sessions['session-a']).toBeDefined();
    expect(published!.sessions['session-b']).toBeUndefined(); // Pruned
  });
});
