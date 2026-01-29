/**
 * Time Module - Current Time & Session Duration (Production)
 * Data Source: System clock
 * Session-Specific: NO (shared)
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';

interface TimeData {
  currentTime: Date;
  sessionStart: Date;
  sessionDuration: number;  // milliseconds
  timeToReset: number;      // milliseconds until UTC midnight
}

class TimeModule implements DataModule<TimeData> {
  readonly moduleId = 'time';
  config: DataModuleConfig = { timeout: 10, cacheTTL: 1000 };  // 1s cache
  private sessionStart: Date = new Date();

  async fetch(sessionId: string): Promise<TimeData> {
    const now = new Date();
    const sessionDuration = now.getTime() - this.sessionStart.getTime();

    // Calculate time to UTC midnight
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(24, 0, 0, 0);
    const timeToReset = tomorrow.getTime() - now.getTime();

    return {
      currentTime: now,
      sessionStart: this.sessionStart,
      sessionDuration,
      timeToReset
    };
  }

  validate(data: TimeData) {
    return {
      valid: true,
      errors: [],
      warnings: [],
      sanitized: data
    };
  }

  format(data: TimeData): string {
    const hours = String(data.currentTime.getHours()).padStart(2, '0');
    const mins = String(data.currentTime.getMinutes()).padStart(2, '0');

    // V1 parity: Only show time, no session duration
    return `🕐:${hours}:${mins}`;
  }
}

export default TimeModule;
export { TimeData };
