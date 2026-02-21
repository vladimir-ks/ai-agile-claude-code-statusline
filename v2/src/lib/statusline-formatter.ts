/**
 * Statusline Formatter - Pre-compute formatted output for all terminal widths
 *
 * This module runs in data-daemon (background, no time limit) to generate
 * pre-formatted statusline output for multiple terminal widths.
 *
 * Display-only.ts simply looks up the appropriate variant (<5ms).
 */

import { SessionHealth, MergedQuotaSlot } from '../types/session-health';
import { homedir } from 'os';
import { FreshnessManager } from './freshness-manager';
import { SessionLockManager } from './session-lock-manager';
import { NotificationManager } from './notification-manager';
import { QuotaBrokerClient } from './quota-broker-client';

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
  version: '\x1b[38;5;242m',       // dim gray (subtle, lowest priority)
  reset: '\x1b[0m'
};

// Check NO_COLOR dynamically (for tests that set it mid-execution)
const c = (name: keyof typeof COLORS) =>
  (process.env.NO_COLOR === '1' || process.env.NO_COLOR === 'true') ? '' : COLORS[name];
const rst = () =>
  (process.env.NO_COLOR === '1' || process.env.NO_COLOR === 'true') ? '' : COLORS.reset;

export class StatuslineFormatter {
  // Max length for single-line mode (no tmux/unknown width)
  private static readonly SINGLE_LINE_MAX_LENGTH = 240;
  // Fixed length for last message preview in single-line mode
  private static readonly SINGLE_LINE_MSG_LENGTH = 50;

  /**
   * Generate pre-formatted output for all terminal widths
   * Includes a special 'singleLine' variant for no-tmux environments
   */
  static formatAllVariants(health: SessionHealth): SessionHealth['formattedOutput'] {
    return {
      width40: this.formatForWidth(health, 40),
      width60: this.formatForWidth(health, 60),
      width80: this.formatForWidth(health, 80),
      width100: this.formatForWidth(health, 100),
      width120: this.formatForWidth(health, 120),
      width150: this.formatForWidth(health, 150),
      width200: this.formatForWidth(health, 200),
      singleLine: this.formatSingleLine(health)
    };
  }

  /**
   * Format as single line for environments without tmux/unknown terminal width
   *
   * All components on one line, max 240 chars total.
   * Last message preview fixed at 50 chars.
   * Same shrink/drop rules apply when line gets too long.
   */
  private static formatSingleLine(health: SessionHealth): string[] {
    const maxLen = this.SINGLE_LINE_MAX_LENGTH;
    const msgLen = this.SINGLE_LINE_MSG_LENGTH;

    // Build all components
    const dir = this.fmtDirectory(health.projectPath);
    const git = this.fmtGit(health, maxLen);
    const modelFull = this.fmtModel(health, false);
    const modelAbbrev = this.fmtModel(health, true);

    // Context variants
    const ctxFull = this.fmtContextFull(health);
    const ctxMedium = this.fmtContextMedium(health);
    const ctxShort = this.fmtContextShort(health);
    const ctxMinimal = this.fmtContextMinimal(health);

    // Turns count
    const turns = health.transcript?.messageCount || 0;
    const turnsFmt = turns > 0 ? `💬:${c('turns')}${turns}t${rst()}` : '';

    // Last message (fixed length)
    const lastMsg = this.buildLine3(health, msgLen);

    // Try to fit components with shrink/drop logic
    // Time and slot are on the account context notification line — not here
    const tryFit = (components: string[]): string | null => {
      const line = [...components, lastMsg].filter(Boolean).join(' ');
      return this.visibleWidth(line) <= maxLen ? line : null;
    };

    // Shrink cascade: context first, then model, then turns
    const combinations = [
      [dir, git, modelFull, ctxFull, turnsFmt],
      [dir, git, modelFull, ctxMedium, turnsFmt],
      [dir, git, modelFull, ctxShort, turnsFmt],
      [dir, git, modelFull, ctxMinimal, turnsFmt],
      [dir, git, modelAbbrev, ctxShort, turnsFmt],
      [dir, git, modelAbbrev, ctxMinimal, turnsFmt],
      [dir, git, modelAbbrev, turnsFmt],
      [dir, git, modelAbbrev],
      [dir, git],
    ];

    for (const combo of combinations) {
      const result = tryFit(combo);
      if (result) return [result];
    }

    // Fallback: just the basics
    return [[dir, git, lastMsg].filter(Boolean).join(' ')];
  }

