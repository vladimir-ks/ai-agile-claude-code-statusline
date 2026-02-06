/**
 * Context-Aware Staleness Indicator Tests
 *
 * Verifies the decision matrix:
 * - Fresh data → no indicator
 * - Stale + no intent → no indicator (daemon will handle)
 * - Stale + intent < 30s → no indicator (refresh pending)
 * - Stale + intent 30s-5min → ⚠ (overdue)
 * - Stale + cooldown → ⚠
 * - Critical age → 🔺
 * - Intent > 5min → 🔺 (broken)
 * - Unknown timestamp → no indicator
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { FreshnessManager, CATEGORIES } from '../src/lib/freshness-manager';
import { RefreshIntentManager } from '../src/lib/refresh-intent-manager';

const TEST_DIR = join(tmpdir(), `contextual-test-${Date.now()}`);

describe('FreshnessManager: getContextAwareIndicator', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    RefreshIntentManager.setBasePath(TEST_DIR);
    FreshnessManager.clearAllCooldowns();
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('fresh data → no indicator regardless of intent state', () => {
    const now = Date.now();
    // Even with intent signaled, fresh data shows nothing
    RefreshIntentManager.signalRefreshNeeded('billing_ccusage');
    expect(FreshnessManager.getContextAwareIndicator(now - 10_000, 'billing_ccusage')).toBe('');
  });

  test('stale data, no intent → no indicator (daemon will handle on next run)', () => {
    const stale = Date.now() - 150_000; // 2.5min > 2min threshold
    expect(FreshnessManager.getContextAwareIndicator(stale, 'billing_ccusage')).toBe('');
  });

  test('stale data, intent < 30s → no indicator (refresh pending)', () => {
    const stale = Date.now() - 150_000; // 2.5min
    RefreshIntentManager.signalRefreshNeeded('billing_ccusage');
    // Intent just created — age < 30s
    expect(FreshnessManager.getContextAwareIndicator(stale, 'billing_ccusage')).toBe('');
  });

  test('stale data, intent 30s-5min → ⚠ (refresh overdue)', () => {
    const stale = Date.now() - 150_000; // 2.5min
    RefreshIntentManager.signalRefreshNeeded('billing_ccusage');

    // Backdate intent to 60s ago
    const intentPath = join(TEST_DIR, 'refresh-intents', 'billing_ccusage.intent');
    const past = new Date(Date.now() - 60_000);
    utimesSync(intentPath, past, past);

    expect(FreshnessManager.getContextAwareIndicator(stale, 'billing_ccusage')).toBe('⚠');
  });

  test('stale data, in cooldown → ⚠', () => {
    const stale = Date.now() - 150_000; // 2.5min
    // Record a failed fetch to trigger cooldown
    FreshnessManager.recordFetch('billing_ccusage', false);

    expect(FreshnessManager.getContextAwareIndicator(stale, 'billing_ccusage')).toBe('⚠');
  });

  test('critical age → 🔺 regardless of intent state', () => {
    // billing_ccusage staleMs = 600_000 (10min)
    const critical = Date.now() - 700_000; // 11.6min > 10min threshold
    expect(FreshnessManager.getContextAwareIndicator(critical, 'billing_ccusage')).toBe('🔺');
  });

  test('intent > 5min → 🔺 (refresh mechanism broken)', () => {
    const stale = Date.now() - 150_000; // 2.5min
    RefreshIntentManager.signalRefreshNeeded('billing_ccusage');

    // Backdate intent to 6 minutes ago
    const intentPath = join(TEST_DIR, 'refresh-intents', 'billing_ccusage.intent');
    const past = new Date(Date.now() - 6 * 60_000);
    utimesSync(intentPath, past, past);

    expect(FreshnessManager.getContextAwareIndicator(stale, 'billing_ccusage')).toBe('🔺');
  });

  test('unknown timestamp → no indicator (not ⚠)', () => {
    expect(FreshnessManager.getContextAwareIndicator(null, 'billing_ccusage')).toBe('');
    expect(FreshnessManager.getContextAwareIndicator(0, 'billing_ccusage')).toBe('');
    expect(FreshnessManager.getContextAwareIndicator(undefined as any, 'billing_ccusage')).toBe('');
  });

  test('unknown category → no indicator', () => {
    const stale = Date.now() - 150_000;
    expect(FreshnessManager.getContextAwareIndicator(stale, 'nonexistent')).toBe('');
  });

  test('git: stale 45s with no intent → no indicator', () => {
    // git_status freshMs=30s, so 45s is stale
    const stale = Date.now() - 45_000;
    expect(FreshnessManager.getContextAwareIndicator(stale, 'git_status')).toBe('');
  });

  test('git: critical 6min → 🔺', () => {
    // git_status staleMs=300_000 (5min)
    const critical = Date.now() - 360_000; // 6min
    expect(FreshnessManager.getContextAwareIndicator(critical, 'git_status')).toBe('🔺');
  });
});
