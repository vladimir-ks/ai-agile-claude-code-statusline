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
import { existsSync, readFileSync } from 'fs';
import { FreshnessManager } from './freshness-manager';
import { SessionLockManager } from './session-lock-manager';
import { NotificationManager } from './notification-manager';
import { QuotaBrokerClient } from './quota-broker-client';
import { writeHeartbeat } from './heartbeat';
import { readLiveBurnEstimate, type LiveBurnEstimate } from './sources/live-burn-source';

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
  burnRate: '\x1b[38;5;245m',       // neutral mid-gray (was orange — too loud for passive cost info)
  usage: '\x1b[38;5;117m',
  cache: '\x1b[38;5;120m',
  turns: '\x1b[38;5;141m',
  lastMessage: '\x1b[38;5;249m',
  secrets: '\x1b[38;5;196m',
  critical: '\x1b[38;5;203m',
  version: '\x1b[38;5;242m',       // dim gray (subtle, lowest priority)
  cost: '\x1b[38;5;248m',          // neutral light-gray (was bright yellow — reserved for alerts now)
  neutralId: '\x1b[38;5;250m',     // light gray for identity/slot labels
  // 6-band pacing palette — attention hierarchy:
  //   red/orange/yellow = act now (under-burning = losing quota)
  //   green             = ideal
  //   blue/violet       = over-pacing (not dangerous; often desirable to consume quota)
  pacingRed:    '\x1b[38;5;196m',  // bright red    — way too slow (weekly loss risk)
  pacingOrange: '\x1b[38;5;208m',  // orange        — not fast enough
  pacingYellow: '\x1b[38;5;226m',  // yellow        — a bit too slow
  pacingGreen:  '\x1b[38;5;46m',   // bright green  — good (±tolerance)
  pacingBlue:   '\x1b[38;5;33m',   // bright blue   — much too fast
  pacingViolet: '\x1b[38;5;201m',  // bright violet — way too fast
  neutralLight: '\x1b[38;5;245m', // muted grey — low-confidence / stale
  bold: '\x1b[1m',
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
   *
   * @param health Session health data
   * @param marginPercent Margin percentage (0-50 typical, null=auto)
   *        - 0: no margin (full width)
   *        - 5-25: typical tmux margin (reserved for corner text)
   *        - null/undefined: auto (25% for ≤80w, min(25,15%) for >80w)
   *        - <0 or >50: clamped to [0,50] to prevent invalid effectiveWidth
   */
  static formatAllVariants(health: SessionHealth, marginPercent?: number | null): SessionHealth['formattedOutput'] {
    const t0 = Date.now();
    const result = {
      width40: this.formatForWidth(health, 40, marginPercent),
      width60: this.formatForWidth(health, 60, marginPercent),
      width80: this.formatForWidth(health, 80, marginPercent),
      width100: this.formatForWidth(health, 100, marginPercent),
      width120: this.formatForWidth(health, 120, marginPercent),
      width150: this.formatForWidth(health, 150, marginPercent),
      width200: this.formatForWidth(health, 200, marginPercent),
      singleLine: this.formatSingleLine(health, marginPercent)
    };
    writeHeartbeat('statusline-formatter', 'render', { latencyMs: Date.now() - t0 });
    return result;
  }

  /**
   * Format as single line for environments without tmux/unknown terminal width
   * Uses same 3-line structure: merged L1, session+message L2, notifications
   */
  private static formatSingleLine(health: SessionHealth, marginPercent?: number | null): string[] {
    const maxMsgLen = this.SINGLE_LINE_MSG_LENGTH;
    const lines: string[] = [];

    // Line 1: merged core + account — split at max length
    const mergedLine = this.buildMergedLine1(health);
    if (mergedLine) {
      const splitLines = this.splitAtWidth(mergedLine, this.SINGLE_LINE_MAX_LENGTH);
      lines.push(...splitLines);
    }

    // Session ID + last message
    const sessionLine = this.buildSessionLine(health, maxMsgLen);
    if (sessionLine) lines.push(sessionLine);

    return lines;
  }

  /**
   * Format statusline for specific terminal width (3-line mode)
   *
   * LINE 1: Core + Account (no width constraint — wraps naturally in terminal)
   * LINE 2: Session ID + Last message (message portion truncated to width)
   * LINE 3+: Notifications (conditional, truncated to width)
   */
  private static formatForWidth(health: SessionHealth, width: number, marginPercent?: number | null): string[] {
    // Ultra-narrow: bare minimum
    if (width < 30) {
      const dir = this.fmtDirectory(health.projectPath);
      return dir ? [dir] : ['🤖'];
    }

    // Margin for notifications and message truncation (line 1 is unconstrained)
    let margin: number;
    if (marginPercent != null) {
      const clamped = Math.max(0, Math.min(50, marginPercent));
      margin = Math.floor(width * (clamped / 100));
    } else {
      margin = width <= 80 ? Math.floor(width * 0.25) : Math.min(25, Math.floor(width * 0.15));
    }
    const effectiveWidth = width - margin;
    const lines: string[] = [];

    // Line 1: merged core + account — split into multiple lines at effectiveWidth
    // Claude Code's statusline doesn't support natural wrapping, so we split explicitly
    const mergedLine = this.buildMergedLine1(health);
    if (mergedLine) {
      const splitLines = this.splitAtWidth(mergedLine, effectiveWidth);
      lines.push(...splitLines);
    }

    // Session ID + last message (message truncated to effectiveWidth)
    const sessionLine = this.buildSessionLine(health, effectiveWidth);
    if (sessionLine) lines.push(sessionLine);

    // Idle detection for notification visibility
    const isIdle = this.detectIdle(health);

    // Notifications: account context removed (merged into L1), rest unchanged
    const notifications = this.buildNotifications(health, effectiveWidth, isIdle);
    lines.push(...notifications);

    return lines;
  }

  /**
   * Build Line 1: Core + Account merged (no width constraint — wraps naturally)
   *
   * Format: 📁:dir 🌿:branch 🤖:Model 📟:vX.Y.Z 🧠:NK(X%) 👤SN|email|🕐:HH:MM|⌛:Xh(Y%)|📅:Zh(W%)@Day 💰:$X|$Y/h
   */
  private static buildMergedLine1(health: SessionHealth): string {
    const parts: string[] = [];

    // 1. Directory — always
    const dir = this.fmtDirectory(health.projectPath);
    if (dir) parts.push(dir);

    // 2. Git — if available (no width constraint, use generous branch length)
    const git = this.fmtGit(health, 200);
    if (git) parts.push(git);

    // 3. Model — always (full name, includes [1m] suffix from formatModelId)
    const model = this.fmtModel(health, false);
    if (model) parts.push(model);

    // 4. CLI version — if available
    if (health.cliVersion) {
      parts.push(`📟:${c('version')}v${health.cliVersion}${rst()}`);
    }

    // 5. Context — short format: 🧠:791K(21%)
    const ctx = this.fmtContextShort(health);
    if (ctx) parts.push(ctx);

    // 6. Account context — inline (slot|email|time|daily|weekly)
    const accountPart = this.fmtAccountInline(health);
    if (accountPart) parts.push(accountPart);

    // 7. Cost — if >= $0.01
    const costPart = this.fmtCostInline(health);
    if (costPart) parts.push(costPart);

    return parts.filter(Boolean).join(' ');
  }

  /**
   * Build Line 2: Session ID + Last message
   *
   * Format: 🆔:full-uuid 💬:(5m) message preview...
   * Session ID is always present. Message appended when available, truncated to width.
   */
  private static buildSessionLine(health: SessionHealth, width: number): string {
    // 🆔 prefix — always present, no color (easily parseable)
    const sidPrefix = `🆔:${health.sessionId}`;

    // 💬 message — appended if available
    if (!health.transcript?.lastMessagePreview) return sidPrefix;

    const elapsed = health.transcript.lastModifiedAgo || '';
    let preview = health.transcript.lastMessagePreview;

    // Filter out system/XML content
    if (preview.startsWith('<') && preview.includes('>')) {
      preview = '(system message)';
    }

    const msgPrefix = ` 💬:${c('lastMessage')}(${elapsed}) `;
    const sidWidth = this.visibleWidth(sidPrefix);
    const msgPrefixWidth = this.visibleWidth(msgPrefix);
    const availableForPreview = Math.max(10, width - sidWidth - msgPrefixWidth - 2);

    const truncatedPreview = this.truncateString(preview, availableForPreview);

    return `${sidPrefix}${msgPrefix}${truncatedPreview}${rst()}`;
  }

  /**
   * Format account context inline for Line 1
   * Format: [⛔]👤SN|email|🕐:HH:MM|⌛:Xh(Y%)|📅:Zh(W%)@Day [⚠ stale Nm]
   */
  private static fmtAccountInline(health: SessionHealth): string {
    const lock = SessionLockManager.read(health.sessionId);
    if (!lock?.slotId) return '';

    const slotNum = this.parseSlotNumber(lock.slotId);
    const email = lock.email || health.launch?.authProfile || '';

    // Time
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');

    // Quota data
    const quotaData = QuotaBrokerClient.read();
    const slot = quotaData?.slots?.[lock.slotId];

    // Ban indicator: derive from rate-limit state file
    const isBanned = this.isSlotBanned(lock.slotId);

    const segments: string[] = [];
    segments.push(this.fmtSlotBadge(slotNum, email, isBanned));
    segments.push(`🕐:${c('time')}${hh}:${mm}${rst()}`);

    if (slot) {
      segments.push(`⌛:${c('budget')}${this.fmtSlotDailyBudget(slot)}${rst()}`);
      // 📅 weekly quota — color computed inside fmtSlotWeeklyQuota
      const { text: weeklyText, color: weeklyColor } = this.fmtSlotWeeklyQuotaColored(slot);
      segments.push(`📅:${weeklyColor}${weeklyText}${rst()}`);

      // Tier 2: read live burn estimate (5s sampler) for the active slot
      const liveRead = this.readLiveBurn(lock.slotId);
      const burn = this.fmtBurnRate(slot, liveRead?.estimate, liveRead?.ageS);
      if (burn) segments.push(burn);

      // Heartbeat: log on staleness transitions and LKG fallbacks (not every render)
      if (liveRead && (liveRead.fromLkg || (liveRead.estimate && liveRead.isStale))) {
        writeHeartbeat('statusline-formatter', 'live_burn_read', {
          status: liveRead.fromLkg ? 'warn' : 'info',
          extra: { ageS: liveRead.ageS, fromLkg: liveRead.fromLkg, slot: lock.slotId },
        });
      }
    }

    // Stale data warning (appended to end)
    const mergedAt = quotaData?.ts ? quotaData.ts * 1000 : 0;
    const stale = mergedAt > 0 ? this.fmtStaleWarning(mergedAt) : '';

    if (segments.length === 0) return '';
    return segments[0] + segments.slice(1).join('') + stale;
  }

  /**
   * Format cost inline for Line 1
   * Format: 💰:$X.XX|$Y.YY/h
   */
  private static fmtCostInline(health: SessionHealth): string {
    if (!health.billing) return '';
    const sessionCost = health.billing.sessionCost || 0;
    const burnRate = health.billing.sessionBurnRate || health.billing.burnRatePerHour || 0;
    if (sessionCost < 0.01) return '';

    const costPart = `${c('cost')}${this.formatMoney(sessionCost)}${rst()}`;
    const burnPart = burnRate >= 0.01 ? `|${c('burnRate')}${this.formatMoney(burnRate)}/h${rst()}` : '';
    return `💰:${costPart}${burnPart}`;
  }

  // ============================================================================
  // Component Formatters
  // ============================================================================

  /**
   * Extract slot number from slotId (e.g. "slot-1" → "1")
   * Handles common formats: "slot-N", "slot N", "SN" (fallback to "?")
   * Returns '?' if format unrecognized (for graceful degradation)
   */
  private static parseSlotNumber(slotId: string | undefined): string {
    if (!slotId) return '?';
    // Primary: "slot-N" format
    let match = slotId.match(/slot-(\d+)/);
    if (match) return match[1];
    // Fallback: "SN" format
    match = slotId.match(/S(\d+)/);
    if (match) return match[1];
    // Fallback: any leading digits
    match = slotId.match(/(\d+)/);
    return match ? match[1] : '?';
  }

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

    // Preserve [Nm] context window suffix (e.g. [1m]) — already set by formatModelId
    // If not present in value, check model ID for it
    const hasCtxSuffix = /\[\d+[mk]\]/i.test(model);
    if (!hasCtxSuffix && health.model?.id) {
      const ctxMatch = health.model.id.match(/\[(\d+[mk])\]/i);
      if (ctxMatch) model += `[${ctxMatch[1].toLowerCase()}]`;
    }

    if (abbreviated) {
      // Abbreviate known models:
      // Opus4.6[1m] → o-4.6[1m], Sonnet4.6 → s-4.6, Haiku4.5 → h-4.5, Claude → c
      model = model
        .replace(/^Opus/i, 'o-')
        .replace(/^Sonnet/i, 's-')
        .replace(/^Haiku/i, 'h-')
        .replace(/^Claude$/i, 'c');
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

  /** Compact slot indicator: 👤S1 (colored by slot number) */
  private static fmtSlotIndicator(sessionId: string): string {
    const lock = SessionLockManager.read(sessionId);
    if (!lock?.slotId) return '';
    const num = this.parseSlotNumber(lock.slotId);
    const colors: Record<string, string> = {
      '1': c('critical'), '2': c('usage'), '3': c('weeklyBudget'), '4': c('cost')
    };
    return `${colors[num] || ''}👤S${num}${rst()}`;
  }

  /**
   * Context formatting: short format only (🧠:54k(97%))
   * Full/medium bar variants removed in compact redesign.
   */

  // Short context: "🧠:54k(97%)"
  private static fmtContextShort(health: SessionHealth): string {
    const left = this.formatTokens(health.context?.tokensLeft || 0);
    const pct = health.context?.percentUsed || 0;
    const colorName = this.getContextColor(pct);
    return `🧠:${c(colorName)}${left}(${pct}%)${rst()}`;
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

  // Note: Slot indicator and account context are both on Line 1 (inline, compact)
  // fmtSlotIndicator: 👤S1 (used in Line 1 core)
  // fmtAccountInline: 👤S1|email|🕐|⌛|📅 (used in Line 1 merged)

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
    const thresholdPercent = 83;
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

  /**
   * Split a long line into multiple output lines at component boundaries.
   * Splits at space characters (component separators) to avoid mid-word breaks.
   * Handles ANSI escape codes: carries open color sequences to continuation lines.
   */
  private static splitAtWidth(line: string, maxWidth: number): string[] {
    if (this.visibleWidth(line) <= maxWidth || maxWidth <= 0) return [line];

    const results: string[] = [];
    // Split by spaces (component boundaries) preserving ANSI codes
    const segments = line.split(/(?<=\s)/); // split AFTER spaces, keeping space with segment
    let currentLine = '';
    let currentWidth = 0;

    for (const seg of segments) {
      const segWidth = this.visibleWidth(seg);

      // Fallback: if a single segment exceeds maxWidth, hard-truncate it
      if (segWidth > maxWidth && currentLine.length === 0) {
        results.push(this.truncateString(seg.replace(/\x1b\[[0-9;]*m/g, ''), maxWidth));
        continue;
      }

      if (currentWidth + segWidth > maxWidth && currentLine.length > 0) {
        // Current segment pushes over — start a new line
        results.push(currentLine);
        currentLine = seg.trimStart(); // trim leading space on continuation
        currentWidth = this.visibleWidth(currentLine);
      } else {
        currentLine += seg;
        currentWidth += segWidth;
      }
    }
    if (currentLine) results.push(currentLine);

    // Ensure ANSI reset at end of each line (prevent color bleed)
    return results.map(l => l + rst());
  }

  private static truncateString(text: string, maxLen: number): string {
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 2) + '..';
  }

  /**
   * Build notification lines (warnings, switch recommendations, version mismatch)
   *
   * NOTE: Account context (active_slot) is now always on Line 1 — skipped here.
   *
   * Display pattern:
   * - Active session (transcript growing): Show 30s → Hide 5min → Repeat
   * - Idle session (transcript stale >2min): Always show
   *
   * Priority order: failover > slot_switch > version_update > version_mismatch > quota_stale > secrets
   */
  private static buildNotifications(health: SessionHealth, maxWidth: number, isIdle: boolean = false): string[] {
    const lines: string[] = [];

    try {
      // Failover notification (transient hot-swap event) — always show if present
      if (health.failoverNotification) {
        lines.push(`${c('critical')}${health.failoverNotification}${rst()}`);
      }

      // Secret detection DISABLED — too many false positives
      NotificationManager.remove('secrets_detected');

      // active_slot is now rendered inline on Line 1 — remove from notification cycle
      NotificationManager.remove('active_slot');

      // Weekly quota waste risk — the one thing user MUST see if pace will lose quota.
      // Compute from current slot's projections (populated by shell fetch-quotas.sh).
      try {
        const lock = SessionLockManager.read(health.sessionId);
        const quotaData = QuotaBrokerClient.read();
        const slot = lock?.slotId ? quotaData?.slots?.[lock.slotId] : null;
        if (slot) {
          const bestCase = slot.weekly_best_case_projected_util;
          const projected = slot.weekly_projected_util;
          const resetDay = slot.weekly_reset_day || 'reset';
          const GUARANTEED_THRESHOLD = 95;   // best-case < this → waste guaranteed
          const LIKELY_THRESHOLD = 85;       // current-pace < this → waste likely

          // Clean up previous registrations first (avoid stale alerts)
          NotificationManager.remove('weekly_quota_waste_certain');
          NotificationManager.remove('weekly_quota_waste_likely');

          if (bestCase != null && bestCase < GUARANTEED_THRESHOLD) {
            const waste = Math.max(0, 100 - bestCase);
            NotificationManager.register(
              'weekly_quota_waste_certain',
              `🚨 Weekly quota: ~${waste}% WILL be unused by ${resetDay} (physical max would still waste)`,
              9
            );
          } else if (projected != null && projected < LIKELY_THRESHOLD) {
            const waste = Math.max(0, 100 - projected);
            NotificationManager.register(
              'weekly_quota_waste_likely',
              `⚠ Weekly quota: at current pace, ~${waste}% may be unused by ${resetDay} — burn faster`,
              8
            );
          }
        }
      } catch { /* ignore — notification is non-critical */ }

      // Version mismatch: register notification if installed != running
      if (health.versionMismatch) {
        NotificationManager.register(
          'version_mismatch',
          `CLI v${health.versionMismatch.installed} installed — restart session to upgrade (running v${health.versionMismatch.running})`,
          8
        );
      } else {
        NotificationManager.remove('version_mismatch');
      }

      const active = isIdle
        ? NotificationManager.getAllRegistered()
        : NotificationManager.getActive();

      // Show max 3 notifications
      for (const [type, notification] of active.slice(0, 3)) {
        // Skip active_slot — it's on Line 1 now
        if (type === 'active_slot') continue;

        NotificationManager.recordShown(type);

        let line = '';

        switch (type) {
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

          case 'version_mismatch':
            line = `${c('critical')}⚠ ${notification.message}${rst()}`;
            break;

          case 'quota_stale':
            line = `${c('critical')}⚠ ${notification.message}${rst()}`;
            break;

          case 'weekly_quota_waste_certain':
            // Bright red: loss is mathematically guaranteed — needs user's full attention
            line = `${c('pacingRed')}${notification.message}${rst()}`;
            break;

          case 'weekly_quota_waste_likely':
            // Orange: action needed but not yet guaranteed to waste
            line = `${c('pacingOrange')}${notification.message}${rst()}`;
            break;

          case 'restart_ready':
            line = `${c('critical')}🔴 ${notification.message}${rst()}`;
            break;

          case 'transcript_sampler_dead':
            line = `${c('burnRate')}⚠ ${notification.message}${rst()}`;
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

  /** Format slot daily budget: Xh(Y%) — time UNTIL reset from five_hour_resets_at */
  private static fmtSlotDailyBudget(slot: MergedQuotaSlot): string {
    const pct = Math.round(slot.five_hour_util || 0);

    if (slot.five_hour_resets_at) {
      const resetMs = new Date(slot.five_hour_resets_at).getTime();
      if (!isNaN(resetMs)) {
        const diffSec = Math.max(0, Math.floor((resetMs - Date.now()) / 1000));
        if (diffSec <= 0) return `reset(${pct}%)`;
        const h = Math.floor(diffSec / 3600);
        const m = Math.floor((diffSec % 3600) / 60);
        const tl = h > 0 ? (m > 0 ? `${h}h${m}m` : `${h}h`) : `${m}m`;
        return `${tl}(${pct}%)`;
      }
    }
    return `(${pct}%)`;
  }

  /**
   * Resolve pacing status → ANSI color (6-band scheme from user spec)
   * way_too_slow/under → bright red; not_fast_enough/slow → blue;
   * a_bit_too_slow → yellow; good/on_track → green;
   * much_too_fast/fast → orange; way_too_fast/over → violet.
   * Legacy pacing values mapped for backward compat.
   */
  private static pacingColor(status: string | undefined): string {
    switch (status) {
      case 'way_too_slow': case 'under': case 'exhausted':
        return c('pacingRed');        // alarm: need to act now
      case 'not_fast_enough': case 'slow':
        return c('pacingOrange');     // attention: under pace
      case 'a_bit_too_slow':
        return c('pacingYellow');     // caution: slightly under
      case 'good': case 'on_track':
        return c('pacingGreen');      // ideal
      case 'much_too_fast': case 'fast':
        return c('pacingBlue');       // cool: over pace (not dangerous)
      case 'way_too_fast': case 'over':
        return c('pacingViolet');     // outlier: way over (still not dangerous)
      default:
        return c('version');          // dim gray — unknown/reset/target-only
    }
  }

  /**
   * Format token-per-hour shorthand for live burn suffix.
   * 0-999   → "N"     (e.g. "800")
   * 1k-99k  → "N.Nk"  (e.g. "3.2k", "52.0k")
   * 100k+   → "Nk"    (e.g. "123k")
   */
  static fmtTokPerHour(tokensPerHour: number): string {
    if (!isFinite(tokensPerHour) || tokensPerHour < 0) return '0';
    if (tokensPerHour < 1000) return `${Math.round(tokensPerHour)}`;
    if (tokensPerHour < 100_000) return `${(tokensPerHour / 1000).toFixed(1)}k`;
    return `${Math.round(tokensPerHour / 1000)}k`;
  }

  /**
   * Format combined burn rate segment: 🔥:{5h_rate}%/h|{7d_rate}%/d [Xk/h~live]
   *
   * Low-confidence marker (burn_sample_count_5h < 3):
   * - Rate prefixed with `~` (estimate)
   * - Color overridden to neutralLight (245) — muted grey, regardless of pacing status
   *
   * High-confidence (≥3 samples): normal 6-band pacing color.
   * Shows min-max range for 5h when ≥3 distinct samples and min ≠ max.
   *
   * Live tier (Tier 2): when liveEstimate is fresh (ageS ≤ 30) and session_count > 0,
   * appends a muted " Xk/h~live" suffix showing real-time token burn rate.
   * Stale / missing live data → no suffix (silent fallback to API baseline).
   * Dead sampler (ageS > 60) → register transcript_sampler_dead notification (once/30min).
   */
  private static fmtBurnRate(
    slot: MergedQuotaSlot,
    liveEstimate?: LiveBurnEstimate | null,
    ageS?: number,
  ): string {
    // ── 5h rate ──
    const target5h = slot.target_burn_rate_5h;
    const avg5h    = slot.burn_rate_1h_avg_5h ?? slot.five_hour_burn_rate;
    const min5h    = slot.burn_rate_1h_min_5h;
    const max5h    = slot.burn_rate_1h_max_5h;
    const sampleCt = slot.burn_sample_count_5h ?? 0;
    const lowConfidence = sampleCt < 3;
    const hasActual5h = avg5h != null && avg5h > 0;

    let part5h = '';
    if (hasActual5h) {
      const tilde = lowConfidence ? '~' : '';
      const color = lowConfidence ? c('neutralLight') : this.pacingColor(slot.pacing_status_5h);
      if (!lowConfidence && min5h != null && max5h != null && min5h !== max5h && sampleCt >= 3) {
        part5h = `${color}${tilde}${min5h}-${max5h}%/h${rst()}`;
      } else {
        part5h = `${color}${tilde}${avg5h}%/h${rst()}`;
      }
    } else if (target5h != null && target5h > 0) {
      part5h = `${c('version')}${target5h}%/h${rst()}`;
    }

    // ── 7d rate (%/day) ──
    const target7d = slot.target_burn_rate_7d_per_day;
    const actual7d = slot.seven_day_burn_rate_per_day;

    let part7d = '';
    if (actual7d != null && actual7d > 0) {
      const color = this.pacingColor(slot.pacing_status_7d);
      part7d = `${color}${actual7d}%/d${rst()}`;
    } else if (target7d != null && target7d > 0) {
      part7d = `${c('version')}${target7d}%/d${rst()}`;
    }

    if (!part5h && !part7d) return '';

    const inner = [part5h, part7d].filter(Boolean).join('|');
    let result = `🔥:${inner}`;

    // ── Tier 2 live suffix ──
    const effectiveAgeS = ageS ?? 0;

    // Dead sampler detection: ageS > 60 → one-time deduped notification
    if (liveEstimate !== undefined && liveEstimate !== null && effectiveAgeS > 60) {
      try {
        NotificationManager.register(
          'transcript_sampler_dead',
          `Transcript sampler appears dead (${effectiveAgeS}s since last sample). Statusline using API baseline only.`,
          6,
        );
      } catch { /* non-critical */ }
    }

    // Fresh live data: append token-rate suffix
    const isFresh = liveEstimate != null && effectiveAgeS <= 30 && liveEstimate.session_count > 0;
    if (isFresh) {
      const tokSuffix = StatuslineFormatter.fmtTokPerHour(liveEstimate!.tokens_per_hour);
      result += ` ${c('neutralLight')}${tokSuffix}/h~live${rst()}`;
    }

    return result;
  }

  /**
   * Read live burn estimate for a given slotId.
   * Returns null on any error (fail-open).
   * Extracted to a method so tests can mock it via the `Fmt` accessor.
   */
  private static readLiveBurn(slotId: string): ReturnType<typeof readLiveBurnEstimate> | null {
    try {
      return readLiveBurnEstimate(slotId);
    } catch {
      return null;
    }
  }

  /**
   * Compute week_progress_pct from seven_day_resets_at.
   * Represents how far into the current week we are (0–100).
   */
  private static weekProgressPct(slot: MergedQuotaSlot): number | null {
    if (!slot.seven_day_resets_at) return null;
    const resetMs = new Date(slot.seven_day_resets_at).getTime();
    if (isNaN(resetMs)) return null;
    const hoursUntilReset = Math.max(0, (resetMs - Date.now()) / 3_600_000);
    return Math.round(100 - (hoursUntilReset / 168) * 100);
  }

  /**
   * Format slot weekly quota with color derived from loss-risk rules.
   * Returns both text and color so the caller can wrap them with reset.
   *
   * Priority (first match wins):
   * 1. weekly_projected_util < 100 AND sample_count ≥ 3 AND week_progress ≥ 20 → CERTAIN LOSS (red bold)
   * 2. best_case_projected_util < 95                                             → LIKELY LOSS (red bold)
   * 3. weekly_projected_util < 90                                                → TRENDING (orange bold)
   * 4. weekly_projected_util < 95                                                → MARGIN AT RISK (yellow)
   * 5. weekly_projected_util 95–105                                              → ON TRACK (green)
   * 6. weekly_projected_util > 105                                               → WASTING (blue)
   * 7. missing data                                                               → neutral (250)
   *
   * Text format: Zh(W%→P%) when projection available, else Zh(W%).
   */
  private static fmtSlotWeeklyQuotaColored(slot: MergedQuotaSlot): { text: string; color: string } {
    const pct = Math.round(slot.seven_day_util || 0);
    const hours = Math.max(0, Math.floor(slot.weekly_budget_remaining_hours || 0));
    const sampleCt = slot.burn_sample_count_5h ?? 0;
    const bestCase = slot.weekly_best_case_projected_util;
    const projected = slot.weekly_projected_util;
    const weekProg = this.weekProgressPct(slot);

    // Build inline projection suffix: →P%
    let projSuffix = '';
    if (sampleCt >= 3 && projected != null) {
      projSuffix = `→${Math.round(projected)}%`;
    } else if (bestCase != null) {
      projSuffix = `→${Math.round(bestCase)}%`;
    }
    const text = projSuffix
      ? `${hours}h(${pct}%${projSuffix})`
      : `${hours}h(${pct}%)`;

    // Color rules
    const noColor = (process.env.NO_COLOR === '1' || process.env.NO_COLOR === 'true');

    if (projected != null && projected < 100 && sampleCt >= 3 && (weekProg ?? 0) >= 20) {
      return { text, color: noColor ? '' : `${COLORS.bold}${COLORS.pacingRed}` };
    }
    if (bestCase != null && bestCase < 95) {
      return { text, color: noColor ? '' : `${COLORS.bold}${COLORS.pacingRed}` };
    }
    if (projected != null && projected < 90) {
      return { text, color: noColor ? '' : `${COLORS.bold}${COLORS.pacingOrange}` };
    }
    if (projected != null && projected < 95) {
      return { text, color: noColor ? '' : COLORS.pacingYellow };
    }
    if (projected != null && projected >= 95 && projected <= 105) {
      return { text, color: noColor ? '' : COLORS.pacingGreen };
    }
    if (projected != null && projected > 105) {
      return { text, color: noColor ? '' : COLORS.pacingBlue };
    }
    // Missing or insufficient data
    return { text, color: noColor ? '' : COLORS.neutralId };
  }

  /** Format slot weekly quota: Zh(W%) — legacy plain text (kept for external use) */
  private static fmtSlotWeeklyQuota(slot: MergedQuotaSlot): string {
    return this.fmtSlotWeeklyQuotaColored(slot).text;
  }

  /**
   * Format slot badge: 👤SN|email  (with optional ban prefix ⛔)
   * When banned: entire badge dimmed to neutralLight (245).
   */
  private static fmtSlotBadge(slotNum: string, email: string, isBanned: boolean): string {
    if (isBanned) {
      return `${c('neutralLight')}⛔S${slotNum}|${email}${rst()}`;
    }
    return `${c('neutralId')}👤S${slotNum}${rst()}|${email}`;
  }

  /**
   * Check if a slot is currently in rate-limit backoff.
   * Reads ~/.claude/session-health/.fetch-rate-limit-state.{slotId}
   */
  private static isSlotBanned(slotId: string): boolean {
    try {
      const stateDir = `${homedir()}/.claude/session-health`;
      const statePath = `${stateDir}/.fetch-rate-limit-state.${slotId}`;
      if (!existsSync(statePath)) return false;
      const content = readFileSync(statePath, 'utf-8');
      const state = JSON.parse(content) as { backoff_until_epoch?: number };
      const backoffUntil = state.backoff_until_epoch || 0;
      return Math.floor(Date.now() / 1000) < backoffUntil;
    } catch {
      return false;
    }
  }

  /**
   * Format stale data warning based on mergedAtMs (Unix timestamp ms of cache write).
   * - < 15min  → empty string
   * - 15–30min → " ⚠ stale Nm" in neutralLight (245)
   * - > 30min  → " ⚠⚠ STALE Nm" in pacingOrange (208) + bold
   */
  static fmtStaleWarning(mergedAtMs: number): string {
    const ageMin = Math.floor((Date.now() - mergedAtMs) / 60_000);
    const noColor = (process.env.NO_COLOR === '1' || process.env.NO_COLOR === 'true');
    if (ageMin < 15) return '';
    if (ageMin <= 30) {
      const col = noColor ? '' : COLORS.neutralLight;
      const r = noColor ? '' : COLORS.reset;
      return ` ${col}⚠ stale ${ageMin}m${r}`;
    }
    const col = noColor ? '' : `${COLORS.bold}${COLORS.pacingOrange}`;
    const r = noColor ? '' : COLORS.reset;
    return ` ${col}⚠⚠ STALE ${ageMin}m${r}`;
  }
}
