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
  isFresh: boolean;
  lastFetched: number;
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

export interface SessionHealth {
  // Identity
  sessionId: string;
  projectPath: string;
  transcriptPath: string;

  // Health
  health: HealthStatus;
  transcript: TranscriptHealth;
  model: ModelInfo;
  context: ContextInfo;
  git: GitInfo;
  billing: BillingInfo;
  alerts: SessionAlerts;

  // Timestamps
  gatheredAt: number;
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
      isFresh: false,
      lastFetched: 0
    },
    alerts: {
      secretsDetected: false,
      secretTypes: [],
      transcriptStale: false,
      dataLossRisk: false
    },
    gatheredAt: Date.now()
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
