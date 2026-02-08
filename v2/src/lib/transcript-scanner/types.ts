/**
 * Unified Transcript Scanner - Core Types
 *
 * Type definitions for the unified transcript scanning system.
 * All transcript operations (last message, secrets, commands, auth changes)
 * go through a single coordinated scanner with pluggable extractors.
 */

// ---------------------------------------------------------------------------
// Parsed JSONL Line
// ---------------------------------------------------------------------------

export interface ParsedLine {
  /** Whether this line parsed successfully as JSON */
  valid: boolean;
  /** Parsed JSON data (if valid) */
  data?: any;
  /** Raw line text (always available) */
  raw: string;
  /** Line number in file (0-indexed) */
  lineNumber?: number;
}

// ---------------------------------------------------------------------------
// Data Extractor Interface (Pluggable)
// ---------------------------------------------------------------------------

export interface DataExtractor<T> {
  /** Unique identifier (e.g., 'last_message', 'secrets') */
  id: string;

  /** Whether to cache extraction result */
  shouldCache: boolean;

  /** Cache TTL in milliseconds (if shouldCache=true) */
  cacheTTL?: number;

  /**
   * Extract data from parsed transcript lines
   * @param lines - Parsed JSONL lines from transcript
   * @returns Extracted data of type T
   */
  extract(lines: ParsedLine[]): T | Promise<T>;
}

// ---------------------------------------------------------------------------
// Extractor Results
// ---------------------------------------------------------------------------

export interface MessageInfo {
  timestamp: number;
  preview: string;
  sender: 'human' | 'assistant' | 'unknown';
  turnNumber: number;
}

export interface Command {
  command: string;  // e.g., '/login', '/swap-auth'
  args: string;     // Arguments after command
  timestamp: number;
  lineNumber: number;
}

export interface AuthChange {
  type: 'login_command' | 'login_success' | 'swap_command';
  timestamp: number;
  lineNumber: number;
  metadata?: Record<string, any>;
}

export interface TranscriptHealth {
  exists: boolean;
  lastModified: number;
  sizeBytes: number;
  messageCount: number;
  lastModifiedAgo: string;
}

// ---------------------------------------------------------------------------
// Composite Scan Result
// ---------------------------------------------------------------------------

export interface ScanResult {
  /** Last user message info */
  lastMessage: MessageInfo;

  /** Detected secrets (redacted patterns) */
  secrets: string[];

  /** Detected commands */
  commands: Command[];

  /** Auth change events */
  authChanges: AuthChange[];

  /** Transcript health metrics */
  health: TranscriptHealth;

  /** Scan performance metrics */
  metrics: {
    scanDuration: number;      // Total scan time in ms
    linesScanned: number;      // Number of lines processed
    bytesRead: number;         // Bytes read from file
    cacheHit: boolean;         // Whether result came from cache
    extractorDurations: Record<string, number>;  // Per-extractor timing
  };
}

// ---------------------------------------------------------------------------
// Scanner State (Persistent)
// ---------------------------------------------------------------------------

export interface ScannerState {
  /** State file format version */
  version: 2;

  /** Last byte offset read from transcript */
  lastOffset: number;

  /** Last modification time of transcript (ms) */
  lastMtime: number;

  /** When this scan was performed (ms) */
  lastScanAt: number;

  /** Per-extractor cached data */
  extractorData: Record<string, any>;

  /** Checksums for detecting changes (optional) */
  checksums?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Scanner Configuration
// ---------------------------------------------------------------------------

export interface ScannerConfig {
  /** Cache TTL for scan results (ms) */
  cacheTTL?: number;

  /** Maximum file size to scan (bytes) */
  maxFileSize?: number;

  /** Maximum lines to scan in single pass */
  maxLines?: number;

  /** Whether to use cross-session memory cache */
  useSharedCache?: boolean;
}

// Default configuration
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  cacheTTL: 10_000,           // 10s in-memory cache
  maxFileSize: 100_000_000,   // 100MB max
  maxLines: 100_000,          // 100k lines max
  useSharedCache: false,      // Disabled by default
};
