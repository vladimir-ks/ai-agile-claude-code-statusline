/**
 * Test Harness for Transcript Scanner
 *
 * Provides mock data generators, fixtures, and utilities for testing
 * UnifiedTranscriptScanner and all extractors.
 *
 * Usage:
 *   import { mockTranscript, mockParsedLine, mockState } from './test-harness';
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { ParsedLine, ScannerState, MessageInfo, Secret, Command, AuthChange } from '../../src/lib/transcript-scanner/types';

// ============================================================================
// Mock Data Generators
// ============================================================================

/**
 * Generate mock JSONL transcript content
 */
export function mockTranscript(options: {
  lines?: number;
  userMessages?: number;
  assistantMessages?: number;
  secrets?: string[];
  commands?: string[];
}): string {
  const {
    lines = 100,
    userMessages = 10,
    assistantMessages = 10,
    secrets = [],
    commands = []
  } = options;

  const jsonlLines: string[] = [];
  let timestamp = Date.now() - (lines * 60000); // Start 'lines' minutes ago

  for (let i = 0; i < lines; i++) {
    timestamp += 60000; // 1 minute between messages

    // User message every 10 lines
    if (i % 10 === 0 && jsonlLines.length < userMessages * 2) {
      const messageText = commands.length > 0 && jsonlLines.length < commands.length
        ? commands[jsonlLines.length]
        : `User message ${i}: What does this code do?`;

      jsonlLines.push(JSON.stringify({
        type: 'user',
        timestamp: new Date(timestamp).toISOString(),
        message: {
          content: [
            { type: 'text', text: messageText }
          ]
        }
      }));
    }
    // Assistant message every 10 lines (offset)
    else if (i % 10 === 5 && jsonlLines.length < assistantMessages * 2) {
      const responseText = secrets.length > 0 && jsonlLines.length < secrets.length * 2
        ? `Here's your secret: ${secrets[Math.floor(jsonlLines.length / 2)]}`
        : `Assistant response ${i}: This code implements...`;

      jsonlLines.push(JSON.stringify({
        type: 'assistant',
        timestamp: new Date(timestamp).toISOString(),
        message: {
          content: [
            { type: 'text', text: responseText }
          ]
        }
      }));
    }
    // Filler lines (tool results, etc.)
    else {
      jsonlLines.push(JSON.stringify({
        type: 'tool_result',
        timestamp: new Date(timestamp).toISOString(),
        content: `Tool output ${i}`
      }));
    }
  }

  return jsonlLines.join('\n') + '\n';
}

/**
 * Generate mock ParsedLine
 */
export function mockParsedLine(overrides?: Partial<ParsedLine>): ParsedLine {
  return {
    lineNumber: 1,
    rawLine: '{"type":"user","text":"hello"}',
    data: { type: 'user', text: 'hello' },
    parseError: null,
    ...overrides
  };
}

/**
 * Generate array of mock ParsedLines
 */
export function mockParsedLines(count: number, options?: {
  userMessages?: number;
  parseErrors?: number;
}): ParsedLine[] {
  const lines: ParsedLine[] = [];
  const { userMessages = Math.floor(count / 2), parseErrors = 0 } = options || {};

  for (let i = 0; i < count; i++) {
    // Parse error line
    if (i < parseErrors) {
      lines.push({
        lineNumber: i + 1,
        rawLine: '{"invalid json',
        data: null,
        parseError: 'Unexpected token'
      });
    }
    // User message line
    else if (i < userMessages) {
      lines.push({
        lineNumber: i + 1,
        rawLine: JSON.stringify({ type: 'user', text: `Message ${i}` }),
        data: {
          type: 'user',
          text: `Message ${i}`,
          timestamp: new Date(Date.now() - (count - i) * 60000).toISOString()
        },
        parseError: null
      });
    }
    // Other lines
    else {
      lines.push({
        lineNumber: i + 1,
        rawLine: JSON.stringify({ type: 'tool_result', content: `Output ${i}` }),
        data: { type: 'tool_result', content: `Output ${i}` },
        parseError: null
      });
    }
  }

  return lines;
}

/**
 * Generate mock ScannerState
 */
export function mockState(overrides?: Partial<ScannerState>): ScannerState {
  return {
    version: 2,
    lastOffset: 0,
    lastMtime: 0,
    lastScanAt: Date.now(),
    extractorData: {},
    ...overrides
  };
}

/**
 * Generate mock MessageInfo
 */
export function mockMessageInfo(overrides?: Partial<MessageInfo>): MessageInfo {
  return {
    timestamp: Date.now(),
    preview: 'What does this code do?',
    sender: 'human',
    turnNumber: 1,
    ...overrides
  };
}

/**
 * Generate mock Secret
 */
export function mockSecret(overrides?: Partial<Secret>): Secret {
  return {
    type: 'GitHub Token',
    fingerprint: 'github-pat-abc123',
    line: 10,
    match: 'ghp_...xyz',
    ...overrides
  };
}

/**
 * Generate mock Command
 */
export function mockCommand(overrides?: Partial<Command>): Command {
  return {
    command: '/login',
    timestamp: Date.now(),
    args: [],
    line: 5,
    ...overrides
  };
}

/**
 * Generate mock AuthChange
 */
export function mockAuthChange(overrides?: Partial<AuthChange>): AuthChange {
  return {
    loginTimestamp: Date.now(),
    email: 'vladks.com',
    line: 6,
    ...overrides
  };
}

// ============================================================================
// Fixtures (Predefined Test Data)
// ============================================================================

/**
 * Small transcript (100 lines, ~10KB)
 */
