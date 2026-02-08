# Scanner Data Model Specification

**Date**: 2026-02-08 08:25
**Phase**: 0.2 - Specifications-Driven Development
**Version**: 2.0.0

---

## Purpose

Definitive schema for all data structures used by UnifiedTranscriptScanner. This specification is the **source of truth** for state files, cache entries, and all data types.

---

## State File Schema

### Version 2 Schema (Current)

**Location**: `~/.claude/session-health/scanners/{sessionId}.state`
**Format**: JSON
**Encoding**: UTF-8
**Permissions**: 0600 (owner read/write only)

```json
{
  "version": 2,
  "lastOffset": 123456,
  "lastMtime": 1738876543000,
  "lastScanAt": 1738876545000,
  "extractorData": {
    "last_message": {
      "timestamp": 1738876540000,
      "preview": "What does the main function do in this file?..",
      "sender": "human",
      "turnNumber": 42
    },
    "secrets": [
      {
        "type": "GitHub Token",
        "fingerprint": "github-pat-abc123",
        "line": 150,
        "match": "ghp_...xyz"
      }
    ],
    "commands": [
      {
        "command": "/login",
        "timestamp": 1738876500000,
        "args": [],
        "line": 100
      }
    ],
    "auth_changes": [
      {
        "loginTimestamp": 1738876500000,
        "email": "vladks.com",
        "line": 101
      }
    ]
  }
}
```

### Field Specifications

#### `version` (required)

- **Type**: `number`
- **Value**: `2` (current schema version)
- **Purpose**: Schema versioning for migration
- **Validation**: Must equal 2 (reject if not)

#### `lastOffset` (required)

- **Type**: `number` (integer)
- **Range**: `0` to file size
- **Purpose**: Byte position of last read in transcript
- **Default**: `0` (full scan on first run)

#### `lastMtime` (required)

- **Type**: `number` (integer)
- **Range**: Unix timestamp in milliseconds
- **Purpose**: File modification time at last scan
- **Default**: `0`

#### `lastScanAt` (required)

- **Type**: `number` (integer)
- **Range**: Unix timestamp in milliseconds
- **Purpose**: When the scan occurred
- **Default**: `Date.now()` at scan time

#### `extractorData` (required)

- **Type**: `object`
- **Keys**: Extractor IDs (string)
- **Values**: Extractor-specific data (any valid JSON)
- **Purpose**: Cached extractor results for quick access
- **Default**: `{}`

---

### Version 1 Schemas (Deprecated - Migration Only)

#### IncrementalTranscriptScanner State

**Location**: `~/.claude/session-health/cooldowns/{sessionId}-transcript.state`

```json
{
  "lastReadOffset": 123456,
  "lastReadMtime": 1738876543000,
  "messageCount": 42,
  "lastUserMessage": {
    "timestamp": 1738876540000,
    "preview": "What does the main function do?"
  }
}
```

**Migration Mapping**:
```
lastReadOffset      → lastOffset
lastReadMtime       → lastMtime
<current timestamp> → lastScanAt
messageCount        → extractorData.last_message.turnNumber
lastUserMessage.*   → extractorData.last_message.*
                    + sender: 'human' (added)
```

#### GitLeaksScanner State

**Location**: `~/.claude/session-health/cooldowns/{sessionId}-gitleaks.state`

```json
{
  "lastScannedOffset": 123456,
  "lastScannedMtime": 1738876543000,
  "knownFindings": [
    "github-pat-abc123",
    "aws-access-xyz789"
  ]
}
```

**Migration Mapping**:
```
lastScannedOffset   → lastOffset
lastScannedMtime    → lastMtime
<current timestamp> → lastScanAt
knownFindings       → extractorData.secrets (convert to Secret[] format)
```

---

## In-Memory Cache Schema

### Cache Entry Structure

```typescript
interface CacheEntry {
  result: ScanResult;      // Full scan result
  expiry: number;          // Absolute timestamp (Date.now() + ttl)
  size: number;            // Estimated bytes
}
```

### Field Specifications

#### `result`

- **Type**: `ScanResult` (see below)
- **Purpose**: Cached scan result
- **Lifetime**: Until expiry

