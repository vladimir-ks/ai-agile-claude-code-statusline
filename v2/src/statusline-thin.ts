#!/usr/bin/env bun
/**
 * Thin Statusline - Read health data, format, output
 *
 * This is the new entry point that:
 * 1. Reads JSON input from Claude Code
 * 2. Reads/triggers health data gathering
 * 3. Reads user config for component visibility
 * 4. Formats and outputs statusline
 *
 * NO trailing newline (critical for CLI UI)
 */

import HealthStore from './lib/health-store';
import DataGatherer from './lib/data-gatherer';
import { SessionHealth, StatuslineConfig, ClaudeCodeInput } from './types/session-health';

class ThinStatusline {
  private healthStore: HealthStore;
  private gatherer: DataGatherer;

  constructor() {
    this.healthStore = new HealthStore();
    this.gatherer = new DataGatherer();
  }

  /**
   * Main entry point
   */
  async run(): Promise<void> {
    try {
      // Read JSON from stdin
      const stdin = await Bun.stdin.text();
      const jsonInput = this.parseInput(stdin);

      // Get session ID
      const sessionId = jsonInput?.session_id;
      if (!sessionId) {
        process.stdout.write('⚠ No session');
        return;
      }

      // Check if health data exists and is fresh
      // Use 5 minute cache TTL since ccusage is slow and billing doesn't change fast
      let health = this.healthStore.readSessionHealth(sessionId);

      if (!health || this.healthStore.isStale(sessionId, 300000)) {
        // Health data stale (>5 min) or missing - gather fresh data
        health = await this.gatherer.gather(
          sessionId,
          jsonInput?.transcript_path || null,
          jsonInput
        );
      } else {
        // Use cached health but update real-time fields (context, time)
        // Context comes from JSON input (real-time)
        if (jsonInput?.context_window) {
          const ctx = jsonInput.context_window;
          const windowSize = ctx.context_window_size || 200000;
          const tokensUsed = (ctx.current_input_tokens || 0) +
                            (ctx.cache_read_input_tokens || 0) +
                            (ctx.current_output_tokens || 0);
          const compactionThreshold = Math.floor(windowSize * 0.78);

          health.context.tokensUsed = tokensUsed;
          health.context.tokensLeft = Math.max(0, compactionThreshold - tokensUsed);
          health.context.percentUsed = Math.min(100, Math.floor((tokensUsed / compactionThreshold) * 100));
          health.context.nearCompaction = health.context.percentUsed >= 70;
        }
      }

      // Read user config
      const config = this.healthStore.readConfig();

      // Format output
      const output = this.format(health, config);

      // Output (NO trailing newline!)
      process.stdout.write(output);

    } catch (error) {
      process.stdout.write('⚠ ERR');
    }
  }

  /**
   * Parse JSON input safely
   */
  private parseInput(stdin: string): ClaudeCodeInput | null {
    try {
      return JSON.parse(stdin) as ClaudeCodeInput;
    } catch {
      return null;
    }
  }

  /**
   * Format statusline based on health and config
   */
  format(health: SessionHealth, config: StatuslineConfig): string {
    const parts: string[] = [];

    if (config.components.directory) {
      parts.push(this.formatDirectory(health));
    }

    if (config.components.git) {
      const git = this.formatGit(health);
      if (git) parts.push(git);
    }

    if (config.components.model) {
      parts.push(this.formatModel(health));
    }

    if (config.components.context) {
      parts.push(this.formatContext(health));
    }

    if (config.components.time) {
      parts.push(this.formatTime());
    }

    if (config.components.transcriptSync) {
      parts.push(this.formatTranscriptSync(health));
    }

    if (config.components.budget) {
      const budget = this.formatBudget(health);
      if (budget) parts.push(budget);
    }

    if (config.components.cost) {
      const cost = this.formatCost(health);
      if (cost) parts.push(cost);
    }

    if (config.components.secrets && health.alerts.secretsDetected) {
      parts.push(this.formatSecretsWarning(health));
    }

    return parts.filter(Boolean).join(' ');
  }

  /**
   * Format directory
   */
  private formatDirectory(health: SessionHealth): string {
    let path = health.projectPath;
    if (!path) return '📁:?';

    // Shorten home directory
    const home = process.env.HOME || '';
    if (path.startsWith(home)) {
      path = '~' + path.slice(home.length);
    }

    // Truncate if too long (show last 30 chars)
    if (path.length > 35) {
      const base = path.split('/').pop() || path;
      path = '~/' + base;
    }

    return `📁:${path}`;
  }

