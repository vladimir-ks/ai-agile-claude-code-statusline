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
  value: string;               // "Opus4.5", "Sonnet4.5", etc.
  source: 'transcript' | 'jsonInput' | 'settings' | 'default';
  confidence: number;          // 0-100
  reason?: string;
}

export interface ContextInfo {
  tokensUsed: number;
  tokensLeft: number;
  percentUsed: number;
  windowSize: number;
  nearCompaction: boolean;     // >70%
}

export interface GitInfo {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
  lastChecked: number;
}

export interface BillingInfo {
  costToday: number;
  burnRatePerHour: number;
  budgetRemaining: number;     // minutes
  budgetPercentUsed: number;
  resetTime: string;           // "14:00" UTC
  totalTokens?: number;        // Total tokens consumed today
  tokensPerMinute?: number | null; // Recent token consumption rate
  isFresh: boolean;
  lastFetched: number;

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

  // Additional Metadata (NEW)
  project?: ProjectMetadata;
  performance?: PerformanceMetrics;

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
