/**
 * Last Message Module - Idle / Cache-Warmth Timer
 *
 * Shows elapsed time since the LAST transcript entry (any role) and a
 * cache-warmth indicator based on Anthropic's prompt-cache TTL.
 *
 * Display format:
 *   < 24h, warm  → 💬:HH:MM(Xm)🔥Xm   (idle < CACHE_TTL_SECONDS)
 *   < 24h, cold  → 💬:HH:MM(Xm)❄️Xm   (idle ≥ CACHE_TTL_SECONDS)
 *   >= 24h       → 💬:Mon DD HH:MM ❄️Xh (date replaces elapsed)
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';
import type { ValidationResult } from '../types/validation';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

// Anthropic prompt-cache eviction threshold (seconds).
// Override via CACHE_TTL_SECONDS env var for custom deployments.
export const CACHE_TTL_SECONDS = (() => {
  const env = parseInt(process.env.CACHE_TTL_SECONDS || '', 10);
  return isFinite(env) && env > 0 ? env : 300;
})();

interface LastMessageData {
  timestamp: Date | null;
  displayTime: string;
  elapsed: string;
  /** 'warm' = cache likely still hot; 'cold' = cache evicted */
  cacheWarmth: 'warm' | 'cold' | 'unknown';
  color: string;
}

class LastMessageModule implements DataModule<LastMessageData> {
  readonly moduleId = 'lastMessage';

  config: DataModuleConfig = {
    timeout: 2000,
    cacheTTL: 5000  // 5s cache (transcript doesn't change rapidly)
  };

  private transcriptPath: string = '';

  setTranscriptPath(path: string): void {
    this.transcriptPath = path;
  }

  async fetch(sessionId: string): Promise<LastMessageData> {
    try {
      if (!this.transcriptPath || !existsSync(this.transcriptPath)) {
        return this.getDefaultData();
      }

      // Read last 50 lines — scan for last entry of ANY role
      const content = await readFile(this.transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');
      const last50 = lines.slice(-50);

      // Find last timestamped entry of any role (user, assistant, tool_result, …)
      let lastEntry: any = null;
      for (let i = last50.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(last50[i]);
          if (parsed.timestamp) {
            lastEntry = parsed;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!lastEntry) {
        return this.getDefaultData();
      }

      // Parse timestamp
      const timestamp = lastEntry.timestamp ? new Date(lastEntry.timestamp) : null;
      if (!timestamp) {
        return this.getDefaultData();
      }

      const now = new Date();
      const elapsedMs = now.getTime() - timestamp.getTime();
      const elapsedSec = Math.floor(elapsedMs / 1000);

      // Format display time (HH:MM) — always show clock time
      const displayTime = `${String(timestamp.getHours()).padStart(2, '0')}:${String(timestamp.getMinutes()).padStart(2, '0')}`;

      // Format elapsed time per spec:
      //   < 60s   → "<1m"
      //   1–59m   → "Xm"
      //   1–23h   → "XhYm"
      //   >= 24h  → calendar date replaces elapsed (elapsed = '')
      let elapsed = '';
      if (elapsedSec < 86400) {
        if (elapsedSec < 60) {
          elapsed = '<1m';
        } else if (elapsedSec < 3600) {
          elapsed = `${Math.floor(elapsedSec / 60)}m`;
        } else {
          const hours = Math.floor(elapsedSec / 3600);
          const mins = Math.floor((elapsedSec % 3600) / 60);
          elapsed = `${hours}h${mins}m`;
        }
      }

      // Cache warmth: warm if idle < CACHE_TTL_SECONDS, cold otherwise
      const cacheWarmth: 'warm' | 'cold' = elapsedSec < CACHE_TTL_SECONDS ? 'warm' : 'cold';

      // Color based on recency
      let color = '245';  // gray (default: old)
      if (elapsedSec < 300) {  // <5 min
        color = '46';  // green (fresh)
      } else if (elapsedSec < 1800) {  // <30 min
        color = '226';  // yellow (recent)
      }

      return {
        timestamp,
        displayTime,
        elapsed,
        cacheWarmth,
        color
      };
    } catch (error) {
      return this.getDefaultData();
    }
  }

  private getDefaultData(): LastMessageData {
    return {
      timestamp: null,
      displayTime: '',
      elapsed: '',
      cacheWarmth: 'unknown',
      color: '245'
    };
  }

  validate(data: LastMessageData): ValidationResult {
    // Last message is optional, always valid
    return {
      valid: true,
      confidence: 100,
      warnings: []
    };
  }

  format(data: LastMessageData): string {
    if (!data || !data.displayTime || !data.timestamp) {
      return '';  // Don't show if no timestamp available
    }

    const warmthGlyph = data.cacheWarmth === 'warm' ? '🔥' : data.cacheWarmth === 'cold' ? '❄️' : '';

    // >= 24h: render "Mon DD HH:MM ❄️Xh" (date replaces elapsed)
    if (data.timestamp && data.elapsed === '') {
      const dateStr = data.timestamp.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      return `💬:${dateStr} ${data.displayTime} ${warmthGlyph}`.trimEnd();
    }

    return `💬:${data.displayTime}(${data.elapsed})${warmthGlyph}`;
  }
}

export default LastMessageModule;
export { LastMessageData };