  /**
   * Format git status
   */
  private formatGit(health: SessionHealth): string {
    if (!health.git.branch) return '';

    let result = `🌿:${health.git.branch}`;

    if (health.git.ahead > 0) {
      result += `+${health.git.ahead}`;
    }
    if (health.git.behind > 0) {
      result += `/-${health.git.behind}`;
    }
    if (health.git.dirty > 0) {
      result += `*${health.git.dirty}`;
    }

    return result;
  }

  /**
   * Format model
   */
  private formatModel(health: SessionHealth): string {
    return `🤖:${health.model.value}`;
  }

  /**
   * Format context window
   */
  private formatContext(health: SessionHealth): string {
    const tokensLeft = this.formatTokens(health.context.tokensLeft);
    const bar = this.generateProgressBar(health.context.percentUsed);
    return `🧠:${tokensLeft}left${bar}`;
  }

  /**
   * Format tokens (e.g., 150000 → 150k)
   */
  private formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
      return `${Math.floor(tokens / 1000)}k`;
    }
    return String(tokens);
  }

  /**
   * Generate progress bar with threshold marker
   */
  private generateProgressBar(percentUsed: number): string {
    const width = 12;
    const thresholdPos = Math.floor(width * 0.78); // 78% = position 9
    const usedPos = Math.floor(width * Math.max(0, Math.min(100, percentUsed)) / 100);

    let bar = '';
    for (let i = 0; i < width; i++) {
      if (i === thresholdPos) {
        bar += '|';
      } else if (i < usedPos) {
        bar += '=';
      } else {
        bar += '-';
      }
    }

    return `[${bar}]`;
  }

  /**
   * Format current time
   */
  private formatTime(): string {
    const now = new Date();
    const hours = String(now.getHours()).padStart(2, '0');
    const mins = String(now.getMinutes()).padStart(2, '0');
    return `🕐:${hours}:${mins}`;
  }

  /**
   * Format transcript sync indicator (NEW)
   */
  private formatTranscriptSync(health: SessionHealth): string {
    if (!health.transcript.exists) {
      return '📝:⚠missing';
    }

    const ago = health.transcript.lastModifiedAgo;

    if (health.alerts.dataLossRisk) {
      return `📝:${ago}🔴`;
    } else if (health.alerts.transcriptStale) {
      return `📝:${ago}⚠`;
    } else {
      return `📝:${ago}`;
    }
  }

  /**
   * Format budget
   */
  private formatBudget(health: SessionHealth): string {
    if (!health.billing.isFresh && health.billing.budgetRemaining === 0) {
      return '';
    }

    const totalMinutes = health.billing.budgetRemaining;
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const pct = health.billing.budgetPercentUsed;

    let result = `⌛:${hours}h${mins}m(${pct}%)`;

    if (health.billing.resetTime) {
      result += health.billing.resetTime;
    }

    if (!health.billing.isFresh) {
      result += '🔴';
    }

    return result;
  }

  /**
   * Format cost
   */
  private formatCost(health: SessionHealth): string {
    if (!health.billing.isFresh && health.billing.costToday === 0) {
      return '';
    }

    if (health.billing.costToday === 0) {
      return '';
    }

    const cost = this.formatMoney(health.billing.costToday);
    const rate = this.formatMoney(health.billing.burnRatePerHour);

    if (health.billing.burnRatePerHour > 0) {
      return `💰:${cost}|${rate}/h`;
    } else {
      return `💰:${cost}`;
    }
  }

  /**
   * Format money (e.g., 45.30 → $45.3)
   */
  private formatMoney(amount: number): string {
    if (amount >= 100) {
      return `$${Math.floor(amount)}`;
    } else if (amount >= 10) {
      return `$${amount.toFixed(1)}`;
    } else {
      return `$${amount.toFixed(2)}`;
    }
  }

  /**
   * Format secrets warning
   */
  private formatSecretsWarning(health: SessionHealth): string {
    const count = health.alerts.secretTypes.length;
    if (count === 1) {
      return `🔐SECRETS!(${health.alerts.secretTypes[0]})`;
    } else {
      return `🔐SECRETS!(${count} types)`;
    }
  }
}

// Run
const statusline = new ThinStatusline();
statusline.run().catch(() => {
  process.stdout.write('⚠ FATAL');
  process.exit(1);
});
