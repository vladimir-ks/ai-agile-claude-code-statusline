/**
 * Auth Change Detector - Detect authentication profile switches
 *
 * Detects when user switches authentication accounts via:
 * - /login → "Login successful for <email>"
 * - /swap-auth <email> → "Switched to account <email>"
 *
 * Strategy:
 * 1. Track /login and /swap-auth commands
 * 2. Scan next few lines for success confirmation
 * 3. Extract email/account from confirmation message
 *
 * Performance: O(n) single pass with lookback
 */

import type { ParsedLine, AuthChange } from '../types';
import type { DataExtractor } from '../types';

/**
 * Success message patterns
 * Must appear within 10 lines of command
 * Matches email addresses and domain names
 */
const SUCCESS_PATTERNS = [
  /Login successful for\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+|[a-zA-Z0-9.-]+\.[a-z]{2,})/i,
  /Successfully logged in as\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+|[a-zA-Z0-9.-]+\.[a-z]{2,})/i,
  /Switched to account\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+|[a-zA-Z0-9.-]+\.[a-z]{2,})/i,
  /Now using account\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+|[a-zA-Z0-9.-]+\.[a-z]{2,})/i,
  /Authentication successful.*?([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+)/i
];

/**
 * Command patterns that trigger auth check
 */
const AUTH_COMMANDS = ['/login', '/swap-auth'];

/**
 * Maximum lines to look ahead for success confirmation
 */
const LOOKAHEAD_WINDOW = 10;

export class AuthChangeDetector implements DataExtractor<AuthChange[]> {
  readonly id = 'auth_changes';
  readonly shouldCache = true;
  readonly cacheTTL = 300_000; // 5 minutes

  /**
   * Extract authentication changes from transcript
   *
   * @param lines - Parsed transcript lines
   * @returns Array of auth change events
   *
   * Algorithm:
   * 1. Find /login or /swap-auth commands
   * 2. Look ahead up to 10 lines for success message
   * 3. Extract email from success message
   * 4. Track timestamp and line number
   *
   * Performance: O(n × w) where w = lookahead window (10)
   */
  extract(lines: ParsedLine[]): AuthChange[] {
    const authChanges: AuthChange[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.data) continue;

      // Check if this line contains an auth command
      const text = this.extractText(line.data);
      if (!this.hasAuthCommand(text)) {
        continue;
      }

      // Look ahead for success confirmation
      const success = this.findSuccessMessage(lines, i);
      if (success) {
        authChanges.push(success);
      }
    }

    return authChanges;
  }

  /**
   * Extract text from data structure
   */
  private extractText(data: any): string {
    if (data.message?.content) {
      if (typeof data.message.content === 'string') {
        return data.message.content;
      }

      if (Array.isArray(data.message.content)) {
        for (const item of data.message.content) {
          if (item.type === 'text' && item.text) {
            return item.text;
          }
        }
      }
    }

    if (data.text) {
      return data.text;
    }

    return '';
  }

  /**
   * Check if text contains an auth command
   */
  private hasAuthCommand(text: string): boolean {
    const lower = text.toLowerCase();
    return AUTH_COMMANDS.some(cmd => lower.includes(cmd));
  }

  /**
   * Look ahead for success confirmation message
   *
   * @param lines - All lines
   * @param startIndex - Index of command line
   * @returns AuthChange if success found, null otherwise
   */
  private findSuccessMessage(lines: ParsedLine[], startIndex: number): AuthChange | null {
    const endIndex = Math.min(startIndex + LOOKAHEAD_WINDOW, lines.length);

    for (let i = startIndex + 1; i < endIndex; i++) {
      const line = lines[i];
      if (!line.data) continue;

      const text = this.extractText(line.data);
      if (!text) continue;

      // Try all success patterns
      for (const pattern of SUCCESS_PATTERNS) {
        const match = pattern.exec(text);
        if (match) {
          const email = match[1];

          // Extract timestamp
          const timestamp = line.data.timestamp
            ? new Date(line.data.timestamp).getTime()
            : 0;

          return {
            loginTimestamp: timestamp,
            email,
            line: line.lineNumber
          };
        }
      }
    }

    return null;
  }
}

export default AuthChangeDetector;
