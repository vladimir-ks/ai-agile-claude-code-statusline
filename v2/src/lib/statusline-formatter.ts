/**
 * Statusline Formatter - Pre-compute formatted output for all terminal widths
 *
 * This module runs in data-daemon (background, no time limit) to generate
 * pre-formatted statusline output for multiple terminal widths.
 *
 * Display-only.ts simply looks up the appropriate variant (<5ms).
 */

import { SessionHealth } from '../types/session-health';
import { homedir } from 'os';

// Color codes
const COLORS = {
  directory: '\x1b[38;5;117m',
  git: '\x1b[38;5;150m',
  model: '\x1b[38;5;147m',
  contextGood: '\x1b[38;5;158m',
  contextWarn: '\x1b[38;5;227m',
  contextCrit: '\x1b[38;5;203m',
  time: '\x1b[38;5;249m',
  budget: '\x1b[38;5;189m',
  weeklyBudget: '\x1b[38;5;183m',
  resetTime: '\x1b[38;5;249m',
  cost: '\x1b[38;5;228m',
  burnRate: '\x1b[38;5;215m',
  usage: '\x1b[38;5;117m',
  cache: '\x1b[38;5;120m',
  turns: '\x1b[38;5;141m',
  lastMessage: '\x1b[38;5;249m',
  secrets: '\x1b[38;5;196m',
  critical: '\x1b[38;5;203m',
  reset: '\x1b[0m'
};

// Check NO_COLOR dynamically (for tests that set it mid-execution)
const c = (name: keyof typeof COLORS) =>
  (process.env.NO_COLOR === '1' || process.env.NO_COLOR === 'true') ? '' : COLORS[name];
const rst = () =>
  (process.env.NO_COLOR === '1' || process.env.NO_COLOR === 'true') ? '' : COLORS.reset;

export class StatuslineFormatter {
  /**
   * Generate pre-formatted output for all terminal widths
   */
  static formatAllVariants(health: SessionHealth): SessionHealth['formattedOutput'] {
    return {
      width40: this.formatForWidth(health, 40),
      width60: this.formatForWidth(health, 60),
      width80: this.formatForWidth(health, 80),
      width100: this.formatForWidth(health, 100),
      width120: this.formatForWidth(health, 120),
      width150: this.formatForWidth(health, 150),
      width200: this.formatForWidth(health, 200)
    };
  }

  /**
   * Format statusline for specific terminal width
   *
   * IMPORTANT: Use only 80% of terminal width to avoid rendering issues
   * when tmux status text appears in the corner.
   *
   * Adaptive overflow rules:
   * - Line 1: Directory + Git (ALWAYS), Model + Context (if they fit)
   * - Line 2: Overflow from L1 (Model, Context) + Time|Budget|Cost|Usage|Turns
   * - Line 3: Last message preview
   */
  private static formatForWidth(health: SessionHealth, width: number): string[] {
    // Use only 80% of terminal width to prevent rendering issues
    // Use only 80% of terminal width to prevent rendering issues
    const effectiveWidth = Math.floor(width * 0.80);
    const lines: string[] = [];

    // Build Line 1 with overflow tracking
    const { line1, overflow } = this.buildLine1WithOverflow(health, effectiveWidth);
    if (line1) lines.push(line1);

    // Build Line 2, prepending any overflow from Line 1
    const line2 = this.buildLine2WithOverflow(health, effectiveWidth, overflow);
    if (line2) lines.push(line2);

    // Line 3: Last message (hard truncate at effectiveWidth)
    const line3 = this.buildLine3(health, effectiveWidth);
    if (line3) lines.push(line3);

    return lines;
  }

