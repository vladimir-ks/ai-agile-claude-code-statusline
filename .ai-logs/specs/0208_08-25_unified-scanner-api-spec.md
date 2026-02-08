# Unified Transcript Scanner - API Specification

**Date**: 2026-02-08 08:25
**Phase**: 0.2 - Specifications-Driven Development
**Status**: SPECIFICATION (no implementation yet)
**Version**: 2.0.0

---

## Purpose

Definitive API contract for UnifiedTranscriptScanner and all related components. This specification is the **source of truth** for implementation. All code MUST conform to these interfaces.

---

## Core Principles

1. **Single-Pass Architecture**: Read transcript once, parse once, extract in parallel
2. **Pluggable Extractors**: Add new data types without modifying core
3. **Incremental Scanning**: Only process new bytes since last scan
4. **Defense in Depth**: Cache (10s) → State (persistent) → Graceful degradation
5. **Type Safety**: Full TypeScript coverage, no `any` types

---

## Module: UnifiedTranscriptScanner

### Static Class Interface

```typescript
class UnifiedTranscriptScanner {
  // Registration
  static register(extractor: DataExtractor<any>): void;
  static configure(config: Partial<ScannerConfig>): void;

  // Core API
  static scan(sessionId: string, transcriptPath: string): Promise<ScanResult>;

  // Utilities
  static clearCache(): void;
  static getCacheStats(): CacheStats;
}
```

### Method: `register()`

**Purpose**: Register a data extractor
**Thread Safety**: NOT thread-safe (call during initialization only)
**Idempotency**: Yes (re-registering same ID replaces existing)

```typescript
static register(extractor: DataExtractor<any>): void
```

**Parameters**:
- `extractor`: DataExtractor instance implementing extract() method

**Throws**:
- `Error` if extractor.id is empty string
- `Error` if extractor.extract is not a function

**Side Effects**:
- Adds extractor to internal registry Map

**Example**:
```typescript
UnifiedTranscriptScanner.register(new LastMessageExtractor());
UnifiedTranscriptScanner.register(new SecretDetector());
```

---

### Method: `configure()`

**Purpose**: Override default scanner configuration
**Thread Safety**: NOT thread-safe (call during initialization only)
**Idempotency**: Yes (merges with existing config)

```typescript
static configure(config: Partial<ScannerConfig>): void
```

**Parameters**:
- `config`: Partial configuration object (merged with defaults)

**Throws**: Nothing (invalid values ignored)

**Side Effects**:
- Updates internal config object

**Example**:
```typescript
UnifiedTranscriptScanner.configure({
  cacheTTL: 5000,        // 5s cache instead of 10s
  maxFileSize: 50_000_000 // 50MB limit
});
```

---

### Method: `scan()` (PRIMARY API)

**Purpose**: Scan transcript for all registered data types
**Thread Safety**: Safe (file-based state coordination)
**Idempotency**: Yes (same input → same output within cache TTL)
**Performance**: <10ms incremental, <100ms full scan (1000 lines)

```typescript
static async scan(
  sessionId: string,
  transcriptPath: string
): Promise<ScanResult>
```

**Parameters**:
- `sessionId`: Session identifier (alphanumeric + hyphen/underscore only, validated)
- `transcriptPath`: Absolute path to transcript.jsonl (validation: exists, readable)

**Returns**: `Promise<ScanResult>` - Composite result from all extractors

**Throws**:
- NEVER throws (returns empty result on error)

**Performance Contract**:
- Incremental scan (100 new lines): <10ms
- Full scan (1000 lines): <100ms
- Memory usage: <5MB per session

**Behavior**:

1. **Input Validation**:
   - sessionId: `/^[a-zA-Z0-9_-]+$/` (prevent path traversal)
   - transcriptPath: Must be absolute path
   - If invalid: Return empty result (no throw)

2. **Cache Check** (O(1)):
   - Check in-memory cache by sessionId
   - If cached AND not expired: Return immediately
   - Cache TTL: 10s default (configurable)

3. **File Check**:
   - If transcript doesn't exist: Return empty result
   - If size exceeds maxFileSize: Log warning, return empty

4. **State Load**:
   - Load state from `~/.claude/session-health/scanners/{sessionId}.state`
   - If doesn't exist: Try migration from old format
   - If migration fails: Create fresh state (offset=0)

5. **Incremental Read**:
   - Compare current mtime/size with state
   - If unchanged: Return cached extractor data from state
   - If changed: Read only new bytes (offset to EOF)
   - Special case: If size < lastOffset (file cleared), reset to full scan

6. **Parse**:
   - Parse new bytes as JSONL
   - Skip malformed lines (log warning)
   - Track parse errors in metrics