  /**
   * Format statusline for specific terminal width (multi-line mode)
   *
   * Uses 75% of terminal width to avoid rendering issues with tmux corner text.
   * Tmux often reserves right margin for clock, notifications, or other overlays.
   *
   * Adaptive overflow rules:
   * - Line 1: Directory + Git (ALWAYS), Model + Context + Turns + Size (if they fit)
   * - Line 2: Overflow from L1 (Model, Context, Turns+Size) — ONLY if overflow exists
   * - Line 3: Last message preview
   * - Notifications: Account context, switch recommendation, secrets (idle=always, active=intermittent)
   */
  private static formatForWidth(health: SessionHealth, width: number): string[] {
    // Ultra-narrow: bare minimum to avoid catastrophic wrapping
    if (width < 30) {
      const dir = this.fmtDirectory(health.projectPath);
      return dir ? [dir] : ['🤖'];
    }

    // Reserve right margin for tmux clock/notifications/corner text
    // Wider terminals need less margin (absolute, not proportional)
    // Narrow (<80): 75% margin (safe). Wide (>150): fixed 25-char margin
    const margin = width <= 80 ? Math.floor(width * 0.25) : Math.min(25, Math.floor(width * 0.15));
    const effectiveWidth = width - margin;
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

    // Idle detection: transcript not growing for >2 minutes = idle
    // More reliable than !line3 (preview can be empty during tool_result sequences)
    const isIdle = this.detectIdle(health);

    // Notifications: intermittent when active, always-on when idle
    // When idle, notifications fill the empty space with account context
    const notifications = this.buildNotifications(health, effectiveWidth, isIdle);
    lines.push(...notifications);

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
    overflow: { model?: string; context?: string; turnsSize?: string };
  } {
    const overflow: { model?: string; context?: string; turnsSize?: string } = {};

    // Core components (ALWAYS on Line 1)
    const coreParts: string[] = [];

    // Directory FIRST — truncated with middle-ellipsis if path is too long
    // Reserve at least 30 chars for git+model (minimum useful display)
    const maxDirChars = Math.max(20, width - 30);
    const dir = this.fmtDirectory(health.projectPath, maxDirChars);
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

    // Turns + size component (try to fit on L1 after model+context)
    const turnsSizeParts: string[] = [];
    const turns = health.transcript?.messageCount || 0;
    if (turns > 0) {
      turnsSizeParts.push(`💬:${c('turns')}${turns}t${rst()}`);
    }
    const sizeBytes = health.transcript?.sizeBytes || 0;
    if (sizeBytes > 0) {
      const sizeMB = sizeBytes / (1024 * 1024);
      const sizeStr = sizeMB >= 1
        ? `${sizeMB.toFixed(1)}MB`
        : `${(sizeBytes / 1024).toFixed(0)}KB`;
      turnsSizeParts.push(`📦:${c('cache')}${sizeStr}${rst()}`);
    }
    const turnsSizeFmt = turnsSizeParts.length > 0 ? turnsSizeParts.join(' ') : '';
    const turnsSizeWidth = turnsSizeFmt ? this.visibleWidth(turnsSizeFmt) + 1 : 0; // +1 for space

    // Helper: try appending turns+size to line, else put in overflow
    const finalizeLine = (parts: string[]): { line1: string; overflow: { model?: string; context?: string; turnsSize?: string } } => {
      const baseLine = parts.filter(Boolean).join(' ');
      const baseWidth = this.visibleWidth(baseLine);
      if (turnsSizeFmt && baseWidth + turnsSizeWidth <= width) {
        return { line1: [...parts, turnsSizeFmt].filter(Boolean).join(' '), overflow: {} };
      }
      return {
        line1: baseLine,
        overflow: turnsSizeFmt ? { turnsSize: turnsSizeFmt } : {}
      };
    };

    // Adaptive fitting logic - try each combination in order of preference

    // Case 1: Full model + full context
    if (remainingSpace >= modelFullWidth + 1 + contextFullWidth) {
      return finalizeLine([...coreParts, modelFull, contextFull]);
    }

    // Case 2: Full model + medium context (no "-free")
    if (remainingSpace >= modelFullWidth + 1 + contextMediumWidth) {
      return finalizeLine([...coreParts, modelFull, contextMedium]);
    }

    // Case 3: Full model + short context
    if (remainingSpace >= modelFullWidth + 1 + contextShortWidth) {
      return finalizeLine([...coreParts, modelFull, contextShort]);
    }

    // Case 4: Full model + minimal context
    if (remainingSpace >= modelFullWidth + 1 + contextMinimalWidth) {
      return finalizeLine([...coreParts, modelFull, contextMinimal]);
    }

    // Case 5: Abbreviated model + short context
    if (remainingSpace >= modelAbbrevWidth + 1 + contextShortWidth) {
      return finalizeLine([...coreParts, modelAbbrev, contextShort]);
    }

    // Case 6: Abbreviated model + minimal context
    if (remainingSpace >= modelAbbrevWidth + 1 + contextMinimalWidth) {
      return finalizeLine([...coreParts, modelAbbrev, contextMinimal]);
    }

    // Case 7: Abbreviated model only - context moves to L2 at full size
    if (remainingSpace >= modelAbbrevWidth) {
      const result = finalizeLine([...coreParts, modelAbbrev]);
      result.overflow.context = contextFull; // Full version on L2 (plenty of room)
      return result;
    }

    // Case 8: Neither fit - both move to L2 at full size
    overflow.model = modelFull; // Full model on L2
    overflow.context = contextFull;
    if (turnsSizeFmt) overflow.turnsSize = turnsSizeFmt;
    return {
      line1: coreParts.filter(Boolean).join(' '),
      overflow
    };
  }

