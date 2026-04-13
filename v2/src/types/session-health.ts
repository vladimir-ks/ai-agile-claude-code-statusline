/**
 * Session Health System - Type Definitions
 *
 * Core data structures for the health monitoring system
 */

// ============================================================================
// Session Health Record (per-session)
// ============================================================================

export interface TranscriptHealth {
  exists: boolean;
  sizeBytes: number;
  lastModified: number;        // Unix timestamp ms
  lastModifiedAgo: string;     // "2m", "1h", etc.
  messageCount: number;
  lastMessageTime: number;     // Unix timestamp ms
  lastMessagePreview: string;  // Truncated preview of last user message
  lastMessageAgo: string;      // "2m", "1h", etc. since last message
  isSynced: boolean;           // mtime < 60s = synced
}

export interface ModelInfo {
  value: string;               // "Opus4.6", "Opus4.6[1m]", "Sonnet4.6", etc.
  id?: string;                 // Raw model ID (e.g. "claude-opus-4-6[1m]")
  source: 'transcript' | 'jsonInput' | 'settings' | 'default';
  confidence: number;          // 0-100
  reason?: string;
  updatedAt?: number;          // Unix ms when model was resolved
}

export interface ContextInfo {
  tokensUsed: number;
  tokensLeft: number;
  percentUsed: number;
  windowSize: number;
  nearCompaction: boolean;     // >70%
  updatedAt?: number;          // Unix ms when context was calculated
}

export interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
  lastChecked: number;
}

export interface BillingInfo {
  costToday: number;           // Account daily cost (from ccusage/OAuth - across ALL sessions)
  burnRatePerHour: number;
  budgetRemaining: number;     // minutes
  budgetPercentUsed: number;
  resetTime: string;           // "14:00" UTC
  totalTokens?: number;        // Total tokens consumed today
  tokensPerMinute?: number | null; // Recent token consumption rate
  isFresh: boolean;
  lastFetched: number;

  // Session-specific cost (from local transcript parsing - THIS session only)
  sessionCost?: number;        // Cost of THIS session (parsed from transcript)
  sessionTokens?: number;      // Tokens in THIS session
  sessionBurnRate?: number;    // Burn rate for THIS session

  // Weekly quota (from OAuth API or subscription.yaml)
  weeklyBudgetRemaining?: number;      // Hours until weekly reset (rounded down)
  weeklyBudgetPercentUsed?: number;    // Percentage of weekly quota used
  weeklyResetDay?: string;             // "Mon", "Tue", etc.
  weeklyLimitUSD?: number;             // Weekly quota limit in USD
  weeklyDataStale?: boolean;           // True if subscription.yaml is >4 hours old
  weeklyLastModified?: number;         // When subscription.yaml was last modified
}

export interface SessionAlerts {
  secretsDetected: boolean;
  secretTypes: string[];
  transcriptStale: boolean;    // >5 min without update during active session
  dataLossRisk: boolean;       // Stale + active = risk
}

export interface HealthStatus {
  status: 'healthy' | 'warning' | 'critical' | 'unknown';
  lastUpdate: number;
  issues: string[];
}

export interface LaunchContext {
  authProfile: string;         // Auth profile ID (from env var, path mapping, or fingerprint)
  detectionMethod: 'env' | 'path' | 'fingerprint' | 'default';
  launchAlias?: string;        // Original alias used (claude1, claude2, etc.)
  shellCommand?: string;       // Full command if detectable
  configDir?: string;          // Derived CLAUDE_CONFIG_DIR from transcript path
  keychainService?: string;    // Exact keychain service name for this session
}

export interface TmuxContext {
  session: string;             // Tmux session name (e.g., "main")
  window: string;              // Window index (e.g., "1")
  pane: string;                // Pane index (e.g., "0")
  width: number;               // Pane width in columns
  height: number;              // Pane height in rows
}

/**
 * Session Lock File - Persists session identity across restarts
 * Path: ~/.claude/session-health/{sessionId}.lock
 * Written: On first statusline invocation
 * Updated: Mutable fields on subsequent invocations
 */
export interface SessionLock {
  // Immutable - Set once at launch, never changes
  sessionId: string;           // Session identifier
  launchedAt: number;          // Unix timestamp ms when session started
  slotId: string;              // Hot-swap slot ID (slot-1, slot-2, etc.)
  configDir: string;           // CLAUDE_CONFIG_DIR path
  keychainService: string;     // Keychain service name for token
  email: string;               // Account email
  transcriptPath: string;      // Path to session transcript file

