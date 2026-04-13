#!/usr/bin/env bun
/**
 * DISPLAY ONLY - Ultra-thin, read-only statusline
 *
 * ARCHITECTURAL GUARANTEE:
 * - This script ONLY reads JSON files and outputs formatted text
 * - NO network calls
 * - NO subprocess spawning (no git, no ccusage, NOTHING)
 * - NO external dependencies that could fail
 * - CANNOT block or slow down Claude Code UI
 *
 * WORST CASE BEHAVIOR:
 * - If health file missing → shows minimal output with ⚠
 * - If health file corrupt → shows minimal output with ⚠
 * - If any error → catches and outputs safe fallback
 * - NEVER throws to caller
 * - NEVER takes more than ~10ms
 *
 * DATA CONTRACT:
 * - Reads from: ~/.claude/session-health/[session-id].json
 * - Reads from: ~/.claude/session-health/config.json
 * - Written by: separate data-daemon (async, background)
 */

// Process-level safety nets — register BEFORE imports to catch import failures
process.on('uncaughtException', () => {
  try { process.stdout.write('⚠:ERR'); } catch { /* last resort */ }
  process.exit(0); // Exit cleanly — never propagate to parent
});
process.on('unhandledRejection', () => {
  try { process.stdout.write('⚠:ERR'); } catch { /* last resort */ }
  process.exit(0);
});
process.stdout.on('error', () => { process.exit(0); });

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { StatuslineFormatter } from './lib/statusline-formatter';
import { writeHeartbeat } from './lib/heartbeat';

// ============================================================================
// Types (inline to avoid import failures)
// ============================================================================

interface SessionHealth {
  sessionId: string;
  projectPath: string;
  gatheredAt?: number;  // Timestamp when health was last gathered
  health: { status: string; issues: string[]; lastUpdate?: number };
  transcript: {
    exists: boolean;
    lastModifiedAgo: string;
    isSynced: boolean;
    messageCount?: number;       // Turn count
    lastMessageTime?: number;    // Unix timestamp ms
    lastMessagePreview?: string;
    lastMessageAgo?: string;
  };
  model: { value: string };
  context: { tokensLeft: number; percentUsed: number; tokensUsed?: number; windowSize?: number };
  git: { branch: string; ahead: number; behind: number; dirty: number };
  billing: { costToday: number; burnRatePerHour: number; budgetRemaining: number; budgetPercentUsed: number; resetTime: string; totalTokens?: number; tokensPerMinute?: number | null; isFresh: boolean; lastFetched?: number };
  alerts: { secretsDetected: boolean; secretTypes: string[]; transcriptStale: boolean; dataLossRisk: boolean };
}

interface ComponentsConfig {
  directory: boolean;
  git: boolean;
  model: boolean;
  context: boolean;
  time: boolean;
  transcriptSync: boolean;
  budget: boolean;
  cost: boolean;
  secrets: boolean;
}

interface DisplayConfig {
  mode: 'auto' | 'multiline' | 'singleline';
  marginPercent: number | null;  // null=auto, 0=no margin, 5-25=custom
  maxLines: number;
}

const DEFAULT_DISPLAY: DisplayConfig = {
  mode: 'auto',
  marginPercent: null,
  maxLines: 6
};

// ============================================================================
// Constants
// ============================================================================

const HEALTH_DIR = `${homedir()}/.claude/session-health`;
const DEFAULT_COMPONENTS: ComponentsConfig = {
  directory: true,
  git: true,
  model: true,
  context: true,
  time: true,
  transcriptSync: true,
  budget: true,
  cost: true,
  secrets: true
};

// ============================================================================
// Color System (respects NO_COLOR environment variable)
// ============================================================================

const USE_COLOR = !process.env.NO_COLOR;

