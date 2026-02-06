/**
 * Tests for SlotRecommendationReader - Slot ranking reader
 *
 * Verifies:
 * - Schema parsing (v1.1)
 * - Staleness detection (>15min)
 * - Missing file handling
 * - Corrupted JSON handling
 * - Cache invalidation
 * - Ranking order validation
 * - Switch recommendation logic
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync, statSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';

import { SlotRecommendationReader } from '../src/lib/slot-recommendation-reader';
import type { SlotRecommendation } from '../src/types/session-health';

const TEST_DIR = join(tmpdir(), `slot-rec-test-${Date.now()}`);
const REC_FILE = join(TEST_DIR, 'slot-recommendation.json');

// Mock recommendation data
const MOCK_RECOMMENDATION: SlotRecommendation = {
  updated_at: new Date().toISOString(),
  updated_epoch: Math.floor(Date.now() / 1000),
  recommended: 'slot-2',
  failover_needed: false,
  all_exhausted: false,
  rankings: [
    {
      slot: 'slot-2',
      rank: 1,
      urgency: 538,
      five_hour_util: 25,
      seven_day_util: 3,
      status: 'active',
      reason: 'highest_urgency'
    },
    {
      slot: 'slot-1',
      rank: 2,
      urgency: 320,
      five_hour_util: 85,
      seven_day_util: 40,
      status: 'active',
      reason: 'high_utilization'
    },
    {
      slot: 'slot-3',
      rank: 3,
      urgency: 100,
      five_hour_util: 95,
      seven_day_util: 90,
      status: 'active',
      reason: 'quota_exhausted'
    }
  ]
};

describe('SlotRecommendationReader', () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    // Override path for testing
    (SlotRecommendationReader as any).RECOMMENDATION_PATH = REC_FILE;
    SlotRecommendationReader.clearCache();
  });

  afterEach(() => {
    SlotRecommendationReader.clearCache();
    try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('read', () => {
    test('reads valid recommendation file', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      const data = SlotRecommendationReader.read();
      expect(data).not.toBeNull();
      expect(data!.recommended).toBe('slot-2');
      expect(data!.rankings.length).toBe(3);
    });

    test('returns null for missing file', () => {
      const data = SlotRecommendationReader.read();
      expect(data).toBeNull();
    });

    test('returns null for corrupted JSON', () => {
      writeFileSync(REC_FILE, 'NOT VALID JSON {{{', 'utf-8');

      const data = SlotRecommendationReader.read();
      expect(data).toBeNull();
    });

    test('returns null for invalid schema (missing recommended)', () => {
      writeFileSync(REC_FILE, JSON.stringify({ rankings: [] }), 'utf-8');

      const data = SlotRecommendationReader.read();
      expect(data).toBeNull();
    });

    test('returns null for invalid schema (missing rankings)', () => {
      writeFileSync(REC_FILE, JSON.stringify({ recommended: 'slot-1' }), 'utf-8');

      const data = SlotRecommendationReader.read();
      expect(data).toBeNull();
    });

    test('returns null for non-array rankings', () => {
      writeFileSync(REC_FILE, JSON.stringify({
        recommended: 'slot-1',
        rankings: 'not-an-array'
      }), 'utf-8');

      const data = SlotRecommendationReader.read();
      expect(data).toBeNull();
    });

    test('caches data for 60s', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      const first = SlotRecommendationReader.read();
      expect(first).not.toBeNull();

      // Modify file
      const modified = { ...MOCK_RECOMMENDATION, recommended: 'slot-3' };
      writeFileSync(REC_FILE, JSON.stringify(modified), 'utf-8');

      // Should still return cached version
      const second = SlotRecommendationReader.read();
      expect(second!.recommended).toBe('slot-2'); // Original, not 'slot-3'
    });

    test('clearCache forces re-read', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      const first = SlotRecommendationReader.read();
      expect(first!.recommended).toBe('slot-2');

      // Modify file
      const modified = { ...MOCK_RECOMMENDATION, recommended: 'slot-3' };
      writeFileSync(REC_FILE, JSON.stringify(modified), 'utf-8');

      // Clear cache
      SlotRecommendationReader.clearCache();

      // Should return new data
      const second = SlotRecommendationReader.read();
      expect(second!.recommended).toBe('slot-3');
    });
  });

  describe('getRecommendedSlot', () => {
    test('returns recommended slot ID', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      const slotId = SlotRecommendationReader.getRecommendedSlot();
      expect(slotId).toBe('slot-2');
    });

    test('returns null for missing file', () => {
      const slotId = SlotRecommendationReader.getRecommendedSlot();
      expect(slotId).toBeNull();
    });

    test('returns "none" when recommended is "none"', () => {
      const noneRec = { ...MOCK_RECOMMENDATION, recommended: 'none' };
      writeFileSync(REC_FILE, JSON.stringify(noneRec), 'utf-8');

      const slotId = SlotRecommendationReader.getRecommendedSlot();
      expect(slotId).toBe('none');
    });
  });

  describe('getRankings', () => {
    test('returns all rankings', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      const rankings = SlotRecommendationReader.getRankings();
      expect(rankings.length).toBe(3);
      expect(rankings[0].slot).toBe('slot-2');
      expect(rankings[0].rank).toBe(1);
    });

    test('returns empty array for missing file', () => {
      const rankings = SlotRecommendationReader.getRankings();
      expect(rankings).toEqual([]);
    });

    test('preserves ranking order', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      const rankings = SlotRecommendationReader.getRankings();
      expect(rankings[0].rank).toBe(1);
      expect(rankings[1].rank).toBe(2);
      expect(rankings[2].rank).toBe(3);
    });
  });

  describe('getSlotRanking', () => {
    test('returns ranking for specific slot', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      const ranking = SlotRecommendationReader.getSlotRanking('slot-1');
      expect(ranking).not.toBeNull();
      expect(ranking!.rank).toBe(2);
      expect(ranking!.urgency).toBe(320);
    });

    test('returns null for nonexistent slot', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      const ranking = SlotRecommendationReader.getSlotRanking('slot-99');
      expect(ranking).toBeNull();
    });

    test('returns null for missing file', () => {
      const ranking = SlotRecommendationReader.getSlotRanking('slot-1');
      expect(ranking).toBeNull();
    });
  });

  describe('isStale', () => {
    test('returns false for recent file', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      const isStale = SlotRecommendationReader.isStale();
      expect(isStale).toBe(false);
    });

    test('returns true for old file (>15min)', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      // Backdate file by 20 minutes
      const past = new Date(Date.now() - 20 * 60 * 1000);
      utimesSync(REC_FILE, past, past);

      const isStale = SlotRecommendationReader.isStale();
      expect(isStale).toBe(true);
    });

    test('returns true for missing file', () => {
      const isStale = SlotRecommendationReader.isStale();
      expect(isStale).toBe(true);
    });

    test('staleness threshold is 15 minutes', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      // Backdate by exactly 15min - 1s (should NOT be stale)
      const justUnderThreshold = new Date(Date.now() - (15 * 60 * 1000 - 1000));
      utimesSync(REC_FILE, justUnderThreshold, justUnderThreshold);

      expect(SlotRecommendationReader.isStale()).toBe(false);

      // Backdate by exactly 15min + 1s (should be stale)
      const justOverThreshold = new Date(Date.now() - (15 * 60 * 1000 + 1000));
      utimesSync(REC_FILE, justOverThreshold, justOverThreshold);

      expect(SlotRecommendationReader.isStale()).toBe(true);
    });
  });

  describe('getAge', () => {
    test('returns age in ms for existing file', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      const age = SlotRecommendationReader.getAge();
      expect(age).not.toBeNull();
      expect(age!).toBeGreaterThanOrEqual(0);
      expect(age!).toBeLessThan(1000); // Should be very recent
    });

    test('returns null for missing file', () => {
      const age = SlotRecommendationReader.getAge();
      expect(age).toBeNull();
    });

    test('returns correct age for old file', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      // Backdate by 5 minutes
      const past = new Date(Date.now() - 5 * 60 * 1000);
      utimesSync(REC_FILE, past, past);

      const age = SlotRecommendationReader.getAge();
      expect(age).not.toBeNull();
      expect(age!).toBeGreaterThanOrEqual(4.9 * 60 * 1000); // ~5 min
      expect(age!).toBeLessThan(5.1 * 60 * 1000);
    });
  });

  describe('isFailoverNeeded', () => {
    test('returns true when failover_needed is true', () => {
      const failoverRec = { ...MOCK_RECOMMENDATION, failover_needed: true };
      writeFileSync(REC_FILE, JSON.stringify(failoverRec), 'utf-8');

      expect(SlotRecommendationReader.isFailoverNeeded()).toBe(true);
    });

    test('returns false when failover_needed is false', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      expect(SlotRecommendationReader.isFailoverNeeded()).toBe(false);
    });

    test('returns false for missing file', () => {
      expect(SlotRecommendationReader.isFailoverNeeded()).toBe(false);
    });
  });

  describe('areAllSlotsExhausted', () => {
    test('returns true when all_exhausted is true', () => {
      const exhaustedRec = { ...MOCK_RECOMMENDATION, all_exhausted: true };
      writeFileSync(REC_FILE, JSON.stringify(exhaustedRec), 'utf-8');

      expect(SlotRecommendationReader.areAllSlotsExhausted()).toBe(true);
    });

    test('returns false when all_exhausted is false', () => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');

      expect(SlotRecommendationReader.areAllSlotsExhausted()).toBe(false);
    });

    test('returns false for missing file', () => {
      expect(SlotRecommendationReader.areAllSlotsExhausted()).toBe(false);
    });
  });

  describe('shouldSwitchSlot', () => {
    beforeEach(() => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');
    });

    test('returns false when current slot matches recommended', () => {
      const shouldSwitch = SlotRecommendationReader.shouldSwitchSlot('slot-2');
      expect(shouldSwitch).toBe(false);
    });

    test('returns true when current slot does not match recommended', () => {
      const shouldSwitch = SlotRecommendationReader.shouldSwitchSlot('slot-1');
      expect(shouldSwitch).toBe(true);
    });

    test('returns false when recommended is "none"', () => {
      const noneRec = { ...MOCK_RECOMMENDATION, recommended: 'none' };
      writeFileSync(REC_FILE, JSON.stringify(noneRec), 'utf-8');
      SlotRecommendationReader.clearCache();

      const shouldSwitch = SlotRecommendationReader.shouldSwitchSlot('slot-1');
      expect(shouldSwitch).toBe(false);
    });

    test('returns false for missing file', () => {
      rmSync(REC_FILE);
      SlotRecommendationReader.clearCache();

      const shouldSwitch = SlotRecommendationReader.shouldSwitchSlot('slot-1');
      expect(shouldSwitch).toBe(false);
    });
  });

  describe('getSwitchMessage', () => {
    beforeEach(() => {
      writeFileSync(REC_FILE, JSON.stringify(MOCK_RECOMMENDATION), 'utf-8');
    });

    test('returns message when switch recommended', () => {
      const msg = SlotRecommendationReader.getSwitchMessage('slot-1');
      expect(msg).not.toBeNull();
      expect(msg).toContain('Switch to slot-2');
      expect(msg).toContain('rank 1');
      expect(msg).toContain('urgency: 538');
      expect(msg).toContain('current: rank 2');
    });

    test('returns null when current matches recommended', () => {
      const msg = SlotRecommendationReader.getSwitchMessage('slot-2');
      expect(msg).toBeNull();
    });

    test('includes current rank if available', () => {
      const msg = SlotRecommendationReader.getSwitchMessage('slot-3');
      expect(msg).toContain('current: rank 3');
    });

    test('omits current rank if slot not in rankings', () => {
      const msg = SlotRecommendationReader.getSwitchMessage('slot-99');
      expect(msg).not.toContain('current');
    });

    test('returns null for missing file', () => {
      rmSync(REC_FILE);
      SlotRecommendationReader.clearCache();

      const msg = SlotRecommendationReader.getSwitchMessage('slot-1');
      expect(msg).toBeNull();
    });
  });
});