export const FIXTURE_SMALL_TRANSCRIPT = mockTranscript({
  lines: 100,
  userMessages: 10,
  assistantMessages: 10
});

/**
 * Large transcript (10000 lines, ~1MB)
 */
export const FIXTURE_LARGE_TRANSCRIPT = mockTranscript({
  lines: 10000,
  userMessages: 500,
  assistantMessages: 500
});

/**
 * Transcript with secrets
 */
export const FIXTURE_TRANSCRIPT_WITH_SECRETS = mockTranscript({
  lines: 50,
  secrets: [
    'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
    'AKIAIOSFODNN7EXAMPLE',
    '-----BEGIN RSA PRIVATE KEY-----'
  ]
});

/**
 * Transcript with commands
 */
export const FIXTURE_TRANSCRIPT_WITH_COMMANDS = mockTranscript({
  lines: 50,
  commands: [
    '/login',
    '/swap-auth rimidalvk@gmail.com',
    '/clear'
  ]
});

/**
 * Malformed transcript (invalid JSON)
 */
export const FIXTURE_MALFORMED_TRANSCRIPT = `
{"type":"user","text":"valid line"}
{"invalid json
{"type":"assistant","text":"another valid line"}
`.trim();

/**
 * Empty transcript
 */
export const FIXTURE_EMPTY_TRANSCRIPT = '';

// ============================================================================
// File System Utilities
// ============================================================================

/**
 * Create temporary transcript file
 */
export function createTempTranscript(content: string): string {
  const tempDir = join(tmpdir(), 'transcript-scanner-tests');
  mkdirSync(tempDir, { recursive: true });

  const filename = `transcript-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`;
  const filepath = join(tempDir, filename);

  writeFileSync(filepath, content, 'utf-8');

  return filepath;
}

/**
 * Create temporary state directory
 */
export function createTempStateDir(): string {
  const tempDir = join(tmpdir(), `scanner-state-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Assert ParsedLine is valid
 */
export function assertValidParsedLine(line: ParsedLine): void {
  if (line.lineNumber <= 0) {
    throw new Error(`Invalid lineNumber: ${line.lineNumber}`);
  }
  if (!line.rawLine) {
    throw new Error('rawLine is empty');
  }
  if (line.data === null && line.parseError === null) {
    throw new Error('Both data and parseError are null (invalid state)');
  }
}

/**
 * Assert ScannerState is valid
 */
export function assertValidState(state: ScannerState): void {
  if (state.version !== 2) {
    throw new Error(`Invalid version: ${state.version}`);
  }
  if (state.lastOffset < 0) {
    throw new Error(`Invalid lastOffset: ${state.lastOffset}`);
  }
  if (state.lastMtime < 0) {
    throw new Error(`Invalid lastMtime: ${state.lastMtime}`);
  }
  if (!state.extractorData || typeof state.extractorData !== 'object') {
    throw new Error('extractorData must be an object');
  }
}

/**
 * Assert MessageInfo is valid
 */
export function assertValidMessageInfo(msg: MessageInfo): void {
  if (msg.timestamp < 0) {
    throw new Error(`Invalid timestamp: ${msg.timestamp}`);
  }
  if (!['human', 'assistant', 'unknown'].includes(msg.sender)) {
    throw new Error(`Invalid sender: ${msg.sender}`);
  }
  if (msg.turnNumber < 0) {
    throw new Error(`Invalid turnNumber: ${msg.turnNumber}`);
  }
  if (msg.preview.length > 80) {
    throw new Error(`Preview too long: ${msg.preview.length} chars`);
  }
}

// ============================================================================
// Performance Utilities
// ============================================================================

/**
 * Measure execution time
 */
export async function measureTime<T>(fn: () => T | Promise<T>): Promise<{ result: T; duration: number }> {
  const start = performance.now();
  const result = await fn();
  const duration = performance.now() - start;
  return { result, duration };
}

/**
 * Assert execution time is under limit
 */
export async function assertUnderTime<T>(
  fn: () => T | Promise<T>,
  maxMs: number,
  label: string
): Promise<T> {
  const { result, duration } = await measureTime(fn);
  if (duration > maxMs) {
    throw new Error(`${label} took ${duration.toFixed(2)}ms (max: ${maxMs}ms)`);
  }
  return result;
}

// ============================================================================
// Cleanup Utilities
// ============================================================================

/**
 * Cleanup temporary files after test
 */
export function cleanupTempFiles(paths: string[]): void {
  for (const path of paths) {
    try {
      require('fs').unlinkSync(path);
    } catch {
      // Ignore errors
    }
  }
}

// ============================================================================
// Secret Patterns (For Testing SecretDetector)
// ============================================================================

export const SECRET_PATTERNS = {
  github_pat: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
  github_fine_grained: 'github_pat_11A23456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  aws_access: 'AKIA' + 'IOSFODNN7EXAMPLE', // Obfuscated to pass GitHub push protection
  aws_secret: 'wJalrXUtnFEMI/' + 'K7MDENG/bPxRfiCYEXAMPLEKEY',
  generic_api: 'api_key="sk_' + 'live_1234567890abcdefghijklmnopqrst"', // Not real Stripe key
  slack_token: 'xoxb-1234567890-12345678' + '90123-ABCdefGHIjklMNOpqrsTUVwx',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----'
};

// ============================================================================
// Command Patterns (For Testing CommandDetector)
// ============================================================================

export const COMMAND_PATTERNS = {
  login: '/login',
  swap_auth: '/swap-auth rimidalvk@gmail.com',
  swap_auth_no_arg: '/swap-auth',
  clear: '/clear',
  not_a_command: '/path/to/file.txt' // Should NOT be detected
};