7. **Extract** (Parallel):
   - Run all registered extractors concurrently via Promise.all()
   - Each extractor receives same ParsedLine[]
   - Timeout per extractor: 5s default
   - On timeout: Use cached data from state, log warning

8. **Build Result**:
   - Merge extractor results into ScanResult
   - Add health metrics (exists, size, mtime, messageCount)
   - Add performance metrics (duration, bytesRead, cacheHit)

9. **Update State**:
   - Save new state with updated offset/mtime/extractorData
   - Atomic write (temp file + rename)

10. **Cache Result**:
    - Store in memory cache with TTL
    - Evict expired entries

11. **Return**:
    - Return ScanResult

**Error Handling**:
- File read error → Return empty result
- Parse error → Skip line, continue
- Extractor error → Use cached data, log error
- State save error → Log error, continue (non-critical)

**Example**:
```typescript
const result = await UnifiedTranscriptScanner.scan(
  'session-abc-123',
  '/Users/user/.claude/sessions/abc-123/transcript.jsonl'
);

console.log(result.lastMessage.preview);      // "What does..."
console.log(result.secrets.length);           // 0
console.log(result.metrics.scanDuration);     // 8ms
console.log(result.metrics.cacheHit);         // false
```

---

### Method: `clearCache()`

**Purpose**: Clear in-memory cache (for testing)
**Thread Safety**: Safe
**Idempotency**: Yes

```typescript
static clearCache(): void
```

**Parameters**: None

**Returns**: void

**Throws**: Nothing

**Side Effects**:
- Clears all entries from ResultCache
- Next scan() will read from disk state

**Example**:
```typescript
UnifiedTranscriptScanner.clearCache();
```

---

### Method: `getCacheStats()`

**Purpose**: Get cache statistics (for debugging/telemetry)
**Thread Safety**: Safe (read-only)
**Idempotency**: Yes

```typescript
static getCacheStats(): CacheStats
```

**Parameters**: None

**Returns**: `CacheStats` object

```typescript
interface CacheStats {
  entries: number;        // Valid (non-expired) entries
  totalSize: number;      // Estimated bytes
  hitRate: number;        // 0.0 - 1.0 (future: track hits/misses)
}
```

**Throws**: Nothing

**Example**:
```typescript
const stats = UnifiedTranscriptScanner.getCacheStats();
console.log(`Cache: ${stats.entries} entries, ${stats.totalSize} bytes`);
```

---

## Module: IncrementalReader

### Static Class Interface

```typescript
class IncrementalReader {
  static read(
    path: string,
    lastOffset: number,
    lastMtime: number
  ): ReadResult;
}
```

### Method: `read()`

**Purpose**: Read new bytes from transcript since last scan
**Thread Safety**: Safe (read-only file access)
**Performance**: O(new_bytes), not O(file_size)

```typescript
static read(
  path: string,
  lastOffset: number,
  lastMtime: number
): ReadResult
```

**Parameters**:
- `path`: Absolute path to transcript file
- `lastOffset`: Byte position of last read (0 = full scan)
- `lastMtime`: File mtime at last read (ms timestamp)

**Returns**: `ReadResult`

```typescript
interface ReadResult {
  newBytes: string;       // UTF-8 decoded content
  newOffset: number;      // New byte position (EOF)
  mtime: number;          // Current file mtime
  size: number;           // Current file size
  cacheHit: boolean;      // True if no new data
}
```

**Throws**:
- `Error` if file doesn't exist
- `Error` if file not readable

**Performance Contract**:
- Read 1MB new content: <5ms
- Memory allocation: Exact size (no over-allocation)

**Behavior**:

1. **Stat File**:
   - Get current size and mtime
   - If mtime === lastMtime AND size === lastOffset: Return cache hit

2. **Detect Reset**:
   - If size < lastOffset: File was cleared/rotated
   - Reset lastOffset = 0 (full scan)

3. **Calculate Read Range**:
   - newBytes = size - lastOffset
   - If newBytes === 0: Return cache hit
   - If newBytes > maxReadSize (10MB): Clamp to maxReadSize, log warning

4. **Read**:
   - Use fd = openSync(path, 'r')
   - Allocate buffer: Buffer.alloc(newBytes)
   - readSync(fd, buffer, 0, newBytes, lastOffset)
   - closeSync(fd)
   - Decode as UTF-8

5. **Return**:
   ```typescript
   {
     newBytes: buffer.toString('utf-8'),
     newOffset: size,
     mtime: stats.mtimeMs,
     size: stats.size,
     cacheHit: false
   }
   ```

