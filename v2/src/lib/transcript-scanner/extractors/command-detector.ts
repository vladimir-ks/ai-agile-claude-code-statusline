/**
 * Command Detector - Detect slash commands in transcript
 *
 * Detects user-invoked slash commands:
 * - /login
 * - /swap-auth [email]
 * - /clear
 * - /commit
 * - etc.
 *
 * Performance: O(n) single-pass with regex matching
 */

import type { ParsedLine, Command } from '../types';
import type { DataExtractor } from '../types';

/**
 * Known slash commands (all that Claude Code supports)
 */
const KNOWN_COMMANDS = new Set([
  'login', 'logout', 'swap-auth', 'clear', 'commit', 'help',
  'status', 'config', 'compact', 'review', 'init', 'continue',
  'permissions', 'doctor', 'memory', 'cost', 'bug', 'model',
  'terminal-setup', 'vim', 'ide', 'listen', 'mcp', 'add-dir',
]);

/**
 * Command pattern: /command-name [args...]
 * Requires word boundary before slash (start of text, space, or newline)
 * Captures command name — arguments are extracted separately via next-command boundary
 */
const COMMAND_REGEX = /(?:^|(?<=\s))\/([a-z][a-z0-9-]*)/gi;

export class CommandDetector implements DataExtractor<Command[]> {
  readonly id = 'commands';
  readonly shouldCache = true;
  readonly cacheTTL = 300_000; // 5 minutes

  /**
   * Extract slash commands from transcript lines
   *
   * @param lines - Parsed transcript lines
   * @returns Array of detected commands
   *
   * Strategy:
   * 1. Scan user messages (type: 'user')
   * 2. Extract text from message.content or data.text
   * 3. Apply command regex pattern
   * 4. Parse arguments (space-separated)
   * 5. Track line numbers and timestamps
   *
   * Performance: O(n) where n = number of lines
   */
  extract(lines: ParsedLine[]): Command[] {
    const commands: Command[] = [];

    for (const line of lines) {
      if (!line.data) continue;

      // Only scan user messages and text fields
      if (line.data.type !== 'user' && !line.data.text) {
        continue;
      }

      // Extract text from various formats
      const text = this.extractText(line.data);
      if (!text) continue;

      // Find all command positions first, then extract args between them
      COMMAND_REGEX.lastIndex = 0;
      const matches: Array<{ name: string; index: number }> = [];
      let match;

      while ((match = COMMAND_REGEX.exec(text)) !== null) {
        const commandName = match[1];
        if (!KNOWN_COMMANDS.has(commandName)) continue;

        // Exclude URL context: /command preceded by :// or URL path
        const before = text.substring(Math.max(0, match.index - 10), match.index + 1);
        if (before.includes('://') || /\.[a-z]{2,}\//.test(before)) continue;

        // Exclude word-attached: must be at start or preceded by whitespace
        if (match.index > 0 && !/\s/.test(text[match.index - 1])) continue;

        matches.push({ name: commandName, index: match.index });
      }

      // Extract args: text between this command end and next command start (or end of text)
      for (let m = 0; m < matches.length; m++) {
        const cmdMatch = matches[m];
        const cmdEnd = cmdMatch.index + cmdMatch.name.length + 1; // +1 for leading /
        const nextStart = m + 1 < matches.length ? matches[m + 1].index : text.length;
        const rawArgs = text.substring(cmdEnd, nextStart).trim();
        // Truncate at sentence conjunctions (stop words) — args don't span past "to", "and", etc.
        const argsString = rawArgs.replace(/\s+(to|and|then|but|or)\s+.*$/i, '').trim();

        const args = this.parseArgs(argsString);
        const timestamp = line.data.timestamp
          ? new Date(line.data.timestamp).getTime()
          : Date.now();

        commands.push({
          command: `/${cmdMatch.name}`,
          timestamp,
          args,
          line: line.lineNumber
        });
      }
    }

    return commands;
  }

  /**
   * Extract text from data structure
   * Handles multiple formats (message.content array, direct text field)
   *
   * @param data - Line data
   * @returns Extracted text or empty string
   */
  private extractText(data: any): string {
    // Format 1: message.content array (real transcript)
    if (data.message?.content) {
      if (typeof data.message.content === 'string') {
        return data.message.content;
      }

      if (Array.isArray(data.message.content)) {
        // Extract text from first text block
        for (const item of data.message.content) {
          if (item.type === 'text' && item.text) {
            return item.text;
          }
        }
      }
    }

    // Format 2: Direct text field (simplified format)
    if (data.text) {
      return data.text;
    }

    return '';
  }

  /**
   * Parse command arguments
   * Handles quoted strings and space-separated tokens
   *
   * @param argsString - Raw argument string
   * @returns Array of argument strings
   *
   * Examples:
   * - "" → []
   * - "foo bar" → ["foo", "bar"]
   * - "foo 'bar baz'" → ["foo", "bar baz"]
   */
  private parseArgs(argsString: string): string[] {
    if (!argsString) return [];

    const args: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < argsString.length; i++) {
      const char = argsString[i];

      if ((char === '"' || char === "'") && !inQuote) {
        // Start quote
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuote) {
        // End quote
        inQuote = false;
        quoteChar = '';
      } else if (char === ' ' && !inQuote) {
        // Argument separator
        if (current) {
          args.push(current);
          current = '';
        }
      } else {
        // Regular character
        current += char;
      }
    }

    // Add last argument
    if (current) {
      args.push(current);
    }

    return args;
  }
}

export default CommandDetector;
