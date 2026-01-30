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
import {
  SessionHealth,
  ClaudeCodeInput,
  ContextInfo,
  GitInfo,
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

class DataGatherer {
  private healthStore: HealthStore;
  private transcriptMonitor: TranscriptMonitor;
  private modelResolver: ModelResolver;
  private gitModule: GitModule;
  private ccusageModule: CCUsageSharedModule;

  constructor(healthStorePath?: string) {
    this.healthStore = new HealthStore(healthStorePath);
    this.transcriptMonitor = new TranscriptMonitor();
    this.modelResolver = new ModelResolver();
    this.gitModule = new GitModule({
      id: 'git',
      name: 'Git Module',
      enabled: true,
      cacheTTL: 10000
    });
    this.ccusageModule = new CCUsageSharedModule({
      id: 'ccusage',
      name: 'CCUsage Module',
      enabled: true,
      cacheTTL: 120000,
      timeout: 25000
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
    const health = createDefaultHealth(sessionId);
    health.gatheredAt = Date.now();

    // Set paths
    health.transcriptPath = transcriptPath || '';
    health.projectPath = this.extractProjectPath(transcriptPath);

    // 1. Transcript health (critical for data loss detection)
    if (transcriptPath) {
      health.transcript = this.transcriptMonitor.checkHealth(transcriptPath);
    }

    // 2. Model (multi-source validation)
    const settingsModel = this.getSettingsModel();
    health.model = this.modelResolver.resolve(transcriptPath, jsonInput, settingsModel);

    // 3. Context window (from JSON input)
    health.context = this.calculateContext(jsonInput);

    // 4. Git status (cached)
    try {
      const gitData = await this.gitModule.fetch(sessionId);
      if (gitData) {
        health.git = {
          branch: gitData.branch || '',
          ahead: gitData.ahead || 0,
          behind: gitData.behind || 0,
          dirty: gitData.dirty || 0,
          lastChecked: Date.now()
        };
      }
    } catch {
      // Git not available - keep defaults
    }

    // 5. Billing data (global, cached - only fetch if stale >2 min)
    // First check if we have existing billing data that's fresh
    const existingHealth = this.healthStore.readSessionHealth(sessionId);
    const billingFresh = existingHealth?.billing?.lastFetched &&
                        (Date.now() - existingHealth.billing.lastFetched) < 120000;

    if (billingFresh && existingHealth?.billing) {
      // Reuse existing billing data
      health.billing = existingHealth.billing;
    } else {
      // Fetch fresh billing data
      try {
        const billingData = await this.ccusageModule.fetch(sessionId);
        if (billingData) {
          health.billing = {
            costToday: billingData.costUSD || 0,
            burnRatePerHour: billingData.costPerHour || 0,
            budgetRemaining: billingData.budgetMinutesLeft || 0,
            budgetPercentUsed: billingData.budgetPercentUsed || 0,
            resetTime: billingData.resetTime || '',
            isFresh: billingData.isFresh !== false,
            lastFetched: Date.now()
          };
        }
      } catch {
        // Billing not available - keep defaults
      }
    }

    // 6. Secrets scan (if transcript exists)
    if (health.transcript.exists && transcriptPath) {
      const secrets = this.scanForSecrets(transcriptPath);
      health.alerts.secretsDetected = secrets.hasSecrets;
      health.alerts.secretTypes = secrets.types;
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

    // 9. Write to health store
    this.healthStore.writeSessionHealth(sessionId, health);

    // 10. Update global summary (non-blocking)
    setTimeout(() => {
      try {
        this.healthStore.updateSessionsSummary();
      } catch {
        // Ignore summary update errors
      }
    }, 0);

    return health;
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

    // Calculate total tokens used
    const inputTokens = ctx.current_input_tokens || 0;
    const cacheTokens = ctx.cache_read_input_tokens || 0;
    const outputTokens = ctx.current_output_tokens || 0;
    result.tokensUsed = inputTokens + cacheTokens + outputTokens;

    // Calculate tokens until 78% compaction threshold
    const compactionThreshold = Math.floor(result.windowSize * 0.78);
    result.tokensLeft = Math.max(0, compactionThreshold - result.tokensUsed);

    // Calculate percentage used (of compaction threshold, not total window)
    result.percentUsed = Math.min(100, Math.floor((result.tokensUsed / compactionThreshold) * 100));

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
        { name: 'Private Key', regex: /-----BEGIN.*PRIVATE KEY-----/g },
        { name: 'DB Connection', regex: /(postgres|mongodb|mysql):\/\/[^:]+:[^@]+@/gi }
      ];

      for (const pattern of patterns) {
        if (pattern.regex.test(content)) {
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
   */
  private isSessionActive(jsonInput: ClaudeCodeInput | null): boolean {
    // If we received JSON input, session is active
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

    if (!health.billing.isFresh && health.billing.lastFetched > 0) {
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
   * Get health store instance (for testing)
   */
  getHealthStore(): HealthStore {
    return this.healthStore;
  }
}

export default DataGatherer;
