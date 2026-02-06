/**
 * Secrets Source — Tier 2 (per-session)
 *
 * Scans transcript for leaked secrets using:
 *   1. GitLeaks (professional scanner, if installed)
 *   2. Regex fallback (built-in patterns)
 *
 * Updates health.alerts.secretsDetected and secretTypes.
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth } from '../../types/session-health';
import GitLeaksScanner from '../gitleaks-scanner';

const gitleaksScanner = new GitLeaksScanner();

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

    try {
      const result = await gitleaksScanner.scan(ctx.sessionId, ctx.transcriptPath);
      return {
        hasSecrets: result.hasSecrets,
        secretTypes: result.secretTypes,
        scanned: true,
      };
    } catch {
      // GitLeaks failed — scanned flag remains false
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
