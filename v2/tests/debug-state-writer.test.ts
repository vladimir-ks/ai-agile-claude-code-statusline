/**
 * Tests for DebugStateWriter
 *
 * Verifies: debug file creation, data quality assessment,
 * freshness report generation, fetch history tracking, age formatting.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { DebugStateWriter, DebugState, FetchAttempt } from '../src/lib/debug-state-writer';
import { createDefaultHealth } from '../src/types/session-health';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_DIR = join(tmpdir(), 'debug-state-writer-test-' + Date.now());

function createHealthWithTimestamps(overrides?: {
  billingLastFetched?: number;
  gitLastChecked?: number;
  modelUpdatedAt?: number;
  contextUpdatedAt?: number;
  transcriptLastModified?: number;
  weeklyLastModified?: number;
}) {
  const health = createDefaultHealth('test-session');
  const now = Date.now();

  health.billing.lastFetched = overrides?.billingLastFetched ?? now;
  health.billing.isFresh = true;
  health.billing.costToday = 42.50;
  health.billing.burnRatePerHour = 15.1;
  health.billing.budgetPercentUsed = 62;
  health.billing.weeklyLastModified = overrides?.weeklyLastModified ?? now;
  health.billing.weeklyBudgetPercentUsed = 30;
  health.billing.weeklyDataStale = false;

  health.git.branch = 'main';
  health.git.dirty = 3;
  health.git.lastChecked = overrides?.gitLastChecked ?? now;

  health.model.value = 'Opus4.5';
  health.model.source = 'jsonInput';
  health.model.confidence = 95;
  health.model.updatedAt = overrides?.modelUpdatedAt ?? now;

  health.context.tokensUsed = 80000;
  health.context.tokensLeft = 76000;
  health.context.percentUsed = 51;
  health.context.windowSize = 200000;
  health.context.updatedAt = overrides?.contextUpdatedAt ?? now;

  health.transcript.exists = true;
  health.transcript.sizeBytes = 150000;
  health.transcript.messageCount = 42;
  health.transcript.lastModified = overrides?.transcriptLastModified ?? now;
  health.transcript.isSynced = true;

  health.performance = {
    gatherDuration: 1500,
    billingFetchDuration: 800,
    transcriptScanDuration: 50,
  };

  return health;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DebugStateWriter', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    DebugStateWriter.clearHistory();
  });

  afterEach(() => {
    try {
      rmSync(TEST_DIR, { recursive: true, force: true });
    } catch { /* ignore */ }
  });

  // =========================================================================
  // File I/O
  // =========================================================================

  describe('write and read', () => {
    test('writes debug file to disk', () => {
      const health = createHealthWithTimestamps();
      DebugStateWriter.write('test-session', health, TEST_DIR);

      const filePath = join(TEST_DIR, 'test-session.debug.json');
      expect(existsSync(filePath)).toBe(true);
    });

    test('debug file is valid JSON', () => {
      const health = createHealthWithTimestamps();
      DebugStateWriter.write('test-session', health, TEST_DIR);

      const filePath = join(TEST_DIR, 'test-session.debug.json');
      const content = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.sessionId).toBe('test-session');
    });

    test('read returns written debug state', () => {
      const health = createHealthWithTimestamps();
      DebugStateWriter.write('test-session', health, TEST_DIR);

      const state = DebugStateWriter.read('test-session', TEST_DIR);
      expect(state).not.toBeNull();
      expect(state!.sessionId).toBe('test-session');
      expect(state!.snapshotAt).toBeGreaterThan(0);
    });

    test('read returns null for non-existent session', () => {
      const state = DebugStateWriter.read('nonexistent', TEST_DIR);
      expect(state).toBeNull();
    });

    test('creates directory if it does not exist', () => {
      const nestedDir = join(TEST_DIR, 'nested', 'dir');
      const health = createHealthWithTimestamps();
      DebugStateWriter.write('test-session', health, nestedDir);

      expect(existsSync(join(nestedDir, 'test-session.debug.json'))).toBe(true);
    });
  });

  // =========================================================================
  // Data Quality Assessment
  // =========================================================================

  describe('data quality', () => {
    test('all fresh → healthy', () => {
      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.dataQuality.overall).toBe('healthy');
      expect(state.dataQuality.freshCount).toBeGreaterThan(0);
      expect(state.dataQuality.staleCount).toBe(0);
      expect(state.dataQuality.criticalCount).toBe(0);
    });

    test('stale billing → warning', () => {
      const health = createHealthWithTimestamps({
        billingLastFetched: Date.now() - 300_000, // 5min old (stale but not critical)
      });
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.dataQuality.overall).toBe('warning');
      expect(state.dataQuality.staleCount).toBeGreaterThanOrEqual(1);
      expect(state.dataQuality.fieldFreshness.billing_ccusage.status).toBe('stale');
      expect(state.dataQuality.fieldFreshness.billing_ccusage.indicator).toBe('⚠');
    });

    test('critical billing → critical', () => {
      const health = createHealthWithTimestamps({
        billingLastFetched: Date.now() - 700_000, // 11+ min old (critical)
      });
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.dataQuality.overall).toBe('critical');
      expect(state.dataQuality.criticalCount).toBeGreaterThanOrEqual(1);
      expect(state.dataQuality.fieldFreshness.billing_ccusage.status).toBe('critical');
      expect(state.dataQuality.fieldFreshness.billing_ccusage.indicator).toBe('🔺');
    });

    test('zero timestamp → unknown', () => {
      const health = createHealthWithTimestamps({
        billingLastFetched: 0,
      });
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.dataQuality.fieldFreshness.billing_ccusage.status).toBe('unknown');
    });

    test('git stale shows correct status', () => {
      const health = createHealthWithTimestamps({
        gitLastChecked: Date.now() - 60_000, // 1min (stale for 30s threshold)
      });
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.dataQuality.fieldFreshness.git_status.status).toBe('stale');
      expect(state.dataQuality.fieldFreshness.git_status.indicator).toBe('⚠');
    });
  });

  // =========================================================================
  // Raw Values
  // =========================================================================

  describe('raw values', () => {
    test('captures billing raw values', () => {
      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.rawValues.billing.costToday).toBe(42.50);
      expect(state.rawValues.billing.burnRatePerHour).toBe(15.1);
      expect(state.rawValues.billing.budgetPercentUsed).toBe(62);
      expect(state.rawValues.billing.isFresh).toBe(true);
    });

    test('captures model raw values', () => {
      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.rawValues.model.value).toBe('Opus4.5');
      expect(state.rawValues.model.source).toBe('jsonInput');
      expect(state.rawValues.model.confidence).toBe(95);
      expect(state.rawValues.model.updatedAt).toBeGreaterThan(0);
    });

    test('captures context raw values', () => {
      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.rawValues.context.tokensUsed).toBe(80000);
      expect(state.rawValues.context.tokensLeft).toBe(76000);
      expect(state.rawValues.context.percentUsed).toBe(51);
      expect(state.rawValues.context.windowSize).toBe(200000);
    });

    test('captures git raw values', () => {
      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.rawValues.git.branch).toBe('main');
      expect(state.rawValues.git.dirty).toBe(3);
      expect(state.rawValues.git.lastChecked).toBeGreaterThan(0);
    });

    test('captures transcript raw values', () => {
      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.rawValues.transcript.exists).toBe(true);
      expect(state.rawValues.transcript.sizeBytes).toBe(150000);
      expect(state.rawValues.transcript.messageCount).toBe(42);
      expect(state.rawValues.transcript.isSynced).toBe(true);
    });

    test('captures alerts', () => {
      const health = createHealthWithTimestamps();
      health.alerts.secretsDetected = true;
      health.alerts.secretTypes = ['API Key'];
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.rawValues.alerts.secretsDetected).toBe(true);
      expect(state.rawValues.alerts.transcriptStale).toBe(false);
    });
  });

  // =========================================================================
  // Freshness Report
  // =========================================================================

  describe('freshness report', () => {
    test('includes all tracked categories', () => {
      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      const categories = Object.keys(state.freshnessReport.fields);
      expect(categories).toContain('billing_ccusage');
      expect(categories).toContain('git_status');
      expect(categories).toContain('model');
      expect(categories).toContain('context');
      expect(categories).toContain('transcript');
    });

    test('report has valid generatedAt', () => {
      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.freshnessReport.generatedAt).toBeGreaterThan(0);
      expect(state.freshnessReport.generatedAt).toBeLessThanOrEqual(Date.now());
    });

    test('fresh data shows fresh status in report', () => {
      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.freshnessReport.fields.billing_ccusage.status).toBe('fresh');
      expect(state.freshnessReport.fields.billing_ccusage.indicator).toBe('');
    });
  });

  // =========================================================================
  // Fetch History
  // =========================================================================

  describe('fetch history', () => {
    test('records fetch attempts', () => {
      DebugStateWriter.recordFetch({
        category: 'billing_ccusage',
        timestamp: Date.now(),
        success: true,
        durationMs: 800,
      });

      const history = DebugStateWriter.getFetchHistory();
      expect(history).toHaveLength(1);
      expect(history[0].category).toBe('billing_ccusage');
      expect(history[0].success).toBe(true);
    });

    test('includes history in debug state', () => {
      DebugStateWriter.recordFetch({
        category: 'billing_oauth',
        timestamp: Date.now(),
        success: false,
        error: 'OAuth 401',
      });

      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.fetchHistory).toHaveLength(1);
      expect(state.fetchHistory[0].category).toBe('billing_oauth');
      expect(state.fetchHistory[0].success).toBe(false);
      expect(state.fetchHistory[0].error).toBe('OAuth 401');
    });

    test('ring buffer caps at 20 entries', () => {
      for (let i = 0; i < 25; i++) {
        DebugStateWriter.recordFetch({
          category: 'billing_ccusage',
          timestamp: Date.now(),
          success: i % 2 === 0,
        });
      }

      const history = DebugStateWriter.getFetchHistory();
      expect(history).toHaveLength(20);
    });

    test('clear history works', () => {
      DebugStateWriter.recordFetch({
        category: 'test',
        timestamp: Date.now(),
        success: true,
      });
      expect(DebugStateWriter.getFetchHistory()).toHaveLength(1);

      DebugStateWriter.clearHistory();
      expect(DebugStateWriter.getFetchHistory()).toHaveLength(0);
    });
  });

  // =========================================================================
  // Performance
  // =========================================================================

  describe('performance metrics', () => {
    test('includes performance data when available', () => {
      const health = createHealthWithTimestamps();
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.performance).toBeDefined();
      expect(state.performance!.gatherDuration).toBe(1500);
      expect(state.performance!.billingFetchDuration).toBe(800);
      expect(state.performance!.transcriptScanDuration).toBe(50);
    });

    test('performance is undefined when health has no metrics', () => {
      const health = createHealthWithTimestamps();
      delete health.performance;
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.performance).toBeUndefined();
    });
  });

  // =========================================================================
  // Age Formatting
  // =========================================================================

  describe('age formatting', () => {
    test('recent data shows seconds', () => {
      const health = createHealthWithTimestamps({
        gitLastChecked: Date.now() - 5000, // 5s ago
      });
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.dataQuality.fieldFreshness.git_status.ageHuman).toMatch(/^\d+s$/);
    });

    test('minutes-old data shows minutes', () => {
      const health = createHealthWithTimestamps({
        billingLastFetched: Date.now() - 180_000, // 3min ago
      });
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.dataQuality.fieldFreshness.billing_ccusage.ageHuman).toBe('3m');
    });

    test('hours-old data shows hours', () => {
      const health = createHealthWithTimestamps({
        billingLastFetched: Date.now() - 7_200_000, // 2h ago
      });
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.dataQuality.fieldFreshness.billing_ccusage.ageHuman).toBe('2h');
    });

    test('days-old data shows days', () => {
      const health = createHealthWithTimestamps({
        billingLastFetched: Date.now() - 345_600_000, // 4d ago
      });
      const state = DebugStateWriter.buildDebugState('test', health);

      expect(state.dataQuality.fieldFreshness.billing_ccusage.ageHuman).toBe('4d');
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    test('handles default health (no data)', () => {
      const health = createDefaultHealth('empty-session');
      const state = DebugStateWriter.buildDebugState('empty-session', health);

      expect(state.sessionId).toBe('empty-session');
      expect(state.dataQuality.overall).not.toBe('healthy'); // Should be warning or critical
      expect(state.rawValues.billing.costToday).toBe(0);
      expect(state.rawValues.model.value).toBe('Claude');
    });

    test('write does not throw on invalid directory', () => {
      const health = createHealthWithTimestamps();
      // This should not throw — debug write is non-critical
      expect(() => {
        DebugStateWriter.write('test', health, '/nonexistent/readonly/path');
      }).not.toThrow();
    });

    test('overwrites previous debug file', () => {
      const health1 = createHealthWithTimestamps();
      health1.billing.costToday = 10;
      DebugStateWriter.write('test-session', health1, TEST_DIR);

      const health2 = createHealthWithTimestamps();
      health2.billing.costToday = 50;
      DebugStateWriter.write('test-session', health2, TEST_DIR);

      const state = DebugStateWriter.read('test-session', TEST_DIR);
      expect(state!.rawValues.billing.costToday).toBe(50);
    });
  });
});