  // Mutable - Updated on daemon runs
  claudeVersion: string;       // From `claude --version`
  lastVersionCheck?: number;   // Unix timestamp ms of last version poll
  lastIdleCheck?: number;      // Unix timestamp ms of last idle detection

  // Tmux context (if running in tmux)
  tmux?: {
    session: string;
    window: string;
    pane: string;
  };

  // Internal tracking
  lockFileVersion: number;     // Lock file schema version (currently 1)
  updatedAt: number;           // Unix timestamp ms of last update
}

/**
 * Slot Recommendation Data - From select-account.sh
 * Path: ~/.claude/session-health/slot-recommendation.json
 * Updated: Every launch + every health check (~5min)
 */
export interface SlotRecommendation {
  updated_at: string;          // ISO8601 UTC timestamp
  updated_epoch: number;       // Unix epoch seconds (10 digits)
  recommended: string;         // "slot-N" or "none"
  failover_needed: boolean;    // True if all slots exhausted
  all_exhausted: boolean;      // True if no slots available
  rankings: SlotRanking[];     // Sorted by urgency desc (rank asc)
}

export interface SlotRanking {
  slot: string;                // "slot-N"
  rank: number;                // 1, 2, 3... (1 = best)
  urgency: number;             // Calculated urgency score
  five_hour_util: number;      // Daily quota % used (0-100)
  seven_day_util: number;      // Weekly quota % used (0-100)
  status: 'active' | 'inactive' | 'expired';
  reason: string;              // Why this slot was ranked here
}

/**
 * Merged Quota Data - From quota-broker.sh
 * Path: ~/.claude/session-health/merged-quota-cache.json
 * Single source of truth for all quota consumers
 */
export interface MergedQuotaSlot {
  email: string;
  status: 'active' | 'inactive' | 'expired';
  subscription_type: string;       // "max", "pro", etc.
  five_hour_util: number;          // Daily quota % used (0-100)
  seven_day_util: number;          // Weekly quota % used (0-100)
  five_hour_resets_at?: string;    // ISO 8601
  seven_day_resets_at?: string;    // ISO 8601
  weekly_budget_remaining_hours: number;
  weekly_reset_day: string;        // "Mon", "Tue", etc.
  daily_reset_time: string;        // "HH:MM" UTC
  last_fetched: number;            // Unix timestamp ms
  is_fresh: boolean;
  config_dir?: string;             // CLAUDE_CONFIG_DIR for this slot
  keychain_hash?: string;          // SHA256 hash prefix
  urgency: number;                 // Calculated urgency score
  rank: number;                    // 1 = best
  reason: string;                  // Why ranked here
  // Burn rate & pacing (written by fetch-quotas.sh, merged by quota-broker.sh)
  five_hour_burn_rate?: number | null;        // Measured %/hr from last delta
  five_hour_burn_confidence?: 'none' | 'low' | 'high';
  seven_day_burn_rate?: number | null;
  seven_day_burn_confidence?: 'none' | 'low' | 'high';
  target_burn_rate_5h?: number | null;        // Remaining%/hrs_to_reset
  target_burn_rate_7d?: number | null;
  burn_efficiency_5h?: number | null;         // actual*100/target (100=1.0x)
  burn_efficiency_7d?: number | null;
  // 6-band pacing (way_too_slow → way_too_fast) + legacy 5-band (under..over) for back-compat
  // during the rollout.
  pacing_status_5h?:
    | 'way_too_slow' | 'not_fast_enough' | 'a_bit_too_slow' | 'good' | 'much_too_fast' | 'way_too_fast'
    | 'under' | 'slow' | 'on_track' | 'fast' | 'over'
    | 'exhausted' | 'reset' | 'unknown';
  pacing_status_7d?:
    | 'way_too_slow' | 'not_fast_enough' | 'a_bit_too_slow' | 'good' | 'much_too_fast' | 'way_too_fast'
    | 'under' | 'slow' | 'on_track' | 'fast' | 'over'
    | 'exhausted' | 'reset' | 'unknown';
  // Range rates (computed from sample history, when ≥3 samples available)
  burn_rate_1h_min_5h?: number | null;        // Min instantaneous rate within last 1h
  burn_rate_1h_max_5h?: number | null;        // Max instantaneous rate within last 1h
  burn_rate_1h_avg_5h?: number | null;        // Avg slope over last 1h
  burn_sample_count_5h?: number;              // # samples used
  // Weekly rates expressed in %/day (preserves precision vs %/hr at 168h scale)
  target_burn_rate_7d_per_day?: number | null;
  seven_day_burn_rate_per_day?: number | null;
  // Weekly waste projections (see fetch-quotas.sh 7d block).
  // best_case = current + daily_cap * days_left (physical ceiling). If < 100 → waste GUARANTEED.
  // projected = current + actual_per_day * days_left (trend). If < ~85 → waste LIKELY.
  weekly_best_case_projected_util?: number | null;
  weekly_projected_util?: number | null;
}

