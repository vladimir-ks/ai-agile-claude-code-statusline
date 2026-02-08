/**
 * Type Definitions for Unified Transcript Scanner
 *
 * All TypeScript interfaces and types used by the scanner system.
 * Based on: .ai-logs/specs/0208_08-25_scanner-data-model.md
 */

// ============================================================================
// Scanner State (Persistent)
// ============================================================================

/**
 * Persistent scanner state (stored in ~/.claude/session-health/scanners/)
 */
export interface ScannerState {
  version: 2;                            // Schema version
  lastOffset: number;                    // Byte position in transcript
  lastMtime: number;                     // File mtime at last scan (ms)
  lastScanAt: number;                    // Timestamp of last scan (ms)
  extractorData: Record<string, any>;    // Cached extractor results
}

/**
 * Scanner configuration
 */
export interface ScannerConfig {
  cacheTTL: number;                      // Result cache TTL (ms)
  maxFileSize: number;                   // Max transcript size to scan (bytes)
  extractorTimeout: number;              // Per-extractor timeout (ms)
  stateDir: string;                      // State file directory
}

/**
 * Default scanner configuration
 */
export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  cacheTTL: 10_000,                      // 10 seconds
  maxFileSize: 50_000_000,               // 50 MB
  extractorTimeout: 5_000,               // 5 seconds
  stateDir: '~/.claude/session-health/scanners'
};

// ============================================================================
// Scan Results
// ============================================================================

/**
 * Complete scan result (returned by UnifiedTranscriptScanner.scan())
 */
export interface ScanResult {
  lastMessage: MessageInfo;
  secrets: Secret[];
  commands: Command[];
  authChanges: AuthChange[];
  health: TranscriptHealth;
  metrics: ScanMetrics;
}

/**
 * Last message information
 */
export interface MessageInfo {
  timestamp: number;                     // Unix timestamp (ms)
  preview: string;                       // First 80 chars
  sender: 'human' | 'assistant' | 'unknown';
  turnNumber: number;                    // Message count (1-based)
}

/**
 * Detected secret
 */
export interface Secret {
  type: string;                          // "GitHub Token", "AWS Key", etc.
  fingerprint: string;                   // Unique ID for deduplication
  line: number;                          // Line number in transcript
  match: string;                         // Redacted match (first4...last4)
}

/**
 * Detected command
 */
export interface Command {
  command: string;                       // "/login", "/swap-auth", etc.
  timestamp: number;                     // Unix timestamp (ms)
  args: string[];                        // Command arguments
  line: number;                          // Line number in transcript
}

/**
 * Authentication change event
 */
export interface AuthChange {
  loginTimestamp: number;                // When auth changed (ms)
  email: string;                         // Email/account identifier
  line: number;                          // Line number in transcript
}

/**
 * Transcript health metrics
 */
export interface TranscriptHealth {
  exists: boolean;
  lastModified: number;                  // File mtime (ms)
  sizeBytes: number;
  messageCount: number;                  // From extractors
  lastModifiedAgo: string;               // Human-readable ("5m", "2h")
}

/**
 * Scan performance metrics
 */
export interface ScanMetrics {
  scanDuration: number;                  // Total ms
  linesScanned: number;                  // Lines processed
  bytesRead: number;                     // Bytes read from disk
  cacheHit: boolean;                     // Was result cached?
  extractorDurations: Record<string, number>; // Per-extractor timing
}

// ============================================================================
// Data Extractor Interface
// ============================================================================

/**
 * Pluggable data extractor interface
 */
export interface DataExtractor<T> {
  id: string;                            // Unique identifier
  shouldCache: boolean;                  // Cache results in state?
  cacheTTL?: number;                     // Optional cache TTL override

  extract(lines: ParsedLine[]): T | Promise<T>; // Extract data
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parsed JSONL line
 */
export interface ParsedLine {
  lineNumber: number;                    // Line number (estimated)
  rawLine: string;                       // Original text
  data: any | null;                      // Parsed JSON (null if invalid)
  parseError: string | null;             // Error message if parse failed
}

// ============================================================================
// File Reading
// ============================================================================

/**
 * Incremental read result
 */
export interface ReadResult {
  newBytes: string;                      // UTF-8 content
  newOffset: number;                     // New byte position
  mtime: number;                         // Current file mtime
  size: number;                          // Current file size
  cacheHit: boolean;                     // True if no new data
}

// ============================================================================
// Cache
// ============================================================================

/**
 * Cache statistics
 */
export interface CacheStats {
  entries: number;                       // Valid (non-expired) entries
  totalSize: number;                     // Estimated bytes
  hitRate: number;                       // 0.0 - 1.0
}
