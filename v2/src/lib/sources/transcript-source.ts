/**
 * Transcript Source — Tier 2 (per-session)
 *
 * Checks transcript health via UnifiedTranscriptScanner.
 * Detects: exists, last modified, message count, last message preview.
 * Critical for data loss detection.
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { SessionHealth, TranscriptHealth } from '../../types/session-health';
import { UnifiedTranscriptScanner } from '../transcript-scanner/unified-transcript-scanner';
import { existsSync, statSync } from 'fs';

const scanner = new UnifiedTranscriptScanner();

/**
 * Convert UnifiedTranscriptScanner.scan() result to TranscriptHealth format
 *
 * Note: The new scanner's TranscriptHealth (types.ts) is different from
 * the old TranscriptHealth (session-health.ts). We need to:
 * 1. Read file stats directly for: exists, sizeBytes, lastModified, isSynced
 * 2. Map ScanResult.lastMessage → lastMessageTime, lastMessagePreview, lastMessageAgo
 * 3. Map ScanResult.health.messageCount → messageCount
 */
function convertScanResultToTranscriptHealth(
  scanResult: any,
  transcriptPath: string
): TranscriptHealth {
  const lastMessage = scanResult.lastMessage;

  // Read file stats directly
  let stats: any;
  try {
    stats = statSync(transcriptPath);
  } catch {
    // File doesn't exist or can't be read
    return {
      exists: false,
      sizeBytes: 0,
      lastModified: 0,
      lastModifiedAgo: 'unknown',
      messageCount: 0,
      lastMessageTime: 0,
      lastMessagePreview: '',
      lastMessageAgo: '',
      isSynced: false,
    };
  }

  // Calculate lastMessageAgo
  const lastMessageAgo = lastMessage.timestamp > 0
    ? formatAgo(lastMessage.timestamp)
    : '';

  // Calculate lastModifiedAgo
  const lastModifiedAgo = stats.mtimeMs > 0
    ? formatAgo(stats.mtimeMs)
    : 'unknown';

  // Check if synced (mtime < 60s)
  const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
  const isSynced = ageSeconds < 60;

  return {
    exists: true,
    sizeBytes: stats.size,
    lastModified: stats.mtimeMs,
    lastModifiedAgo,
    messageCount: lastMessage.turnNumber,
    lastMessageTime: lastMessage.timestamp,
    lastMessagePreview: lastMessage.preview,
    lastMessageAgo,
    isSynced,
  };
}

/**
 * Format timestamp as human-readable "Xm", "Xh", "Xd"
 */
function formatAgo(timestamp: number): string {
  if (!timestamp || timestamp === 0) {
    return 'unknown';
  }

  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 0) {
    return '<1m';
  } else if (seconds < 60) {
    return '<1m';
  } else if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  } else if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h`;
  } else {
    return `${Math.floor(seconds / 86400)}d`;
  }
}

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

    // Check if file exists before scanning
    if (!existsSync(ctx.transcriptPath)) {
      return {
        exists: false,
        sizeBytes: 0,
        lastModified: 0,
        lastModifiedAgo: 'unknown',
        messageCount: 0,
        lastMessageTime: 0,
        lastMessagePreview: '',
        lastMessageAgo: '',
        isSynced: false,
      };
    }

    // Scan using new UnifiedTranscriptScanner
    const scanResult = scanner.scan(ctx.sessionId, ctx.transcriptPath);

    // Convert to old TranscriptHealth format
    return convertScanResultToTranscriptHealth(scanResult, ctx.transcriptPath);
  },

  merge(target: SessionHealth, data: TranscriptHealth): void {
    target.transcript = data;
  },
};

export default transcriptSource;
