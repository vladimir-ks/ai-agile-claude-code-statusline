/**
 * Transcript Source — Tier 2 (per-session)
 *
 * Checks transcript health via IncrementalTranscriptScanner.
 * Detects: exists, last modified, message count, last message preview.
 * Critical for data loss detection.
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth, TranscriptHealth } from '../../types/session-health';
import IncrementalTranscriptScanner from '../incremental-transcript-scanner';

const scanner = new IncrementalTranscriptScanner();

export const transcriptSource: DataSourceDescriptor<TranscriptHealth> = {
  id: 'transcript',
  tier: 2,
  freshnessCategory: 'transcript',
  timeoutMs: 3000,

  async fetch(ctx: GatherContext): Promise<TranscriptHealth> {
    if (!ctx.transcriptPath) {
      return {
        exists: false,
        sizeBytes: 0,
        lastModified: 0,
        lastModifiedAgo: '',
        messageCount: 0,
        lastMessageTime: 0,
        lastMessagePreview: '',
        lastMessageAgo: '',
        isSynced: false,
      };
    }

    return scanner.checkHealth(ctx.sessionId, ctx.transcriptPath);
  },

  merge(target: SessionHealth, data: TranscriptInfo): void {
    target.transcript = data;
  },
};

export default transcriptSource;