// ANSI 256-color codes (matching V1 palette)
const COLORS = {
  reset: '\x1b[0m',
  // Component colors
  directory: '\x1b[38;5;117m',    // sky blue
  git: '\x1b[38;5;150m',          // soft green
  model: '\x1b[38;5;147m',        // light purple
  version: '\x1b[38;5;180m',      // soft yellow
  time: '\x1b[38;5;249m',         // light gray
  transcript: '\x1b[38;5;156m',   // light green
  budget: '\x1b[38;5;189m',       // lavender
  cost: '\x1b[38;5;222m',         // light gold
  burnRate: '\x1b[38;5;220m',     // bright gold
  usage: '\x1b[38;5;222m',        // light gold (same as cost)
  cache: '\x1b[38;5;156m',        // light green (same as V1)
  lastMsg: '\x1b[38;5;252m',      // white/gray (for message preview)
  // Context colors based on usage
  contextGood: '\x1b[38;5;158m',  // mint green
  contextWarn: '\x1b[38;5;215m',  // peach
  contextCrit: '\x1b[38;5;203m',  // coral red
  // Alert colors
  warning: '\x1b[38;5;215m',      // peach/orange
  critical: '\x1b[38;5;203m',     // coral red
  secrets: '\x1b[38;5;196m',      // bright red
  stale: '\x1b[38;5;208m',        // orange
};

function c(colorName: keyof typeof COLORS): string {
  if (!USE_COLOR) return '';
  return COLORS[colorName] || '';
}

function rst(): string {
  if (!USE_COLOR) return '';
  return COLORS.reset;
}

// ============================================================================
// Safe File Reading (never throws)
// ============================================================================

function safeReadJson<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8');
    if (!content || content.trim() === '') return null;
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

// ============================================================================
// Formatting Functions (pure, no side effects)
// ============================================================================

