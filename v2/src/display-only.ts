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
  transcript: { exists: boolean; lastModifiedAgo: string; isSynced: boolean; lastMessagePreview?: string; lastMessageAgo?: string };
  model: { value: string };
  context: { tokensLeft: number; percentUsed: number };
  git: { branch: string; ahead: number; behind: number; dirty: number };
  billing: { costToday: number; burnRatePerHour: number; budgetRemaining: number; budgetPercentUsed: number; resetTime: string; isFresh: boolean; lastFetched?: number };
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

function shortenPath(path: string, maxLen: number = 25): string {
  if (!path) return '?';
  const home = homedir();
  let shortened = path.startsWith(home) ? '~' + path.slice(home.length) : path;

  if (shortened.length <= maxLen) {
    return shortened;
  }

  // Get last path component
  const parts = shortened.split('/').filter(p => p);
  if (parts.length <= 1) {
    return shortened.slice(0, maxLen - 2) + '..';
  }

  let lastPart = parts[parts.length - 1];
  // Remove common prefixes that add noise
  lastPart = lastPart.replace(/^_+/, ''); // Leading underscores

  if (lastPart.length <= maxLen - 2) {
    return `~/${lastPart}`;
  }
  // Truncate if still too long
  return `~/${lastPart.slice(0, maxLen - 4)}..`;
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

function fmtDirectory(h: SessionHealth): string {
  return `📁:${c('directory')}${shortenPath(h.projectPath)}${rst()}`;
}

function fmtGit(h: SessionHealth): string {
  if (!h.git?.branch) return '';
  let result = `🌿:${c('git')}${h.git.branch}`;
  if (h.git.ahead > 0) result += `+${h.git.ahead}`;
  if (h.git.behind > 0) result += `-${h.git.behind}`;
  if (h.git.dirty > 0) result += `*${h.git.dirty}`;
  return result + rst();
}

function fmtModel(h: SessionHealth): string {
  return `🤖:${c('model')}${h.model?.value || 'Claude'}${rst()}`;
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
  if (!h.transcript?.exists) return `📝:${c('warning')}⚠${rst()}`;
  const ago = h.transcript.lastModifiedAgo || '?';
  if (h.alerts?.dataLossRisk) return `📝:${c('critical')}${ago}🔴${rst()}`;
  if (h.alerts?.transcriptStale) return `📝:${c('warning')}${ago}⚠${rst()}`;
  return `📝:${c('transcript')}${ago}${rst()}`;
}

function fmtLastMessage(h: SessionHealth): string {
  if (!h.transcript?.lastMessagePreview) return '';
  const ago = h.transcript.lastMessageAgo || '?';
  const preview = h.transcript.lastMessagePreview;
  // Compact format: "💬:preview(ago)" saves 1 char vs "💬:ago preview"
  return `💬:${c('lastMsg')}${preview}(${ago})${rst()}`;
}

function fmtBudget(h: SessionHealth): string {
  if (!h.billing?.budgetRemaining && h.billing?.budgetRemaining !== 0) return '';
  const mins = h.billing.budgetRemaining || 0;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;

  // Compact format: "1h53m@14:00" or "1h53m🔴" if stale
  const stale = !h.billing.isFresh ? `${c('critical')}🔴${rst()}` : '';
  const reset = h.billing.resetTime && h.billing.isFresh ? `@${h.billing.resetTime}` : '';
  return `⌛:${c('budget')}${hours}h${m}m${reset}${rst()}${stale}`;
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
    // 1. Parse session_id from stdin (minimal parsing, fail-safe)
    let sessionId: string | null = null;
    try {
      const stdin = require('fs').readFileSync(0, 'utf-8');
      const parsed = JSON.parse(stdin);
      sessionId = parsed?.session_id || null;
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

    // 4b. Check if health data is stale (>5 minutes old)
    const healthAge = health.gatheredAt ? Date.now() - health.gatheredAt : 0;
    const STALE_THRESHOLD = 5 * 60 * 1000; // 5 minutes
    const isStale = healthAge > STALE_THRESHOLD;

    // 5. Read config (safe, use defaults on error)
    const configPath = `${HEALTH_DIR}/config.json`;
    const configRaw = safeReadJson<{ components?: Partial<ComponentsConfig> }>(configPath);
    const cfg: ComponentsConfig = { ...DEFAULT_COMPONENTS, ...configRaw?.components };

    // 6. Build SINGLE LINE output with last message at end (truncated to fit)
    // Format: [alerts] [dir] [git] [model] [context] [cost] [budget] [time] [sync] [lastMsg...]
    // Terminal width is typically ~120 chars; leave ~15 for Claude Code UI

    const parts: string[] = [];

    // Alerts first (critical)
    if (isStale) {
      const minsOld = Math.floor(healthAge / 60000);
      parts.push(`${c('stale')}⚠${minsOld}m${rst()}`);
    }
    { const hs = fmtHealthStatus(health); if (hs) parts.push(hs); }
    if (cfg.secrets) { const s = fmtSecrets(health); if (s) parts.push(s); }

    // Core info
    if (cfg.directory) parts.push(fmtDirectory(health));
    if (cfg.git) { const g = fmtGit(health); if (g) parts.push(g); }
    if (cfg.model) parts.push(fmtModel(health));
    if (cfg.context) parts.push(fmtContext(health));

    // Billing info (condensed)
    if (cfg.cost) { const co = fmtCost(health); if (co) parts.push(co); }
    if (cfg.budget) { const b = fmtBudget(health); if (b) parts.push(b); }

    // Time and sync (compact)
    if (cfg.time) parts.push(fmtTime());
    if (cfg.transcriptSync) parts.push(fmtTranscriptSync(health));

    // Calculate remaining space for last message
    const coreLine = parts.join(' ');
    const coreWidth = visibleWidth(coreLine);
    const MAX_WIDTH = 115; // Leave room for Claude Code UI
    const remainingWidth = MAX_WIDTH - coreWidth - 2; // -2 for space and safety

    // Last message at end - truncate to fill remaining space
    if (remainingWidth > 10 && health.transcript?.lastMessagePreview) {
      const ago = health.transcript.lastMessageAgo || '';
      const preview = health.transcript.lastMessagePreview;
      // Calculate how much preview we can fit
      const agoLen = ago.length + 3; // "(<1m)" format
      const maxPreviewLen = Math.max(5, remainingWidth - agoLen - 3); // -3 for 💬:
      const truncatedPreview = preview.length > maxPreviewLen
        ? preview.slice(0, maxPreviewLen - 2) + '..'
        : preview;
      parts.push(`💬:${c('lastMsg')}${truncatedPreview}(${ago})${rst()}`);
    }

    // 7. Output SINGLE LINE (NO trailing newline)
    process.stdout.write(parts.join(' '))

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
