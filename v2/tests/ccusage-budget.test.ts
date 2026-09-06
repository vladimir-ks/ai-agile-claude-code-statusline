/**
 * ccusage time-budget derivation.
 *
 * Contract: the ccusage subprocess budget is DERIVED from the caller's
 * remaining gather deadline and can never exceed it.
 */

import { describe, test, expect } from 'bun:test';
import {
  deriveCcusageTimeoutSec,
  CCUSAGE_MIN_TIMEOUT_SEC,
  CCUSAGE_MAX_TIMEOUT_SEC,
  CCUSAGE_DEFAULT_TIMEOUT_SEC,
  CCUSAGE_MIN_REMAINING_MS,
  CCUSAGE_DEADLINE_RESERVE_MS,
} from '../src/modules/ccusage-shared-module';

const NOW = 1_700_000_000_000;
const withRemaining = (ms: number) => deriveCcusageTimeoutSec(NOW + ms, NOW);

describe('deriveCcusageTimeoutSec', () => {
  test('25s remaining → 23s (reserves 2s for parse + cache write)', () => {
    expect(withRemaining(25_000)).toBe(23);
  });

  test('40s remaining → clamped to the 25s ceiling', () => {
    expect(withRemaining(40_000)).toBe(CCUSAGE_MAX_TIMEOUT_SEC);
    expect(withRemaining(40_000)).toBe(25);
  });

  test('7s remaining → skip (null)', () => {
    expect(withRemaining(7_000)).toBeNull();
  });

  test('deadline missing → default 15s', () => {
    expect(deriveCcusageTimeoutSec(undefined, NOW)).toBe(CCUSAGE_DEFAULT_TIMEOUT_SEC);
    expect(deriveCcusageTimeoutSec(null, NOW)).toBe(15);
  });

  test('non-finite deadline → default', () => {
    expect(deriveCcusageTimeoutSec(NaN, NOW)).toBe(CCUSAGE_DEFAULT_TIMEOUT_SEC);
    expect(deriveCcusageTimeoutSec(Infinity, NOW)).toBe(CCUSAGE_DEFAULT_TIMEOUT_SEC);
  });

  test('skip threshold is exact at 8s remaining', () => {
    expect(withRemaining(CCUSAGE_MIN_REMAINING_MS - 1)).toBeNull();
    expect(withRemaining(CCUSAGE_MIN_REMAINING_MS)).toBe(6);
  });

  test('past deadline → skip', () => {
    expect(withRemaining(0)).toBeNull();
    expect(withRemaining(-5_000)).toBeNull();
  });

  test('never exceeds the remaining budget', () => {
    for (let remaining = CCUSAGE_MIN_REMAINING_MS; remaining <= 60_000; remaining += 250) {
      const sec = withRemaining(remaining);
      if (sec === null) continue;
      expect(sec * 1000).toBeLessThanOrEqual(remaining - CCUSAGE_DEADLINE_RESERVE_MS);
      expect(sec).toBeGreaterThanOrEqual(CCUSAGE_MIN_TIMEOUT_SEC);
      expect(sec).toBeLessThanOrEqual(CCUSAGE_MAX_TIMEOUT_SEC);
    }
  });

  test('20s gather deadline (UnifiedDataBroker) at t=0 → 18s', () => {
    expect(withRemaining(20_000)).toBe(18);
  });

  test('defaults sit inside the clamp', () => {
    expect(CCUSAGE_DEFAULT_TIMEOUT_SEC).toBeGreaterThanOrEqual(CCUSAGE_MIN_TIMEOUT_SEC);
    expect(CCUSAGE_DEFAULT_TIMEOUT_SEC).toBeLessThanOrEqual(CCUSAGE_MAX_TIMEOUT_SEC);
  });
});
