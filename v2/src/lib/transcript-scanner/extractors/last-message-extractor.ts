/**
 * Last Message Extractor - Extract last user message from transcript
 *
 * Scans backward from end to find most recent user message.
 * Extracts preview (80 chars max), timestamp, sender, turn count.
 *
 * Performance: O(n) backward scan (stops at first user message)
 */

import type { ParsedLine, MessageInfo } from '../types';
import type { DataExtractor } from '../types';

export class LastMessageExtractor implements DataExtractor<MessageInfo> {
  readonly id = 'last_message';
  readonly shouldCache = true;
  readonly cacheTTL = 300_000; // 5 minutes

  /**
   * Extract last user message from lines
   *
   * @param lines - Parsed transcript lines
   * @returns MessageInfo with last user message details
   *
   * Strategy:
   * 1. Count total user/assistant messages (turnNumber)
   * 2. Scan backward to find last user message
   * 3. Extract text from message.content array
   * 4. Truncate to 80 chars for preview
   *
   * Edge cases:
   * - No user messages → return default (empty preview, timestamp=0)
   * - Only assistant messages → return default
   * - Empty lines → return default
   */
  extract(lines: ParsedLine[]): MessageInfo {
    // Default result
    const defaultInfo: MessageInfo = {
      timestamp: 0,
      preview: '',
      sender: 'unknown',
      turnNumber: 0
    };

    if (!lines || lines.length === 0) {
      return defaultInfo;
    }

    // Count total turns (user + assistant messages)
    let turnCount = 0;
    for (const line of lines) {
      if (line.data?.type === 'user' || line.data?.type === 'assistant') {
        turnCount++;
      }
    }

    // Scan backward for last user message
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];

      if (!line.data || line.data.type !== 'user') {
        continue;
      }

      // Found a user message - try to extract text
      let fullText = '';

      // Try message.content format (real transcript)
      if (line.data.message && line.data.message.content) {
        const message = line.data.message;

        if (typeof message.content === 'string') {
          // String format (simplified test format)
          fullText = message.content;
        } else if (Array.isArray(message.content)) {
          // Array format (real transcript format)
          // Extract the first non-empty text block
          for (const item of message.content) {
            if (item.type === 'text' && item.text && item.text.trim() !== '') {
              fullText = item.text;
              break; // Take first non-empty text block only
            }
          }
        }
      }
      // Fallback: try direct text field (mock format)
      else if (line.data.text) {
        fullText = line.data.text;
      }

      fullText = fullText.trim();

      // Skip if no text extracted (continue searching)
      if (fullText === '') {
        continue;
      }

      // Normalize whitespace (collapse multiple spaces, remove newlines/tabs)
      fullText = fullText.replace(/\s+/g, ' ').trim();

      // Extract timestamp
      const timestamp = line.data.timestamp
        ? new Date(line.data.timestamp).getTime()
        : 0;

      // Truncate preview to exactly 80 chars (78 content + ".." if truncated)
      let preview = fullText;
      if (fullText.length > 80) {
        preview = fullText.slice(0, 78) + '..';
      }

      return {
        timestamp,
        preview,
        sender: 'human',
        turnNumber: turnCount
      };
    }

    // No user message found
    return defaultInfo;
  }
}

export default LastMessageExtractor;