export interface MergedQuotaData {
  ts: number;                      // Unix epoch seconds
  active_slot: string;             // "slot-N"
  recommended_slot: string;        // "slot-N" or "none"
  failover_needed: boolean;
  all_exhausted: boolean;
  slots: Record<string, MergedQuotaSlot>;
  // Computed by client, not in file
  age_seconds?: number;
  is_fresh?: boolean;
}

export interface ProjectMetadata {
  language?: string;           // Detected primary language
  gitRemote?: string;          // Remote URL if git repo
  repoName?: string;           // Extracted from remote or directory
}

export interface PerformanceMetrics {
  gatherDuration?: number;     // ms to gather all data
  billingFetchDuration?: number; // ms to fetch billing
  transcriptScanDuration?: number; // ms to scan transcript
}

export interface SessionHealth {
  // Identity
  sessionId: string;
  projectPath: string;
  transcriptPath: string;

  // Launch Context
  launch: LaunchContext;

  // Tmux Context (if running in tmux)
  tmux?: TmuxContext;

  // Health
  health: HealthStatus;
  transcript: TranscriptHealth;
  model: ModelInfo;
  context: ContextInfo;
  git: GitInfo;
  billing: BillingInfo;
  alerts: SessionAlerts;

  // Additional Metadata
  cliVersion?: string;             // Claude Code CLI version (e.g., "1.0.29")
  versionMismatch?: {              // Set by display layer when installed != running
    running: string;               // Version this session launched with
    installed: string;             // Currently installed version (from daemon cache)
  };
  project?: ProjectMetadata;
  performance?: PerformanceMetrics;
  failoverNotification?: string;   // "🔄 Swapped → slot-2 (3m ago)" if recent swap

  // Timestamps
  gatheredAt: number;
  firstSeen?: number;          // When session was first detected
  sessionDuration?: number;    // ms since first seen

  // Pre-formatted output for different terminal widths (NEW - Phase 0)
  formattedOutput?: {
    width40: string[];     // Lines for 40-char terminal
    width60: string[];     // Lines for 60-char terminal
    width80: string[];     // Lines for 80-char terminal
    width100: string[];    // Lines for 100-char terminal
    width120: string[];    // Lines for 120-char terminal (default)
    width150: string[];    // Lines for 150-char terminal
    width200: string[];    // Lines for 200-char terminal
    singleLine: string[];  // Single line for no-tmux (max 240 chars)
  };
}

// ============================================================================
// Global Sessions Summary
// ============================================================================

export interface SessionSummaryEntry {
  sessionId: string;
  projectPath: string;
  shortName: string;           // Last path component
  health: 'healthy' | 'warning' | 'critical' | 'unknown';
  lastActivity: number;
  lastActivityAgo: string;
  model: string;
  transcriptSynced: boolean;
}

export interface GlobalMetrics {
  totalCostToday: number;
  burnRatePerHour: number;
  budgetRemaining: number;
}

export interface GlobalAlerts {
  sessionsWithSecrets: string[];
  sessionsAtRisk: string[];
  sessionsNearCompaction: string[];
}

export interface SessionsSummary {
  lastUpdated: number;
  activeSessions: number;      // Activity < 1 hour
  totalSessions: number;
  sessions: SessionSummaryEntry[];
  global: GlobalMetrics;
  alerts: GlobalAlerts;
}

// ============================================================================
// User Configuration
// ============================================================================

