/**
 * Runtime State Types - Unified auth profiles + sessions
 *
 * Two-level structure:
 * 1. Auth Profiles - Shared billing data per authentication
 * 2. Sessions - Per-session data with links to auth profiles
 */

import { SessionHealth } from './session-health';

/**
 * Authentication Profile
 * Represents one Claude Code authentication (billing account)
 */
export interface AuthProfile {
  profileId: string;              // Unique identifier (e.g., "work", "personal", "auto_123")
  label: string;                  // Human-readable label (e.g., "Work Account")
  billingFingerprint?: string;    // Hash of billing pattern for auto-detection

  // Detection patterns (user-configurable)
  pathPatterns?: string[];        // Glob patterns for project paths (e.g., "/Users/vmks/work/**")
  aliases?: string[];             // Shell aliases that use this profile (e.g., ["claude1", "work-claude"])

  // Profile-specific billing (NOT shared across profiles)
  billing: {
    costToday: number;
    burnRatePerHour: number;
    budgetRemaining: number;      // minutes
    budgetPercentUsed: number;
    resetTime: string;            // HH:MM UTC
    totalTokens: number;
    tokensPerMinute: number | null;
    isFresh: boolean;
    lastFetched: number;
  };

  // Metadata
  metadata: {
    detectionMethod: 'manual' | 'auto' | 'fingerprint';
    firstSeen: number;
    lastUsed: number;
    totalSessions: number;
  };
}

/**
 * Session Entry in Runtime State
 * Lighter than full SessionHealth, links to auth profile
 */
export interface RuntimeSession {
  sessionId: string;
  authProfile: string;            // Links to AuthProfile.profileId
  projectPath: string;
  transcriptPath: string;

  // Tmux context (if running in tmux)
  tmux?: {
    session: string;              // Tmux session name (e.g., "main")
    window: string;               // Window index (e.g., "1")
    pane: string;                 // Pane index (e.g., "0")
    width: number;                // Pane width in columns
    height: number;               // Pane height in rows
  };

  // Session health summary
  health: {
    status: 'healthy' | 'warning' | 'critical' | 'unknown';
    lastUpdate: number;
    issues: string[];
  };

  model: {
    value: string;
    source: 'transcript' | 'jsonInput' | 'settings' | 'default';
    confidence: number;
  };

  context: {
    tokensUsed: number;
    tokensLeft: number;
    percentUsed: number;
    windowSize: number;
    nearCompaction: boolean;
  };

  git: {
    branch: string;
    ahead: number;
    behind: number;
    dirty: number;
    lastChecked: number;
  };

  transcript: {
    exists: boolean;
    sizeBytes: number;
    lastModified: number;
    lastModifiedAgo: string;
    messageCount: number;
    lastMessagePreview: string;
    isSynced: boolean;
  };

  alerts: {
    secretsDetected: boolean;
    secretTypes: string[];
    transcriptStale: boolean;
    dataLossRisk: boolean;
  };

  metadata: {
    gatheredAt: number;
    lastActivity: number;
  };

  // FINAL FORMATTED STRINGS (ready to output)
  // These are pre-rendered statusline strings for each terminal width
  // Display script just picks the right one and outputs it - no formatting logic needed
  formattedStrings?: {
    width40: string;    // "Line1\nLine2" format
    width60: string;
    width80: string;
    width100: string;
    width120: string;
    width150: string;
    width200: string;
  };
}

/**
 * Complete Runtime State
 */
export interface RuntimeState {
  // Part 1: Authentication profiles (shared billing data)
  authProfiles: AuthProfile[];

  // Part 2: Active sessions (session-specific data)
  sessions: RuntimeSession[];

  // Global metadata
  metadata: {
    version: string;
    lastUpdated: number;
    totalAuthProfiles: number;
    totalActiveSessions: number;
  };
}

/**
 * Factory: Create default runtime state
 */
export function createDefaultRuntimeState(): RuntimeState {
  return {
    authProfiles: [],
    sessions: [],
    metadata: {
      version: '1.0',
      lastUpdated: Date.now(),
      totalAuthProfiles: 0,
      totalActiveSessions: 0
    }
  };
}

/**
 * Factory: Create default auth profile
 */
export function createDefaultAuthProfile(profileId: string = 'default'): AuthProfile {
  return {
    profileId,
    label: profileId === 'default' ? 'Primary Account' : `Account ${profileId}`,
    billing: {
      costToday: 0,
      burnRatePerHour: 0,
      budgetRemaining: 0,
      budgetPercentUsed: 0,
      resetTime: '00:00',
      totalTokens: 0,
      tokensPerMinute: null,
      isFresh: false,
      lastFetched: 0
    },
    metadata: {
      detectionMethod: 'auto',
      firstSeen: Date.now(),
      lastUsed: Date.now(),
      totalSessions: 0
    }
  };
}

/**
 * Convert SessionHealth to RuntimeSession
 */
export function sessionHealthToRuntimeSession(
  health: SessionHealth,
  authProfileId: string = 'default'
): RuntimeSession {
  return {
    sessionId: health.sessionId,
    authProfile: authProfileId,
    projectPath: health.projectPath,
    transcriptPath: health.transcriptPath,
    tmux: health.tmux,  // Copy tmux context if present
    health: {
      status: health.health.status,
      lastUpdate: health.health.lastUpdate,
      issues: health.health.issues
    },
    model: {
      value: health.model.value,
      source: health.model.source,
      confidence: health.model.confidence
    },
    context: {
      tokensUsed: health.context.tokensUsed,
      tokensLeft: health.context.tokensLeft,
      percentUsed: health.context.percentUsed,
      windowSize: health.context.windowSize,
      nearCompaction: health.context.nearCompaction
    },
    git: {
      branch: health.git.branch,
      ahead: health.git.ahead,
      behind: health.git.behind,
      dirty: health.git.dirty,
      lastChecked: health.git.lastChecked
    },
    transcript: {
      exists: health.transcript.exists,
      sizeBytes: health.transcript.sizeBytes,
      lastModified: health.transcript.lastModified,
      lastModifiedAgo: health.transcript.lastModifiedAgo,
      messageCount: health.transcript.messageCount,
      lastMessagePreview: health.transcript.lastMessagePreview,
      isSynced: health.transcript.isSynced
    },
    alerts: {
      secretsDetected: health.alerts.secretsDetected,
      secretTypes: health.alerts.secretTypes,
      transcriptStale: health.alerts.transcriptStale,
      dataLossRisk: health.alerts.dataLossRisk
    },
    metadata: {
      gatheredAt: health.gatheredAt,
      lastActivity: health.transcript.lastModified
    },

    // Copy pre-formatted strings from SessionHealth
    formattedStrings: health.formattedOutput ? {
      width40: health.formattedOutput.width40.join('\n'),
      width60: health.formattedOutput.width60.join('\n'),
      width80: health.formattedOutput.width80.join('\n'),
      width100: health.formattedOutput.width100.join('\n'),
      width120: health.formattedOutput.width120.join('\n'),
      width150: health.formattedOutput.width150.join('\n'),
      width200: health.formattedOutput.width200.join('\n')
    } : undefined
  };
}