  /**
   * Build Line 2: overflow from L1 (model, context, turns+size)
   *
   * Only emitted when there IS overflow. Turns+size live on L1 when they fit;
   * they only appear here when L1 pushed them to overflow.
   */
  private static buildLine2WithOverflow(
    health: SessionHealth,
    _width: number,
    overflow: { model?: string; context?: string; turnsSize?: string }
  ): string {
    const parts: string[] = [];

    // Overflow components (full-size model + context)
    if (overflow.model) parts.push(overflow.model);
    if (overflow.context) parts.push(overflow.context);

    // Turns + size (only when they didn't fit on L1)
    if (overflow.turnsSize) parts.push(overflow.turnsSize);

    // CLI version — always appended to L2 when present (lowest priority, subtle)
    if (health.cliVersion) {
      parts.push(`${c('version')}v${health.cliVersion}${rst()}`);
    }

    if (parts.length === 0) return '';

    return parts.filter(Boolean).join(' ');
  }

  /**
   * Build Line 3: Last message (hard truncate)
   *
   * Filters out system messages (XML tags, task notifications) to show only
   * meaningful user content.
   */
  private static buildLine3(health: SessionHealth, width: number): string {
    if (!health.transcript?.lastMessagePreview) return '';

    const elapsed = health.transcript.lastModifiedAgo || '';
    let preview = health.transcript.lastMessagePreview;

    // Filter out system/XML content - these aren't useful to display
    // Examples: <task-notification>, <task-id>, <system-reminder>, etc.
    if (preview.startsWith('<') && preview.includes('>')) {
      preview = '(system message)';
    }

    const prefix = `💬:${c('lastMessage')}(${elapsed}) `;
    const prefixWidth = this.visibleWidth(prefix);
    const availableForPreview = width - prefixWidth - 2; // 2 = safety margin

    if (availableForPreview < 10) return ''; // Too narrow

    const truncatedPreview = this.truncateString(preview, availableForPreview);

    return `${prefix}${truncatedPreview}${rst()}`;
  }

  // ============================================================================
  // Component Formatters
  // ============================================================================