export interface ComponentsConfig {
  directory: boolean;
  git: boolean;
  model: boolean;
  version: boolean;
  context: boolean;
  time: boolean;
  budget: boolean;
  cost: boolean;
  usage: boolean;
  cache: boolean;
  lastMessage: boolean;
  transcriptSync: boolean;     // NEW
  secrets: boolean;            // NEW
}

export interface ThresholdsConfig {
  transcriptStaleMinutes: number;
  contextWarningPercent: number;
  budgetWarningPercent: number;
}

export interface DisplayConfig {
  maxWidth: number;
  useEmoji: boolean;
  useColor: boolean;
}

export interface StatuslineConfig {
  components: ComponentsConfig;
  thresholds: ThresholdsConfig;
  display: DisplayConfig;
}

// ============================================================================
// JSON Input (from Claude Code)
// ============================================================================

/**
 * Actual Claude Code JSON input structure.
 *
 * CRITICAL: This must match what Claude Code actually provides!
 *
 * context_window has NESTED current_usage object:
 *   context_window.current_usage.input_tokens
 *   context_window.current_usage.output_tokens
 *   context_window.current_usage.cache_read_input_tokens
 *   context_window.current_usage.cache_creation_input_tokens
 *
 * model provides:
 *   model.display_name - human readable ("Claude Opus 4.5")
 *   model.id - API identifier ("claude-opus-4-5-20251101")
 *   model.model_id - alternate field in some contexts
 */
export interface ClaudeCodeInput {
  session_id?: string;
  transcript_path?: string;
  model?: {
    display_name?: string;
    id?: string;
    model_id?: string;
    name?: string;  // Legacy fallback
  };
  context_window?: {
    context_window_size?: number;
    // Current usage is NESTED (not flat)
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
    // Total tokens (cumulative, for reference)
    total_input_tokens?: number;
    total_output_tokens?: number;
  };
  start_directory?: string;
}

// ============================================================================
// Factory Functions
// ============================================================================

export function createDefaultHealth(sessionId: string): SessionHealth {
  return {
    sessionId,
    projectPath: '',
    transcriptPath: '',
    launch: {
      authProfile: 'default',
      detectionMethod: 'default'
    },
    health: {
      status: 'unknown',
      lastUpdate: Date.now(),
      issues: []
    },
    transcript: {
      exists: false,
      sizeBytes: 0,
      lastModified: 0,
      lastModifiedAgo: 'unknown',
      messageCount: 0,
      lastMessageTime: 0,
      lastMessagePreview: '',
      lastMessageAgo: '',
      isSynced: false
    },
    model: {
      value: 'Claude',
      source: 'default',
      confidence: 10
    },
    context: {
      tokensUsed: 0,
      tokensLeft: 0,
      percentUsed: 0,
      windowSize: 200000,
      nearCompaction: false
    },
    git: {
      branch: '',
      ahead: 0,
      behind: 0,
      dirty: 0,
      lastChecked: 0
    },
    billing: {
      costToday: 0,
      burnRatePerHour: 0,
      budgetRemaining: 0,
      budgetPercentUsed: 0,
      resetTime: '',
      totalTokens: 0,
      tokensPerMinute: null,
      isFresh: false,
      lastFetched: 0
    },
    alerts: {
      secretsDetected: false,
      secretTypes: [],
      transcriptStale: false,
      dataLossRisk: false
    },
    gatheredAt: Date.now(),
    firstSeen: Date.now()
  };
}

export function createDefaultConfig(): StatuslineConfig {
  return {
    components: {
      directory: true,
      git: true,
      model: true,
      version: false,
      context: true,
      time: true,
      budget: true,
      cost: true,
      usage: false,
      cache: false,
      lastMessage: true,
      transcriptSync: true,
      secrets: true
    },
    thresholds: {
      transcriptStaleMinutes: 5,
      contextWarningPercent: 70,
      budgetWarningPercent: 80
    },
    display: {
      maxWidth: 200,
      useEmoji: true,
      useColor: false
    }
  };
}

export function createDefaultSummary(): SessionsSummary {
  return {
    lastUpdated: Date.now(),
    activeSessions: 0,
    totalSessions: 0,
    sessions: [],
    global: {
      totalCostToday: 0,
      burnRatePerHour: 0,
      budgetRemaining: 0
    },
    alerts: {
      sessionsWithSecrets: [],
      sessionsAtRisk: [],
      sessionsNearCompaction: []
    }
  };
}
