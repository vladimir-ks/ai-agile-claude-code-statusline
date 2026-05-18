/**
 * Model Source — Tier 1 (instant, from stdin + transcript + settings)
 *
 * Multi-source model resolution with priority:
 *   1. Fresh transcript (<5 min) overrides stdin when they disagree
 *      — transcript reflects what the API ran; stdin is launch-frozen
 *   2. JSON input (stdin, all other cases)
 *   3. Settings.json (global default)
 *   4. "Claude" (fallback)
 *
 * Wraps ModelResolver for descriptor-compatible API.
 * Settings model is read inline (fast, file read only).
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { ModelInfo, SessionHealth } from '../../types/session-health';
import ModelResolver from '../model-resolver';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';

// Shared instance (stateless per resolution, safe to reuse)
const resolver = new ModelResolver();

export const modelSource: DataSourceDescriptor<ModelInfo> = {
  id: 'model',
  tier: 1,
  freshnessCategory: 'model',
  timeoutMs: 500, // File reads only, but transcript can be large

  async fetch(ctx: GatherContext): Promise<ModelInfo> {
    const settingsModel = getSettingsModel();
    return resolver.resolve(ctx.transcriptPath, ctx.jsonInput, settingsModel);
  },

  merge(target: SessionHealth, data: ModelInfo): void {
    target.model = data;
    target.model.updatedAt = Date.now();
  },
};

/**
 * Read model from ~/.claude/settings.json
 */
function getSettingsModel(): string | null {
  const settingsPath = `${homedir()}/.claude/settings.json`;
  try {
    if (existsSync(settingsPath)) {
      const content = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      return content.model || null;
    }
  } catch {
    // Ignore
  }
  return null;
}

// Export for testing
export { getSettingsModel };

export default modelSource;
