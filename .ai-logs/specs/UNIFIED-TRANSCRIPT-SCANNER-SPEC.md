# Unified Transcript Scanner - Architecture Specification

**Date**: 2026-02-07
**Status**: SPECIFICATION - PENDING IMPLEMENTATION
**Priority**: HIGH (Perfection Protocol)

---

## Executive Summary

**Current State**: Transcript scanning is fragmented across 3 independent modules (IncrementalTranscriptScanner, GitLeaksScanner, TranscriptMonitor), each with own state management and file I/O patterns.

**Goal**: Create a unified, ultra-efficient TranscriptScanner module that:
- Reads transcript ONCE per invocation
- Extracts ALL data types in single pass (last message, secrets, auth changes, commands)
- Scales to 40+ concurrent sessions with minimal CPU/memory
- Supports future extensions (new command detection, analytics)
- Uses incremental scanning with byte-level precision

**Performance Target**:
- Single session: <10ms per scan (incremental)
- 40 concurrent sessions: <400ms aggregate (10ms avg each)
- Memory: <5MB per session scanner state
- CPU: <2% per session (background daemon only)

---

## Current Architecture Analysis

### Existing Modules

| Module | Location | Purpose | Scan Frequency | State File | Efficiency |
|--------|----------|---------|---|---|---|
| `IncrementalTranscriptScanner` | `lib/incremental-transcript-scanner.ts` | Last message + count | Every gather | `cooldowns/{sessionId}-transcript.state` | ✅ 20x speedup (incremental) |
| `GitLeaksScanner` | `lib/gitleaks-scanner.ts` | Secret detection | 5min cooldown | `cooldowns/{sessionId}-gitleaks.state` | ⚠️ CLI subprocess overhead |
| `TranscriptMonitor` | `lib/transcript-monitor.ts` | Health metrics | Every gather | NONE | ❌ Stateless, re-scans every time |

### Current Inefficiencies

1. **Multiple File Reads**: Each module reads transcript independently
2. **Duplicate Logic**: "Find last user message" implemented 3 times
3. **No Coordination**: Could scan once, extract all data
4. **Subprocess Overhead**: Gitleaks CLI adds 100-500ms latency
5. **No Cross-Session Caching**: 40 sessions = 40 independent scans

---

## Unified Architecture Design

### Module Structure

```
TranscriptScanner (Unified)
  ├─ ScanCoordinator       (Entry point, state management)
  ├─ IncrementalReader     (Byte-level incremental reads)
  ├─ LineParser            (JSONL parsing, validation)
  ├─ DataExtractors        (Pluggable extractors)
  │   ├─ LastMessageExtractor
  │   ├─ SecretDetector
  │   ├─ CommandDetector   (NEW: /login, /swap-auth)
  │   ├─ AuthChangeDetector (NEW: account switches)
  │   └─ (Future: custom extractors)
  ├─ StateManager          (Persistent offset tracking)
  └─ ResultCache           (In-memory cache with TTL)
```

### Data Flow

```
scan(sessionId, transcriptPath) →
  1. Load state (last offset, mtime)
  2. Check mtime/size → cache hit? Return cached
  3. Read new bytes since offset (incremental)
  4. Parse JSONL lines (single pass)
  5. Run ALL extractors in parallel on parsed lines
  6. Update state (new offset, mtime)
  7. Cache result (10s TTL)
  8. Return composite result
```

### State Schema

**File**: `~/.claude/session-health/scanners/{sessionId}.state`

```json
{
  "version": 2,
  "lastOffset": 1048576,          // Byte position
  "lastMtime": 1707312400000,     // File mtime (ms)
  "lastScanAt": 1707312400000,    // When scan occurred
  "checksumCache": {
    "lastMessage": "sha256-abc123",
    "secrets": "sha256-def456"
  },
  "extractorData": {
    "lastMessage": {
      "timestamp": 1707312390000,
      "preview": "What does this function do?",
      "sender": "human",
      "turnNumber": 42
    },
    "secretsFound": ["github-pat-***", "aws-key-***"],
    "commandsDetected": [
      { "command": "/login", "timestamp": 1707312300000, "line": 1250 }
    ],
    "authChanges": [
      { "from": "old@example.com", "to": "new@example.com", "timestamp": 1707312300000 }
    ]
  }
}
```

---

## Performance Optimizations

### 1. Incremental Reading (Byte-Level)

**Current**: IncrementalTranscriptScanner already implements this ✅

