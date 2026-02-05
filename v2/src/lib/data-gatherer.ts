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
import IncrementalTranscriptScanner from './incremental-transcript-scanner';
import GitLeaksScanner from './gitleaks-scanner';
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

class DataGatherer {
  private healthStore: HealthStore;
  private transcriptMonitor: TranscriptMonitor;
  private incrementalScanner: IncrementalTranscriptScanner;
  private gitleaksScanner: GitLeaksScanner;
  private cleanupManager: CleanupManager;
  private modelResolver: ModelResolver;
  private gitModule: GitModule;
  private ccusageModule: CCUsageSharedModule;
  private runtimeStateStore: RuntimeStateStore;

  constructor(healthStorePath?: string) {
    this.healthStore = new HealthStore(healthStorePath);
    this.transcriptMonitor = new TranscriptMonitor();
    this.incrementalScanner = new IncrementalTranscriptScanner();
    this.gitleaksScanner = new GitLeaksScanner();
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
   */
  async gather(
    sessionId: string,
    transcriptPath: string | null,
    jsonInput: ClaudeCodeInput | null
  ): Promise<SessionHealth> {
    const startTime = Date.now();
    // Hard time budget: 20s (wrapper SIGKILL at 30s, need margin for post-billing steps)
    const DEADLINE_MS = 20000;
    const deadline = startTime + DEADLINE_MS;
    const health = createDefaultHealth(sessionId);
    health.gatheredAt = startTime;

    // Set paths
    health.transcriptPath = transcriptPath || '';
    // Priority: 1) start_directory from JSON, 2) cwd from environment, 3) decoded transcript path
    health.projectPath = jsonInput?.start_directory || process.cwd() || this.extractProjectPath(transcriptPath);

    // Preserve firstSeen from existing health (if this is not a new session)
    const existingHealth = this.healthStore.readSessionHealth(sessionId);
    if (existingHealth?.firstSeen) {
      health.firstSeen = existingHealth.firstSeen;
      health.sessionDuration = Date.now() - existingHealth.firstSeen;
    } else {
      health.firstSeen = Date.now();
      health.sessionDuration = 0;
    }

    // 0. Auth profile detection (run early before billing fetch)
    // We'll update this later once we have billing data
    const authProfiles = this.runtimeStateStore.read().authProfiles;
    health.launch = AuthProfileDetector.detectProfile(
      health.projectPath,
      existingHealth?.billing || null,
      authProfiles
    );

    // 0b. Session-aware keychain resolution (derive configDir + keychainService from transcript path)
    const { configDir, keychainService } = KeychainResolver.resolveFromTranscript(transcriptPath);
    if (configDir) {
      health.launch.configDir = configDir;
      health.launch.keychainService = keychainService || undefined;

      // Derive auth profile from configDir → hot-swap slot mapping
      // This is more precise than generic detection since it's derived from the session's transcript path
      const matchedSlot = HotSwapQuotaReader.getSlotByConfigDir(configDir);
      if (matchedSlot) {
        health.launch.authProfile = matchedSlot.email;
        health.launch.detectionMethod = 'path'; // configDir-based is a path-derived method
        console.error(`[DataGatherer] Session matched → ${keychainService} (${redactEmail(matchedSlot.email)})`);
      } else {
        console.error(`[DataGatherer] Session → ${keychainService} (no slot match)`);
      }
    }

    // 0c. Tmux context capture (if running in tmux)
    if (process.env.TMUX_SESSION_NAME) {
      health.tmux = {
        session: process.env.TMUX_SESSION_NAME,
        window: process.env.TMUX_WINDOW_INDEX || '0',
        pane: process.env.TMUX_PANE_INDEX || '0',
        width: parseInt(process.env.STATUSLINE_WIDTH || '120', 10),
        height: parseInt(process.env.TMUX_PANE_HEIGHT || '30', 10)
      };
    }

    // 1. Transcript health (critical for data loss detection)
    // OPTIMIZATION: Use incremental scanner for 20x speedup
    if (transcriptPath) {
      health.transcript = this.incrementalScanner.checkHealth(sessionId, transcriptPath);
    }

    // 2. Model (multi-source validation)
    const settingsModel = this.getSettingsModel();
    health.model = this.modelResolver.resolve(transcriptPath, jsonInput, settingsModel);
    health.model.updatedAt = Date.now();

    // 3. Context window (from JSON input)
    health.context = this.calculateContext(jsonInput);
    health.context.updatedAt = Date.now();

    // 4. Git status (cached)
    // NOTE: lastChecked is now set BEFORE fetch, so cached git data
    // gets the fetch time, not the post-return time. This fixes the bug
    // where cached git data showed "just checked" when it was actually 30s old.
    try {
      const gitFetchStart = Date.now();
      const gitData = await this.gitModule.fetch(sessionId);
      if (gitData) {
        health.git = {
          branch: gitData.branch || '',
          ahead: gitData.ahead || 0,
          behind: gitData.behind || 0,
          dirty: gitData.dirty || 0,
          lastChecked: gitFetchStart
        };
      }
    } catch {
      // Git not available - keep defaults
    }

    // 5. Billing data - SHARED across all sessions (billing is global, not per-session)
    // TIME BUDGET: Billing is the slowest step (OAuth + ccusage can take 20s+).
    // If we've already spent too long on prior steps, skip billing and use stale data.
    // This guarantees writeSessionHealth() is always reached before the 30s SIGKILL.
    const billingStartTime = Date.now();
    const billingBudgetMs = Math.max(0, deadline - billingStartTime - 5000); // Reserve 5s for post-billing steps

    const slotStatus = configDir ? HotSwapQuotaReader.getSlotStatus(
      HotSwapQuotaReader.getSlotByConfigDir(configDir)?.slotId || ''
    ) : 'unknown';

    if (billingBudgetMs < 2000) {
      // Not enough time for billing — use stale data
      console.error(`[DataGatherer] Skipping billing (only ${billingBudgetMs}ms left in budget)`);
      if (existingHealth?.billing?.costToday > 0) {
        health.billing = { ...existingHealth.billing, isFresh: false };
      }
    } else {
      // Race billing fetch against remaining time budget
      const billingPromise = this.fetchBilling(
        health, configDir, keychainService, slotStatus, authProfiles, existingHealth
      );
      const timeoutPromise = new Promise<void>(resolve => setTimeout(resolve, billingBudgetMs));

      await Promise.race([billingPromise, timeoutPromise]);

      // If billing didn't complete in time, use stale
      if (!health.billing.isFresh && !health.billing.costToday && existingHealth?.billing?.costToday > 0) {
        health.billing = { ...existingHealth.billing, isFresh: false };
      }
    }

    // 5b. Weekly/Daily quota - priority:
    // 1. hot-swap-quota.json (PRIMARY - reads active_account from claude-sessions.yaml)
    // 2. OAuth API (already in health.billing if OAuth succeeded)
    // 3. subscription.yaml (user-managed fallback, typically stale)
    const hotSwapQuota = HotSwapQuotaReader.getActiveQuota(configDir || undefined);

    if (hotSwapQuota) {
      // Hot-swap has quota data — use it (even if slightly stale, it's still
      // better than subscription.yaml which may be hours/days old)
      health.billing.weeklyBudgetRemaining = hotSwapQuota.weeklyBudgetRemaining;
      health.billing.weeklyBudgetPercentUsed = hotSwapQuota.weeklyPercentUsed;
      health.billing.weeklyResetDay = hotSwapQuota.weeklyResetDay;
      health.billing.weeklyDataStale = hotSwapQuota.isStale;
      health.billing.weeklyLastModified = hotSwapQuota.lastFetched;

      if (hotSwapQuota.dailyPercentUsed > 0) {
        health.billing.budgetPercentUsed = hotSwapQuota.dailyPercentUsed;
      }

      const ageSec = Math.floor((Date.now() - hotSwapQuota.lastFetched) / 1000);
      console.error(`[DataGatherer] Hot-swap quota: ${hotSwapQuota.slotId} (${redactEmail(hotSwapQuota.email)}, age: ${ageSec}s, stale: ${hotSwapQuota.isStale})`);
    } else {
      // No hot-swap data — fall through to OAuth or subscription.yaml
      const hasOAuthWeeklyData = health.billing.weeklyBudgetRemaining !== undefined ||
                                 health.billing.weeklyBudgetPercentUsed !== undefined;

      if (hasOAuthWeeklyData) {
        health.billing.weeklyDataStale = false;
        health.billing.weeklyLastModified = Date.now();
      } else {
        const subscriptionQuota = SubscriptionReader.getWeeklyQuota();
        if (subscriptionQuota) {
          health.billing.weeklyBudgetRemaining = subscriptionQuota.hoursRemaining;
          health.billing.weeklyBudgetPercentUsed = subscriptionQuota.percentUsed;
          health.billing.weeklyResetDay = subscriptionQuota.resetDay;
          health.billing.weeklyDataStale = subscriptionQuota.isStale;
          health.billing.weeklyLastModified = subscriptionQuota.lastModified;
        }
      }

      const sessionQuota = SubscriptionReader.getCurrentSessionQuota();
      if (sessionQuota && sessionQuota.percentUsed > 0) {
        health.billing.budgetPercentUsed = sessionQuota.percentUsed;
      }
    }

    // 6. Secrets scan (if transcript exists)
    // OPTIMIZATION: Use gitleaks for professional secret detection (if installed)
    if (health.transcript.exists && transcriptPath) {
      try {
        const gitleaksResult = await this.gitleaksScanner.scan(sessionId, transcriptPath);
        health.alerts.secretsDetected = gitleaksResult.hasSecrets;
        health.alerts.secretTypes = gitleaksResult.secretTypes;
      } catch {
        // GitLeaks failed - fall back to regex scan
        const secrets = this.scanForSecrets(transcriptPath);
        health.alerts.secretsDetected = secrets.hasSecrets;
        health.alerts.secretTypes = secrets.types;
      }
    }

    // 7. Data loss risk detection
    const config = this.healthStore.readConfig();
    health.alerts.transcriptStale = this.transcriptMonitor.isTranscriptStale(
      health.transcript,
      config.thresholds.transcriptStaleMinutes
    );
    health.alerts.dataLossRisk =
      health.alerts.transcriptStale && this.isSessionActive(jsonInput);

    // 8. Calculate overall health status
    health.health = this.calculateOverallHealth(health, config);

    // 9. Add project metadata and performance metrics
    health.project = {
      language: AuthProfileDetector.detectProjectLanguage(health.projectPath),
      gitRemote: this.extractGitRemote(health.projectPath),
      repoName: AuthProfileDetector.extractRepoName(
        health.projectPath,
        this.extractGitRemote(health.projectPath)
      )
    };

    health.performance = {
      gatherDuration: Date.now() - startTime,
      billingFetchDuration: health.billing.isFresh ? (Date.now() - billingStartTime) : undefined,
      transcriptScanDuration: undefined // Will be added by incremental scanner if available
    };

    // 9b. Failover notification (read local JSONL — fast, non-blocking)
    health.failoverNotification = FailoverSubscriber.getNotification() || undefined;

    // 10. CRITICAL FIX: Compute billing.isFresh from timestamp (replaces stored boolean)
    // Previously isFresh was stored as true and never recomputed — 4-day-old data showed fresh.
    health.billing.isFresh = FreshnessManager.isBillingFresh(health.billing.lastFetched);

    // 10b. Pre-format output for all terminal widths (Phase 0: Performance Architecture)
    // CRITICAL: Must happen BEFORE writeSessionHealth() so formattedOutput is included in JSON
    health.formattedOutput = StatuslineFormatter.formatAllVariants(health);

    // 11. Write to health store (NOW includes formattedOutput!)
    this.healthStore.writeSessionHealth(sessionId, health);

    // 11b. Write debug state file (non-critical — never fails the gather)
    DebugStateWriter.write(sessionId, health);

    // 11c. Publish health for cloud_configs handshake (non-critical)
    HealthPublisher.publish(sessionId, health);

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
   * Fetch billing data (extracted for time-budget racing).
   * Mutates health.billing directly.
   */
  private async fetchBilling(
    health: SessionHealth,
    configDir: string | null,
    keychainService: string | null,
    slotStatus: string,
    authProfiles: any,
    existingHealth: SessionHealth | null
  ): Promise<void> {
    // Try OAuth API first (authoritative source with weekly quota)
    let oauthBilling: BillingInfo | null = null;

    if (slotStatus === 'inactive') {
      console.error(`[DataGatherer] Skipping OAuth API for inactive slot (${redactEmail(health.launch.authProfile)})`);
    } else {
      const oauthStart = Date.now();
      try {
        oauthBilling = await AnthropicOAuthAPI.fetchUsage(health.launch.authProfile, keychainService || undefined);
        DebugStateWriter.recordFetch({
          category: 'billing_oauth',
          timestamp: oauthStart,
          success: !!(oauthBilling && oauthBilling.isFresh),
          durationMs: Date.now() - oauthStart,
        });
      } catch (err) {
        DebugStateWriter.recordFetch({
          category: 'billing_oauth',
          timestamp: oauthStart,
          success: false,
          durationMs: Date.now() - oauthStart,
          error: sanitizeError(err),
        });
      }
    }

    if (oauthBilling && oauthBilling.isFresh) {
      health.billing = oauthBilling;
      health.launch = AuthProfileDetector.detectProfile(
        health.projectPath, health.billing, authProfiles
      );
    } else {
      // OAuth failed - fallback to ccusage
      const ccusageStart = Date.now();
      try {
        const billingData = await this.ccusageModule.fetch(health.sessionId || '');

        if (billingData && billingData.isFresh) {
          const totalMinutes = (billingData.hoursLeft || 0) * 60 + (billingData.minutesLeft || 0);
          health.billing = {
            costToday: billingData.costUSD || 0,
            burnRatePerHour: billingData.costPerHour || 0,
            budgetRemaining: totalMinutes,
            budgetPercentUsed: billingData.percentageUsed || 0,
            resetTime: billingData.resetTime || '',
            totalTokens: billingData.totalTokens || 0,
            tokensPerMinute: billingData.tokensPerMinute || null,
            isFresh: true,
            lastFetched: billingData.lastFetched || Date.now()
          };
          health.launch = AuthProfileDetector.detectProfile(
            health.projectPath, health.billing, authProfiles
          );
          DebugStateWriter.recordFetch({
            category: 'billing_ccusage',
            timestamp: ccusageStart,
            success: true,
            durationMs: Date.now() - ccusageStart,
          });
        } else {
          // ccusage returned stale data or failed - try local cost calculation
          // This is the PRIMARY path when ccusage hangs or returns stale cache
          console.error(`[DataGatherer] ccusage returned stale data (isFresh=${billingData?.isFresh})`);
          DebugStateWriter.recordFetch({
            category: 'billing_ccusage',
            timestamp: ccusageStart,
            success: false,
            durationMs: Date.now() - ccusageStart,
          });

          console.error(`[DataGatherer] transcriptPath=${health.transcriptPath}, exists=${health.transcriptPath ? existsSync(health.transcriptPath) : false}`);
          if (health.transcriptPath && existsSync(health.transcriptPath)) {
            console.error('[DataGatherer] ccusage stale, trying local cost calculation...');
            const localCostStart = Date.now();
            try {
              const localCost = await LocalCostCalculator.calculateCost(health.transcriptPath);
              if (localCost && localCost.isFresh && localCost.costUSD > 0) {
                // Use local cost data but preserve budget info from ccusage if available
                const totalMinutes = billingData
                  ? (billingData.hoursLeft || 0) * 60 + (billingData.minutesLeft || 0)
                  : (existingHealth?.billing?.budgetRemaining || 0);
                health.billing = {
                  costToday: localCost.costUSD,
                  burnRatePerHour: localCost.costPerHour || 0,
                  budgetRemaining: totalMinutes,
                  budgetPercentUsed: billingData?.percentageUsed || existingHealth?.billing?.budgetPercentUsed || 0,
                  resetTime: billingData?.resetTime || existingHealth?.billing?.resetTime || '',
                  totalTokens: localCost.totalTokens || 0,
                  tokensPerMinute: localCost.tokensPerMinute || null,
                  isFresh: true,
                  lastFetched: localCost.lastFetched
                };
                DebugStateWriter.recordFetch({
                  category: 'billing_local',
                  timestamp: localCostStart,
                  success: true,
                  durationMs: Date.now() - localCostStart,
                });
                console.error(`[DataGatherer] Local cost: $${localCost.costUSD.toFixed(2)} (${localCost.messageCount} msgs)`);
              } else if (billingData && billingData.costUSD >= 0) {
                // Local cost failed - use stale ccusage data
                const totalMinutes = (billingData.hoursLeft || 0) * 60 + (billingData.minutesLeft || 0);
                health.billing = {
                  costToday: billingData.costUSD || 0,
                  burnRatePerHour: billingData.costPerHour || 0,
                  budgetRemaining: totalMinutes,
                  budgetPercentUsed: billingData.percentageUsed || 0,
                  resetTime: billingData.resetTime || '',
                  totalTokens: billingData.totalTokens || 0,
                  tokensPerMinute: billingData.tokensPerMinute || null,
                  isFresh: false,
                  lastFetched: billingData.lastFetched || Date.now()
                };
              } else if (existingHealth?.billing?.costToday > 0) {
                health.billing = { ...existingHealth.billing, isFresh: false };
              }
            } catch (localErr) {
              DebugStateWriter.recordFetch({
                category: 'billing_local',
                timestamp: localCostStart,
                success: false,
                durationMs: Date.now() - localCostStart,
                error: sanitizeError(localErr),
              });
              // Fall back to stale ccusage data
              if (billingData && billingData.costUSD >= 0) {
                const totalMinutes = (billingData.hoursLeft || 0) * 60 + (billingData.minutesLeft || 0);
                health.billing = {
                  costToday: billingData.costUSD || 0,
                  burnRatePerHour: billingData.costPerHour || 0,
                  budgetRemaining: totalMinutes,
                  budgetPercentUsed: billingData.percentageUsed || 0,
                  resetTime: billingData.resetTime || '',
                  totalTokens: billingData.totalTokens || 0,
                  tokensPerMinute: billingData.tokensPerMinute || null,
                  isFresh: false,
                  lastFetched: billingData.lastFetched || Date.now()
                };
              } else if (existingHealth?.billing?.costToday > 0) {
                health.billing = { ...existingHealth.billing, isFresh: false };
              }
            }
          } else if (billingData && billingData.costUSD >= 0) {
            // No transcript path - use stale ccusage data
            const totalMinutes = (billingData.hoursLeft || 0) * 60 + (billingData.minutesLeft || 0);
            health.billing = {
              costToday: billingData.costUSD || 0,
              burnRatePerHour: billingData.costPerHour || 0,
              budgetRemaining: totalMinutes,
              budgetPercentUsed: billingData.percentageUsed || 0,
              resetTime: billingData.resetTime || '',
              totalTokens: billingData.totalTokens || 0,
              tokensPerMinute: billingData.tokensPerMinute || null,
              isFresh: false,
              lastFetched: billingData.lastFetched || Date.now()
            };
          } else if (existingHealth?.billing?.costToday > 0) {
            health.billing = { ...existingHealth.billing, isFresh: false };
          }
        }
      } catch (err) {
        // ccusage module threw an error (rare - usually returns stale data)
        DebugStateWriter.recordFetch({
          category: 'billing_ccusage',
          timestamp: ccusageStart,
          success: false,
          durationMs: Date.now() - ccusageStart,
          error: sanitizeError(err),
        });
        console.error('[DataGatherer] ccusage threw error:', sanitizeError(err));

        if (existingHealth?.billing?.costToday > 0) {
          health.billing = { ...existingHealth.billing, isFresh: false };
        }
      }
    }
  }

  /**
   * Extract project path from transcript path
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
   * Get model from settings.json
   */
  private getSettingsModel(): string | null {
    const settingsPath = `${homedir()}/.claude/settings.json`;
    try {
      if (existsSync(settingsPath)) {
        const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        return content.model || null;
      }
    } catch {
      // Ignore
    }
    return null;
  }

  /**
   * Calculate context window usage
   *
   * CRITICAL: Claude Code provides nested structure:
   *   context_window.current_usage.input_tokens (NOT context_window.current_input_tokens)
   *   context_window.current_usage.output_tokens
   *   context_window.current_usage.cache_read_input_tokens
   *   context_window.current_usage.cache_creation_input_tokens
   *
   * SEMANTICS:
   *   percentUsed = percentage of COMPACTION THRESHOLD (78%), not total window
   *   tokensLeft = tokens until compaction triggers, not until window full
   */
  private calculateContext(jsonInput: ClaudeCodeInput | null): ContextInfo {
    const result: ContextInfo = {
      tokensUsed: 0,
      tokensLeft: 0,
      percentUsed: 0,
      windowSize: 200000,
      nearCompaction: false
    };

    if (!jsonInput?.context_window) {
      return result;
    }

    const ctx = jsonInput.context_window;
    result.windowSize = ctx.context_window_size || 200000;

    // VALIDATION: Ensure window size is reasonable (10k - 500k tokens)
    if (result.windowSize < 10000 || result.windowSize > 500000) {
      result.windowSize = 200000; // Default to standard window
    }

    // CRITICAL FIX: Use nested current_usage structure (matches V1 and actual Claude Code output)
    const currentUsage = ctx.current_usage;

    // VALIDATION: Extract and validate token counts (must be non-negative numbers)
    const inputTokens = Math.max(0, Number(currentUsage?.input_tokens) || 0);
    const outputTokens = Math.max(0, Number(currentUsage?.output_tokens) || 0);
    const cacheReadTokens = Math.max(0, Number(currentUsage?.cache_read_input_tokens) || 0);

    // Total tokens = input + output + cache reads (cache creation is separate billing concern)
    result.tokensUsed = inputTokens + outputTokens + cacheReadTokens;

    // VALIDATION: tokensUsed cannot exceed window size (would indicate bad data)
    if (result.tokensUsed > result.windowSize * 1.5) {
      // Likely bad data - cap at window size
      result.tokensUsed = result.windowSize;
    }

    // Calculate tokens until 78% compaction threshold
    const compactionThreshold = Math.floor(result.windowSize * 0.78);
    result.tokensLeft = Math.max(0, compactionThreshold - result.tokensUsed);

    // Calculate percentage used (of compaction threshold, not total window)
    result.percentUsed = compactionThreshold > 0
      ? Math.min(100, Math.floor((result.tokensUsed / compactionThreshold) * 100))
      : 0;

    // Near compaction warning
    result.nearCompaction = result.percentUsed >= 70;

    return result;
  }

  /**
   * Scan transcript for secrets
   */
  private scanForSecrets(transcriptPath: string): { hasSecrets: boolean; types: string[] } {
    const result = { hasSecrets: false, types: [] as string[] };

    try {
      const stats = statSync(transcriptPath);
      if (stats.size === 0 || stats.size > 10_000_000) {
        // Skip empty or very large files
        return result;
      }

      const content = readFileSync(transcriptPath, 'utf-8');

      // High-severity patterns only
      const patterns: Array<{ name: string; regex: RegExp }> = [
        { name: 'API Key', regex: /sk-[a-zA-Z0-9]{20,}/g },
        { name: 'AWS Key', regex: /AKIA[0-9A-Z]{16}/g },
        { name: 'GitHub Token', regex: /gh[ps]_[a-zA-Z0-9]{36}/g },
        { name: 'Private Key', regex: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]{50,4096}?-----END[A-Z ]*PRIVATE KEY-----/g },
        { name: 'DB Connection', regex: /(postgres|mongodb|mysql):\/\/[^:]+:[^@]+@/gi }
      ];

      for (const pattern of patterns) {
        const matches = content.match(pattern.regex);
        if (matches && matches.length > 0) {
          // Additional validation for private keys: require base64-like content
          if (pattern.name === 'Private Key') {
            // Real private keys have continuous base64 content (A-Za-z0-9+/=)
            // Code snippets or discussions have: quotes, regex markers, spaces, newlines
            const hasRealKeyContent = matches.some(match => {
              // Extract content between BEGIN and END
              const inner = match.replace(/-----BEGIN[^-]*-----/, '').replace(/-----END[^-]*-----/, '');
              // Real keys: mostly base64 chars, minimal whitespace
              const base64Chars = (inner.match(/[A-Za-z0-9+\/=]/g) || []).length;
              const totalChars = inner.length;
              // Real key should be >80% base64 characters
              return base64Chars > totalChars * 0.8 && totalChars > 200;
            });
            if (!hasRealKeyContent) continue; // Skip false positive
          }
          result.hasSecrets = true;
          result.types.push(pattern.name);
        }
      }

    } catch {
      // Ignore scan errors
    }

    return result;
  }

  /**
   * Check if session appears to be active
   *
   * NOTE: If we're receiving JSON input, the session IS syncing properly.
   * Data loss risk is when transcript is stale AND we're NOT receiving fresh input.
   * This means the statusline is being polled but Claude Code may have crashed.
   */
  private isSessionActive(jsonInput: ClaudeCodeInput | null): boolean {
    // Session is "active" for data loss risk purposes when:
    // - We received JSON input (session is running)
    // - Data loss risk = stale transcript + active session
    //
    // However, the REAL risk is when transcript is stale and we DON'T have fresh input
    // For now, keep simple: receiving input = session is running
    return jsonInput !== null && jsonInput.session_id !== undefined;
  }

  /**
   * Calculate overall health status
   */
  private calculateOverallHealth(
    health: SessionHealth,
    config: ReturnType<HealthStore['readConfig']>
  ): SessionHealth['health'] {
    const issues: string[] = [];
    let status: 'healthy' | 'warning' | 'critical' | 'unknown' = 'healthy';

    // Critical issues
    if (!health.transcript.exists && health.transcriptPath) {
      issues.push('Transcript file missing');
      status = 'critical';
    }

    if (health.alerts.secretsDetected) {
      issues.push(`Secrets detected: ${health.alerts.secretTypes.join(', ')}`);
      status = 'critical';
    }

    if (health.alerts.dataLossRisk) {
      issues.push(`Data loss risk: transcript not updated in ${health.transcript.lastModifiedAgo}`);
      if (status !== 'critical') {
        status = 'warning';
      }
    }

    // Warning issues
    if (health.context.percentUsed >= config.thresholds.contextWarningPercent) {
      issues.push(`Context window ${health.context.percentUsed}% full`);
      if (status === 'healthy') {
        status = 'warning';
      }
    }

    if (!FreshnessManager.isBillingFresh(health.billing.lastFetched) && health.billing.lastFetched > 0) {
      issues.push('Billing data stale');
      if (status === 'healthy') {
        status = 'warning';
      }
    }

    return {
      status,
      lastUpdate: Date.now(),
      issues
    };
  }

  /**
   * Extract git remote URL (if git repo)
   */
  private extractGitRemote(projectPath: string): string | undefined {
    try {
      const remote = execSync('git config --get remote.origin.url', {
        cwd: projectPath,
        encoding: 'utf-8',
        timeout: 1000,
        stdio: ['pipe', 'pipe', 'ignore']
      }).trim();
      return remote || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get health store instance (for testing)
   */
  getHealthStore(): HealthStore {
    return this.healthStore;
  }
}

export default DataGatherer;