**Error Handling**:
- File doesn't exist → Throw Error
- File not readable → Throw Error
- Read error → Throw Error
- Caller (UnifiedScanner) catches and returns empty result

**Example**:
```typescript
const result = IncrementalReader.read(
  '/path/to/transcript.jsonl',
  123456,  // Last read at byte 123456
  1738876543000
);

if (result.cacheHit) {
  console.log('No new data');
} else {
  console.log(`Read ${result.newBytes.length} bytes`);
}
```

---

## Module: LineParser

### Static Class Interface

```typescript
class LineParser {
  static parse(content: string, startLine: number): ParsedLine[];
}
```

### Method: `parse()`

**Purpose**: Parse JSONL content into structured lines
**Thread Safety**: Safe (pure function)
**Performance**: O(n) where n = number of lines

```typescript
static parse(content: string, startLine: number): ParsedLine[]
```

**Parameters**:
- `content`: Raw JSONL content (newline-delimited JSON)
- `startLine`: Starting line number (for error reporting, estimated)

**Returns**: `ParsedLine[]` - Array of successfully parsed lines

```typescript
interface ParsedLine {
  lineNumber: number;     // Line number in file (estimated)
  rawLine: string;        // Original line text
  data: any | null;       // Parsed JSON object (null if parse failed)
  parseError: string | null; // Error message if parse failed
}
```

**Throws**: NEVER (graceful error handling)

**Performance Contract**:
- Parse 1000 lines: <5ms
- Memory: ~2x content size (raw + parsed)

**Behavior**:

1. **Split Lines**:
   - Split on `\n`
   - Filter empty lines (trim() === '')

2. **Parse Each Line**:
   - Try JSON.parse()
   - On success: Store in data field
   - On failure: Store error message, data = null

3. **Build ParsedLine**:
   ```typescript
   {
     lineNumber: startLine + i,
     rawLine: line,
     data: parsedObj,
     parseError: null
   }
   ```

4. **Return**:
   - Array of all ParsedLine objects (including failed parses)
   - Failed parses have data=null, parseError set

**Error Handling**:
- Invalid JSON → data=null, parseError set, line included in result
- No throwing - extractors decide how to handle invalid lines

**Example**:
```typescript
const lines = LineParser.parse(
  '{"type":"user","text":"hello"}\n{"invalid\n',
  100
);

console.log(lines[0].data.type);        // "user"
console.log(lines[1].data);             // null
console.log(lines[1].parseError);       // "Unexpected token..."
```

---

## Module: StateManager

### Static Class Interface

```typescript
class StateManager {
  static load(sessionId: string): ScannerState | null;
  static save(sessionId: string, state: ScannerState): void;
  static createInitial(sessionId: string): ScannerState;
  static update(
    state: ScannerState,
    offset: number,
    mtime: number,
    extractorData: Record<string, any>
  ): ScannerState;
  static delete(sessionId: string): void;
  static listSessions(): string[];
  static getStatePath(sessionId: string): string;
}
```

### Type: `ScannerState`

```typescript
interface ScannerState {
  version: 2;                            // Schema version (for migration)
  lastOffset: number;                    // Byte position in transcript
  lastMtime: number;                     // File mtime at last scan
  lastScanAt: number;                    // Timestamp of last scan
  extractorData: Record<string, any>;    // Cached extractor results
}
```

**State File Location**: `~/.claude/session-health/scanners/{sessionId}.state`

---

### Method: `load()`

**Purpose**: Load scanner state from disk
**Thread Safety**: Safe (read-only)
**Idempotency**: Yes

```typescript
static load(sessionId: string): ScannerState | null
```

**Parameters**:
- `sessionId`: Session identifier

**Returns**:
- `ScannerState` if exists and valid
- `null` if doesn't exist or invalid

**Throws**: NEVER (returns null on error)

**Behavior**:

1. **Validate sessionId**:
   - Must match `/^[a-zA-Z0-9_-]+$/`
   - If invalid: Return null

2. **Check File**:
   - Path: `~/.claude/session-health/scanners/{sessionId}.state`
   - If doesn't exist: Try migration (see below)

3. **Read & Parse**:
   - readFileSync() + JSON.parse()
   - Validate version === 2
   - If version !== 2: Log warning, return null

4. **Return**: ScannerState object

**Migration** (from old formats):

1. Try `~/.claude/session-health/cooldowns/{sessionId}-transcript.state`:
   ```typescript
   {
     lastReadOffset: 123,
     lastReadMtime: 456,
     messageCount: 10,
     lastUserMessage: { timestamp, preview }
   }
   ```
   Migrate to:
   ```typescript
   {
     version: 2,
     lastOffset: lastReadOffset,
     lastMtime: lastReadMtime,
     lastScanAt: Date.now(),
     extractorData: {
       last_message: {
         timestamp: lastUserMessage.timestamp,
         preview: lastUserMessage.preview,
         sender: 'human',
         turnNumber: messageCount
       }
     }
   }
   ```

