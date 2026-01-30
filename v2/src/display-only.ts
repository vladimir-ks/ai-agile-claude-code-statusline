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
  transcript: { exists: boolean; lastModifiedAgo: string; isSynced: boolean };
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
  const thresholdPos = 9; // 78% of 12
  const pct = Math.max(0, Math.min(100, percentUsed || 0));
  const usedPos = Math.floor(width * pct / 100);

  let bar = '';
  for (let i = 0; i < width; i++) {
    if (i === thresholdPos) bar += '|';
    else if (i < usedPos) bar += '=';
    else bar += '-';
  }
  return `[${bar}]`;
}

function shortenPath(path: string): string {
  if (!path) return '?';
  const home = homedir();
  let shortened = path.startsWith(home) ? '~' + path.slice(home.length) : path;
  if (shortened.length > 35) {
    const parts = shortened.split('/');
    shortened = '~/' + parts[parts.length - 1];
  }
  return shortened;
}

// ============================================================================
// Component Formatters (each handles its own errors)
// ============================================================================

function fmtDirectory(h: SessionHealth): string {
  return `📁:${shortenPath(h.projectPath)}`;
}

function fmtGit(h: SessionHealth): string {
  if (!h.git?.branch) return '';
  let result = `🌿:${h.git.branch}`;
  if (h.git.ahead > 0) result += `+${h.git.ahead}`;
  if (h.git.behind > 0) result += `/-${h.git.behind}`;
  if (h.git.dirty > 0) result += `*${h.git.dirty}`;
  return result;
}

function fmtModel(h: SessionHealth): string {
  return `🤖:${h.model?.value || 'Claude'}`;
}

function fmtContext(h: SessionHealth): string {
  const left = formatTokens(h.context?.tokensLeft || 0);
  const bar = generateProgressBar(h.context?.percentUsed || 0);
  return `🧠:${left}left${bar}`;
}

function fmtTime(): string {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  return `🕐:${hours}:${mins}`;
}

function fmtTranscriptSync(h: SessionHealth): string {
  if (!h.transcript?.exists) return '📝:⚠';
  const ago = h.transcript.lastModifiedAgo || '?';
  if (h.alerts?.dataLossRisk) return `📝:${ago}🔴`;
  if (h.alerts?.transcriptStale) return `📝:${ago}⚠`;
  return `📝:${ago}`;
}

function fmtBudget(h: SessionHealth): string {
  if (!h.billing?.budgetRemaining && h.billing?.budgetRemaining !== 0) return '';
  const mins = h.billing.budgetRemaining || 0;
  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  const pct = h.billing.budgetPercentUsed || 0;
  let result = `⌛:${hours}h${m}m(${pct}%)`;
  if (h.billing.resetTime) result += h.billing.resetTime;
  if (!h.billing.isFresh) result += '🔴';
  return result;
}

function fmtCost(h: SessionHealth): string {
  if (!h.billing?.costToday) return '';
  const cost = formatMoney(h.billing.costToday);
  if (h.billing.burnRatePerHour > 0) {
    const rate = formatMoney(h.billing.burnRatePerHour);
    return `💰:${cost}|${rate}/h`;
  }
  return `💰:${cost}`;
}

function fmtSecrets(h: SessionHealth): string {
  if (!h.alerts?.secretsDetected) return '';
  const count = h.alerts.secretTypes?.length || 0;
  if (count === 1) return `🔐SECRETS!(${h.alerts.secretTypes[0]})`;
  return `🔐SECRETS!(${count} types)`;
}

function fmtHealthStatus(h: SessionHealth): string {
  // Show health issues count if any
  const status = h.health?.status;
  const issues = h.health?.issues?.length || 0;

  if (!status || status === 'healthy') return '';
  if (status === 'critical') return `🔴${issues}issue${issues > 1 ? 's' : ''}`;
  if (status === 'warning') return `🟡${issues}issue${issues > 1 ? 's' : ''}`;
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
      process.stdout.write(`🤖:Claude 🕐:${fmtTime().slice(3)}`);
      return;
    }

    // 3. Read health file (safe, returns null on any error)
    const healthPath = `${HEALTH_DIR}/${sessionId}.json`;
    const health = safeReadJson<SessionHealth>(healthPath);

    // 4. If no health data, output minimal with warning
    if (!health) {
      process.stdout.write(`⚠:NoData 🤖:Claude ${fmtTime()} (check: tail ~/.claude/session-health/daemon.log)`);
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

    // 6. Build output (each formatter handles its own errors)
    const parts: string[] = [];

    // Stale data indicator (shows first if data is old)
    if (isStale) {
      const minsOld = Math.floor(healthAge / 60000);
      parts.push(`⚠:Stale(${minsOld}m)`);
    }

    // Health status indicator (shows if issues exist)
    { const hs = fmtHealthStatus(health); if (hs) parts.push(hs); }

    if (cfg.directory) parts.push(fmtDirectory(health));
    if (cfg.git) { const g = fmtGit(health); if (g) parts.push(g); }
    if (cfg.model) parts.push(fmtModel(health));
    if (cfg.context) parts.push(fmtContext(health));
    if (cfg.time) parts.push(fmtTime());
    if (cfg.transcriptSync) parts.push(fmtTranscriptSync(health));
    if (cfg.budget) { const b = fmtBudget(health); if (b) parts.push(b); }
    if (cfg.cost) { const c = fmtCost(health); if (c) parts.push(c); }
    if (cfg.secrets) { const s = fmtSecrets(health); if (s) parts.push(s); }

    // 7. Output (NO trailing newline - critical for CLI UI)
    process.stdout.write(parts.join(' '));

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
