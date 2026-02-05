/**
 * Health Publisher - Publishes session health for cloud_configs consumption
 *
 * Writes: ~/.claude/session-health/publish-health.json
 *
 * This file is the OUTBOUND handshake:
 * - Statusline writes it after each gather
 * - cloud_configs/hot-swap reads it to make swap decisions
 *
 * Contains: per-session summary with urgency scores.
 * Designed for cross-process, cross-system consumption.
 */

import { existsSync, mkdirSync, writeFileSync, readFileSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { SessionHealth } from '../types/session-health';
import { UrgencyCalculator, UrgencyResult } from './urgency-calculator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PublishedSession {
  slotId?: string;
  email: string;
  billingPercentUsed: number;
  weeklyPercentUsed: number;
  burnRatePerHour: number;
  transcriptSynced: boolean;
  lastActivity: number;
  urgency: UrgencyResult;
  model: string;
  contextPercentUsed: number;
  healthStatus: string;
}

export interface PublishHealthPayload {
  publishedAt: number;
  version: 1;
  sessions: Record<string, PublishedSession>;
}

// ---------------------------------------------------------------------------
// HealthPublisher
// ---------------------------------------------------------------------------

export class HealthPublisher {

  private static readonly PUBLISH_PATH = join(homedir(), '.claude', 'session-health', 'publish-health.json');

  /**
   * Publish session health data for cloud_configs.
   * Merges with existing published sessions (multi-session support).
   * Prunes sessions with no activity in 1 hour.
   */
  static publish(sessionId: string, health: SessionHealth, basePath?: string): void {
    try {
      const existing = this.read(basePath);
      const payload: PublishHealthPayload = existing || {
        publishedAt: Date.now(),
        version: 1,
        sessions: {},
      };

      // Build session entry
      payload.sessions[sessionId] = this.buildSessionEntry(health);
      payload.publishedAt = Date.now();

      // Prune stale sessions (no activity in 1 hour)
      const oneHourAgo = Date.now() - 3_600_000;
      for (const [id, session] of Object.entries(payload.sessions)) {
        if (session.lastActivity < oneHourAgo && id !== sessionId) {
          delete payload.sessions[id];
        }
      }

      this.atomicWrite(payload, basePath);
    } catch {
      // Publishing is non-critical — never fail the gather
    }
  }

  /**
   * Read current published health data.
   */
  static read(basePath?: string): PublishHealthPayload | null {
    const path = basePath
      ? join(basePath, 'publish-health.json')
      : this.PUBLISH_PATH;

    try {
      if (!existsSync(path)) return null;
      const content = readFileSync(path, 'utf-8');
      return JSON.parse(content) as PublishHealthPayload;
    } catch {
      return null;
    }
  }

  /**
   * Build a published session entry from health data.
   */
  static buildSessionEntry(health: SessionHealth): PublishedSession {
    const urgency = UrgencyCalculator.calculate({
      weeklyPercentUsed: health.billing.weeklyBudgetPercentUsed || 0,
      dailyPercentUsed: health.billing.budgetPercentUsed || 0,
      burnRatePerHour: health.billing.burnRatePerHour || 0,
      budgetRemaining: health.billing.budgetRemaining || 0,
    });

    return {
      slotId: undefined, // Set by caller if known
      email: health.launch.authProfile,
      billingPercentUsed: health.billing.budgetPercentUsed,
      weeklyPercentUsed: health.billing.weeklyBudgetPercentUsed || 0,
      burnRatePerHour: health.billing.burnRatePerHour,
      transcriptSynced: health.transcript.isSynced,
      lastActivity: health.transcript.lastModified || health.gatheredAt,
      urgency,
      model: health.model.value,
      contextPercentUsed: health.context.percentUsed,
      healthStatus: health.health.status,
    };
  }

  /**
   * Atomic write to publish file.
   */
  private static atomicWrite(payload: PublishHealthPayload, basePath?: string): void {
    const path = basePath
      ? join(basePath, 'publish-health.json')
      : this.PUBLISH_PATH;

    const dir = join(path, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const tempPath = `${path}.tmp`;
    try {
      writeFileSync(tempPath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 });
      renameSync(tempPath, path);
    } catch {
      try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }

  /**
   * Write to a custom path (for testing).
   * Delegates to publish() with basePath override.
   */
  static publishToPath(sessionId: string, health: SessionHealth, basePath: string): void {
    this.publish(sessionId, health, basePath);
  }
}

export default HealthPublisher;