2. Try `~/.claude/session-health/cooldowns/{sessionId}-gitleaks.state`:
   ```typescript
   {
     lastScannedOffset: 123,
     lastScannedMtime: 456,
     knownFindings: ['fp1', 'fp2']
   }
   ```
   Migrate to:
   ```typescript
   {
     version: 2,
     lastOffset: lastScannedOffset,
     lastMtime: lastScannedMtime,
     lastScanAt: Date.now(),
     extractorData: {
       secrets: knownFindings
     }
   }
   ```

3. If both migration attempts fail: Return null

**Example**:
```typescript
const state = StateManager.load('session-abc');
if (state) {
  console.log(`Last scan at offset ${state.lastOffset}`);
} else {
  console.log('No state found, will do full scan');
}
```

---

### Method: `save()`

**Purpose**: Save scanner state to disk (atomic)
**Thread Safety**: Safe (atomic write via temp file + rename)
**Idempotency**: Yes

```typescript
static save(sessionId: string, state: ScannerState): void
```

**Parameters**:
- `sessionId`: Session identifier
- `state`: Scanner state to save

**Returns**: void

**Throws**: NEVER (logs error if save fails)

**Behavior**:

1. **Validate sessionId**: Match `/^[a-zA-Z0-9_-]+$/`

2. **Ensure Directory**:
   - `~/.claude/session-health/scanners/`
   - mkdirSync with recursive: true

3. **Atomic Write**:
   - Write to `{path}.tmp`
   - JSON.stringify(state, null, 2)
   - UTF-8 encoding
   - renameSync() to final path (atomic on POSIX)

4. **Cleanup on Error**:
   - If rename fails: Try unlinkSync(tempPath)
   - Log error but don't throw

**Error Handling**:
- Write error → Log, no throw (state will be stale but not corrupt)
- Rename error → Try direct write fallback
- Cleanup error → Ignore (orphan temp files cleaned by system)

**Example**:
```typescript
const state = {
  version: 2,
  lastOffset: 123456,
  lastMtime: Date.now(),
  lastScanAt: Date.now(),
  extractorData: { last_message: {...} }
};

StateManager.save('session-abc', state);
```

---

### Method: `createInitial()`

**Purpose**: Create initial state for new session
**Thread Safety**: Safe (pure function)
**Idempotency**: Yes

```typescript
static createInitial(sessionId: string): ScannerState
```

**Parameters**:
- `sessionId`: Session identifier

**Returns**: Fresh `ScannerState` with offset=0

```typescript
{
  version: 2,
  lastOffset: 0,
  lastMtime: 0,
  lastScanAt: Date.now(),
  extractorData: {}
}
```

**Throws**: NEVER

**Example**:
```typescript
const state = StateManager.createInitial('new-session');
```

---

### Method: `update()`

**Purpose**: Create updated state (immutable)
**Thread Safety**: Safe (pure function)
**Idempotency**: Yes

```typescript
static update(
  state: ScannerState,
  offset: number,
  mtime: number,
  extractorData: Record<string, any>
): ScannerState
```

**Parameters**:
- `state`: Current state
- `offset`: New byte offset
- `mtime`: New file mtime
- `extractorData`: New extractor results (merged with existing)

**Returns**: New `ScannerState` (original unchanged)

**Throws**: NEVER

**Behavior**:
- Shallow clone state
- Update offset, mtime, lastScanAt
- Merge extractorData (new values override old)

**Example**:
```typescript
const newState = StateManager.update(
  oldState,
  200000,
  Date.now(),
  { last_message: {...}, secrets: [...] }
);
```

---

### Method: `delete()`

**Purpose**: Delete state file for session
**Thread Safety**: Safe
**Idempotency**: Yes

```typescript
static delete(sessionId: string): void
```

**Parameters**:
- `sessionId`: Session identifier

**Returns**: void

**Throws**: NEVER (logs error if delete fails)

**Example**:
```typescript
StateManager.delete('old-session');
```

---

### Method: `listSessions()`

**Purpose**: List all sessions with scanner state
**Thread Safety**: Safe (read-only)
**Idempotency**: Yes

```typescript
static listSessions(): string[]
```

**Parameters**: None

**Returns**: Array of session IDs

**Throws**: NEVER (returns [] on error)

**Behavior**:
- Read `~/.claude/session-health/scanners/` directory
- Filter files ending with `.state`
- Strip `.state` extension
- Return session IDs

