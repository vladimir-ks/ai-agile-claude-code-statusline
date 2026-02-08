/**
 * Secrets Source — Tier 2 (per-session)
 *
 * Scans transcript for leaked secrets using UnifiedTranscriptScanner's
 * SecretDetector. Detects GitHub tokens, AWS keys, Stripe keys, private
 * keys, and other sensitive credentials.
 *
 * Updates health.alerts.secretsDetected and secretTypes.
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth } from '../../types/session-health';
import { UnifiedTranscriptScanner } from '../transcript-scanner/unified-transcript-scanner';
import { existsSync } from 'fs';

const scanner = new UnifiedTranscriptScanner();

export interface SecretsSourceData {
  hasSecrets: boolean;
  secretTypes: string[];
  scanned: boolean;
}

export const secretsSource: DataSourceDescriptor<SecretsSourceData> = {
  id: 'secrets_scan',
  tier: 2,
  freshnessCategory: 'secrets_scan',
  timeoutMs: 5000,

  async fetch(ctx: GatherContext): Promise<SecretsSourceData> {
    if (!ctx.transcriptPath) {
      return { hasSecrets: false, secretTypes: [], scanned: false };
    }

    // Check if file exists
    if (!existsSync(ctx.transcriptPath)) {
      return { hasSecrets: false, secretTypes: [], scanned: false };
    }

    try {
      // Scan using UnifiedTranscriptScanner
      const scanResult = scanner.scan(ctx.sessionId, ctx.transcriptPath);

      // Extract unique secret types
      const secretTypes = Array.from(
        new Set(scanResult.secrets.map((s) => s.type))
      );

      return {
        hasSecrets: scanResult.secrets.length > 0,
        secretTypes,
        scanned: true,
      };
    } catch (error) {
      // Scanner failed — scanned flag remains false
      console.error('[SecretsSource] Scan failed:', error);
      return { hasSecrets: false, secretTypes: [], scanned: false };
    }
  },

  merge(target: SessionHealth, data: SecretsSourceData): void {
    if (data.scanned) {
      target.alerts.secretsDetected = data.hasSecrets;
      target.alerts.secretTypes = data.secretTypes;
    }
  },
};

export default secretsSource;