  /**
   * Build Line 1 with overflow tracking
   *
   * Returns the line AND any components that couldn't fit (overflow to L2)
   *
   * SHRINK CASCADE (ordered by priority):
   * 1. Full model + full context (🤖:Opus4.5 🧠:154k-free[---------|--])
   * 2. Full model + medium context (🤖:Opus4.5 🧠:154k[---------|--])
   * 3. Full model + short context (🤖:Opus4.5 🧠:154k[---|--])
   * 4. Full model + minimal context (🤖:Opus4.5 🧠:154k)
   * 5. Abbreviated model + short context (🤖:o-4.5 🧠:154k[---|--])
   * 6. Abbreviated model + minimal context (🤖:o-4.5 🧠:154k)
   * 7. Abbreviated model only → context to L2
   * 8. Neither fit → both to L2
   */
  private static buildLine1WithOverflow(health: SessionHealth, width: number): {
    line1: string;
    overflow: { model?: string; context?: string };
  } {
    const overflow: { model?: string; context?: string } = {};

    // Core components (ALWAYS on Line 1)
    const coreParts: string[] = [];

    // Alerts/Health Status (if any issues)
    const healthStatus = this.fmtHealthStatus(health);
    if (healthStatus) coreParts.push(healthStatus);

    // Directory (NEVER truncated, always show)
    const dir = this.fmtDirectory(health.projectPath);
    if (dir) coreParts.push(dir);

    // Git (truncate branch if needed, but always show)
    const git = this.fmtGit(health, width);
    if (git) coreParts.push(git);

    // Calculate remaining space after core components
    const coreWidth = this.visibleWidth(coreParts.join(' '));
    const remainingSpace = width - coreWidth - 2; // 2 = spacing

    // Model variants
    const modelFull = this.fmtModel(health, false);      // Opus4.5 (~10 chars)
    const modelAbbrev = this.fmtModel(health, true);     // o-4.5 (~8 chars)
    const modelFullWidth = this.visibleWidth(modelFull);
    const modelAbbrevWidth = this.visibleWidth(modelAbbrev);

    // Context variants (ordered by size, largest first)
    const contextFull = this.fmtContextFull(health);     // 154k-free[---------|--] (~26 chars)
    const contextMedium = this.fmtContextMedium(health); // 154k[---------|--] (~20 chars)
    const contextShort = this.fmtContextShort(health);   // 154k[---|--] (~16 chars)
    const contextMinimal = this.fmtContextMinimal(health); // 154k (~8 chars)

    const contextFullWidth = this.visibleWidth(contextFull);
    const contextMediumWidth = this.visibleWidth(contextMedium);
    const contextShortWidth = this.visibleWidth(contextShort);
    const contextMinimalWidth = this.visibleWidth(contextMinimal);

    // Adaptive fitting logic - try each combination in order of preference

    // Case 1: Full model + full context
    if (remainingSpace >= modelFullWidth + 1 + contextFullWidth) {
      return {
        line1: [...coreParts, modelFull, contextFull].filter(Boolean).join(' '),
        overflow: {}
      };
    }

    // Case 2: Full model + medium context (no "-free")
    if (remainingSpace >= modelFullWidth + 1 + contextMediumWidth) {
      return {
        line1: [...coreParts, modelFull, contextMedium].filter(Boolean).join(' '),
        overflow: {}
      };
    }

    // Case 3: Full model + short context
    if (remainingSpace >= modelFullWidth + 1 + contextShortWidth) {
      return {
        line1: [...coreParts, modelFull, contextShort].filter(Boolean).join(' '),
        overflow: {}
      };
    }

    // Case 4: Full model + minimal context
    if (remainingSpace >= modelFullWidth + 1 + contextMinimalWidth) {
      return {
        line1: [...coreParts, modelFull, contextMinimal].filter(Boolean).join(' '),
        overflow: {}
      };
    }

    // Case 5: Abbreviated model + short context
    if (remainingSpace >= modelAbbrevWidth + 1 + contextShortWidth) {
      return {
        line1: [...coreParts, modelAbbrev, contextShort].filter(Boolean).join(' '),
        overflow: {}
      };
    }

    // Case 6: Abbreviated model + minimal context
    if (remainingSpace >= modelAbbrevWidth + 1 + contextMinimalWidth) {
      return {
        line1: [...coreParts, modelAbbrev, contextMinimal].filter(Boolean).join(' '),
        overflow: {}
      };
    }

    // Case 7: Abbreviated model only - context moves to L2
    if (remainingSpace >= modelAbbrevWidth) {
      overflow.context = contextMinimal; // Pass minimal version to L2
      return {
        line1: [...coreParts, modelAbbrev].filter(Boolean).join(' '),
        overflow
      };
    }

    // Case 8: Neither fit - both move to L2
    overflow.model = modelAbbrev; // Use abbreviated on L2 too
    overflow.context = contextMinimal;
    return {
      line1: coreParts.filter(Boolean).join(' '),
      overflow
    };
  }

