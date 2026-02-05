/**
 * State Serializer - Converts SessionHealth ↔ DurableSessionState
 *
 * Handles:
 * - Compression: 12KB SessionHealth → <5KB DurableSessionState
 * - Dollar → cents conversion (avoids floating point)
 * - Issue truncation (max 3, max 50 chars each)
 * - Round-trip fidelity (serialize → deserialize = equivalent data)
 */

import {
  DurableSessionState,
  encodeAlerts,
  decodeAlerts,
  encodeStatus,
  decodeStatus,
} from '../types/durable-state';
import { SessionHealth, createDefaultHealth } from '../types/session-health';

// Max issues to include (keep state small)
const MAX_ISSUES = 3;
const MAX_ISSUE_LENGTH = 50;

export class StateSerializer {

  /**
   * Serialize SessionHealth → DurableSessionState.
   * Lossy compression (drops formattedOutput, performance metrics, etc.)
   */
  static serialize(health: SessionHealth): DurableSessionState {
    const issues = (health.health.issues || [])
      .slice(0, MAX_ISSUES)
      .map(i => i.length > MAX_ISSUE_LENGTH ? i.substring(0, MAX_ISSUE_LENGTH) + '…' : i);

    const state: DurableSessionState = {
      v: 1,
      sid: health.sessionId,
      aid: health.launch.authProfile || 'default',
      meta: {
        ca: health.firstSeen || health.gatheredAt,
        ua: health.gatheredAt,
        uc: 0, // Set by caller (increment on each sync)
        hash: '', // Set by ChangeDetector after serialization
      },
      hs: {
        st: encodeStatus(health.health.status),
        is: issues,
      },
      bd: {
        ct: Math.round(health.billing.costToday * 100),    // dollars → cents
        br: Math.round(health.billing.burnRatePerHour * 100),
        bp: health.billing.budgetPercentUsed,
        lf: health.billing.lastFetched,
      },
      ac: {
        ts: health.transcript.sizeBytes,
        mc: health.transcript.messageCount,
        lm: health.transcript.lastMessageTime || health.transcript.lastModified,
        sy: health.transcript.isSynced,
      },
      mc: {
        mv: health.model.value,
        cf: health.model.confidence,
        tu: health.context.tokensUsed,
        tl: health.context.tokensLeft,
        cp: health.context.percentUsed,
        nc: health.context.nearCompaction,
      },
      al: encodeAlerts(health.alerts),
    };

    // Optional: weekly billing
    if (health.billing.weeklyBudgetPercentUsed !== undefined) {
      state.bw = {
        wp: health.billing.weeklyBudgetPercentUsed,
        wh: health.billing.weeklyBudgetRemaining || 0,
        rd: health.billing.weeklyResetDay || '',
        lf: health.billing.weeklyLastModified || 0,
      };
    }

    // Optional: git
    if (health.git.branch) {
      state.gt = {
        br: health.git.branch,
        dt: health.git.dirty,
      };
    }

    return state;
  }

  /**
   * Deserialize DurableSessionState → partial SessionHealth.
   * Returns a SessionHealth with all fields populated from the compact state.
   * Some fields will have default values (e.g., formattedOutput, performance).
   */
  static deserialize(state: DurableSessionState): SessionHealth {
    const health = createDefaultHealth(state.sid);

    health.gatheredAt = state.meta.ua;
    health.firstSeen = state.meta.ca;
    health.sessionDuration = state.meta.ua - state.meta.ca;

    health.launch.authProfile = state.aid;

    health.health.status = decodeStatus(state.hs.st) as SessionHealth['health']['status'];
    health.health.issues = state.hs.is;
    health.health.lastUpdate = state.meta.ua;

    health.billing.costToday = state.bd.ct / 100;       // cents → dollars
    health.billing.burnRatePerHour = state.bd.br / 100;
    health.billing.budgetPercentUsed = state.bd.bp;
    health.billing.lastFetched = state.bd.lf;

    if (state.bw) {
      health.billing.weeklyBudgetPercentUsed = state.bw.wp;
      health.billing.weeklyBudgetRemaining = state.bw.wh;
      health.billing.weeklyResetDay = state.bw.rd;
      health.billing.weeklyLastModified = state.bw.lf;
    }

    health.transcript.sizeBytes = state.ac.ts;
    health.transcript.messageCount = state.ac.mc;
    health.transcript.lastMessageTime = state.ac.lm;
    health.transcript.lastModified = state.ac.lm;
    health.transcript.isSynced = state.ac.sy;
    health.transcript.exists = state.ac.ts > 0;

    health.model.value = state.mc.mv;
    health.model.confidence = state.mc.cf;

    health.context.tokensUsed = state.mc.tu;
    health.context.tokensLeft = state.mc.tl;
    health.context.percentUsed = state.mc.cp;
    health.context.nearCompaction = state.mc.nc;

    if (state.gt) {
      health.git.branch = state.gt.br;
      health.git.dirty = state.gt.dt;
    }

    const alerts = decodeAlerts(state.al);
    health.alerts.secretsDetected = alerts.secretsDetected;
    health.alerts.transcriptStale = alerts.transcriptStale;
    health.alerts.dataLossRisk = alerts.dataLossRisk;

    return health;
  }

  /**
   * Estimate serialized size in bytes (UTF-8).
   */
  static estimateSize(state: DurableSessionState): number {
    const json = JSON.stringify(state);
    // Use Buffer.byteLength for accurate byte count with multi-byte chars
    if (typeof Buffer !== 'undefined') {
      return Buffer.byteLength(json, 'utf-8');
    }
    // Fallback: TextEncoder (works in all environments)
    return new TextEncoder().encode(json).length;
  }
}

export default StateSerializer;