**Example**:
```typescript
const sessions = StateManager.listSessions();
console.log(`${sessions.length} sessions tracked`);
```

---

## Module: ResultCache

### Static Class Interface

```typescript
class ResultCache {
  static get(sessionId: string): ScanResult | null;
  static set(sessionId: string, result: ScanResult, ttl?: number): void;
  static invalidate(sessionId: string): void;
  static clear(): void;
  static getStats(): CacheStats;
  static cleanup(): void;
}
```

### In-Memory Cache Behavior

- **Storage**: Static Map<sessionId, CacheEntry>
- **TTL**: 10s default (configurable per-entry)
- **Eviction**: LRU when MAX_ENTRIES (100) exceeded
- **Size Limit**: 10MB total (estimated)

### Type: `CacheEntry`

```typescript
interface CacheEntry {
  result: ScanResult;
  expiry: number;        // Absolute timestamp (Date.now() + ttl)
  size: number;          // Estimated bytes (JSON.stringify().length * 2)
}
```

---

### Method: `get()`

**Purpose**: Get cached result if not expired
**Thread Safety**: Safe (in-process only)
**Performance**: O(1)

```typescript
static get(sessionId: string): ScanResult | null
```

**Parameters**:
- `sessionId`: Session identifier

**Returns**:
- `ScanResult` if cached and not expired
- `null` if missing or expired

**Throws**: NEVER

**Side Effects**:
- Deletes entry if expired (cleanup)

**Example**:
```typescript
const cached = ResultCache.get('session-abc');
if (cached) {
  return cached; // Fast path
}
```

---

### Method: `set()`

**Purpose**: Store result in cache with TTL
**Thread Safety**: Safe (in-process only)
**Performance**: O(1) amortized (eviction may be O(n))

```typescript
static set(
  sessionId: string,
  result: ScanResult,
  ttl: number = 10000
): void
```

**Parameters**:
- `sessionId`: Session identifier
- `result`: Scan result to cache
- `ttl`: Time-to-live in milliseconds (default 10000)

**Returns**: void

**Throws**: NEVER

**Side Effects**:
- Adds/replaces cache entry
- May evict oldest entries if MAX_ENTRIES exceeded
- May trigger cleanup of expired entries

**Eviction Strategy** (when size > MAX_ENTRIES):
1. Remove all expired entries
2. If still > MAX_ENTRIES:
   - Sort by expiry (oldest first)
   - Remove oldest (size - MAX_ENTRIES) entries

**Example**:
```typescript
ResultCache.set('session-abc', result, 5000); // 5s TTL
```

---

### Method: `invalidate()`

**Purpose**: Remove cached result for session
**Thread Safety**: Safe
**Idempotency**: Yes

```typescript
static invalidate(sessionId: string): void
```

**Parameters**:
- `sessionId`: Session identifier

**Returns**: void

**Throws**: NEVER

**Example**:
```typescript
ResultCache.invalidate('session-abc');
```

---

### Method: `clear()`

**Purpose**: Clear all cached results
**Thread Safety**: Safe
**Idempotency**: Yes

```typescript
static clear(): void
```

**Parameters**: None

**Returns**: void

**Throws**: NEVER

**Example**:
```typescript
ResultCache.clear(); // For testing
```

---

### Method: `cleanup()`

**Purpose**: Remove expired entries (manual GC)
**Thread Safety**: Safe
**Idempotency**: Yes

```typescript
static cleanup(): void
```

**Parameters**: None

**Returns**: void

**Throws**: NEVER

**Behavior**:
- Iterate all entries
- Delete if expiry < Date.now()

**Example**:
```typescript
// Called periodically in background
setInterval(() => ResultCache.cleanup(), 60000); // Every minute
```

---

## Module: DataExtractor (Interface)

### Interface Definition

```typescript
interface DataExtractor<T> {
  id: string;                           // Unique identifier (e.g., "last_message")
  shouldCache: boolean;                 // Whether to cache results in state
  cacheTTL?: number;                    // Cache TTL in ms (optional)

  extract(lines: ParsedLine[]): T | Promise<T>; // Extract data from lines
}
```

### Contract

1. **`id`**:
   - Must be unique across all extractors
   - Used as key in state.extractorData
   - Format: snake_case (e.g., "last_message", "secrets", "commands")

2. **`shouldCache`**:
   - `true`: Results stored in state, reused on cache hit
   - `false`: Always re-extracted (for cheap operations)

3. **`cacheTTL`**:
   - Optional override for cache duration
   - If not set: Uses scanner's default (10s)