  /**
   * Build Line 2 with overflow components from Line 1
   *
   * PRIORITY ORDER (what we KEEP, most important first):
   * 1. Model (from overflow) - CRITICAL, user needs to know which model
   * 2. Context (from overflow) - CRITICAL, user needs context awareness
   * 3. Time|Budget|Weekly - NEVER DROP
   * 4. Cost total - important financial info
   *
   * DROP ORDER (when space is tight, drop these first):
   * 1. First drop: Usage (📊) - least critical
   * 2. Then drop: Turns (💬) - also hide if <1000
   * 3. Then drop: Burn rate (keep total cost only)
   * 4. Last resort: Drop total cost
   */
  private static buildLine2WithOverflow(
    health: SessionHealth,
    width: number,
    overflow: { model?: string; context?: string }
  ): string {
    // STEP 1: Calculate required components first
    const timeBudgetWeekly = this.fmtTimeBudgetLine(health);
    const tbwWidth = this.visibleWidth(timeBudgetWeekly);

    // Overflow components (CRITICAL - must show if present)
    const overflowModel = overflow.model || '';
    const overflowContext = overflow.context || '';
    const overflowModelWidth = this.visibleWidth(overflowModel);
    const overflowContextWidth = this.visibleWidth(overflowContext);

    // Calculate minimum required width (overflow + time/budget/weekly)
    const requiredWidth = tbwWidth +
      (overflowModel ? overflowModelWidth + 1 : 0) +
      (overflowContext ? overflowContextWidth + 1 : 0) + 2;

    // STEP 2: Calculate space for optional components
    const availableForOptional = width - requiredWidth;

    // STEP 3: Build optional components with drop logic
    // Prepare all optional components
    const costToday = health.billing?.costToday || 0;
    const burnRate = health.billing?.burnRatePerHour || 0;
    const totalTokens = health.billing?.totalTokens || 0;
    const tokensPerMin = health.billing?.tokensPerMinute || null;
    const turns = health.transcript?.messageCount || 0;

    // Format optional components
    const cost = this.formatMoney(costToday);
    const rate = this.formatMoney(burnRate);
    const costFull = (costToday >= 0.01 || burnRate >= 0.01)
      ? `💰:${c('cost')}${cost}${rst()}|${c('burnRate')}${rate}/h${rst()}`
      : '';
    const costOnly = (costToday >= 0.01)
      ? `💰:${c('cost')}${cost}${rst()}`
      : '';

    const tokens = this.formatTokens(totalTokens);
    const tpm = tokensPerMin ? `(${this.formatTokens(tokensPerMin)}tpm)` : '';
    const usageComp = (totalTokens >= 100000)
      ? `📊:${c('usage')}${tokens}tok${tpm}${rst()}`
      : '';

    // Turns: only show if >= 1000 (significant), format as "1.2k" if >= 1000
    const turnsComp = (turns >= 1000)
      ? `💬:${c('turns')}${turns >= 1000 ? this.formatTokens(turns) : turns}t${rst()}`
      : '';

    // STEP 4: Fit optional components based on available space
    // Try to fit in order of importance (cost > usage > turns)
    const optionalParts: string[] = [];
    let usedOptional = 0;

    // Try cost (full, then total only)
    if (costFull && availableForOptional - usedOptional >= this.visibleWidth(costFull) + 1) {
      optionalParts.push(costFull);
      usedOptional += this.visibleWidth(costFull) + 1;
    } else if (costOnly && availableForOptional - usedOptional >= this.visibleWidth(costOnly) + 1) {
      optionalParts.push(costOnly);
      usedOptional += this.visibleWidth(costOnly) + 1;
    }

    // Try usage (drop first when tight)
    if (usageComp && availableForOptional - usedOptional >= this.visibleWidth(usageComp) + 1) {
      optionalParts.push(usageComp);
      usedOptional += this.visibleWidth(usageComp) + 1;
    }

    // Try turns (drop second when tight, only if >= 1000)
    if (turnsComp && availableForOptional - usedOptional >= this.visibleWidth(turnsComp) + 1) {
      optionalParts.push(turnsComp);
      usedOptional += this.visibleWidth(turnsComp) + 1;
    }

    // STEP 5: Assemble final line
    // Order: [overflow model] [overflow context] [time|budget|weekly] [cost] [usage] [turns]
    const parts: string[] = [];
    if (overflowModel) parts.push(overflowModel);
    if (overflowContext) parts.push(overflowContext);
    parts.push(timeBudgetWeekly);
    parts.push(...optionalParts);

    return parts.filter(Boolean).join(' ');
  }

