#!/usr/bin/env bun
/**
 * Telemetry Dashboard - CLI tool for viewing statusline metrics
 *
 * Provides insights from SQLite telemetry database:
 * - Session statistics (invocation count, avg performance, cost tracking)
 * - Daily statistics (unique sessions, total invocations, cost trends)
 * - Performance trends (cache hit rate, staleness patterns)
 * - Auth profile breakdown (usage per account)
 *
 * Usage:
 *   bun telemetry-dashboard.ts [command] [options]
 *
 * Commands:
 *   session <sessionId>    Show statistics for specific session
 *   daily [date]           Show daily statistics (default: today)
 *   summary                Show overall summary (last 7 days)
 *   profiles               Show auth profile breakdown
 *   cleanup                Remove entries older than 30 days
 */

import { TelemetryDatabase } from '../lib/telemetry-database';
import type { TelemetryEntry } from '../lib/telemetry-database';

// -------------------------------------------------------------------------
// Formatting Helpers
// -------------------------------------------------------------------------

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = sec / 60;
  if (min < 60) return `${min.toFixed(0)}m`;
  const hour = min / 60;
  return `${hour.toFixed(1)}h`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatNumber(value: number): string {
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value.toString();
}

function horizontalLine(width: number = 80): string {
  return '─'.repeat(width);
}

function box(title: string, content: string, width: number = 80): string {
  const titleLine = `┌─ ${title} ${'─'.repeat(Math.max(0, width - title.length - 4))}`;
  const bottomLine = `└${'─'.repeat(width - 1)}`;
  const lines = content.split('\n').map(line => `│ ${line}`);
  return [titleLine, ...lines, bottomLine].join('\n');
}

// -------------------------------------------------------------------------
// Commands
// -------------------------------------------------------------------------

function showSessionStats(sessionId: string): void {
  const stats = TelemetryDatabase.getSessionStats(sessionId);

  if (!stats) {
    console.error(`❌ No data found for session: ${sessionId}`);
    process.exit(1);
  }

  const entries = TelemetryDatabase.query({ sessionId, limit: 10 });

  console.log('\n' + box(`Session: ${sessionId}`, `
Invocations:      ${stats.invocationCount}
Avg Display Time: ${formatDuration(stats.avgDisplayTimeMs)}
Cache Hit Rate:   ${formatPercent(stats.cacheHitRate)}
Total Cost:       ${formatCost(stats.totalCost)}
  `));

  if (entries.length > 0) {
    console.log('\n📊 Recent Invocations:\n');
    console.log('Time                  | Display | Cache | Model       | Context | Cost');
    console.log(horizontalLine());

    for (const entry of entries) {
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const display = `${entry.displayTimeMs.toFixed(1)}ms`;
      const cache = entry.cacheHit ? '✓' : '✗';
      const model = entry.model.padEnd(11);
      const context = `${formatNumber(entry.contextUsed)}/${formatPercent(entry.contextPercent)}`;
      const cost = formatCost(entry.sessionCost);

      console.log(`${time.padEnd(20)} | ${display.padEnd(7)} | ${cache.padEnd(5)} | ${model} | ${context.padEnd(7)} | ${cost}`);
    }
  }

  console.log('');
}

function showDailyStats(date?: Date): void {
  const targetDate = date || new Date();
  const stats = TelemetryDatabase.getDailyStats(targetDate);

  if (!stats) {
    console.error(`❌ No data found for date: ${targetDate.toDateString()}`);
    process.exit(1);
  }

  console.log('\n' + box(`Daily Statistics: ${targetDate.toDateString()}`, `
Invocations:      ${stats.invocationCount}
Unique Sessions:  ${stats.uniqueSessions}
Avg Display Time: ${formatDuration(stats.avgDisplayTimeMs)}
Total Cost:       ${formatCost(stats.totalCost)}
  `));

  console.log('');
}