**Enhancement**: Share offset state across all extractors

```typescript
class IncrementalReader {
  read(path: string, fromOffset: number): {
    newBytes: Buffer;
    newOffset: number;
    mtime: number;
  } {
    const fd = openSync(path, 'r');
    const stats = fstatSync(fd);

    // Cache hit: no new data
    if (stats.mtimeMs === lastMtime && stats.size === fromOffset) {
      closeSync(fd);
      return { newBytes: Buffer.alloc(0), newOffset: fromOffset, mtime: lastMtime };
    }

    // Read only new bytes
    const bytesToRead = stats.size - fromOffset;
    const buffer = Buffer.alloc(bytesToRead);
    readSync(fd, buffer, 0, bytesToRead, fromOffset);
    closeSync(fd);

    return { newBytes: buffer, newOffset: stats.size, mtime: stats.mtimeMs };
  }
}
```

**Optimization**: Use `fs.createReadStream({ start: offset })` for large incremental reads (>10MB)

### 2. Single-Pass Parsing

**Current**: Each module parses JSONL independently ❌

**Unified**:
```typescript
class LineParser {
  parse(bytes: Buffer): ParsedLine[] {
    const lines = bytes.toString('utf-8').split('\n');
    return lines
      .filter(l => l.trim())
      .map(line => {
        try {
          return { valid: true, data: JSON.parse(line), raw: line };
        } catch {
          return { valid: false, raw: line };
        }
      });
  }
}
```

**Result**: Parse once, pass to all extractors

### 3. Parallel Extraction

```typescript
async extractAllData(parsedLines: ParsedLine[]): Promise<ScanResult> {
  const [lastMessage, secrets, commands, authChanges] = await Promise.all([
    LastMessageExtractor.extract(parsedLines),
    SecretDetector.scan(parsedLines),
    CommandDetector.detect(parsedLines),
    AuthChangeDetector.detect(parsedLines)
  ]);

  return { lastMessage, secrets, commands, authChanges };
}
```

**Benefit**: CPU parallelization for independent extractors

### 4. Native Secret Detection (Replace Gitleaks CLI)

**Current**: `gitleaks` subprocess adds 100-500ms overhead ❌

**Proposed**: In-process regex patterns (TypeScript)

```typescript
class SecretDetector {
  private static PATTERNS = {
    github_pat: /gh[ps]_[a-zA-Z0-9]{36}/g,
    aws_key: /AKIA[0-9A-Z]{16}/g,
    api_key: /sk-[a-zA-Z0-9]{20,}/g,
    private_key: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]{50,4096}?-----END[A-Z ]*PRIVATE KEY-----/g,
  };

  static scan(lines: ParsedLine[]): string[] {
    const found = new Set<string>();
    for (const line of lines) {
      const text = line.data?.text || line.raw;
      for (const [type, regex] of Object.entries(this.PATTERNS)) {
        const matches = text.match(regex);
        if (matches) {
          matches.forEach(m => found.add(`${type}:${m.substring(0, 10)}***`));
        }
      }
    }
    return Array.from(found);
  }
}
```

**Performance**: <1ms for 1000 lines (vs 100ms for Gitleaks subprocess)

**Trade-off**: Less accurate than Gitleaks, but 100x faster

**Hybrid Approach** (Recommended):
- Fast path: In-process regex (every invocation)
- Deep scan: Gitleaks CLI (5min cooldown, background job)

### 5. Cross-Session Memory Cache (Advanced)

**For 40 concurrent sessions**:

```typescript
class SharedScannerCache {
  // Global cache: transcriptPath → parsed content
  private static cache = new Map<string, {
    content: ParsedLine[];
    mtime: number;
    expiry: number;
  }>();

  static get(path: string, currentMtime: number): ParsedLine[] | null {
    const cached = this.cache.get(path);
    if (!cached || cached.mtime !== currentMtime || Date.now() > cached.expiry) {
      return null;
    }
    return cached.content;
  }

  static set(path: string, content: ParsedLine[], mtime: number) {
    this.cache.set(path, {
      content,
      mtime,
      expiry: Date.now() + 60_000  // 1min TTL
    });
  }
}
```

**Benefit**: 40 sessions with same transcript → 1 parse (not 40)

**Use Case**: Tmux multi-pane with same project

---

## Extractor Interface (Pluggable)

