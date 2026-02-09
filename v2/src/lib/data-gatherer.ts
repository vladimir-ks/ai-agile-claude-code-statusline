/**
 * Data Gatherer - Orchestrates all data gathering modules
 *
 * Collects data from:
 * - Transcript (health, last message)
 * - Model (multi-source resolution)
 * - Context (from JSON input)
 * - Git (cached)
 * - Billing (ccusage, cached globally)
 * - Secrets (scan transcript)
 *
 * Writes complete SessionHealth to health store
 */

import HealthStore from './health-store';
import TranscriptMonitor from './transcript-monitor';
import ModelResolver from './model-resolver';
import { StatuslineFormatter } from './statusline-formatter';
import {
  SessionHealth,
  ClaudeCodeInput,
  ContextInfo,
  BillingInfo,
  createDefaultHealth
} from '../types/session-health';
import { existsSync, readFileSync, statSync } from 'fs';
import { basename, dirname } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';

// Import existing modules for git and billing
import GitModule from '../modules/git-module';
import CCUsageSharedModule from '../modules/ccusage-shared-module';
import { AnthropicOAuthAPI } from '../modules/anthropic-oauth-api';
import CleanupManager from './cleanup-manager';
import RuntimeStateStore from './runtime-state-store';
import { sessionHealthToRuntimeSession } from '../types/runtime-state';
import { AuthProfileDetector } from '../modules/auth-profile-detector';
import { SubscriptionReader } from './subscription-reader';
import { HotSwapQuotaReader } from './hot-swap-quota-reader';
import { KeychainResolver } from '../modules/keychain-resolver';
import { FreshnessManager } from './freshness-manager';
import { DebugStateWriter } from './debug-state-writer';
import { HealthPublisher } from './health-publisher';
import { sanitizeError, redactEmail } from './sanitize';
import { FailoverSubscriber } from './failover-subscriber';
import { LocalCostCalculator } from './local-cost-calculator';
import { RefreshIntentManager } from './refresh-intent-manager';
import { TelemetryDashboard } from './telemetry-dashboard';
import { SessionLockManager } from './session-lock-manager';
import { VersionChecker } from './version-checker';
import { NotificationManager } from './notification-manager';
import { SlotRecommendationReader } from './slot-recommendation-reader';
import { QuotaBrokerClient } from './quota-broker-client';
import { UnifiedDataBroker } from './unified-data-broker';

class DataGatherer {
  private healthStore: HealthStore;
  private healthStorePath: string | undefined;
  private transcriptMonitor: TranscriptMonitor;
  private cleanupManager: CleanupManager;
  private modelResolver: ModelResolver;
  private gitModule: GitModule;
  private ccusageModule: CCUsageSharedModule;
  private runtimeStateStore: RuntimeStateStore;

  constructor(healthStorePath?: string) {
    this.healthStorePath = healthStorePath;
    this.healthStore = new HealthStore(healthStorePath);
    this.transcriptMonitor = new TranscriptMonitor();
    this.cleanupManager = new CleanupManager(healthStorePath);
    this.modelResolver = new ModelResolver();
    this.runtimeStateStore = new RuntimeStateStore(healthStorePath);
    this.gitModule = new GitModule({
      id: 'git',
      name: 'Git Module',
      enabled: true,
      cacheTTL: 30000  // Increased to 30s (was 10s)
    });
    this.ccusageModule = new CCUsageSharedModule({
      id: 'ccusage',
      name: 'CCUsage Module',
      enabled: true,
      cacheTTL: 120000,  // 2min cooldown
      timeout: 25000
    });

    // Ensure runtime state is initialized (migrate from old files if needed)
    this.runtimeStateStore.migrate().catch(() => {
      // Ignore migration errors - will create default on first write
    });
  }