  /**
   * Build Line 3: Last message (hard truncate)
   */
  private static buildLine3(health: SessionHealth, width: number): string {
    if (!health.transcript?.lastMessagePreview) return '';

    const elapsed = health.transcript.lastModifiedAgo || '';
    const preview = health.transcript.lastMessagePreview;

    const prefix = `💬:${c('lastMessage')}(${elapsed}) `;
    const prefixWidth = this.visibleWidth(prefix);
    const availableForPreview = width - prefixWidth - 5; // 5 = safety margin

    if (availableForPreview < 10) return ''; // Too narrow

    const truncatedPreview = this.truncateString(preview, availableForPreview);

    return `${prefix}${truncatedPreview}${rst()}`;
  }

  // ============================================================================
  // Component Formatters
  // ============================================================================

  private static fmtDirectory(path: string): string {
    if (!path) return '';
    const truncated = this.truncateLongFolders(path);
    return `📁:${c('directory')}${truncated}${rst()}`;
  }

  private static fmtGit(health: SessionHealth, width: number): string {
    if (!health.git?.branch) return '';

    const branch = health.git.branch;
    const ahead = health.git.ahead || 0;
    const behind = health.git.behind || 0;
    const dirty = health.git.dirty || 0;

    // Truncate branch if very long
    const maxBranchLen = width < 80 ? 15 : 30;
    const truncatedBranch = branch.length > maxBranchLen
      ? branch.substring(0, maxBranchLen - 2) + '..'
      : branch;

    let git = `🌿:${c('git')}${truncatedBranch}`;

    // SMART VISIBILITY: Only show counts if non-zero
    // This reduces clutter for clean repos
    if (ahead > 0) git += `+${ahead}`;
    if (behind > 0) git += `-${behind}`;
    if (dirty > 0) git += `*${dirty}`;

    git += rst();

    return git;
  }

  private static fmtModel(health: SessionHealth, abbreviated: boolean = false): string {
    let model = health.model?.value || 'Claude';
    model = model.replace(/\s+/g, ''); // Remove spaces

    if (abbreviated) {
      // Only abbreviate Opus: Opus4.5 → o-4.5
      // Other models (Sonnet, Haiku, Claude) keep full name, just wrap to L2
      model = model.replace(/^Opus/i, 'o-');
    }

    return `🤖:${c('model')}${model}${rst()}`;
  }

