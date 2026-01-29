/**
 * Last Message Module - Display Last User Message
 *
 * Displays: 💬:14:30(2h43m) What is...
 */

import type { DataModule, DataModuleConfig, ValidationResult } from '../types/data-module';
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';

interface LastMessageData {
  text: string;
  timestamp: Date | null;
  displayTime: string;
  elapsed: string;
  color: string;  // Based on recency
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

      // Read last 50 lines (optimization from V1)
      const content = await readFile(this.transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');
      const last50 = lines.slice(-50);

      // Find last user message (role: "user")
      let lastUserMsg: any = null;
      for (let i = last50.length - 1; i >= 0; i--) {
        try {
          const parsed = JSON.parse(last50[i]);
          if (parsed.type === 'user' || parsed.role === 'user') {
            lastUserMsg = parsed;
            break;
          }
        } catch {
          continue;
        }
      }

      if (!lastUserMsg) {
        return this.getDefaultData();
      }

      // Extract text
      let text = '';
      if (lastUserMsg.message?.content) {
        if (Array.isArray(lastUserMsg.message.content)) {
          const textContent = lastUserMsg.message.content.find((c: any) => c.type === 'text');
          text = textContent?.text || '';
        } else {
          text = lastUserMsg.message.content;
        }
      }

      // Strip HTML-like tags
      text = text.replace(/<[^>]*>/g, '').trim();

      // Truncate to 60 chars
      if (text.length > 60) {
        text = text.substring(0, 60) + '...';
      }

      // Parse timestamp
      const timestamp = lastUserMsg.timestamp ? new Date(lastUserMsg.timestamp) : null;

      if (!timestamp) {
        return this.getDefaultData();
      }

      const now = new Date();
      const elapsedMs = now.getTime() - timestamp.getTime();
      const elapsedSec = Math.floor(elapsedMs / 1000);

      // Format elapsed time
      let elapsed = '';
      if (elapsedSec < 60) {
        elapsed = `${elapsedSec}s`;
      } else if (elapsedSec < 3600) {
        elapsed = `${Math.floor(elapsedSec / 60)}m`;
      } else if (elapsedSec < 86400) {
        const hours = Math.floor(elapsedSec / 3600);
        const mins = Math.floor((elapsedSec % 3600) / 60);
        elapsed = `${hours}h${mins}m`;
      } else {
        elapsed = `${Math.floor(elapsedSec / 86400)}d`;
      }

      // Format display time (HH:MM)
      const displayTime = `${String(timestamp.getHours()).padStart(2, '0')}:${String(timestamp.getMinutes()).padStart(2, '0')}`;

      // Color based on recency
      let color = '245';  // gray (default: old)
      if (elapsedSec < 300) {  // <5 min
        color = '46';  // green (fresh)
      } else if (elapsedSec < 1800) {  // <30 min
        color = '226';  // yellow (recent)
      }

      return {
        text,
        timestamp,
        displayTime,
        elapsed,
        color
      };
    } catch (error) {
      return this.getDefaultData();
    }
  }

  private getDefaultData(): LastMessageData {
    return {
      text: '',
      timestamp: null,
      displayTime: '',
      elapsed: '',
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
    if (!data || !data.text || !data.displayTime) {
      return '';  // Don't show if no message
    }

    return `💬:${data.displayTime}(${data.elapsed}) ${data.text}`;
  }
}

export default LastMessageModule;
export { LastMessageData };
