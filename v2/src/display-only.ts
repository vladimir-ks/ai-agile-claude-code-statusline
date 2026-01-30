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

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';

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
  if (!tokens || tokens < 0) return '0';
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${Math.floor(tokens / 1000)}k`;
  return String(tokens);
}

function formatMoney(amount: number): string {
  if (!amount || amount < 0) return '$0';
  if (amount >= 100) return `$${Math.floor(amount)}`;
  // For values 10-99, show integer if whole number, otherwise one decimal
  if (amount >= 10) {
    return amount === Math.floor(amount) ? `$${Math.floor(amount)}` : `$${amount.toFixed(1)}`;
  }
  return `$${amount.toFixed(2)}`;
}

function generateProgressBar(percentUsed: number): string {
  const width = 12;
  const thresholdPos = 9; // 78% of 12 (position 9 = 75%, close enough)
  const pct = Math.max(0, Math.min(100, percentUsed || 0));
  const usedPos = Math.floor(width * pct / 100);

  let bar = '';
  for (let i = 0; i < width; i++) {
    // Threshold marker ALWAYS appears at position 9 (highest priority)
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
  return `📁:${c('directory')}${shortenPath(path)}${rst()}`;
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

function fmtContext(h: SessionHealth): string {
  const left = formatTokens(h.context?.tokensLeft || 0);
  const bar = generateProgressBar(h.context?.percentUsed || 0);
  const pct = h.context?.percentUsed || 0;

  // Color based on context usage
  let colorName: keyof typeof COLORS = 'contextGood';
  if (pct >= 95) colorName = 'contextCrit';
  else if (pct >= 80) colorName = 'contextWarn';

  return `🧠:${c(colorName)}${left}left${bar}${rst()}`;
}

function fmtTime(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  return `🕐:${c('time')}${hours}:${mins}${rst()}`;
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
  const mins = Math.max(0, h.billing.budgetRemaining || 0);  // Clamp to 0
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  const pct = h.billing.budgetPercentUsed || 0;

  // V1 format: "XhXm(XX%)HH:MM" or "XhXm(XX%)🔴" if stale
  const stale = !h.billing.isFresh ? `${c('critical')}🔴${rst()}` : '';
  const reset = h.billing.resetTime && h.billing.isFresh ? h.billing.resetTime : '';
  return `⌛:${c('budget')}${hours}h${m}m(${pct}%)${reset}${rst()}${stale}`;
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
  if (count === 1) return `${c('secrets')}🔐SECRETS!(${h.alerts.secretTypes[0]})${rst()}`;
  return `${c('secrets')}🔐SECRETS!(${count} types)${rst()}`;
}

function fmtHealthStatus(h: SessionHealth): string {
  // Only show for TRULY critical issues (secrets detected, transcript missing)
  // Context warnings are already visible in the progress bar
  // Billing staleness is shown via 🔴 on budget
  if (h.alerts?.secretsDetected) {
    return `${c('critical')}🔴SEC${rst()}`;
  }
  if (!h.transcript?.exists && h.transcriptPath) {
    return `${c('critical')}🔴TXN${rst()}`;
  }
  return '';
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
    let cacheRatio: number | null = null;  // Cache hit ratio from JSON input
    try {
      const stdin = require('fs').readFileSync(0, 'utf-8');
      const parsed = JSON.parse(stdin);
      sessionId = parsed?.session_id || null;
      // Extract directory from Claude Code input (most reliable source)
      stdinDirectory = parsed?.start_directory || parsed?.workspace?.current_dir || parsed?.cwd || null;
      // Extract model from stdin (takes priority over cached)
      stdinModel = parsed?.model?.display_name || parsed?.model?.name || null;

      // Calculate cache hit ratio from context_window data (V1 parity)
      const currentInput = parsed?.context_window?.current_usage?.input_tokens || 0;
      const cacheRead = parsed?.context_window?.current_usage?.cache_read_input_tokens || 0;
      if (currentInput > 0 || cacheRead > 0) {
        const totalEligible = currentInput + cacheRead;
        if (totalEligible > 0) {
          cacheRatio = Math.round((cacheRead * 100) / totalEligible);
        }
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

    // 4. If no health data, output minimal with warning
    if (!health) {
      process.stdout.write(`${c('warning')}⚠:NoData${rst()} 🤖:${c('model')}Claude${rst()} ${fmtTime()} ${c('stale')}(check: tail ~/.claude/session-health/daemon.log)${rst()}`);
      return;
    }

    // 5. Read config (safe, use defaults on error)
    const configPath = `${HEALTH_DIR}/config.json`;
    const configRaw = safeReadJson<{ components?: Partial<ComponentsConfig> }>(configPath);
    const cfg: ComponentsConfig = { ...DEFAULT_COMPONENTS, ...configRaw?.components };

    // 6. Build output matching V1 format:
    // 📁:dir 🌿:git 🤖:model 🧠:context 🕐:time ⌛:budget 💰:cost 💬:turns 📝:sync 💬:lastMsg
    const parts: string[] = [];

    // Critical alerts only (secrets, health issues)
    { const hs = fmtHealthStatus(health); if (hs) parts.push(hs); }
    if (cfg.secrets) { const s = fmtSecrets(health); if (s) parts.push(s); }

    // Core info - ONLY use stdin directory (from Claude Code), never daemon's cached path
    if (cfg.directory && stdinDirectory) {
      const dir = fmtDirectory(stdinDirectory);
      if (dir) parts.push(dir);
    }
    if (cfg.git) { const g = fmtGit(health); if (g) parts.push(g); }
    if (cfg.model) parts.push(fmtModel(health, stdinModel));
    if (cfg.context) parts.push(fmtContext(health));

    // Time first, then billing
    if (cfg.time) parts.push(fmtTime());
    if (cfg.budget) { const b = fmtBudget(health); if (b) parts.push(b); }
    if (cfg.cost) { const co = fmtCost(health); if (co) parts.push(co); }

    // Usage metrics (📊 total tokens + TPM from ccusage)
    { const u = fmtUsage(health); if (u) parts.push(u); }

    // Cache ratio (from stdin JSON context_window data)
    { const ca = fmtCache(cacheRatio); if (ca) parts.push(ca); }

    // Conversation metrics (message count = turns)
    { const mc = fmtMessageCount(health); if (mc) parts.push(mc); }

    // Sync status
    if (cfg.transcriptSync) parts.push(fmtTranscriptSync(health));

    // Last message at end (V1 format: HH:MM(elapsed) preview)
    { const lm = fmtLastMessage(health); if (lm) parts.push(lm); }

    // 7. Intelligent multi-line wrapping
    // Use tmux pane width if available (set by wrapper script), else default
    // Use 80% of width to leave room for Claude's messages on the right
    const paneWidth = parseInt(process.env.STATUSLINE_WIDTH || '120', 10);
    const MAX_LINE_WIDTH = Math.floor(paneWidth * 0.8);

    // Build output with intelligent line wrapping
    const lines: string[] = [];
    let currentLine = '';

    for (const part of parts) {
      const testLine = currentLine ? currentLine + ' ' + part : part;
      if (visibleWidth(testLine) <= MAX_LINE_WIDTH) {
        currentLine = testLine;
      } else {
        // Current line is full, start new line
        if (currentLine) lines.push(currentLine);
        currentLine = part;
      }
    }
    // Don't forget the last line
    if (currentLine) lines.push(currentLine);

    // Output with newlines between lines (NO trailing newline)
    process.stdout.write(lines.join('\n'));

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
