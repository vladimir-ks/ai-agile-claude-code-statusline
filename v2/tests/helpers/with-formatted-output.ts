/**
 * Test Helper: Add formattedOutput to SessionHealth for legacy tests
 *
 * This helper ensures old tests work with the new Phase 0 architecture
 * by generating formattedOutput for test health objects.
 */

import { StatuslineFormatter } from '../../src/lib/statusline-formatter';

/**
 * Add formattedOutput to SessionHealth object
 * Use this in tests that create health data without formattedOutput
 */
export function withFormattedOutput(health: any): any {
  // Respect NO_COLOR from environment (for tests)
  const originalNoColor = process.env.NO_COLOR;
  if (!process.env.NO_COLOR) {
    process.env.NO_COLOR = '1'; // Default to no colors in tests
  }

  try {
  // Ensure health has all required fields (fill with defaults if missing, merge with provided)
  const complete = {
    sessionId: health.sessionId || 'test',
    projectPath: health.projectPath || '',
    transcriptPath: health.transcriptPath || '',
    launch: { authProfile: 'default', detectionMethod: 'default', ...health.launch },
    health: { status: 'healthy', lastUpdate: Date.now(), issues: [], ...health.health },
    transcript: {
      exists: false,
      sizeBytes: 0,
      lastModified: 0,
      lastModifiedAgo: '',
      messageCount: 0,
      lastMessageTime: 0,
      lastMessagePreview: '',
      lastMessageAgo: '',
      isSynced: false,
      ...health.transcript
    },
    model: { value: 'Claude', source: 'default', confidence: 10, ...health.model },
    context: {
      tokensUsed: 0,
      tokensLeft: 0,
      percentUsed: 0,
      windowSize: 200000,
      nearCompaction: false,
      ...health.context
    },
    git: { branch: '', ahead: 0, behind: 0, dirty: 0, lastChecked: 0, ...health.git },
    billing: {
      costToday: 0,
      burnRatePerHour: 0,
      budgetRemaining: 0,
      budgetPercentUsed: 0,
      resetTime: '',
      isFresh: false,
      lastFetched: 0,
      ...health.billing
    },
    alerts: {
      secretsDetected: false,
      secretTypes: [],
      transcriptStale: false,
      dataLossRisk: false,
      ...health.alerts
    },
    gatheredAt: health.gatheredAt || Date.now()
  };

    // Generate formattedOutput using StatuslineFormatter
    complete.formattedOutput = StatuslineFormatter.formatAllVariants(complete);

    return complete;
  } finally {
    // Restore original NO_COLOR setting
    if (originalNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  }
}