4. **`extract(lines)`**:
   - **Parameters**: Array of ParsedLine objects
   - **Returns**: Extracted data (generic type T)
   - **Can be async** (return Promise<T>)
   - **Must not throw** (return empty/default value on error)
   - **Performance**: Should complete within 5s (timeout enforced)

### Example Implementations

#### LastMessageExtractor

```typescript
interface MessageInfo {
  timestamp: number;
  preview: string;
  sender: 'human' | 'assistant' | 'unknown';
  turnNumber: number;
}

class LastMessageExtractor implements DataExtractor<MessageInfo> {
  id = 'last_message';
  shouldCache = true;
  cacheTTL = 10000;

  extract(lines: ParsedLine[]): MessageInfo {
    // Scan backward for last user message
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.data) continue;

      if (line.data.type === 'user' && line.data.message?.content) {
        const text = this.extractText(line.data.message.content);
        if (text) {
          return {
            timestamp: new Date(line.data.timestamp).getTime(),
            preview: this.truncate(text, 80),
            sender: 'human',
            turnNumber: this.countMessages(lines.slice(0, i + 1))
          };
        }
      }
    }

    // No message found
    return {
      timestamp: 0,
      preview: '',
      sender: 'unknown',
      turnNumber: 0
    };
  }

  private extractText(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'text') return block.text;
      }
    }
    return '';
  }

  private truncate(text: string, max: number): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length <= max ? clean : clean.slice(0, max - 2) + '..';
  }

  private countMessages(lines: ParsedLine[]): number {
    return lines.filter(l => l.data?.type === 'user' || l.data?.type === 'assistant').length;
  }
}
```

#### SecretDetector

```typescript
interface Secret {
  type: string;          // "GitHub Token", "AWS Key", etc.
  fingerprint: string;   // Unique ID for deduplication
  line: number;          // Line number where found
  match: string;         // Redacted match (first 4 + last 4)
}

class SecretDetector implements DataExtractor<Secret[]> {
  id = 'secrets';
  shouldCache = true;
  cacheTTL = 300000; // 5 minutes

  private readonly PATTERNS = {
    github_pat: /ghp_[A-Za-z0-9]{36}/g,
    aws_access: /AKIA[0-9A-Z]{16}/g,
    generic_api: /api[_-]?key["\s:=]+[A-Za-z0-9]{32,}/gi,
    private_key: /-----BEGIN (RSA|OPENSSH|EC) PRIVATE KEY-----/g
  };

  extract(lines: ParsedLine[]): Secret[] {
    const secrets: Secret[] = [];

    for (const line of lines) {
      if (!line.data) continue;

      const text = JSON.stringify(line.data);

      for (const [type, pattern] of Object.entries(this.PATTERNS)) {
        const matches = text.matchAll(pattern);
        for (const match of matches) {
          const secret = match[0];
          secrets.push({
            type: this.formatType(type),
            fingerprint: `${type}-${this.hash(secret)}`,
            line: line.lineNumber,
            match: this.redact(secret)
          });
        }
      }
    }

    return secrets;
  }

  private formatType(key: string): string {
    const map: Record<string, string> = {
      github_pat: 'GitHub Token',
      aws_access: 'AWS Key',
      generic_api: 'API Key',
      private_key: 'Private Key'
    };
    return map[key] || key;
  }

  private hash(text: string): string {
    // Simple hash for fingerprinting
    let hash = 0;
    for (let i = 0; i < text.length; i++) {
      hash = ((hash << 5) - hash) + text.charCodeAt(i);
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash).toString(36);
  }

  private redact(secret: string): string {
    if (secret.length <= 12) return '***';
    return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
  }
}
```

---

## Data Types

### Type: `ScanResult`

**Primary return type from `scan()`**

```typescript
interface ScanResult {
  lastMessage: MessageInfo;
  secrets: Secret[];
  commands: Command[];
  authChanges: AuthChange[];
  health: TranscriptHealth;
  metrics: ScanMetrics;
}
```

**Fields**:

- `lastMessage`: Last user message info (from LastMessageExtractor)
- `secrets`: Array of detected secrets (from SecretDetector)
- `commands`: Array of slash commands (from CommandDetector)
- `authChanges`: Array of auth events (from AuthChangeDetector)
- `health`: Transcript health metrics
- `metrics`: Performance metrics for this scan

---

### Type: `MessageInfo`

```typescript
interface MessageInfo {
  timestamp: number;      // Unix timestamp (ms)
  preview: string;        // First 80 chars of message
  sender: 'human' | 'assistant' | 'unknown';
  turnNumber: number;     // Message count (1-based)
}
```

---

### Type: `Secret`