#### `expiry`

- **Type**: `number` (integer)
- **Range**: Unix timestamp in milliseconds
- **Purpose**: When cache entry expires
- **Calculation**: `Date.now() + cacheTTL`

#### `size`

- **Type**: `number` (integer)
- **Range**: Estimated bytes (0 to 100KB typical)
- **Purpose**: Memory usage tracking
- **Calculation**: `JSON.stringify(result).length * 2` (UTF-16 overhead)

---

## ScanResult Schema

### Complete Structure

```json
{
  "lastMessage": {
    "timestamp": 1738876540000,
    "preview": "What does the main function do in this file?..",
    "sender": "human",
    "turnNumber": 42
  },
  "secrets": [
    {
      "type": "GitHub Token",
      "fingerprint": "github-pat-abc123",
      "line": 150,
      "match": "ghp_...xyz"
    }
  ],
  "commands": [
    {
      "command": "/login",
      "timestamp": 1738876500000,
      "args": [],
      "line": 100
    }
  ],
  "authChanges": [
    {
      "loginTimestamp": 1738876500000,
      "email": "vladks.com",
      "line": 101
    }
  ],
  "health": {
    "exists": true,
    "lastModified": 1738876543000,
    "sizeBytes": 123456,
    "messageCount": 42,
    "lastModifiedAgo": "5m"
  },
  "metrics": {
    "scanDuration": 8,
    "linesScanned": 100,
    "bytesRead": 10000,
    "cacheHit": false,
    "extractorDurations": {
      "last_message": 2,
      "secrets": 5,
      "commands": 1,
      "auth_changes": 1
    }
  }
}
```

### Field Specifications

#### `lastMessage` (required)

- **Type**: `MessageInfo` (see below)
- **Purpose**: Last user message preview
- **Empty value**: `{ timestamp: 0, preview: '', sender: 'unknown', turnNumber: 0 }`

#### `secrets` (required)

- **Type**: `Secret[]` (array)
- **Purpose**: Detected secrets in transcript
- **Empty value**: `[]`

#### `commands` (required)

- **Type**: `Command[]` (array)
- **Purpose**: Slash commands executed in session
- **Empty value**: `[]`

#### `authChanges` (required)

- **Type**: `AuthChange[]` (array)
- **Purpose**: Account switch events
- **Empty value**: `[]`

#### `health` (required)

- **Type**: `TranscriptHealth` (see below)
- **Purpose**: File health metrics

#### `metrics` (required)

- **Type**: `ScanMetrics` (see below)
- **Purpose**: Performance metrics for this scan

---

## MessageInfo Schema

### Structure

```json
{
  "timestamp": 1738876540000,
  "preview": "What does the main function do in this file?..",
  "sender": "human",
  "turnNumber": 42
}
```

### Field Specifications

#### `timestamp`

- **Type**: `number` (integer)
- **Range**: Unix timestamp in milliseconds
- **Purpose**: When message was sent
- **Default**: `0` (no message)

#### `preview`

- **Type**: `string`
- **Max Length**: 80 characters
- **Format**: Truncated with ".." suffix if >80 chars
- **Purpose**: Message preview for statusline
- **Default**: `''` (empty string)

#### `sender`

- **Type**: `string`
- **Enum**: `'human' | 'assistant' | 'unknown'`
- **Purpose**: Who sent the message
- **Default**: `'unknown'`

#### `turnNumber`

- **Type**: `number` (integer)
- **Range**: 0 to N
- **Purpose**: Turn count (1-based, user+assistant messages)
- **Default**: `0`

---

## Secret Schema

### Structure

```json
{
  "type": "GitHub Token",
  "fingerprint": "github-pat-abc123",
  "line": 150,
  "match": "ghp_...xyz"
}
```

### Field Specifications

#### `type`

- **Type**: `string`
- **Examples**: "GitHub Token", "AWS Key", "Private Key", "API Key"
- **Purpose**: Human-readable secret type
- **Source**: Mapped from pattern rule ID

#### `fingerprint`