```typescript
interface DataExtractor<T> {
  id: string;                         // 'last_message', 'secrets', etc.
  extract(lines: ParsedLine[]): T;    // Synchronous extraction
  shouldCache: boolean;                // Cache result?
  cacheTTL?: number;                   // TTL in ms
}

// Example: Last Message Extractor
class LastMessageExtractor implements DataExtractor<MessageInfo> {
  id = 'last_message';
  shouldCache = true;
  cacheTTL = 10_000;  // 10s

  extract(lines: ParsedLine[]): MessageInfo {
    // Scan backwards for last human message
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (line.data?.sender === 'human' && line.data?.text) {
        return {
          timestamp: line.data.ts || Date.now(),
          preview: line.data.text.substring(0, 100),
          sender: 'human',
          turnNumber: this.countMessages(lines.slice(0, i + 1))
        };
      }
    }
    return { timestamp: 0, preview: '', sender: 'unknown', turnNumber: 0 };
  }
}
```

**Benefits**:
- Add new extractors without modifying core scanner
- Each extractor is independently testable
- Future extensions: command detection, analytics, custom patterns

---

## Account Switch Detection (NEW)

### Requirement

> "When I use /login inside the chat, the statusline should update the email and quota."

### Implementation

**Detector**:
```typescript
class AuthChangeDetector implements DataExtractor<AuthChange[]> {
  id = 'auth_changes';
  shouldCache = false;  // Always fresh

  extract(lines: ParsedLine[]): AuthChange[] {
    const changes: AuthChange[] = [];

    for (const line of lines) {
      // Detect /login command
      if (line.data?.type === 'text' &&
          line.data?.sender === 'human' &&
          (line.data?.text === '/login' || line.data?.text?.includes('/login'))) {
        changes.push({
          type: 'login_command',
          timestamp: line.data.ts || Date.now(),
          line: line.raw
        });
      }

      // Detect system response: "Login successful"
      if (line.data?.type === 'command_result' &&
          line.data?.command === 'login' &&
          line.data?.success === true) {
        changes.push({
          type: 'login_success',
          timestamp: line.data.ts || Date.now(),
          line: line.raw
        });
      }

      // Detect /swap-auth command
      if (line.data?.text?.includes('/swap-auth')) {
        changes.push({
          type: 'swap_command',
          timestamp: line.data.ts || Date.now(),
          line: line.raw
        });
      }
    }

    return changes;
  }
}
```

**Integration**:
```typescript
// In auth-source.ts or new auth-lock-source.ts

const scanResult = TranscriptScanner.scan(sessionId, transcriptPath);
const sessionLock = SessionLockManager.read(sessionId);

// Check if /login occurred AFTER session lock was created
const recentLogin = scanResult.authChanges.find(change =>
  change.type === 'login_success' &&
  change.timestamp > (sessionLock?.locked_at || 0)
);

if (recentLogin) {
  // Re-detect account from keychain
  const newEmail = await detectCurrentAccount();

  if (newEmail !== sessionLock?.locked_email) {
    // Update lock
    SessionLockManager.update(sessionId, {
      locked_email: newEmail,
      locked_at: Date.now()
    });

    // Register notification
    NotificationManager.register(
      'account_switch',
      `Switched to ${newEmail}`,
      8  // High priority
    );

    console.log(`[AuthSource] Account switched: ${sessionLock?.locked_email} → ${newEmail}`);
  }
}
```

---

## Command Detection (NEW - Future Extension)

```typescript
class CommandDetector implements DataExtractor<Command[]> {
  id = 'commands';
  shouldCache = false;

  private static COMMANDS = [
    '/login',
    '/swap-auth',
    '/logout',
    '/clear',
    '/help'
  ];

  extract(lines: ParsedLine[]): Command[] {
    const commands: Command[] = [];

    for (const line of lines) {
      if (line.data?.type === 'text' && line.data?.sender === 'human') {
        const text = line.data.text?.trim() || '';
        const matchedCmd = this.COMMANDS.find(cmd => text.startsWith(cmd));

        if (matchedCmd) {
          commands.push({
            command: matchedCmd,
            args: text.substring(matchedCmd.length).trim(),
            timestamp: line.data.ts || Date.now(),
            line: line.raw
          });
        }
      }
    }

    return commands;
  }
}
```

**Use Cases**:
- Detect `/clear` → reset session state
- Detect `/help` → show help notification
- Analytics: command usage frequency

---

## Migration Path (Backward Compatible)

### Phase 1: Create Unified Module (No Breaking Changes)