function formatTokens(tokens: number): string {
  if (typeof tokens !== 'number' || !isFinite(tokens) || tokens < 0) return '0';
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.floor(tokens / 1000)}k`;
  return String(Math.floor(tokens));
}

function formatMoney(amount: number): string {
  if (typeof amount !== 'number' || !isFinite(amount) || amount < 0) return '$0';
  if (amount >= 100) return `$${Math.floor(amount)}`;
  // For values 10-99, show integer if whole number, otherwise one decimal
  if (amount >= 10) {
    return amount === Math.floor(amount) ? `$${Math.floor(amount)}` : `$${amount.toFixed(1)}`;
  }
  return `$${amount.toFixed(2)}`;
}

function generateProgressBar(percentUsed: number, width: number = 12): string {
  const thresholdPercent = 83;
  const thresholdPos = Math.floor(width * thresholdPercent / 100);
  const pct = Math.max(0, Math.min(100, percentUsed || 0));
  const usedPos = Math.floor(width * pct / 100);

  let bar = '';
  for (let i = 0; i < width; i++) {
    // Threshold marker ALWAYS appears at threshold position (83%)
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
 * Smart path truncation - keep all parts visible, shorten long directory names
 * Example: ~/Projects/ai-agile-claude-code-statusline/v2 → ~/Projects/ai-agi…/v2
 * Only truncates directory names >= 10 characters
 */
function smartTruncatePath(path: string): string {
  if (!path) return '?';
  const home = homedir();
  const startsWithHome = path.startsWith(home);
  let workingPath = startsWithHome ? '~' + path.slice(home.length) : path;

  const parts = workingPath.split('/').filter(p => p);

  const truncated = parts.map(part => {
    // Don't truncate short names (< 10 chars)
    if (part.length < 10) return part;

    // Truncate long names: first 6 chars + …
    return part.slice(0, 6) + '…';
  });

  return truncated.join('/');
}

function shortenPath(path: string, maxLen: number = 40): string {
  if (!path) return '?';
  const home = homedir();
  const startsWithHome = path.startsWith(home);
  let shortened = startsWithHome ? '~' + path.slice(home.length) : path;

  if (shortened.length <= maxLen) {
    return shortened;
  }

  // Get path components
  const parts = shortened.split('/').filter(p => p);
  if (parts.length <= 1) {
    return shortened.slice(0, maxLen - 1) + '…';
  }

  const hasTilde = parts[0] === '~';
  let lastPart = parts[parts.length - 1];

  // Try to show last 2 parts with truncation indicator
  if (parts.length >= 2) {
    const lastTwo = parts.slice(-2).join('/');
    const prefix = hasTilde ? '~/…/' : '…/';
    const candidate = prefix + lastTwo;
    if (candidate.length <= maxLen) {
      return candidate;
    }
  }

  // Show last part only with truncation indicator
  const prefix = hasTilde ? '~/…/' : '…/';
  if (prefix.length + lastPart.length <= maxLen) {
    return prefix + lastPart;
  }

  // Truncate last part if still too long
  const available = maxLen - prefix.length - 1;
  if (available > 3) {
    return prefix + lastPart.slice(0, available) + '…';
  }

  // Ultimate fallback
  return shortened.slice(0, maxLen - 1) + '…';
}

/**
 * Strip ANSI escape codes to calculate visible width
 */
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Validate DisplayConfig values
 * - mode: must be one of 'auto', 'multiline', 'singleline'
 * - marginPercent: null (auto), 0 (no margin), or 5-25 (custom)
 * - maxLines: must be >= 1
 */
function validateDisplayConfig(cfg: Partial<DisplayConfig>): DisplayConfig {
  const result: DisplayConfig = { ...DEFAULT_DISPLAY };

  if (cfg.mode !== undefined) {
    if (['auto', 'multiline', 'singleline'].includes(cfg.mode)) {
      result.mode = cfg.mode as 'auto' | 'multiline' | 'singleline';
    }
    // Invalid mode silently ignored, keeps default
  }

  if (cfg.marginPercent !== undefined) {
    if (cfg.marginPercent === null) {
      result.marginPercent = null;
    } else if (typeof cfg.marginPercent === 'number') {
      // Accept 0 (no margin) or 5-25 (custom)
      if (cfg.marginPercent === 0 || (cfg.marginPercent >= 5 && cfg.marginPercent <= 25)) {
        result.marginPercent = cfg.marginPercent;
      }
      // Out-of-range values silently ignored, keeps default
    }
  }

  if (cfg.maxLines !== undefined && typeof cfg.maxLines === 'number') {
    // Minimum 1 line (preserve "always outputs something" guarantee)
    // Maximum 10 lines (reasonable bound to prevent runaway output)
    if (cfg.maxLines >= 1 && cfg.maxLines <= 10) {
      result.maxLines = cfg.maxLines;
    }
    // Out-of-range values silently ignored, keeps default
  }

  return result;
}

/**
 * Calculate visible width (excluding ANSI codes)
 */
function visibleWidth(str: string): number {
  return stripAnsi(str).length;
}

// ============================================================================
// Component Formatters (each handles its own errors, with colors)
// ============================================================================

function fmtDirectory(path: string | null): string {
  if (!path) return '';
  // SPEC: Directory should NEVER be truncated - only replace home with ~
  const home = homedir();
  const displayPath = path.startsWith(home) ? '~' + path.slice(home.length) : path;
  return `📁:${c('directory')}${displayPath}${rst()}`;
}

function fmtGit(h: SessionHealth): string {
  if (!h.git?.branch) return '';
  let result = `🌿:${c('git')}${h.git.branch}`;
  if (h.git.ahead > 0) result += `+${h.git.ahead}`;
  if (h.git.behind > 0) result += `-${h.git.behind}`;
  if (h.git.dirty > 0) result += `*${h.git.dirty}`;
  return result + rst();
}

function fmtModel(h: SessionHealth, stdinModel: string | null = null): string {
  // Prefer stdin model (real-time from Claude Code) over cached health data
  let model = stdinModel || h.model?.value || 'Claude';
  // Remove spaces for compact display (e.g., "Opus 4.5" → "Opus4.5")
  model = model.replace(/\s+/g, '');
  return `🤖:${c('model')}${model}${rst()}`;
}

function fmtContext(h: SessionHealth, availableWidth?: number): string {
  const left = formatTokens(h.context?.tokensLeft || 0);
  const pct = h.context?.percentUsed || 0;

  // Determine bar width based on available space
  const barWidth = availableWidth && availableWidth > 15 ? Math.min(availableWidth - 10, 15) : 12;
  const bar = generateProgressBar(h.context?.percentUsed || 0, barWidth);

  // Color based on context usage
  let colorName: keyof typeof COLORS = 'contextGood';
  if (pct >= 95) colorName = 'contextCrit';
  else if (pct >= 80) colorName = 'contextWarn';

  // No suffix — just the token count. Bar conveys meaning.
  const suffix = '';

  return `🧠:${c(colorName)}${left}${suffix}${bar}${rst()}`;
}

function fmtTime(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  return `🕐:${c('time')}${hours}:${mins}${rst()}`;
}

function fmtWeeklyBudget(h: SessionHealth): string {
  if (!h.billing?.weeklyBudgetRemaining) return '';

  const hours = Math.floor(h.billing.weeklyBudgetRemaining); // Round down
  const pct = h.billing.weeklyBudgetPercentUsed || 0;
  const resetDay = h.billing.weeklyResetDay || 'Mon';

  return `📅:${c('weeklyBudget')}${hours}h(${pct}%)@${resetDay}${rst()}`;
}

function fmtTimeBudgetLine(h: SessionHealth): string {
  // Combined line: 🕐:13:18|⌛:42m(29%)|📅:28h(41%)@Mon
  const parts: string[] = [];

  parts.push(fmtTime());

  const budget = fmtBudget(h);
  if (budget) parts.push(budget);

  const weekly = fmtWeeklyBudget(h);
  if (weekly) parts.push(weekly);

  return parts.join('|');
}

function fmtTranscriptSync(h: SessionHealth): string {
  // Only show when there's something to worry about
  if (!h.transcript?.exists) return `📝:${c('warning')}⚠${rst()}`;
  if (h.alerts?.dataLossRisk) return `📝:${c('critical')}${h.transcript.lastModifiedAgo}🔴${rst()}`;
  if (h.alerts?.transcriptStale) return `📝:${c('warning')}${h.transcript.lastModifiedAgo}⚠${rst()}`;
  // Hide when recent (< 2 min) - no need to show "everything is fine"
  return '';
}

function fmtMessageCount(h: SessionHealth): string {
  const count = h.transcript?.messageCount || 0;
  if (count === 0) return '';
  return `💬:${c('transcript')}${count}t${rst()}`;
}

function fmtLastMessage(h: SessionHealth): string {
  if (!h.transcript?.lastMessagePreview) return '';
  const ago = h.transcript.lastMessageAgo || '?';
  const preview = h.transcript.lastMessagePreview;
  // Simple format: just elapsed time + preview (no clock time)
  return `💬:${c('lastMsg')}(${ago})${rst()} ${preview}`;
}

function fmtBudget(h: SessionHealth): string {
  if (!h.billing?.budgetRemaining && h.billing?.budgetRemaining !== 0) return '';

  // Client-side time adjustment: subtract elapsed minutes from cached value
  let mins = h.billing.budgetRemaining || 0;
  if (h.billing.lastFetched) {
    const ageMinutes = Math.floor((Date.now() - h.billing.lastFetched) / 60000);
    mins = Math.max(0, mins - ageMinutes);  // Adjust for staleness
  }

  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  const pct = h.billing.budgetPercentUsed || 0;

  // New format: "42m(29%)" or "2h15m(73%)" - omit hours if 0
  const stale = !h.billing.isFresh ? `${c('critical')}🔴${rst()}` : '';
  const timeStr = hours > 0 ? `${hours}h${m}m` : `${m}m`;
  return `⌛:${c('budget')}${timeStr}(${pct}%)${rst()}${stale}`;
}

function fmtCost(h: SessionHealth): string {
  if (!h.billing?.costToday) return '';
  const cost = formatMoney(h.billing.costToday);
  if (h.billing.burnRatePerHour > 0) {
    const rate = formatMoney(h.billing.burnRatePerHour);
    return `💰:${c('cost')}${cost}${rst()}|${c('burnRate')}${rate}/h${rst()}`;
  }
  return `💰:${c('cost')}${cost}${rst()}`;
}

function fmtCache(cacheRatio: number | null): string {
  if (cacheRatio === null) return '';
  return `💾:${c('cache')}${cacheRatio}%${rst()}`;
}

function fmtUsage(h: SessionHealth): string {
  // 📊:130.0Mtok(951ktpm) format from V1
  const tokens = h.billing?.totalTokens;
  if (!tokens || tokens <= 0) return '';

  // Format tokens (same logic as V1)
  let tokStr: string;
  if (tokens >= 1000000) {
    tokStr = `${(tokens / 1000000).toFixed(1)}M`;
  } else if (tokens >= 1000) {
    tokStr = `${Math.floor(tokens / 1000)}k`;
  } else {
    tokStr = String(tokens);
  }

  // Add TPM if available
  const tpm = h.billing?.tokensPerMinute;
  if (tpm && tpm > 0) {
    let tpmStr: string;
    if (tpm >= 1000) {
      tpmStr = `${Math.floor(tpm / 1000)}k`;
    } else {
      tpmStr = String(Math.floor(tpm));
    }
    return `📊:${c('usage')}${tokStr}tok(${tpmStr}tpm)${rst()}`;
  }

  return `📊:${c('usage')}${tokStr}tok${rst()}`;
}

function fmtSecrets(h: SessionHealth): string {
  if (!h.alerts?.secretsDetected) return '';
  const count = h.alerts.secretTypes?.length || 0;

  // Short name mapping for compact display
  const shortName = (type: string): string => {
    if (type.includes('Private Key') || type === 'Private Key') return 'Key';
    if (type.includes('API Key')) return 'API';
    if (type.includes('GitHub')) return 'GH';
    if (type.includes('AWS')) return 'AWS';
    if (type.includes('GitLab')) return 'GL';
    if (type.includes('Slack')) return 'Slack';
    if (type.includes('DB') || type.includes('Connection')) return 'DB';
    return type.slice(0, 6); // Fallback: first 6 chars
  };

  if (count === 1) return `${c('secrets')}🔐${shortName(h.alerts.secretTypes[0])}${rst()}`;
  return `${c('secrets')}🔐${count}types${rst()}`;
}

function fmtHealthStatus(h: SessionHealth): string {
  // Only show for TRULY critical issues (secrets detected, transcript missing)
  // Context warnings are already visible in the progress bar
  // Billing staleness is shown via 🔴 on budget
  if (h.alerts?.secretsDetected) {
    // Enhanced secrets display - show type instead of generic "SEC"
    const types = h.alerts.secretTypes || [];

    // Filter out file paths (like /var/folders/.../gitleaks) - keep only secret type names
    const secretNames = types
      .filter(t => !t.startsWith('/'))  // Remove paths
      .map(t => {
        // Shorten common names
        if (t.includes('Private Key') || t.includes('RSA') || t.includes('SSH')) return 'Key';
        if (t.includes('API') || t.includes('Anthropic') || t.includes('OpenAI')) return 'API';
        if (t.includes('GitHub')) return 'GH';
        if (t.includes('AWS')) return 'AWS';
        if (t.includes('GitLab')) return 'GL';
        if (t.includes('Slack')) return 'Slack';
        if (t.includes('DB') || t.includes('Connection')) return 'DB';
        return t.slice(0, 10);  // Fallback: first 10 chars
      });

    if (secretNames.length === 0) {
      // All were paths (false positive) - don't show alert
      return '';
    }

    if (secretNames.length === 1) {
      return `${c('critical')}⚠️ ${secretNames[0]}${rst()}`;
    }
    return `${c('critical')}⚠️ ${secretNames.length} secrets${rst()}`;
  }
  if (!h.transcript?.exists && h.transcriptPath) {
    return `${c('critical')}🔴TXN${rst()}`;
  }
  return '';
}

/**
 * Format model ID to display name: "claude-opus-4-6" → "Opus4.6", "Opus" → "Opus"
 * Already-formatted names pass through: "Opus4.5" → "Opus4.5"
 * Inline (no imports) — display-only architectural guarantee.
 */
function formatModelId(modelId: string): string {
  const lower = modelId.toLowerCase();
  // Extract context window suffix: [1m], [200k], etc.
  const ctxMatch = modelId.match(/\[(\d+[mk])\]/i);
  const ctxSuffix = ctxMatch ? `[${ctxMatch[1].toLowerCase()}]` : '';
  // Extract version: "claude-opus-4-6" → "4.6", "claude-opus-4-6[1m]" → "4.6"
  // Strip context suffix before version extraction to avoid regex confusion
  const stripped = lower.replace(/\[\d+[mk]\]/i, '');
  const dashVersion = stripped.match(/(\d+)-(\d+)(?:-\d|$)/);
  // Also detect already-formatted: "Opus4.5" → keep as-is via dot version
  const dotVersion = stripped.match(/(\d+\.\d+)/);
  const version = dashVersion ? `${dashVersion[1]}.${dashVersion[2]}` : (dotVersion ? dotVersion[1] : '');
  if (lower.includes('opus')) return `Opus${version}${ctxSuffix}`;
  if (lower.includes('sonnet')) return `Sonnet${version}${ctxSuffix}`;
  if (lower.includes('haiku')) return `Haiku${version}${ctxSuffix}`;
  return modelId;
}

// ============================================================================
// Main Display Logic
// ============================================================================

function display(): void {
  try {
    // 1. Parse stdin JSON from Claude Code (contains real-time data)
    let sessionId: string | null = null;
    let stdinDirectory: string | null = null;
    let stdinModel: string | null = null;
    let rawModelId: string | null = null;  // Raw model ID for [1m] detection
    let stdinVersion: string | null = null;
    let stdinContext: { tokensUsed: number; tokensLeft: number; percentUsed: number } | null = null;
    let cacheRatio: number | null = null;  // Cache hit ratio from JSON input
    try {
      const stdin = require('fs').readFileSync(0, 'utf-8');
      const parsed = JSON.parse(stdin);
      sessionId = parsed?.session_id || null;
      // Extract directory from Claude Code input (most reliable source)
      stdinDirectory = parsed?.start_directory || parsed?.workspace?.current_dir || parsed?.cwd || null;
      // Extract model from stdin (takes priority over cached)
      // Prefer model.id (has version: "claude-opus-4-6[1m]") over display_name (just "Opus")
      // formatModelId will prettify: "claude-opus-4-6[1m]" → "Opus4.6[1m]"
      rawModelId = parsed?.model?.id || parsed?.model?.model_id || null;
      stdinModel = rawModelId || parsed?.model?.display_name || parsed?.model?.name || null;
      if (stdinModel) {
        stdinModel = formatModelId(stdinModel);
      }
      // Extract CLI version from stdin (e.g., "1.0.29")
      stdinVersion = parsed?.version || null;

      // Calculate cache hit ratio from context_window data (V1 parity)
      const currentInput = parsed?.context_window?.current_usage?.input_tokens || 0;
      const cacheRead = parsed?.context_window?.current_usage?.cache_read_input_tokens || 0;
      const outputTokens = parsed?.context_window?.current_usage?.output_tokens || 0;
      if (currentInput > 0 || cacheRead > 0) {
        const totalEligible = currentInput + cacheRead;
        if (totalEligible > 0) {
          cacheRatio = Math.round((cacheRead * 100) / totalEligible);
        }
      }

      // Extract context window data for accurate display (CRITICAL for fresh data)
      // context_window_size comes from Claude Code's stdin JSON — dynamic per model/session
      // 83% = Claude's auto-compaction trigger (tokens used / window size)
      // Default 200000 if Claude Code doesn't send the field (conservative estimate)
      const windowSize = parsed?.context_window?.context_window_size || 200000;
      const tokensUsed = currentInput + outputTokens + cacheRead;
      if (tokensUsed > 0) {
        const compactionThreshold = Math.floor(windowSize * 0.83);
        stdinContext = {
          tokensUsed,
          tokensLeft: Math.max(0, compactionThreshold - tokensUsed),
          percentUsed: compactionThreshold > 0 ? Math.min(100, Math.floor((tokensUsed / compactionThreshold) * 100)) : 0
        };
      }
    } catch {
      // Can't parse stdin - will show fallback
    }

    // 2. If no session, output minimal and exit
    if (!sessionId) {
      process.stdout.write(`🤖:${c('model')}Claude${rst()} ${fmtTime()}`);
      return;
    }

    // 3. Read health file (safe, returns null on any error)
    const healthPath = `${HEALTH_DIR}/${sessionId}.json`;
    const health = safeReadJson<SessionHealth>(healthPath);

    // 4. If no health data, show minimal loading indicator
    // Applies to: fresh session start, resumed session (stale health), any !health state
    // Daemon will write health file shortly → next render shows full display
    if (!health) {
      process.stdout.write(`${c('stale')}⏳${rst()}`);
      return;
    }

    // 5. Read config (safe, use defaults on error)
    const configPath = `${HEALTH_DIR}/config.json`;
    const configRaw = safeReadJson<{ components?: Partial<ComponentsConfig>; display?: Partial<DisplayConfig> }>(configPath);
    const cfg: ComponentsConfig = { ...DEFAULT_COMPONENTS, ...configRaw?.components };
    // Validate display config to catch invalid values (mode, marginPercent, maxLines)
    const displayCfg: DisplayConfig = validateDisplayConfig(configRaw?.display || {});

    // 6. Simple variant lookup - NO formatting logic (Phase 0: Performance Architecture)
    // All formatting logic moved to StatuslineFormatter in data-daemon (background)
    // Display-only just looks up pre-formatted variant for current terminal width

    // Get terminal width from environment
    // Priority: STATUSLINE_WIDTH (shell wrapper) > COLUMNS (terminal) > 120 (fallback)
    // paneWidth represents the available width from tmux/terminal for rendering
    // Used by Guard 2 to hard-truncate lines and prevent horizontal wrapping
    const paneWidthRaw = process.env.STATUSLINE_WIDTH || process.env.COLUMNS;
    const paneWidth = paneWidthRaw ? parseInt(paneWidthRaw, 10) : 120;
    const hasWidth = paneWidth > 0;

    // Display mode: "auto" (default), "multiline" (forced), "singleline" (forced)
    const useSingleLine = displayCfg.mode === 'singleline'
      || (displayCfg.mode === 'auto' && !hasWidth);

    let variant: string[];

    // Always regenerate formatting on-the-fly (<5ms, pure computation).
    // Pre-formatted output from daemon is stale for: notifications (idle state
    // changes after daemon runs), time (clock drift), stdin overrides (context).
    // Merge stdin data (start_directory, model, context) into health before formatting
    const healthWithStdin = { ...health } as any;
    if (stdinDirectory) {
      healthWithStdin.projectPath = stdinDirectory;
    }
    if (stdinModel) {
      healthWithStdin.model = healthWithStdin.model || {};
      healthWithStdin.model.value = stdinModel;
      // Store raw model ID for [1m] context window detection in formatter
      if (rawModelId) healthWithStdin.model.id = rawModelId;
    }
    // CRITICAL: Use fresh context data from stdin (most accurate)
    if (stdinContext) {
      healthWithStdin.context = healthWithStdin.context || {};
      healthWithStdin.context.tokensUsed = stdinContext.tokensUsed;
      healthWithStdin.context.tokensLeft = stdinContext.tokensLeft;
      healthWithStdin.context.percentUsed = stdinContext.percentUsed;
    }
    // CLI version: use session lock's launch-time version (immutable per session)
    // This ensures version stays fixed until session restart — critical for
    // identifying sessions that need restart after CLI updates
    if (sessionId) {
      try {
        const lockPath = `${HEALTH_DIR}/${sessionId}.lock`;
        const lockData = safeReadJson<{ claudeVersion?: string }>(lockPath);
        if (lockData?.claudeVersion) {
          healthWithStdin.cliVersion = lockData.claudeVersion;
        } else if (stdinVersion) {
          healthWithStdin.cliVersion = stdinVersion; // Fallback before lock exists
        }
      } catch {
        if (stdinVersion) healthWithStdin.cliVersion = stdinVersion;
      }
    } else if (stdinVersion) {
      healthWithStdin.cliVersion = stdinVersion;
    }

    // Version mismatch detection: compare running vs installed (read-only, zero cost)
    // Display layer reads cached file written by data-daemon — no subprocess
    if (healthWithStdin.cliVersion) {
      try {
        const installedData = safeReadJson<{ version: string; checkedAt: number }>(
          `${HEALTH_DIR}/installed-version.json`
        );
        if (installedData?.version && installedData.version !== healthWithStdin.cliVersion) {
          // Semver comparison: only warn if installed is NEWER
          const running = healthWithStdin.cliVersion.split('.').map(Number);
          const installed = installedData.version.split('.').map(Number);
          const isNewer = installed[0] > running[0] ||
            (installed[0] === running[0] && installed[1] > running[1]) ||
            (installed[0] === running[0] && installed[1] === running[1] && installed[2] > running[2]);
          if (isNewer) {
            healthWithStdin.versionMismatch = {
              running: healthWithStdin.cliVersion,
              installed: installedData.version
            };
          }
        }
      } catch { /* non-critical */ }
    }

    // P1-d: hot-path single-variant render (8× → 1×). Picks ONE width bucket
    // directly in the formatter instead of computing all 8 variants then discarding 7.
    // P1-g: readOnlyNotifications=true (default) — display-only never writes to
    // notifications.json; the daemon path (unified-data-broker → formatAllVariants)
    // is the singleton-owned writer.
    //
    // Observability: formatter emits `statusline-formatter:render_picked` heartbeat
    // with latencyMs + width bucket. Kept permanent (hot-path perf regression alarm).
    const renderT0 = Date.now();
    variant = StatuslineFormatter.formatPicked(
      healthWithStdin,
      paneWidth,
      useSingleLine,
      displayCfg.marginPercent,
      /*readOnlyNotifications*/ true,
    );
    // Hot-path self-timing: complements the formatter's own heartbeat so we can
    // attribute any regression to display-only wiring vs. formatter internals.
    try {
      writeHeartbeat('display-only', 'render', {
        latencyMs: Date.now() - renderT0,
        extra: { paneWidth, singleLine: useSingleLine, variantLines: variant.length },
      });
    } catch { /* heartbeat is best-effort */ }

    // === ANTI-WRAPPING GUARDS ===
    // Guard 1: Max lines (configurable, default 6)
    const MAX_LINES = displayCfg.maxLines;
    if (variant.length > MAX_LINES) {
      variant = variant.slice(0, MAX_LINES);
    }

    // Guard 2: Hard-truncate each line to pane width (prevents horizontal overflow)
    // Line 1 content is pre-split by formatter's splitAtWidth() into multiple output lines.
    if (paneWidth > 0) {
      variant = variant.map((line) => {
        const visible = stripAnsi(line);
        if (visible.length <= paneWidth) return line;
        // Truncate: walk through original string, count visible chars
        let visCount = 0;
        let cutIdx = line.length;
        let inEsc = false;
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '\x1b') { inEsc = true; continue; }
          if (inEsc) { if (line[i] === 'm') inEsc = false; continue; }
          visCount++;
          if (visCount >= paneWidth - 1) { cutIdx = i + 1; break; }
        }
        // Re-append any open ANSI sequences' reset
        return line.slice(0, cutIdx) + '\x1b[0m';
      });
    }

    // Guard 3: Total chars cap (defense in depth)
    const MAX_STATUSLINE_CHARS = 500;
    const visLen = (s: string) => stripAnsi(s).length;
    while (variant.length > 1 && variant.reduce((sum, l) => sum + visLen(l), 0) > MAX_STATUSLINE_CHARS) {
      variant.pop();
    }

    // Output with newlines between lines (NO trailing newline)
    process.stdout.write(variant.join('\n'));

  } catch (error) {
    // LAST RESORT: If anything fails, output safe fallback
    // This should NEVER happen, but defense in depth
    process.stdout.write('⚠:ERR');
  }
}

// ============================================================================
// Entry Point
// ============================================================================

display();