  /**
   * Context formatting variants for adaptive overflow
   *
   * SHRINK CASCADE (per user spec):
   * 1. Full:      "🧠:54k-free[=======--|--]" - full bar WITH -free
   * 2. ShortBar:  "🧠:54k-free[===-|-]" - short bar WITH -free
   * 3. NoFree:    "🧠:54k[===-|-]" - short bar, NO -free
   * 4. Minimal:   "🧠:54k" - no bar, no -free
   */

  // Full context: "🧠:54k-free[=======--|--]"
  private static fmtContextFull(health: SessionHealth): string {
    const left = this.formatTokens(health.context?.tokensLeft || 0);
    const pct = health.context?.percentUsed || 0;
    const bar = this.generateProgressBar(pct, 12);
    const colorName = this.getContextColor(pct);
    return `🧠:${c(colorName)}${left}-free${bar}${rst()}`;
  }

  // Short bar WITH -free: "🧠:54k-free[===-|-]"
  private static fmtContextMedium(health: SessionHealth): string {
    const left = this.formatTokens(health.context?.tokensLeft || 0);
    const pct = health.context?.percentUsed || 0;
    const bar = this.generateProgressBar(pct, 6);
    const colorName = this.getContextColor(pct);
    return `🧠:${c(colorName)}${left}-free${bar}${rst()}`;
  }

  // Short bar NO -free: "🧠:54k[===-|-]"
  private static fmtContextShort(health: SessionHealth): string {
    const left = this.formatTokens(health.context?.tokensLeft || 0);
    const pct = health.context?.percentUsed || 0;
    const bar = this.generateProgressBar(pct, 6);
    const colorName = this.getContextColor(pct);
    return `🧠:${c(colorName)}${left}${bar}${rst()}`;
  }

  // Minimal: "🧠:54k"
  private static fmtContextMinimal(health: SessionHealth): string {
    const left = this.formatTokens(health.context?.tokensLeft || 0);
    const colorName = this.getContextColor(health.context?.percentUsed || 0);
    return `🧠:${c(colorName)}${left}${rst()}`;
  }

  // Helper to get context color based on usage percentage
  private static getContextColor(pct: number): keyof typeof COLORS {
    if (pct >= 95) return 'contextCrit';
    if (pct >= 70) return 'contextWarn';
    return 'contextGood';
  }

  private static fmtTimeBudgetLine(health: SessionHealth): string {
    const parts: string[] = [];

    // Time - ALWAYS shows current time
    // Clock updates = data is fresh. Clock frozen = data is stale.
    const now = new Date();
    const timeHours = String(now.getHours()).padStart(2, '0');
    const timeMins = String(now.getMinutes()).padStart(2, '0');
    parts.push(`🕐:${c('time')}${timeHours}:${timeMins}${rst()}`);

    // Check data staleness (>3 minutes = stale, add ⚠ to affected data)
    const lastFetched = health.billing?.lastFetched || health.gatheredAt || Date.now();
    const ageMinutes = Math.floor((Date.now() - lastFetched) / 60000);
    const isStale = ageMinutes >= 3;
    const staleMarker = isStale ? `${c('critical')}⚠${rst()}` : '';

    // Budget
    if (health.billing?.budgetRemaining || health.billing?.budgetRemaining === 0) {
      let mins = health.billing.budgetRemaining;

      // Client-side time adjustment based on data age
      mins = Math.max(0, mins - ageMinutes);

      const hours = Math.floor(mins / 60);
      const m = mins % 60;
      const pct = Math.max(0, Math.min(100, health.billing.budgetPercentUsed || 0));

      // Omit hours if 0
      const timeStr = hours > 0 ? `${hours}h${m}m` : `${m}m`;

      // Add ⚠ if billing data is stale
      parts.push(`⌛:${c('budget')}${timeStr}(${pct}%)${rst()}${staleMarker}`);
    }

    // Weekly (if available) - check for undefined/null, NOT falsy (0 is valid!)
    if (health.billing?.weeklyBudgetRemaining !== undefined &&
        health.billing?.weeklyBudgetRemaining !== null) {
      const hours = Math.max(0, Math.floor(health.billing.weeklyBudgetRemaining)); // Round down, min 0
      const pct = Math.max(0, Math.min(100, health.billing.weeklyBudgetPercentUsed || 0));
      const resetDay = health.billing.weeklyResetDay || 'Mon';

      // Weekly data shares staleness with budget
      parts.push(`📅:${c('weeklyBudget')}${hours}h(${pct}%)@${resetDay}${rst()}${staleMarker}`);
    }

    return parts.join('|');
  }