  /**
   * Gather all data for a session
   *
   * ARCHITECTURE: This method now delegates data gathering to UnifiedDataBroker
   * and handles only post-processing (writes, cleanup, notifications).
   */
  async gather(
    sessionId: string,
    transcriptPath: string | null,
    jsonInput: ClaudeCodeInput | null
  ): Promise<SessionHealth> {
    const startTime = Date.now();
    const DEADLINE_MS = 20000;
    const deadline = startTime + DEADLINE_MS;

    // Derive session context for broker
    const { configDir, keychainService } = KeychainResolver.resolveFromTranscript(transcriptPath);
    const existingHealth = this.healthStore.readSessionHealth(sessionId);
    const projectPath = jsonInput?.start_directory || process.cwd() || this.extractProjectPath(transcriptPath);

    // DELEGATE: All data gathering to UnifiedDataBroker (steps 0-10b)
    const health = await UnifiedDataBroker.gatherAll(
      sessionId,
      transcriptPath,
      jsonInput,
      {
        healthStorePath: this.healthStorePath,
        existingHealth,
        projectPath,
        configDir,
        keychainService,
        deadline,
      }
    );

    // -----------------------------------------------------------------------
    // POST-PROCESSING (steps 11-14): File writes, cleanup, notifications
    // -----------------------------------------------------------------------

    // 11. Write to health store (includes formattedOutput from broker)
    this.healthStore.writeSessionHealth(sessionId, health);

    // 11b. Write debug state file (non-critical — never fails the gather)
    DebugStateWriter.write(sessionId, health);

    // 11c. Publish health for cloud_configs handshake (non-critical)
    HealthPublisher.publish(sessionId, health);

    // 11d. Update telemetry dashboard (non-critical)
    try {
      TelemetryDashboard.update(sessionId, health);
    } catch {
      // Telemetry update failed - not critical
    }

    // 11d2. Record telemetry to SQLite database (non-critical)
    try {
      const { TelemetryDatabase } = require('./telemetry-database');
      const displayTimeMs = Date.now() - startTime;
      TelemetryDatabase.recordFromHealth(health, displayTimeMs);
    } catch {
      // Telemetry recording failed - not critical
    }

    // 11e. Create or update session lock file (non-critical — Phase 1)
    try {
      // Only create lock if we have slot resolution
      const matchedSlot = configDir ? HotSwapQuotaReader.getSlotByConfigDir(configDir) : null;
      if (matchedSlot && keychainService && health.transcriptPath) {
        const tmuxContext = health.tmux ? {
          session: health.tmux.session,
          window: health.tmux.window,
          pane: health.tmux.pane
        } : undefined;

        SessionLockManager.getOrCreate(
          sessionId,
          matchedSlot.slotId,
          configDir,
          keychainService,
          matchedSlot.email,
          health.transcriptPath,
          tmuxContext
        );
      }
    } catch {
      // Session lock creation failed - not critical
    }

    // 11f. Check for version updates (non-critical — Phase 2)
    try {
      // Only check if cooldown expired (4h)
      if (VersionChecker.getCheckCooldown() === 0) {
        // Non-blocking async check
        VersionChecker.getLatestVersion().then(latest => {
          if (latest) {
            SessionLockManager.update(sessionId, {
              lastVersionCheck: Date.now()
            });

            // Register update notification if newer version available
            const currentVersion = VersionChecker.getCurrentVersion();
            if (currentVersion !== 'unknown' && VersionChecker.needsUpdate(currentVersion, latest.version)) {
              NotificationManager.register(
                'version_update',
                `Update to ${latest.version} available (your version: ${currentVersion})`,
                7
              );
            }
          }
        }).catch(() => {
          // Version check failed - silent failure (non-critical)
        });
      }
    } catch {
      // Version check initialization failed - not critical
    }

    // 11g. Check for slot switch recommendation (non-critical — Phase 2)
    // Priority: QuotaBrokerClient (merged data) → SlotRecommendationReader (fallback)
    try {
      const lock = SessionLockManager.read(sessionId);
      if (lock && lock.slotId) {
        let switchMsg: string | null = null;

        if (QuotaBrokerClient.isAvailable()) {
          switchMsg = QuotaBrokerClient.getSwitchMessage(lock.slotId);
        } else {
          switchMsg = SlotRecommendationReader.getSwitchMessage(lock.slotId);
        }

        if (switchMsg) {
          NotificationManager.register('slot_switch', switchMsg, 6);
        } else {
          // No switch recommended - remove notification if exists
          NotificationManager.remove('slot_switch');
        }
      }
    } catch {
      // Slot switch check failed - not critical
    }

    // 12. Update global summary (synchronous - we're already in background daemon)
    try {
      this.healthStore.updateSessionsSummary();
    } catch {
      // Ignore summary update errors
    }

    // 13. Cleanup old files (runs max once per 24h via cooldown)
    try {
      await this.cleanupManager.cleanupIfNeeded();
    } catch {
      // Cleanup failed - not critical
    }

    // 13b. Cleanup old dismissed notifications (>24h)
    try {
      NotificationManager.cleanup();
    } catch {
      // Notification cleanup failed - not critical
    }

    // 14. Update runtime state (unified auth profiles + sessions)
    try {
      // Ensure the detected auth profile exists (or create it)
      const authProfile = this.runtimeStateStore.getAuthProfile(health.launch.authProfile) ||
                         this.runtimeStateStore.ensureDefaultAuthProfile();

      // Update auth profile billing (if we have fresh data)
      if (health.billing.isFresh) {
        this.runtimeStateStore.updateAuthProfileBilling(authProfile.profileId, health.billing);
      }

      // Convert SessionHealth to RuntimeSession
      const runtimeSession = sessionHealthToRuntimeSession(health, authProfile.profileId);

      // Upsert session
      this.runtimeStateStore.upsertSession(runtimeSession);
    } catch (error) {
      // Runtime state update failed - not critical, continue
      console.error('[DataGatherer] Failed to update runtime state:', sanitizeError(error));
    }

    return health;
  }


  /**
   * Extract project path from transcript path encoding
   * Used as fallback when jsonInput.start_directory is missing
   */
  private extractProjectPath(transcriptPath: string | null): string {
    if (!transcriptPath) return '';

    // Transcript is at: ~/.claude/projects/-[encoded-path]/[session-id].jsonl
    // We need to decode the encoded path
    const dir = dirname(transcriptPath);
    const encodedPath = basename(dir);

    // Decode: -Users-vmks--project → /Users/vmks/project
    if (encodedPath.startsWith('-')) {
      // Replace - with / but handle -- as single -
      return encodedPath
        .replace(/--/g, '\x00')  // Temporarily replace -- with null char
        .replace(/-/g, '/')       // Replace - with /
        .replace(/\x00/g, '-');   // Restore -- as -
    }

    return dir;
  }

  /**
   * Get health store instance (for testing)
   */
  getHealthStore(): HealthStore {
    return this.healthStore;
  }
}

export default DataGatherer;
