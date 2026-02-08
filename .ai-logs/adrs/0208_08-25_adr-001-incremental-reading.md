# ADR-001: Incremental File Reading Strategy

**Date**: 2026-02-08 08:25
**Status**: Accepted
**Context**: UnifiedTranscriptScanner Phase 0

---

## Context

Transcript files can grow to 5-10MB in active sessions with heavy tool usage. Reading the entire file on every statusline invocation (0.5-5 Hz) creates:

- **I/O bottleneck**: 50ms+ to read 5MB file
- **Memory waste**: Allocate/parse full content repeatedly
- **CPU waste**: Re-parse already-seen lines

Current IncrementalTranscriptScanner solves this with offset tracking but lacks:
- Unified architecture (fragmented across 3 modules)
- Pluggable extractors (hard-coded logic)
- Migration path from old state files

---

## Decision

**Use byte-level incremental reading with persistent state tracking.**

### Core Algorithm

1. **Track offset + mtime in state file**:
   ```typescript
   {
     lastOffset: 123456,  // Byte position
     lastMtime: 1738876543000  // File modification time
   }
   ```

2. **Cache hit detection**:
   ```typescript
   if (currentMtime === lastMtime && currentSize === lastOffset) {
     return cachedData; // No new content
   }
   ```

3. **Incremental read**:
   ```typescript
   const newBytes = currentSize - lastOffset;
   readSync(fd, buffer, 0, newBytes, lastOffset);
   ```

4. **File reset detection**:
   ```typescript
   if (currentSize < lastOffset) {
     lastOffset = 0; // Transcript cleared/rotated
   }
   ```

### State Persistence

- **Location**: `~/.claude/session-health/scanners/{sessionId}.state`
- **Format**: JSON with version field for migration
- **Write**: Atomic (temp file + rename)
- **Read**: Cached in memory (10s TTL)

---

## Alternatives Considered

### Alternative 1: Full Scan Every Time

**Approach**: Read entire file on every invocation, no state tracking.

**Pros**:
- Simplest implementation (no state management)
- No stale state issues
- Guaranteed fresh data

**Cons**:
- ❌ 20x slower (100ms vs 5ms for 5MB file)
- ❌ 10x more memory (5MB vs 500KB for incremental)
- ❌ CPU waste (re-parse 99% duplicate content)
- ❌ Unacceptable for 40 concurrent sessions

**Rejected**: Performance unacceptable.

---

### Alternative 2: inotify/FSEvents File Watching

**Approach**: Use OS file watch APIs to detect changes, trigger scan on modify event.

**Pros**:
- Zero I/O when file unchanged
- Instant notification of changes
- No polling overhead

**Cons**:
- ❌ Complexity (setup watchers, handle errors)
- ❌ Cross-platform issues (inotify=Linux, FSEvents=macOS, ReadDirectoryChangesW=Windows)
- ❌ Scale issues (40 sessions = 40 watchers)
- ❌ Daemon required (statusline is event-driven, not long-running)
- ❌ Over-engineering (mtime check is <1ms)

**Rejected**: Complexity not justified by marginal gains.

---

### Alternative 3: Line-Based Offset (Line Number)

**Approach**: Track line number instead of byte offset.

**Pros**:
- Human-readable state
- Easier debugging

**Cons**:
- ❌ Requires full file scan to find line N (no seek)
- ❌ Variable line length makes seeking impossible
- ❌ Slower than byte offset
- ❌ Same memory allocation needed

**Rejected**: Byte offset is faster and more accurate.

---

### Alternative 4: Tail Reading Only (No State)

**Approach**: Always read last 2MB of file, scan backward for last message.

**Pros**:
- No state management
- Works for large files

**Cons**:
- ❌ Misses data if last message is >2MB back
- ❌ Re-scans same 2MB every invocation
- ❌ Can't track message count accurately
- ❌ Wastes I/O reading redundant data

**Rejected**: Inaccurate and wasteful.

---

## Rationale

### Why Byte-Level Offset?

1. **Performance**: O(new_bytes) complexity, not O(file_size)
   - 5ms to read 500KB vs 50ms to read 5MB

2. **Accuracy**: Exact tracking, no estimation
   - Line-based requires full scan to find line N
   - Byte offset allows direct seek

3. **Simplicity**: POSIX read() supports offset natively
   ```typescript
   readSync(fd, buffer, 0, newBytes, lastOffset);
   ```

4. **Proven**: IncrementalTranscriptScanner uses this successfully
   - Battle-tested in production
   - No reported bugs

### Why Persistent State?

1. **Deduplication**: Avoid re-processing same content
   - 99% of file unchanged between invocations
   - State enables skip

2. **Fast restarts**: Daemon crash doesn't force full rescan
   - State survives process restart
   - Pick up where left off