- **Type**: `string`
- **Format**: `{ruleID}-{hash}` (e.g., "github-pat-abc123")
- **Purpose**: Unique identifier for deduplication
- **Uniqueness**: Same secret value → same fingerprint

#### `line`

- **Type**: `number` (integer)
- **Range**: 1 to N (estimated line number)
- **Purpose**: Location in transcript

#### `match`

- **Type**: `string`
- **Format**: Redacted value (first 4 + "..." + last 4)
- **Purpose**: Safe display (doesn't expose full secret)
- **Example**: `"ghp_...xyz"` for `"ghp_1234567890abcdefghijklmnopqrstuvwxyz"`

---

## Command Schema

### Structure

```json
{
  "command": "/login",
  "timestamp": 1738876500000,
  "args": [],
  "line": 100
}
```

### Field Specifications

#### `command`

- **Type**: `string`
- **Examples**: "/login", "/swap-auth", "/clear"
- **Format**: Always starts with "/"
- **Purpose**: Command name

#### `timestamp`

- **Type**: `number` (integer)
- **Range**: Unix timestamp in milliseconds
- **Purpose**: When command was executed

#### `args`

- **Type**: `string[]` (array)
- **Purpose**: Command arguments
- **Example**: `["/swap-auth", "user@example.com"]` → args: `["user@example.com"]`

#### `line`

- **Type**: `number` (integer)
- **Range**: 1 to N
- **Purpose**: Location in transcript

---

## AuthChange Schema

### Structure

```json
{
  "loginTimestamp": 1738876500000,
  "email": "vladks.com",
  "line": 101
}
```

### Field Specifications

#### `loginTimestamp`

- **Type**: `number` (integer)
- **Range**: Unix timestamp in milliseconds
- **Purpose**: When authentication changed
- **Usage**: Compare with SessionLock.locked_at

#### `email`

- **Type**: `string`
- **Format**: Email address or domain
- **Purpose**: Account identifier
- **Example**: "vladks.com", "rimidalvk@gmail.com"

#### `line`

- **Type**: `number` (integer)
- **Range**: 1 to N
- **Purpose**: Location in transcript

---

## TranscriptHealth Schema

### Structure

```json
{
  "exists": true,
  "lastModified": 1738876543000,
  "sizeBytes": 123456,
  "messageCount": 42,
  "lastModifiedAgo": "5m"
}
```

### Field Specifications

#### `exists`

- **Type**: `boolean`
- **Purpose**: Whether transcript file exists
- **Default**: `false`

#### `lastModified`

- **Type**: `number` (integer)
- **Range**: Unix timestamp in milliseconds
- **Purpose**: File modification time
- **Default**: `0`

#### `sizeBytes`

- **Type**: `number` (integer)
- **Range**: 0 to file size
- **Purpose**: File size in bytes
- **Default**: `0`

#### `messageCount`

- **Type**: `number` (integer)
- **Range**: 0 to N
- **Purpose**: Total messages in transcript
- **Source**: From last_message extractor
- **Default**: `0`

#### `lastModifiedAgo`

- **Type**: `string`
- **Format**: "<number><unit>" (e.g., "5m", "2h", "1d")
- **Units**: m (minutes), h (hours), d (days)
- **Purpose**: Human-readable age
- **Default**: `"unknown"`

---

## ScanMetrics Schema

### Structure

```json
{
  "scanDuration": 8,
  "linesScanned": 100,
  "bytesRead": 10000,
  "cacheHit": false,
  "extractorDurations": {
    "last_message": 2,
    "secrets": 5,
    "commands": 1,
    "auth_changes": 1
  }
}
```

### Field Specifications

#### `scanDuration`

- **Type**: `number` (integer)
- **Unit**: Milliseconds
- **Purpose**: Total scan time (including I/O, parsing, extraction)
- **Target**: <10ms incremental, <100ms full scan

#### `linesScanned`

- **Type**: `number` (integer)
- **Range**: 0 to N
- **Purpose**: Number of JSONL lines processed

#### `bytesRead`

- **Type**: `number` (integer)
- **Range**: 0 to file size
- **Purpose**: Bytes read from disk (incremental)

#### `cacheHit`

- **Type**: `boolean`
- **Purpose**: Whether result was cached
- **True**: No disk I/O, instant return
- **False**: Disk read + processing occurred

#### `extractorDurations`

- **Type**: `object`
- **Keys**: Extractor IDs (string)
- **Values**: Duration in milliseconds (number)
- **Purpose**: Per-extractor performance profiling

---

## ParsedLine Schema

### Structure

```json
{
  "lineNumber": 150,
  "rawLine": "{\"type\":\"user\",\"text\":\"hello\"}",
  "data": {
    "type": "user",
    "text": "hello"
  },
  "parseError": null
}
```

### Field Specifications

#### `lineNumber`

- **Type**: `number` (integer)
- **Range**: 1 to N (estimated)
- **Purpose**: Line number in file
- **Note**: Estimated from byte offset (~150 bytes/line)

#### `rawLine`

- **Type**: `string`
- **Purpose**: Original JSONL line text
- **Usage**: Error reporting, debugging

#### `data`

- **Type**: `any | null`
- **Purpose**: Parsed JSON object
- **Null**: If JSON.parse() failed
- **Value**: Parsed object if successful

#### `parseError`

- **Type**: `string | null`
- **Purpose**: Error message if parsing failed
- **Null**: If JSON.parse() succeeded
- **Value**: Error.message if failed

---

## ReadResult Schema

### Structure

```json
{
  "newBytes": "...JSONL content...",
  "newOffset": 123456,
  "mtime": 1738876543000,
  "size": 123456,
  "cacheHit": false
}
```

### Field Specifications

#### `newBytes`

- **Type**: `string`
- **Encoding**: UTF-8
- **Purpose**: New content since lastOffset
- **Empty**: `''` if cacheHit=true

#### `newOffset`

- **Type**: `number` (integer)
- **Range**: 0 to file size
- **Purpose**: New byte position (typically EOF)

#### `mtime`

- **Type**: `number` (integer)
- **Range**: Unix timestamp in milliseconds
- **Purpose**: Current file modification time

#### `size`

- **Type**: `number` (integer)
- **Range**: 0 to file size
- **Purpose**: Current file size

#### `cacheHit`

- **Type**: `boolean`
- **Purpose**: Whether file was unchanged
- **True**: mtime and size match lastMtime/lastOffset
- **False**: File has new content

---

## ScannerConfig Schema

### Structure

```json
{
  "cacheTTL": 10000,
  "maxFileSize": 50000000,
  "extractorTimeout": 5000,
  "stateDir": "~/.claude/session-health/scanners"
}
```

### Field Specifications

#### `cacheTTL`

- **Type**: `number` (integer)
- **Unit**: Milliseconds
- **Range**: 0 to 600000 (10 minutes max)
- **Purpose**: In-memory cache expiry
- **Default**: `10000` (10 seconds)

#### `maxFileSize`

- **Type**: `number` (integer)
- **Unit**: Bytes
- **Range**: 0 to 100MB
- **Purpose**: Max transcript size to process
- **Default**: `50000000` (50 MB)

#### `extractorTimeout`

- **Type**: `number` (integer)
- **Unit**: Milliseconds
- **Range**: 1000 to 30000
- **Purpose**: Per-extractor timeout
- **Default**: `5000` (5 seconds)

#### `stateDir`

- **Type**: `string`
- **Format**: Absolute path
- **Purpose**: Directory for state files
- **Default**: `"~/.claude/session-health/scanners"`

---

## CacheStats Schema

### Structure

```json
{
  "entries": 42,
  "totalSize": 2100000,
  "hitRate": 0.75
}
```

### Field Specifications

#### `entries`

- **Type**: `number` (integer)
- **Range**: 0 to MAX_ENTRIES (100)
- **Purpose**: Valid (non-expired) cache entries
- **Note**: Counts only non-expired entries

#### `totalSize`

- **Type**: `number` (integer)
- **Unit**: Bytes
- **Range**: 0 to ~10MB
- **Purpose**: Estimated total memory usage

#### `hitRate`

- **Type**: `number` (float)
- **Range**: 0.0 to 1.0
- **Purpose**: Cache hit ratio (hits / total requests)
- **Note**: Currently returns 0 (TODO: implement tracking)

---

## Data Constraints

### Size Limits

| Field | Max Size | Enforcement |
|-------|----------|-------------|
| State file | ~100KB | Log warning if exceeded |
| Cache entry | ~50KB | Evict if oversized |
| Message preview | 80 chars | Truncate with ".." |
| Secret match | Variable | Redact (first4...last4) |
| Extractor ID | 50 chars | Validation at registration |
| Session ID | 100 chars | Validation + pattern check |

### Performance Targets

| Metric | Target | Max Acceptable |
|--------|--------|----------------|
| State file read | <1ms | 5ms |
| State file write | <2ms | 10ms |
| Cache lookup | <1ms | 2ms |
| JSONL parse (100 lines) | <5ms | 10ms |
| Incremental read (1KB) | <5ms | 10ms |
| Full scan (1000 lines) | <100ms | 150ms |

---

## Data Integrity

### Validation Rules

1. **sessionId**:
   - Pattern: `/^[a-zA-Z0-9_-]+$/`
   - Max length: 100 chars
   - No path separators (`/`, `\`)

2. **State file**:
   - Must have `version: 2`
   - lastOffset >= 0
   - lastMtime >= 0
   - extractorData must be object

3. **Fingerprints**:
   - Must be unique per secret value
   - Format: `{type}-{hash}`
   - Hash algorithm: Simple 32-bit hash

4. **Timestamps**:
   - Must be positive integers
   - Must be Unix milliseconds (13 digits typical)
   - Range: 0 to Date.now() + 1 year (future prevention)

### Atomicity Guarantees

1. **State file writes**:
   - Write to temp file
   - Rename to final path (atomic on POSIX)
   - Cleanup temp on failure

2. **Cache updates**:
   - Single-threaded (in-process only)
   - No partial updates

3. **Concurrent scans**:
   - Separate state files per session (no contention)
   - Atomic renames prevent corruption

---

## Migration Strategy

### Version 1 → Version 2

**Trigger**: `StateManager.load()` doesn't find v2 state file

**Steps**:

1. **Try IncrementalTranscriptScanner migration**:
   - Check: `~/.claude/session-health/cooldowns/{sessionId}-transcript.state`
   - If exists: Migrate to v2 schema
   - Map fields as documented above

2. **Try GitLeaksScanner migration**:
   - Check: `~/.claude/session-health/cooldowns/{sessionId}-gitleaks.state`
   - If exists: Migrate to v2 schema
   - Convert fingerprints to Secret[] format

3. **Both migrations**:
   - If both old files exist: Merge data
   - Use IncrementalScanner offset/mtime (more reliable)
   - Combine extractorData from both

4. **No old state**:
   - Return null
   - Next scan creates fresh v2 state

**Logging**:
```
[StateManager] INFO: Migrated old transcript state for session-abc
[StateManager] INFO: Migrated old gitleaks state for session-abc
```

---

## Data Examples

### Example 1: New Session (Empty State)

```json
{
  "version": 2,
  "lastOffset": 0,
  "lastMtime": 0,
  "lastScanAt": 1738876545000,
  "extractorData": {}
}
```

### Example 2: Active Session

```json
{
  "version": 2,
  "lastOffset": 123456,
  "lastMtime": 1738876543000,
  "lastScanAt": 1738876545000,
  "extractorData": {
    "last_message": {
      "timestamp": 1738876540000,
      "preview": "What does the main function do in this file?..",
      "sender": "human",
      "turnNumber": 42
    },
    "secrets": [
      {
        "type": "GitHub Token",
        "fingerprint": "github-pat-5z9a2k",
        "line": 150,
        "match": "ghp_...xyz"
      }
    ],
    "commands": [
      {
        "command": "/login",
        "timestamp": 1738876500000,
        "args": [],
        "line": 100
      }
    ],
    "auth_changes": [
      {
        "loginTimestamp": 1738876500000,
        "email": "vladks.com",
        "line": 101
      }
    ]
  }
}
```

### Example 3: Migrated from Old Format

```json
{
  "version": 2,
  "lastOffset": 50000,
  "lastMtime": 1738876543000,
  "lastScanAt": 1738876600000,
  "extractorData": {
    "last_message": {
      "timestamp": 1738876540000,
      "preview": "How do I implement this feature?",
      "sender": "human",
      "turnNumber": 25
    }
  }
}
```

### Example 4: Complete ScanResult

```json
{
  "lastMessage": {
    "timestamp": 1738876540000,
    "preview": "What does the main function do in this file?..",
    "sender": "human",
    "turnNumber": 42
  },
  "secrets": [
    {
      "type": "GitHub Token",
      "fingerprint": "github-pat-5z9a2k",
      "line": 150,
      "match": "ghp_...xyz"
    },
    {
      "type": "AWS Key",
      "fingerprint": "aws-access-8x3m1p",
      "line": 200,
      "match": "AKIA...PLE"
    }
  ],
  "commands": [
    {
      "command": "/login",
      "timestamp": 1738876500000,
      "args": [],
      "line": 100
    },
    {
      "command": "/swap-auth",
      "timestamp": 1738876600000,
      "args": ["user@example.com"],
      "line": 250
    }
  ],
  "authChanges": [
    {
      "loginTimestamp": 1738876500000,
      "email": "vladks.com",
      "line": 101
    },
    {
      "loginTimestamp": 1738876600000,
      "email": "user@example.com",
      "line": 251
    }
  ],
  "health": {
    "exists": true,
    "lastModified": 1738876543000,
    "sizeBytes": 123456,
    "messageCount": 42,
    "lastModifiedAgo": "5m"
  },
  "metrics": {
    "scanDuration": 8,
    "linesScanned": 100,
    "bytesRead": 10000,
    "cacheHit": false,
    "extractorDurations": {
      "last_message": 2,
      "secrets": 5,
      "commands": 1,
      "auth_changes": 1
    }
  }
}
```

---

## Schema Evolution

### Future Version 3 Considerations

**Potential additions** (not implemented yet):

1. **Compression**:
   - Compress extractorData if >10KB
   - Decompress on load

2. **Checksums**:
   - Add SHA256 checksum of transcript
   - Detect manual file edits

3. **Incremental extractor data**:
   - Store deltas instead of full state
   - Reduce write amplification

4. **Metadata**:
   - Track scan count
   - Track error count
   - Track last error timestamp

### Backward Compatibility Promise

- Version 2 state files will be supported indefinitely
- Version 3+ will auto-migrate from v2
- No manual user intervention required

---

## Data Serialization

### JSON Formatting

**State files**:
- Pretty-printed: `JSON.stringify(state, null, 2)`
- Indentation: 2 spaces
- Purpose: Human-readable for debugging

**Cache entries**:
- Minified: `JSON.stringify(result)` (no spacing)
- Purpose: Minimize memory footprint

### Character Encoding

- **UTF-8** for all files
- **No BOM** (Byte Order Mark)
- **Unix line endings** (`\n`, not `\r\n`)

### Number Precision

- Timestamps: Integer milliseconds (no decimals)
- Durations: Integer milliseconds
- Sizes: Integer bytes
- No floating-point arithmetic for critical values

---

## Error Handling

### Invalid Data Recovery

1. **Corrupted state file**:
   - JSON.parse() fails → Return null
   - Load creates fresh state on next scan

2. **Missing fields**:
   - Use defaults (0, '', [], {})
   - Log warning

3. **Wrong version**:
   - Reject if version > 2 (future-proofing)
   - Attempt migration if version < 2

4. **Oversized data**:
   - Truncate if possible (e.g., message preview)
   - Skip if not critical (e.g., large extractorData)

---

## Success Criteria

Data model specification is complete when:

- [x] All schemas documented with JSON examples
- [x] All fields have type, range, purpose specified
- [x] Migration strategy defined
- [x] Validation rules documented
- [x] Size limits defined
- [x] Examples provided for common scenarios
- [x] Backward compatibility addressed

**Next Phase**: Write Architecture Decision Records (ADRs)

---

**Document Status**: ✅ COMPLETE
**Lines**: 900+
**Coverage**: 100% of data structures
**Next**: `0208_08-25_adr-001-incremental-reading.md`