function showSummary(): void {
  const now = Date.now();
  const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

  const entries = TelemetryDatabase.query({ since: sevenDaysAgo });

  if (entries.length === 0) {
    console.error('❌ No data available for the last 7 days');
    process.exit(1);
  }

  // Calculate aggregates
  const uniqueSessions = new Set(entries.map(e => e.sessionId)).size;
  const avgDisplayTime = entries.reduce((sum, e) => sum + e.displayTimeMs, 0) / entries.length;
  const cacheHits = entries.filter(e => e.cacheHit).length;
  const cacheHitRate = (cacheHits / entries.length) * 100;
  const totalCost = Math.max(...entries.map(e => e.dailyCost));
  const avgBurnRate = entries.reduce((sum, e) => sum + e.burnRatePerHour, 0) / entries.length;

  // Health indicators
  const secretsDetected = entries.filter(e => e.hasSecrets).length;
  const authChanges = entries.filter(e => e.hasAuthChanges).length;
  const transcriptStale = entries.filter(e => e.transcriptStale).length;
  const billingStale = entries.filter(e => e.billingStale).length;

  console.log('\n' + box('7-Day Summary', `
📊 Usage:
  Invocations:      ${entries.length}
  Unique Sessions:  ${uniqueSessions}
  Avg Display Time: ${formatDuration(avgDisplayTime)}
  Cache Hit Rate:   ${formatPercent(cacheHitRate)}

💰 Cost:
  Total Daily Cost: ${formatCost(totalCost)}
  Avg Burn Rate:    ${formatCost(avgBurnRate)}/hour

⚠️  Health:
  Secrets Detected: ${secretsDetected} (${formatPercent((secretsDetected / entries.length) * 100)})
  Auth Changes:     ${authChanges} (${formatPercent((authChanges / entries.length) * 100)})
  Transcript Stale: ${transcriptStale} (${formatPercent((transcriptStale / entries.length) * 100)})
  Billing Stale:    ${billingStale} (${formatPercent((billingStale / entries.length) * 100)})
  `));

  console.log('');
}

function showProfiles(): void {
  const entries = TelemetryDatabase.query({ limit: 1000 });

  if (entries.length === 0) {
    console.error('❌ No telemetry data available');
    process.exit(1);
  }

  // Group by auth profile
  const profileStats = new Map<string, {
    invocations: number;
    totalCost: number;
    avgDisplayTime: number;
    cacheHits: number;
  }>();

  for (const entry of entries) {
    const profile = entry.authProfile;
    const existing = profileStats.get(profile) || {
      invocations: 0,
      totalCost: 0,
      avgDisplayTime: 0,
      cacheHits: 0,
    };

    existing.invocations++;
    existing.totalCost = Math.max(existing.totalCost, entry.dailyCost);
    existing.avgDisplayTime += entry.displayTimeMs;
    if (entry.cacheHit) existing.cacheHits++;

    profileStats.set(profile, existing);
  }

  // Calculate averages
  for (const [profile, stats] of profileStats.entries()) {
    stats.avgDisplayTime /= stats.invocations;
  }

  console.log('\n' + box('Auth Profile Breakdown', ''));
  console.log('Profile                      | Invocations | Avg Display | Cache Hit % | Daily Cost');
  console.log(horizontalLine());

  for (const [profile, stats] of profileStats.entries()) {
    const cacheHitRate = (stats.cacheHits / stats.invocations) * 100;
    console.log(
      `${profile.padEnd(28)} | ${stats.invocations.toString().padEnd(11)} | ` +
      `${formatDuration(stats.avgDisplayTime).padEnd(11)} | ${formatPercent(cacheHitRate).padEnd(11)} | ` +
      `${formatCost(stats.totalCost)}`
    );
  }

  console.log('');
}

function runCleanup(): void {
  console.log('🧹 Cleaning up old telemetry entries (>30 days)...\n');
  const deletedCount = TelemetryDatabase.cleanup();

  if (deletedCount > 0) {
    console.log(`✅ Removed ${deletedCount} old entries`);
  } else {
    console.log('✅ No old entries to remove');
  }

  console.log('');
}

// -------------------------------------------------------------------------
// CLI
// -------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
📊 Telemetry Dashboard - Statusline V2 Metrics

Usage:
  bun telemetry-dashboard.ts [command] [options]

Commands:
  session <sessionId>    Show statistics for specific session
  daily [YYYY-MM-DD]     Show daily statistics (default: today)
  summary                Show 7-day summary (default)
  profiles               Show auth profile breakdown
  cleanup                Remove entries older than 30 days
  help                   Show this help message

Examples:
  bun telemetry-dashboard.ts summary
  bun telemetry-dashboard.ts session abc123
  bun telemetry-dashboard.ts daily 2026-02-08
  bun telemetry-dashboard.ts profiles
  bun telemetry-dashboard.ts cleanup
  `);
}

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === 'summary') {
    showSummary();
    return;
  }

  const command = args[0];

  switch (command) {
    case 'session':
      if (args.length < 2) {
        console.error('❌ Missing session ID\n');
        showHelp();
        process.exit(1);
      }
      showSessionStats(args[1]);
      break;

    case 'daily':
      if (args.length >= 2) {
        const date = new Date(args[1]);
        if (isNaN(date.getTime())) {
          console.error('❌ Invalid date format. Use YYYY-MM-DD\n');
          process.exit(1);
        }
        showDailyStats(date);
      } else {
        showDailyStats();
      }
      break;

    case 'profiles':
      showProfiles();
      break;

    case 'cleanup':
      runCleanup();
      break;

    case 'help':
    case '--help':
    case '-h':
      showHelp();
      break;

    default:
      console.error(`❌ Unknown command: ${command}\n`);
      showHelp();
      process.exit(1);
  }
}

// Run CLI
main();