3. **Cache extractor results**: Expensive operations cached
   - Secret detection (regex heavy)
   - Message counting

### Why mtime Check?

1. **Fast cache hit detection**: <1ms stat() call
   - Avoids read() if file unchanged
   - Zero I/O for idle sessions

2. **Handle concurrent writes**: Detect ongoing changes
   - Writer updates mtime on every write
   - Scanner detects change immediately

3. **Standard practice**: Used by make, rsync, git
   - Well-understood semantics
   - Reliable across filesystems

---

## Consequences

### Positive

1. **4-10x speedup**:
   - Incremental: 5-10ms (vs 50-100ms full scan)
   - Cache hit: <1ms (vs 50ms)

2. **Scalable**:
   - 40 concurrent sessions sustainable
   - Each session reads only new content

3. **Memory efficient**:
   - Allocate only new bytes (500KB typical)
   - Not full file (5MB)

4. **Extensible**:
   - State schema supports new fields
   - Version field enables migration

5. **Testable**:
   - Deterministic (same input → same output)
   - No race conditions (single-writer model)

### Negative

1. **State file management**:
   - Must handle corruption (graceful fallback)
   - Must migrate old formats (backward compat)
   - Orphan state files if sessions deleted

2. **Stale state risk**:
   - If file rotated without size change: miss data
   - Mitigation: mtime check catches rotation

3. **Complexity**:
   - More complex than full scan
   - ~200 lines (vs ~50 for full scan)

4. **Debugging harder**:
   - State mismatch can cause confusion
   - Need tools to inspect state files

---

## Implementation Notes

### Cache Hit Fast Path

```typescript
// Stat file
const stats = statSync(transcriptPath);

// Check cache hit
if (stats.mtimeMs === state.lastMtime && stats.size === state.lastOffset) {
  // FAST PATH: Return cached data (no read)
  return buildResultFromState(state);
}
```

**Performance**: <1ms (single stat() syscall)

### Incremental Read

```typescript
// Calculate new bytes
const newBytes = stats.size - state.lastOffset;

// Allocate exact size buffer
const buffer = Buffer.alloc(newBytes);

// Seek + read
const fd = openSync(transcriptPath, 'r');
readSync(fd, buffer, 0, newBytes, state.lastOffset);
closeSync(fd);
```

**Performance**: ~5ms for 500KB (sequential read)

### File Reset Detection

```typescript
// File shrunk (cleared/rotated)
if (stats.size < state.lastOffset) {
  state.lastOffset = 0;  // Reset to full scan
}
```

**Rationale**: Transcript can be cleared by user or Claude Code

### Atomic State Write

```typescript
// Write to temp file
const tempPath = `${statePath}.tmp`;
writeFileSync(tempPath, JSON.stringify(state, null, 2));

// Atomic rename (POSIX guarantee)
renameSync(tempPath, statePath);
```

**Guarantee**: No partial state files (all-or-nothing)

---

## Validation

### Performance Benchmarks (Target)

| Scenario | Target | Max |
|----------|--------|-----|
| Cache hit (no I/O) | <1ms | 2ms |
| Incremental (100 lines, 10KB) | <5ms | 10ms |
| Incremental (1000 lines, 100KB) | <10ms | 20ms |
| Full scan (1000 lines) | <50ms | 100ms |
| Full scan (10000 lines) | <200ms | 500ms |

### Test Cases

1. **Cache hit**: mtime + size unchanged → no read
2. **Incremental**: 100 new lines → read only new bytes
3. **Full scan**: No state → read all
4. **File reset**: Size < lastOffset → reset offset
5. **Concurrent**: Multiple processes → atomic state writes

---

## Migration Path

### From IncrementalTranscriptScanner

```typescript
// Old state format
{
  "lastReadOffset": 123456,
  "lastReadMtime": 1738876543000,
  "messageCount": 42
}

// New state format (auto-migrated)
{
  "version": 2,
  "lastOffset": 123456,        // Mapped
  "lastMtime": 1738876543000,  // Mapped
  "extractorData": {
    "last_message": {
      "turnNumber": 42           // Mapped
    }
  }
}
```

**Trigger**: StateManager.load() auto-detects old format

---

## Related Decisions

- **ADR-002**: Pluggable extractors (why separate extraction logic)
- **ADR-003**: State management (why file-based, not DB)

---

## References

- IncrementalTranscriptScanner implementation (proven algorithm)
- POSIX read() semantics (offset support)
- Git index format (similar offset tracking)
- rsync algorithm (incremental sync inspiration)

---

**Status**: ✅ Accepted
**Implementation**: Phase 0.3-0.4 (TDD with tests first)
**Validation**: Performance benchmarks in Phase 2
