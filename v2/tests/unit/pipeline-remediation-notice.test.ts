/**
 * Unit — pipelineRemediationNotice (statusline quota-pipeline warning UX).
 *
 * Locks the wording/severity contract the user asked to polish:
 *  - degraded_scheduler must NOT claim the quota pipeline is "frozen"/"stale"
 *    (a background agent being down does not mean the quota data is stale).
 *  - blocked_* are the genuinely-critical states ("data may be stale").
 *  - messages carry NO leading ⚠ (the render layer adds the glyph — embedding one
 *    caused the "⚠ ⚠" double-glyph bug).
 */
import { describe, test, expect } from 'bun:test';
import { pipelineRemediationNotice } from '../../src/lib/statusline-formatter';

describe('pipelineRemediationNotice', () => {
  test('degraded_scheduler is a quiet, accurate note — not "frozen/stale"', () => {
    const n = pipelineRemediationNotice('degraded_scheduler');
    expect(n).not.toBeNull();
    expect(n!.type).toBe('pipeline_degraded');
    expect(n!.priority).toBe(4); // low — does not dominate the notification cycle
    expect(n!.message.toLowerCase()).not.toContain('frozen');
    expect(n!.message.toLowerCase()).not.toContain('stale');
    expect(n!.message).toContain('scheduler degraded');
  });

  test('blocked_* are critical with an accurate cause + "data may be stale"', () => {
    for (const [state, why] of [
      ['blocked_rate_limited', 'rate limited'],
      ['blocked_auth_required', 'auth required'],
      ['blocked_no_active_slot', 'no active slot'],
      ['blocked_no_scheduler', 'no scheduler'],
    ] as const) {
      const n = pipelineRemediationNotice(state);
      expect(n).not.toBeNull();
      expect(n!.type).toBe('pipeline_blocked');
      expect(n!.priority).toBe(9);
      expect(n!.message).toContain(why);
      expect(n!.message.toLowerCase()).toContain('data may be stale');
    }
  });

  test('no message embeds a glyph (render layer owns the ⚠ — no double glyph)', () => {
    for (const s of ['degraded_scheduler', 'blocked_rate_limited', 'blocked_auth_required']) {
      const n = pipelineRemediationNotice(s);
      expect(n!.message).not.toContain('⚠');
    }
  });

  test('healthy / unknown / empty states produce no notice', () => {
    for (const s of ['ok', 'refresh_in_progress', 'unknown', '', null, undefined]) {
      expect(pipelineRemediationNotice(s as any)).toBeNull();
    }
  });
});