1. Create `TranscriptScanner` class
2. Register extractors: LastMessage, Secrets, Commands, AuthChanges
3. Keep existing modules intact
4. Add new `TranscriptSource` that uses unified scanner

### Phase 2: Migrate Existing Code

1. Replace IncrementalTranscriptScanner calls → TranscriptScanner
2. Replace GitLeaksScanner calls → TranscriptScanner (with native detector)
3. Replace TranscriptMonitor → TranscriptScanner.getHealth()
4. Remove old modules after migration

### Phase 3: Add Account Switch Detection

1. Enable AuthChangeDetector in unified scanner
2. Update auth-source.ts to check for login commands
3. Implement session lock updates
4. Register account switch notifications

---

## Performance Benchmarks (Target)

| Scenario | Current | Target | Method |
|---|---|---|---|
| **Incremental scan (100 new lines)** | 5ms | 3ms | Unified parsing |
| **Full scan (1000 lines)** | 100ms | 50ms | Single-pass extraction |
| **Secret detection (1000 lines)** | 150ms (CLI) | 2ms | Native regex |
| **40 concurrent sessions** | 4000ms | 400ms | Cross-session cache |
| **Memory per session** | 8MB | 5MB | Compact state schema |

---

## Testing Strategy

### Unit Tests

1. **IncrementalReader**
   - Cache hits (mtime/size unchanged)
   - New bytes only (partial reads)
   - Large files (>10MB)

2. **LineParser**
   - Valid JSONL
   - Malformed lines
   - Mixed valid/invalid

3. **Each Extractor**
   - LastMessageExtractor: find last human message
   - SecretDetector: detect patterns, false positives
   - CommandDetector: command parsing, args extraction
   - AuthChangeDetector: login/swap detection

### Integration Tests

1. **Full Pipeline**
   - Scan → Extract → State Update → Cache
   - Multiple invocations (incremental)
   - Session isolation

2. **Account Switch Flow**
   - /login detected → auth re-detection → lock update → notification

### Performance Tests

1. **Scalability**
   - 40 concurrent sessions
   - Large transcripts (10MB+)
   - Memory profiling

---

## Implementation Priority

### P0 (Critical - Week 1)
- [ ] Create TranscriptScanner base module
- [ ] Implement IncrementalReader (reuse existing logic)
- [ ] Implement LineParser
- [ ] Implement LastMessageExtractor
- [ ] Add StateManager

### P1 (High - Week 2)
- [ ] Implement native SecretDetector (regex-based)
- [ ] Implement CommandDetector
- [ ] Implement AuthChangeDetector
- [ ] Integrate with auth-source.ts

### P2 (Medium - Week 3)
- [ ] Account switch notification registration
- [ ] Session lock updates on /login
- [ ] Cross-session memory cache (optional optimization)

### P3 (Low - Week 4)
- [ ] Migrate existing code to use unified scanner
- [ ] Deprecate old modules (IncrementalTranscriptScanner, GitLeaksScanner, TranscriptMonitor)
- [ ] Performance benchmarking

---

## Open Questions

1. **Native vs Gitleaks**: Should we completely replace Gitleaks CLI, or use hybrid (fast regex + deep CLI scan)?
   - **Recommendation**: Hybrid — fast path always, CLI on 5min cooldown

2. **Cross-Session Cache**: Is 1min TTL safe, or could it cause stale data issues?
   - **Recommendation**: 30s TTL, per-session offset tracking prevents staleness

3. **Account Detection**: Should we verify keychain hash to ensure auth actually changed?
   - **Recommendation**: Yes — compare keychain service name or token hash

4. **Notification Persistence**: Should account switch notification persist across session restarts?
   - **Recommendation**: No — transient notification, resets on session close

---

## Success Criteria

✅ **Functional**:
- Single scan extracts all data types
- Account switches detected and displayed
- Notifications working end-to-end

✅ **Performance**:
- <10ms per scan (incremental)
- <400ms for 40 concurrent sessions
- <5MB memory per session

✅ **Architecture**:
- Pluggable extractor interface
- Backward compatible migration
- No breaking changes to existing API

---

## Next Steps

1. Review this spec with team/user
2. Create detailed implementation tasks
3. Write tests first (TDD)
4. Implement Phase 1 (unified module)
5. Validate performance benchmarks
6. Migrate existing code (Phase 2-3)

---

**This specification provides a complete roadmap for creating a unified, ultra-efficient transcript scanning system that scales to 40+ concurrent sessions while maintaining <10ms performance and supporting future extensions.**