  // Note: Cost, Usage, Turns adaptive logic moved inline to buildLine2WithOverflow

  /**
   * Format health status / alerts
   */
  private static fmtHealthStatus(health: SessionHealth): string {
    // Check for secrets first (highest priority alert)
    if (health.alerts?.secretsDetected && health.alerts?.secretTypes?.length > 0) {
      // Filter out file paths (anything starting with /)
      const secretNames = health.alerts.secretTypes
        .filter(type => !type.startsWith('/'))
        .slice(0, 3); // Max 3 types

      if (secretNames.length === 1) {
        return `${c('critical')}⚠️ ${secretNames[0]}${rst()}`;
      } else if (secretNames.length > 1) {
        return `${c('critical')}⚠️ ${secretNames.length} secrets${rst()}`;
      }
    }

    // Check for data loss risk (highest priority - active session with stale transcript)
    // Make this informative: show how long since last save
    if (health.alerts?.dataLossRisk) {
      const ago = health.transcript?.lastModifiedAgo || '?';
      return `${c('critical')}📝:${ago}⚠${rst()}`;
    }

    // Check for transcript stale (session inactive but transcript old)
    // Less alarming - just show age indicator
    if (health.alerts?.transcriptStale) {
      const ago = health.transcript?.lastModifiedAgo || '?';
      return `${c('time')}📝:${ago}${rst()}`;
    }

    return '';
  }

  // ============================================================================
  // Helper Functions
  // ============================================================================

  private static truncateLongFolders(path: string): string {
    // SPECIFICATION: Directory should NEVER be truncated - always show full path
    if (!path) return '?';
    const home = homedir();
    const startsWithHome = path.startsWith(home);
    // Only replace home directory with ~ for brevity, NO other truncation
    return startsWithHome ? '~' + path.slice(home.length) : path;
  }

  private static formatTokens(tokens: number): string {
    // Handle invalid/negative values
    if (!tokens || tokens < 0 || !isFinite(tokens)) return '0';

    if (tokens >= 1_000_000) {
      return `${(tokens / 1_000_000).toFixed(1)}M`;
    } else if (tokens >= 1_000) {
      return `${Math.floor(tokens / 1_000)}k`;
    }
    return `${tokens}`;
  }

  private static formatMoney(amount: number): string {
    if (typeof amount !== 'number' || !isFinite(amount) || amount < 0) return '$0';
    if (amount >= 100) return `$${Math.floor(amount)}`;
    // For values 10-99, show integer if whole number, otherwise one decimal
    if (amount >= 10) {
      return amount === Math.floor(amount) ? `$${Math.floor(amount)}` : `$${amount.toFixed(1)}`;
    }
    return `$${amount.toFixed(2)}`;
  }

  private static generateProgressBar(percentUsed: number, width: number = 12): string {
    const thresholdPercent = 78;
    const thresholdPos = Math.floor(width * thresholdPercent / 100);
    const pct = Math.max(0, Math.min(100, percentUsed || 0));
    const usedPos = Math.floor(width * pct / 100);

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

  private static visibleWidth(text: string): number {
    // Remove ANSI escape codes to calculate visible width
    return text.replace(/\x1b\[[0-9;]*m/g, '').length;
  }

  private static truncateString(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 2) + '..';
  }
}