```typescript
interface Secret {
  type: string;           // Human-readable type ("GitHub Token")
  fingerprint: string;    // Unique ID for deduplication
  line: number;           // Line number in transcript
  match: string;          // Redacted secret (first4...last4)
}
```

---

### Type: `Command`

```typescript
interface Command {
  command: string;        // Command name ("/login", "/swap-auth")
  timestamp: number;      // Unix timestamp (ms)
  args: string[];         // Command arguments
  line: number;           // Line number in transcript
}
```

---

### Type: `AuthChange`

```typescript
interface AuthChange {
  loginTimestamp: number; // When login occurred
  email: string;          // Email address logged in
  line: number;           // Line number in transcript
}
```

---

### Type: `TranscriptHealth`

```typescript
interface TranscriptHealth {
  exists: boolean;
  lastModified: number;       // File mtime (ms)
  sizeBytes: number;
  messageCount: number;       // From extractors
  lastModifiedAgo: string;    // Human-readable ("5m", "2h")
}
```

---

### Type: `ScanMetrics`

```typescript
interface ScanMetrics {
  scanDuration: number;                        // Total ms
  linesScanned: number;                        // Lines processed
  bytesRead: number;                           // Bytes read from disk
  cacheHit: boolean;                           // Was result cached?
  extractorDurations: Record<string, number>;  // Per-extractor timing
}
```

---

### Type: `ParsedLine`

```typescript
interface ParsedLine {
  lineNumber: number;      // Line number (estimated)
  rawLine: string;         // Original text
  data: any | null;        // Parsed JSON (null if invalid)
  parseError: string | null; // Error message if parse failed
}
```

---

### Type: `ScannerConfig`

```typescript
interface ScannerConfig {
  cacheTTL: number;         // Result cache TTL (ms)
  maxFileSize: number;      // Max transcript size to scan
  extractorTimeout: number; // Per-extractor timeout (ms)
  stateDir: string;         // State file directory
}
```

**Default Config**:

```typescript
const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  cacheTTL: 10_000,              // 10 seconds
  maxFileSize: 50_000_000,       // 50 MB
  extractorTimeout: 5_000,       // 5 seconds
  stateDir: '~/.claude/session-health/scanners'
};
```

---

## Error Handling Strategy

### UnifiedTranscriptScanner

- **NEVER throws**: Always returns valid ScanResult (may be empty)
- Invalid sessionId → Return empty result
- File doesn't exist → Return empty result
- Parse errors → Skip lines, continue
- Extractor errors → Use cached data, log error
- State save errors → Log, continue (non-critical)

### IncrementalReader

- **Throws on file errors**: Caller must handle
- File not found → throw Error
- File not readable → throw Error
- Read error → throw Error

### LineParser

- **NEVER throws**: Gracefully handles malformed JSON
- Invalid JSON → ParsedLine with data=null, parseError set
- Empty content → Return empty array

### StateManager

- **NEVER throws**: All methods return null/void on error
- Load error → Return null
- Save error → Log, no throw
- Delete error → Log, no throw

### ResultCache

- **NEVER throws**: All operations safe
- Memory limit exceeded → Evict oldest
- Invalid data → Ignore

### DataExtractor

- **Should NOT throw**: Return default value on error
- Timeout enforced by UnifiedScanner (5s)
- Errors caught by scanner, cached data used as fallback

---

## Performance Contracts

### UnifiedTranscriptScanner.scan()

| Scenario | Lines | Target | Max |
|----------|-------|--------|-----|
| Cache hit | Any | <1ms | 2ms |
| Incremental (100 new lines) | 100 | <10ms | 15ms |
| Full scan (small file) | 1000 | <100ms | 150ms |
| Full scan (large file) | 10000 | <500ms | 1000ms |

### Memory Usage

| Component | Per Session | Max Total |
|-----------|-------------|-----------|
| State file | <10KB | N/A |
| In-memory cache | <50KB | 10MB (100 sessions) |
| Scan buffer | <2MB (tail) | 2MB |
| Parse overhead | ~2x content | Temporary |

### Disk I/O

| Operation | Frequency | Cost |
|-----------|-----------|------|
| State load | Once per scan | 1 read (<1ms) |
| Transcript read | Once per scan | 1 read (5-10ms) |
| State save | Once per scan | 1 write (~2ms) |

**Total I/O per scan**: 2 reads + 1 write = <15ms

---

## Thread Safety & Concurrency

### File-Based State Coordination

- **State files**: One per session (no contention)
- **Atomic writes**: temp file + rename (POSIX atomic)
- **No locking needed**: Sessions don't share state files

### Cache Coordination

