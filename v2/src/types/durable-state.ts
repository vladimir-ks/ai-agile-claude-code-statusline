/**
 * Durable Object State - Serializable session state for Cloudflare Workers
 *
 * CONSTRAINTS:
 * - <5KB per session (current health JSON is ~12KB)
 * - Short field names for size optimization
 * - Hash-based change detection (only sync when changed)
 * - Delta encoding for numeric fields
 * - Versioned schema for forward compatibility
 *
 * FIELD NAMING: 2-3 character abbreviations for size.
 * Full names in comments for readability.
 */

// ---------------------------------------------------------------------------
// Durable State (compact, serializable)
// ---------------------------------------------------------------------------

export interface DurableSessionState {
  v: 1;                        // Schema version
  sid: string;                 // sessionId
  aid: string;                 // accountId (email or auth profile)

  // Metadata
  meta: {
    ca: number;                // createdAt (unix ms)
    ua: number;                // updatedAt (unix ms)
    uc: number;                // updateCount
    hash: string;              // Content hash (for change detection)
  };

  // Health summary
  hs: {
    st: 'h' | 'w' | 'c' | 'u';  // status: healthy/warning/critical/unknown
    is: string[];                  // issues (truncated, max 3)
  };

  // Billing (daily)
  bd: {
    ct: number;                // costToday (cents, integer)
    br: number;                // burnRate (cents/hr, integer)
    bp: number;                // budgetPercentUsed
    lf: number;                // lastFetched (unix ms)
  };

  // Billing (weekly)
  bw?: {
    wp: number;                // weeklyPercentUsed
    wh: number;                // weeklyBudgetRemainingHours
    rd: string;                // resetDay ("Mon", "Tue", etc.)
    lf: number;                // lastFetched (unix ms)
  };

  // Activity
  ac: {
    ts: number;                // transcriptSizeBytes
    mc: number;                // messageCount
    lm: number;                // lastMessageAt (unix ms)
    sy: boolean;               // transcriptSynced
  };

  // Model + Context (combined for compactness)
  mc: {
    mv: string;                // modelValue ("Opus4.5")
    cf: number;                // confidence (0-100)
    tu: number;                // tokensUsed
    tl: number;                // tokensLeft
    cp: number;                // contextPercentUsed
    nc: boolean;               // nearCompaction
  };

  // Git (optional — only if repo)
  gt?: {
    br: string;                // branch
    dt: number;                // dirty count
  };

  // Alerts (bit flags for minimal size)
  al: number;                  // Alert flags (bitfield)
  // Bit 0: secretsDetected
  // Bit 1: transcriptStale
  // Bit 2: dataLossRisk
}

// ---------------------------------------------------------------------------
// Alert bit flags
// ---------------------------------------------------------------------------

export const ALERT_FLAGS = {
  SECRETS_DETECTED: 1 << 0,    // 1
  TRANSCRIPT_STALE: 1 << 1,    // 2
  DATA_LOSS_RISK:   1 << 2,    // 4
} as const;

export function encodeAlerts(alerts: {
  secretsDetected: boolean;
  transcriptStale: boolean;
  dataLossRisk: boolean;
}): number {
  let flags = 0;
  if (alerts.secretsDetected) flags |= ALERT_FLAGS.SECRETS_DETECTED;
  if (alerts.transcriptStale) flags |= ALERT_FLAGS.TRANSCRIPT_STALE;
  if (alerts.dataLossRisk)    flags |= ALERT_FLAGS.DATA_LOSS_RISK;
  return flags;
}

export function decodeAlerts(flags: number): {
  secretsDetected: boolean;
  transcriptStale: boolean;
  dataLossRisk: boolean;
} {
  return {
    secretsDetected: (flags & ALERT_FLAGS.SECRETS_DETECTED) !== 0,
    transcriptStale: (flags & ALERT_FLAGS.TRANSCRIPT_STALE) !== 0,
    dataLossRisk:    (flags & ALERT_FLAGS.DATA_LOSS_RISK) !== 0,
  };
}

// ---------------------------------------------------------------------------
// Health status encoding
// ---------------------------------------------------------------------------

const STATUS_MAP: Record<string, DurableSessionState['hs']['st']> = {
  healthy: 'h',
  warning: 'w',
  critical: 'c',
  unknown: 'u',
};

const STATUS_REVERSE: Record<string, string> = {
  h: 'healthy',
  w: 'warning',
  c: 'critical',
  u: 'unknown',
};

export function encodeStatus(status: string): DurableSessionState['hs']['st'] {
  return STATUS_MAP[status] || 'u';
}

export function decodeStatus(code: string): string {
  return STATUS_REVERSE[code] || 'unknown';
}

// ---------------------------------------------------------------------------
// Delta encoding for numeric arrays
// ---------------------------------------------------------------------------

/**
 * Delta encode: [100, 105, 103, 110] → [100, 5, -2, 7]
 * Smaller numbers = better compression.
 */
export function deltaEncode(values: number[]): number[] {
  if (values.length === 0) return [];
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) {
    result.push(values[i] - values[i - 1]);
  }
  return result;
}

/**
 * Delta decode: [100, 5, -2, 7] → [100, 105, 103, 110]
 */
export function deltaDecode(deltas: number[]): number[] {
  if (deltas.length === 0) return [];
  const result = [deltas[0]];
  for (let i = 1; i < deltas.length; i++) {
    result.push(result[i - 1] + deltas[i]);
  }
  return result;
}
