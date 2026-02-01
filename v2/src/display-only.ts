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
import { StatuslineFormatter } from './lib/statusline-formatter';

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
  const thresholdPercent = 78;
  const thresholdPos = Math.floor(width * thresholdPercent / 100);
  const pct = Math.max(0, Math.min(100, percentUsed || 0));
  const usedPos = Math.floor(width * pct / 100);

  let bar = '';
  for (let i = 0; i < width; i++) {
    // Threshold marker ALWAYS appears at threshold position (78%)
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

  // Show "-free" suffix, or just "K" if space is tight
  const suffix = availableWidth && availableWidth < 20 ? '' : '-free';

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

// ============================================================================
// Main Display Logic
// ============================================================================

function display(): void {
  try {
    // 1. Parse stdin JSON from Claude Code (contains real-time data)
    let sessionId: string | null = null;
    let stdinDirectory: string | null = null;
    let stdinModel: string | null = null;
    let stdinContext: { tokensUsed: number; tokensLeft: number; percentUsed: number } | null = null;
    let cacheRatio: number | null = null;  // Cache hit ratio from JSON input
    try {
      const stdin = require('fs').readFileSync(0, 'utf-8');
      const parsed = JSON.parse(stdin);
      sessionId = parsed?.session_id || null;
      // Extract directory from Claude Code input (most reliable source)
      stdinDirectory = parsed?.start_directory || parsed?.workspace?.current_dir || parsed?.cwd || null;
      // Extract model from stdin (takes priority over cached)
      stdinModel = parsed?.model?.display_name || parsed?.model?.id || parsed?.model?.model_id || parsed?.model?.name || null;

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
      const windowSize = parsed?.context_window?.context_window_size || 200000;
      const tokensUsed = currentInput + outputTokens + cacheRead;
      if (tokensUsed > 0) {
        const compactionThreshold = Math.floor(windowSize * 0.78);
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

    // 4. If no health data, show what we have from stdin (new session)
    if (!health) {
      const parts: string[] = [];

      // Use data from stdin that we DO have
      if (stdinDirectory) {
        parts.push(fmtDirectory(stdinDirectory));
      }

      // Model from stdin or default
      const model = (stdinModel || 'Claude').replace(/\s+/g, '');
      parts.push(`🤖:${c('model')}${model}${rst()}`);

      parts.push(fmtTime());

      // Try to get billing from shared cache (available even for new sessions)
      try {
        const sharedBillingPath = `${HEALTH_DIR}/billing-shared.json`;
        if (existsSync(sharedBillingPath)) {
          const billing = JSON.parse(readFileSync(sharedBillingPath, 'utf-8'));
          if (billing?.costToday > 0) {
            const cost = formatMoney(billing.costToday);
            parts.push(`💰:${c('cost')}${cost}${rst()}`);
          }
        }
      } catch { /* ignore */ }

      // Small indicator that health is loading (not scary error message)
      parts.push(`${c('stale')}⏳${rst()}`);

      process.stdout.write(parts.join(' '));
      return;
    }

    // 5. Read config (safe, use defaults on error)
    const configPath = `${HEALTH_DIR}/config.json`;
    const configRaw = safeReadJson<{ components?: Partial<ComponentsConfig> }>(configPath);
    const cfg: ComponentsConfig = { ...DEFAULT_COMPONENTS, ...configRaw?.components };

    // 6. Simple variant lookup - NO formatting logic (Phase 0: Performance Architecture)
    // All formatting logic moved to StatuslineFormatter in data-daemon (background)
    // Display-only just looks up pre-formatted variant for current terminal width

    // Get terminal width from environment (0 or undefined = no tmux/unknown)
    const paneWidthRaw = process.env.STATUSLINE_WIDTH;
    const paneWidth = paneWidthRaw ? parseInt(paneWidthRaw, 10) : 0;
    const noTmux = !paneWidth || paneWidth <= 0;

    let variant: string[];

    // Check if stdin has overrides (directory, model, or context) that differ from cached health
    // If stdin has fresh context data, ALWAYS regenerate to show accurate token counts
    const hasStdinOverrides = (stdinDirectory && stdinDirectory !== health.projectPath) ||
                               (stdinModel && stdinModel !== health.model?.value) ||
                               (stdinContext && stdinContext.tokensUsed > 0);

    // Helper to select variant based on width
    const selectVariant = (variants: any): string[] => {
      if (noTmux) {
        // No tmux: use single-line mode (max 240 chars)
        return variants.singleLine || variants.width120;
      }
      if (paneWidth <= 50) return variants.width40;
      if (paneWidth <= 70) return variants.width60;
      if (paneWidth <= 90) return variants.width80;
      if (paneWidth <= 110) return variants.width100;
      if (paneWidth <= 135) return variants.width120;
      if (paneWidth <= 175) return variants.width150;
      return variants.width200;
    };

    if (health.formattedOutput && !hasStdinOverrides) {
      // Use pre-formatted variant (fast path)
      variant = selectVariant(health.formattedOutput);
    } else {
      // Fallback: Generate on-the-fly (backwards compatibility until daemon runs)
      // Merge stdin data (start_directory, model, context) into health before formatting
      const healthWithStdin = { ...health } as any;
      if (stdinDirectory) {
        healthWithStdin.projectPath = stdinDirectory;
      }
      if (stdinModel) {
        healthWithStdin.model = healthWithStdin.model || {};
        healthWithStdin.model.value = stdinModel;
      }
      // CRITICAL: Use fresh context data from stdin (most accurate)
      if (stdinContext) {
        healthWithStdin.context = healthWithStdin.context || {};
        healthWithStdin.context.tokensUsed = stdinContext.tokensUsed;
        healthWithStdin.context.tokensLeft = stdinContext.tokensLeft;
        healthWithStdin.context.percentUsed = stdinContext.percentUsed;
      }

      const allVariants = StatuslineFormatter.formatAllVariants(healthWithStdin);
      variant = selectVariant(allVariants);
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