- **In-memory cache**: Single process only
- **No cross-process cache**: Each daemon has own cache
- **TTL prevents stale reads**: 10s max staleness

### Concurrent Scans

- **Same session, same process**: Safe (cache prevents duplicate work)
- **Same session, different processes**: Safe (file-based state, atomic writes)
- **Different sessions**: Fully independent

---

## Migration & Backward Compatibility

### State File Migration

**Automatic migration** from old formats on first `load()`:

1. Check for new format first (`{sessionId}.state`)
2. If not found, try old formats:
   - `{sessionId}-transcript.state` (IncrementalTranscriptScanner)
   - `{sessionId}-gitleaks.state` (GitLeaksScanner)
3. Migrate to new schema, save new file
4. Log migration: `[StateManager] Migrated old state for {sessionId}`

### API Compatibility

- **Drop-in replacement** for IncrementalTranscriptScanner
- Returns same `TranscriptHealth` interface
- No breaking changes to data-gatherer.ts

---

## Extension Points

### Adding New Extractors

1. **Implement DataExtractor<T>**:
   ```typescript
   class MyExtractor implements DataExtractor<MyDataType> {
     id = 'my_data';
     shouldCache = true;
     extract(lines) { /* ... */ }
   }
   ```

2. **Register**:
   ```typescript
   UnifiedTranscriptScanner.register(new MyExtractor());
   ```

3. **Access Results**:
   ```typescript
   const result = await UnifiedTranscriptScanner.scan(...);
   const myData = result.extractorData?.my_data;
   ```

**No core code changes needed** ✅

---

## Validation Rules

### sessionId Validation

- **Pattern**: `/^[a-zA-Z0-9_-]+$/`
- **Rationale**: Prevent path traversal attacks
- **Enforcement**: All modules validate before file operations

### transcriptPath Validation

- **Must be absolute path** (starts with `/`)
- **Must exist** (existsSync check)
- **Must be readable** (try stat)

### File Size Limits

- **Max size**: 50MB default (configurable)
- **Behavior**: Log warning, return empty result if exceeded
- **Rationale**: Prevent memory exhaustion

### JSON Validation

- **Strict parsing**: JSON.parse() with try-catch
- **No schema validation**: Accept any valid JSON
- **Rationale**: Forward-compatible with transcript format changes

---

## Logging Strategy

### Log Levels

- **Error**: File read failures, state save failures, extractor crashes
- **Warn**: Parse errors, size limit exceeded, migration fallbacks
- **Info**: State migration, first scan for session
- **Debug**: Cache hits, extractor timing, state updates

### Log Format

```
[UnifiedScanner] <level>: <message>
[IncrementalReader] <level>: <message>
[StateManager] <level>: <message>
```

### Examples

```
[StateManager] INFO: Migrated old state for session-abc-123
[LineParser] WARN: Invalid JSON at line 145, skipping
[UnifiedScanner] ERROR: Extractor 'secrets' failed: timeout after 5s
[ResultCache] DEBUG: Cache hit for session-abc-123
```

---

## Testing Strategy (Phase 0.3)

### Unit Tests (Per Module)

- **IncrementalReader**: Cache hit, incremental read, file reset, errors
- **LineParser**: Valid JSON, invalid JSON, empty lines, edge cases
- **StateManager**: Load, save, migrate, atomic writes, validation
- **ResultCache**: Get, set, eviction, TTL, cleanup
- **Each Extractor**: Extract logic, edge cases, performance

### Integration Tests

- **Full scan flow**: UnifiedScanner → Reader → Parser → Extractors → State
- **State persistence**: Scan → save → load → verify
- **Migration**: Old state format → new format
- **Concurrent scans**: Multiple sessions simultaneously

### Performance Tests

- **Benchmark**: 100 lines, 1000 lines, 10000 lines
- **Memory profiling**: Peak usage, leak detection
- **I/O profiling**: Disk read/write counts

### Edge Case Tests

- **Empty transcript**: Size 0
- **File reset**: Size < lastOffset
- **Malformed JSON**: Every line invalid
- **No user messages**: Only assistant/system messages
- **Extractor timeout**: Slow extractor simulation

---

## Success Criteria

API specification is complete when:

- [x] All public methods documented
- [x] All parameters specified (types, validation, defaults)
- [x] All return types specified
- [x] All error handling defined
- [x] Performance contracts stated
- [x] Thread safety documented
- [x] Migration strategy defined
- [x] Extension points identified

**Next Phase**: Write .feature file (BDD scenarios) based on this API

---

**Document Status**: ✅ COMPLETE
**Lines**: 1800+
**Coverage**: 100% of planned API surface
**Next**: `0208_08-25_unified-scanner-behaviors.feature`
