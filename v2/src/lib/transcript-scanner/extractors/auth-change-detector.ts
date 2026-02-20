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
const EMAIL_OR_DOMAIN = '([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+|[a-zA-Z0-9.-]+\\.[a-z]{2,})';
const SUCCESS_PATTERNS = [
  new RegExp(`Login successful for\\s+${EMAIL_OR_DOMAIN}`, 'i'),
  new RegExp(`Successfully logged in as\\s+${EMAIL_OR_DOMAIN}`, 'i'),
  new RegExp(`Logged in as\\s+${EMAIL_OR_DOMAIN}`, 'i'),
  new RegExp(`Switched to account\\s+${EMAIL_OR_DOMAIN}`, 'i'),
  new RegExp(`Switched to\\s+${EMAIL_OR_DOMAIN}`, 'i'),
  new RegExp(`Authentication switched to\\s+${EMAIL_OR_DOMAIN}`, 'i'),
  new RegExp(`Now using account\\s+${EMAIL_OR_DOMAIN}`, 'i'),
  new RegExp(`Authentication:\\s+${EMAIL_OR_DOMAIN}`, 'i'),
  new RegExp(`Authentication successful.*?${EMAIL_OR_DOMAIN}`, 'i'),
];

/**
 * Success patterns without email capture — used when email fallback is needed
 * (email extracted from command instead)
 */
const SUCCESS_NO_EMAIL_PATTERNS = [
  /Authentication switched successfully/i,
  /Successfully switched/i,
  /Login successful$/i,
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
   * Extract email from auth command text (e.g., "/swap-auth user@example.com")
   */
  private extractEmailFromCommand(text: string): string | null {
    const match = text.match(/\/swap-auth\s+([a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+|[a-zA-Z0-9.-]+\.[a-z]{2,})/i);
    return match ? match[1] : null;
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
    const commandLine = lines[startIndex];
    const commandLineNumber = commandLine.lineNumber || 0;
    const commandText = this.extractText(commandLine.data);
    const commandEmail = this.extractEmailFromCommand(commandText);

    for (let i = startIndex + 1; i < endIndex; i++) {
      const line = lines[i];
      if (!line.data) continue;

      // Skip if line number distance exceeds window (transcript may have gaps)
      if (commandLineNumber > 0 && line.lineNumber > 0 &&
          (line.lineNumber - commandLineNumber) > LOOKAHEAD_WINDOW) {
        break;
      }

      const text = this.extractText(line.data);
      if (!text) continue;

      // Try all success patterns (with email in message)
      for (const pattern of SUCCESS_PATTERNS) {
        const match = pattern.exec(text);
        if (match) {
          const email = match[1];
          const timestamp = line.data.timestamp
            ? new Date(line.data.timestamp).getTime()
            : Date.now();

          return {
            loginTimestamp: timestamp,
            email,
            line: line.lineNumber
          };
        }
      }

      // Try success patterns without email — fall back to command email
      if (commandEmail) {
        for (const pattern of SUCCESS_NO_EMAIL_PATTERNS) {
          if (pattern.test(text)) {
            const timestamp = line.data.timestamp
              ? new Date(line.data.timestamp).getTime()
              : Date.now();

            return {
              loginTimestamp: timestamp,
              email: commandEmail,
              line: line.lineNumber
            };
          }
        }
      }
    }

    return null;
  }
}

export default AuthChangeDetector;