  private static fmtDirectory(path: string, maxDirChars?: number): string {
    if (!path) return '';
    const truncated = this.truncateLongFolders(path, maxDirChars);
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

    // Staleness indicator for git (>5min = stale)
    const gitIndicator = FreshnessManager.getContextAwareIndicator(health.git?.lastChecked, 'git_status');
    if (gitIndicator) git += `${c('critical')}${gitIndicator}${rst()}`;

    return git;
  }

  private static fmtModel(health: SessionHealth, abbreviated: boolean = false): string {
    let model = health.model?.value || 'Claude';
    model = model.replace(/\s+/g, ''); // Remove spaces

    if (abbreviated) {
      // Abbreviate known models:
      // Opus4.5 → o-4.5, Sonnet4.5 → s-4.5, Haiku4.5 → h-4.5, Claude → c
      model = model
        .replace(/^Opus/i, 'o-')
        .replace(/^Sonnet/i, 's-')
        .replace(/^Haiku/i, 'h-')
        .replace(/^Claude$/i, 'c');
      // Unknown models keep full name (e.g., GPT-4, Gemini, etc.)
    }

    let result = `🤖:${c('model')}${model}${rst()}`;

    // Staleness indicator for model (low confidence = uncertain)
    const confidence = health.model?.confidence ?? 0;
    if (confidence > 0 && confidence < 50) {
      result += `${c('critical')}🔺${rst()}`;
    } else if (confidence > 0 && confidence < 80) {
      result += `${c('critical')}⚠${rst()}`;
    }

    return result;
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

  // Note: Time and slot moved to account context notification line (buildAccountContextLine)

  /**
   * Detect idle state using transcript file growth.
   * If transcript hasn't been modified for >2 minutes, session is idle.
   * Wires into existing health.transcript.lastModified — no new I/O.
   *
   * Returns false (not idle) when:
   * - No transcript data (fresh session, not idle)
   * - lastModified is 0 (uninitialized data)
   * - Transcript was modified within last 2 minutes
   */
  private static detectIdle(health: SessionHealth): boolean {
    // Use lastModifiedAgo string (computed by daemon at gather time) rather than
    // raw epoch timestamp, which goes stale between daemon runs (every 5s rate gate).
    // The string "<1m", "2m", "5m" etc. is the actual elapsed at time of data gathering.
    const ago = health.transcript?.lastModifiedAgo;
    if (!ago) return false; // No data → assume active (fresh session)

    // Parse elapsed: "<1m" = active, "1m"/"2m" = active, "3m"+ = idle
    const match = ago.match(/^<?(\d+)m$/);
    if (match) {
      return parseInt(match[1], 10) > 2;
    }
    // "Xh", "Xd" = definitely idle
    if (/\d+[hd]/.test(ago)) return true;
    // "<1m" with no number match = active
    return false;
  }

  // ============================================================================
  // Helper Functions
  // ============================================================================

  private static truncateLongFolders(path: string, maxWidth?: number): string {
    if (!path) return '?';
    const home = homedir();
    const startsWithHome = path.startsWith(home);
    let result = startsWithHome ? '~' + path.slice(home.length) : path;

    // Width-aware truncation: use middle-ellipsis for very long paths
    // Preserves first segment (project root) and last segment (current dir)
    if (maxWidth && result.length > maxWidth && maxWidth > 10) {
      const parts = result.split('/').filter(Boolean);
      if (parts.length > 2) {
        const first = parts[0]; // e.g. "~" or "~/_IT_Projects"
        const last = parts[parts.length - 1]; // e.g. "v2"
        // Try keeping first + last with ellipsis
        const ellipsed = `${first}/…/${last}`;
        if (ellipsed.length <= maxWidth) {
          // Try adding more trailing segments
          let best = ellipsed;
          for (let i = parts.length - 2; i > 0; i--) {
            const candidate = `${first}/…/${parts.slice(i).join('/')}`;
            if (candidate.length <= maxWidth) {
              best = candidate;
              break;
            }
          }
          result = best;
        } else {
          // Even first/…/last is too long — just truncate from end
          result = result.substring(0, maxWidth - 2) + '..';
        }
      }
    }

    return result;
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
    // Remove ANSI escape codes
    let clean = text.replace(/\x1b\[[0-9;]*m/g, '');

    // Count emojis (they take 2 columns in most terminals)
    const emojiRegex = /[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]|[\u{2300}-\u{23FF}]/gu;
    const emojiMatches = clean.match(emojiRegex) || [];
    const emojiCount = emojiMatches.length;

    // Total width = string length + extra column per emoji (emoji counted once, needs 2)
    return clean.length + emojiCount;
  }

  private static truncateString(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 2) + '..';
  }

  /**
   * Build notification lines (Phase 3 — structured account context)
   *
   * Line format when idle or on show cycle:
   * - Account: 👤 S2|rimidalvk@gmail.com|🕐:13:18|⌛:3h53m(74%)|📅:143h(50%)@Wed 💰:$740|$3.98/h
   * - Switch:  💡 Switch to S3|v@ainsys.com|⌛:3h53m(1%)|📅:143h(2%)@Wed
   * - Secrets: ⚠️ 2 secrets detected (lowest priority, shown last)
   *
   * Display pattern:
   * - Active session (transcript growing): Show 30s → Hide 5min → Repeat
   * - Idle session (transcript stale >2min): Always show account context
   *
   * Priority order: failover > active_slot > slot_switch > version_update > secrets
   */
  private static buildNotifications(health: SessionHealth, maxWidth: number, isIdle: boolean = false): string[] {
    const lines: string[] = [];

    try {
      // Failover notification (transient hot-swap event) — always show if present
      if (health.failoverNotification) {
        lines.push(`${c('critical')}${health.failoverNotification}${rst()}`);
      }

      // Secret detection DISABLED — too many false positives (API Key, etc.)
      // TODO: Re-enable after DetectionEngine confidence scoring is improved
      // For now, unconditionally clear any stale secret notifications
      NotificationManager.remove('secrets_detected');

      // Notification visibility strategy:
      // - Idle (>2min no transcript growth): show ALL notifications (always visible)
      // - Active (outputting): standard 30s show / 5min hide cycle for ALL notifications
      //   Account context only appears during idle gaps — keeps display clean while working
      const active = isIdle
        ? NotificationManager.getAllRegistered()
        : NotificationManager.getActive();

      // Read merged quota data once for all notification rendering
      const quotaData = QuotaBrokerClient.read();

      // Show max 3 notifications (account + switch + 1 more)
      for (const [type, notification] of active.slice(0, 3)) {
        NotificationManager.recordShown(type);

        let line = '';

        switch (type) {
          case 'active_slot':
            line = this.buildAccountContextLine(health, quotaData, maxWidth);
            break;

          case 'slot_switch': {
            // Guard: don't show "Switch to SX" if already on slot X
            const lock = SessionLockManager.read(health.sessionId);
            const currentNum = lock?.slotId?.match(/slot-(\d+)/)?.[1];
            const switchNum = notification.message.match(/Switch to S(\d+)/)?.[1];
            if (currentNum && switchNum && currentNum === switchNum) {
              NotificationManager.remove('slot_switch');
              continue;
            }
            line = this.buildSwitchLine(notification.message);
            break;
          }

          case 'secrets_detected':
            line = `${c('critical')}⚠️ ${notification.message}${rst()}`;
            break;

          case 'version_update':
            line = `${c('cost')}⚠️ ${notification.message}${rst()}`;
            break;

          case 'quota_stale':
            line = `${c('critical')}⚠ ${notification.message}${rst()}`;
            break;

          case 'restart_ready':
            line = `${c('critical')}🔴 ${notification.message}${rst()}`;
            break;

          default:
            line = notification.message;
        }

        if (!line) continue;

        // Truncate if too long
        if (this.visibleWidth(line) > maxWidth) {
          const truncated = this.truncateString(
            line.replace(/\x1b\[[0-9;]*m/g, ''), // strip ANSI for truncation
            maxWidth - 2
          );
          line = truncated;
        }

        lines.push(line);
      }
    } catch {
      // Notification rendering failed — non-critical
    }

    return lines;
  }

  /**
   * Build rich account context line from live quota data.
   * Format: 👤 S2|email|🕐:HH:MM|⌛:Xh(Y%)|📅:Zh(W%)@Day 💰:$X|$Y/h
   */
  private static buildAccountContextLine(
    health: SessionHealth,
    quotaData: ReturnType<typeof QuotaBrokerClient.read>,
    maxWidth: number
  ): string {
    const lock = SessionLockManager.read(health.sessionId);
    if (!lock?.slotId) {
      // Fallback: simple notification
      const notif = NotificationManager.get('active_slot');
      return notif ? `${c('usage')}👤 ${notif.message}${rst()}` : '';
    }

    const slotMatch = lock.slotId.match(/slot-(\d+)/);
    const slotNum = slotMatch ? slotMatch[1] : '?';
    const email = lock.email || health.launch?.authProfile || '';

    // Slot color (same as fmtSlotIndicator)
    const slotColors: Record<string, string> = {
      '1': c('critical'), '2': c('usage'), '3': c('weeklyBudget'), '4': c('cost')
    };
    const slotColor = slotColors[slotNum] || '';

    // Time (same color as line 2 clock)
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');

    // Quota data for this slot
    const slot = quotaData?.slots?.[lock.slotId];
    const parts: string[] = [];

    // 👤 S2|email — slot-colored prefix
    parts.push(`${slotColor}👤 S${slotNum}${rst()}|${email}`);

    // 🕐 — time-colored
    parts.push(`🕐:${c('time')}${hh}:${mm}${rst()}`);

    if (slot) {
      // ⌛ daily budget — budget-colored
      parts.push(`⌛:${c('budget')}${this.fmtSlotDailyBudget(slot)}${rst()}`);

      // 📅 weekly quota — weeklyBudget-colored
      parts.push(`📅:${c('weeklyBudget')}${this.fmtSlotWeeklyQuota(slot)}${rst()}`);
    }

    let line = parts.join('|');

    // Append cost if available — cost/burnRate-colored (space-separated from rest)
    const sessionCost = health.billing?.sessionCost || 0;
    const burnRate = health.billing?.sessionBurnRate || health.billing?.burnRatePerHour || 0;
    if (sessionCost >= 0.01) {
      const costPart = `${c('cost')}${this.formatMoney(sessionCost)}${rst()}`;
      const burnPart = burnRate >= 0.01 ? `|${c('burnRate')}${this.formatMoney(burnRate)}/h${rst()}` : '';
      line += ` 💰:${costPart}${burnPart}`;
    }

    return line;
  }

  /**
   * Build switch recommendation line.
   * The message is pre-composed by QuotaBrokerClient.getSwitchMessage()
   * in rich format: Switch to S3|email|⌛:Xh(Y%)|📅:Zh(W%)@Day
   * Just adds 💡 prefix and color.
   */
  private static buildSwitchLine(
    message: string
  ): string {
    if (!message) return '';
    return `${c('usage')}💡 ${message}${rst()}`;
  }

  /** Format slot daily budget: Xh(Y%) from five_hour_util */
  private static fmtSlotDailyBudget(slot: MergedQuotaSlot): string {
    const pct = Math.round(slot.five_hour_util || 0);
    // five_hour_util is % used out of 5h window
    const hoursUsed = (pct / 100) * 5;
    const hoursLeft = Math.max(0, 5 - hoursUsed);
    const h = Math.floor(hoursLeft);
    const m = Math.round((hoursLeft - h) * 60);
    return m > 0 ? `${h}h${m}m(${pct}%)` : `${h}h(${pct}%)`;
  }

  /** Format slot weekly quota: Zh(W%)@Day from seven_day_util */
  private static fmtSlotWeeklyQuota(slot: MergedQuotaSlot): string {
    const pct = Math.round(slot.seven_day_util || 0);
    const hours = Math.max(0, Math.floor(slot.weekly_budget_remaining_hours || 0));
    const day = slot.weekly_reset_day || '';
    return day ? `${hours}h(${pct}%)@${day}` : `${hours}h(${pct}%)`;
  }
}
