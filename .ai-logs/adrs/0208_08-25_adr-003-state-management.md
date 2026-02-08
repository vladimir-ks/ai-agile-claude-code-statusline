# ADR-003: File-Based State Management

**Date**: 2026-02-08 08:25
**Status**: Accepted
**Context**: UnifiedTranscriptScanner Phase 0

---

## Context

UnifiedTranscriptScanner needs to persist state across invocations:

- **Offset tracking**: Last byte position read
- **mtime tracking**: File modification time
- **Extractor cache**: Results from expensive operations (secret detection, message counting)

**Requirements**:

1. **Fast reads**: <1ms to check if scan needed
2. **Atomic writes**: No partial state (corrupted offsets cause data loss)
3. **Cross-process safe**: Multiple daemons for different sessions
4. **Migration support**: Upgrade from old state formats
5. **Minimal dependencies**: No external database required

**Scale**:

- 40 concurrent sessions typical
- 100+ sessions per user (historical)
- State reads: 0.5-5 Hz during active work
- State writes: 0.5-5 Hz (after each scan)

---

## Decision

**Use file-based JSON state with atomic writes via temp file + rename.**

### State File Structure

```json
{
  "version": 2,
  "lastOffset": 123456,
  "lastMtime": 1738876543000,
  "lastScanAt": 1738876545000,
  "extractorData": {
    "last_message": { /* cached result */ },
    "secrets": [ /* cached findings */ ]
  }
}
```

### Storage Location

**Directory**: `~/.claude/session-health/scanners/`
**File naming**: `{sessionId}.state`
**Example**: `~/.claude/session-health/scanners/session-abc-123.state`

### Atomic Write Strategy

```typescript
// 1. Write to temp file
const tempPath = `${statePath}.tmp`;
writeFileSync(tempPath, JSON.stringify(state, null, 2));

// 2. Atomic rename (POSIX guarantee)
renameSync(tempPath, statePath);
```

**Guarantee**: All-or-nothing (no partial writes)

---

## Alternatives Considered

### Alternative 1: SQLite Database

**Approach**: Store all session state in SQLite database

```sql
CREATE TABLE scanner_state (
  session_id TEXT PRIMARY KEY,
  last_offset INTEGER,
  last_mtime INTEGER,
  last_scan_at INTEGER,
  extractor_data TEXT -- JSON blob
);
```

**Pros**:
- Structured queries possible
- ACID guarantees
- Single file for all sessions

**Cons**:
- ❌ Dependency (requires sqlite3 binary or node-sqlite3)
- ❌ Lock contention (40 sessions writing to same DB)
- ❌ Complexity (schema migrations, connection pooling)
- ❌ Overkill (no complex queries needed)
- ❌ Slower for simple read (1-2ms vs <1ms for JSON file)

**Rejected**: Over-engineered, performance worse.

---

### Alternative 2: In-Memory Only (No Persistence)

**Approach**: Keep state in memory, lose on process restart

**Pros**:
- Fastest (no disk I/O)
- Simplest (no serialization)

**Cons**:
- ❌ Data loss on crash/restart
- ❌ Full rescan after every daemon restart (slow)
- ❌ No cross-process sharing (each daemon has own state)

**Rejected**: Unacceptable data loss risk.

---

### Alternative 3: LevelDB / RocksDB

**Approach**: Use embedded key-value store

**Pros**:
- Fast (optimized for writes)
- Embedded (no separate process)

**Cons**:
- ❌ Dependency (native bindings required)
- ❌ Complexity (compaction, snapshots)
- ❌ Overkill (no need for range queries)
- ❌ Lock contention (single DB for all sessions)

**Rejected**: Complexity not justified.

---

### Alternative 4: Shared JSON File (All Sessions)

**Approach**: Single `state.json` with all sessions

```json
{
  "session-abc": { /* state */ },
  "session-xyz": { /* state */ }
}
```

**Pros**:
- Single file (easier backup)
- Atomic updates to multiple sessions

**Cons**:
- ❌ Lock contention (40 writers to same file)
- ❌ Read amplification (read all sessions, use one)
- ❌ Write amplification (rewrite entire file for one session update)
- ❌ Corruption risk (one corrupt session breaks all)

**Rejected**: Contention and amplification unacceptable.

---

## Rationale

### Why File-Based?

1. **No dependencies**:
   - Built-in fs module (Node.js/Bun)
   - No native bindings
   - Works on all platforms

2. **Cross-process safe**:
   - Separate file per session (no contention)
   - Atomic rename (POSIX guarantee)
   - No locks needed

3. **Simple**:
   - Read: `JSON.parse(readFileSync(path))`
   - Write: `writeFileSync(temp); renameSync(temp, path)`
   - ~50 lines total

4. **Fast**:
   - Read: <1ms (small JSON file, OS cache)
   - Write: <2ms (atomic rename is fast)
   - No network latency

5. **Human-readable**:
   - JSON format (easy debugging)
   - Pretty-printed (2-space indent)
   - `cat ~/.claude/session-health/scanners/*.state | jq`

### Why Separate File Per Session?

**Problem**: Lock contention with shared file

```
40 daemons × 5 Hz = 200 writes/sec to single file
→ File lock contention
→ Write failures
→ Retry storms
```

**Solution**: Separate files (no contention)

```
40 daemons × 5 Hz = 200 writes/sec to 40 files
→ No contention (each daemon owns its file)
→ No locks needed
→ Parallel writes
```

**Benefit**: 100% write success rate

### Why Atomic Rename?

**Problem**: Partial writes corrupt state

```
writeFileSync(statePath, JSON.stringify(state));
// Crash here → partial JSON written
// Next read → JSON.parse() fails
// Lost offset → full rescan required
```

**Solution**: Temp file + atomic rename

```
writeFileSync(tempPath, JSON.stringify(state));
renameSync(tempPath, statePath);  // Atomic (POSIX guarantee)
// Crash before rename → old state intact
// Crash after rename → new state intact
// Never partial state
```

**Guarantee**: State file is always valid JSON

### Why JSON (Not Binary)?

1. **Human-readable**:
   - Debug: `cat state.json | jq`
   - Inspect: Open in editor
   - Understand: No hex viewer needed

2. **Backward compatible**:
   - Add fields without breaking old readers
   - Version field enables migration

3. **Standard**:
   - JSON.parse/stringify built-in
   - All languages support JSON
   - No schema files needed

4. **Fast enough**:
   - Parse: <1ms for <10KB file
   - Stringify: <1ms
   - Not a bottleneck

**Trade-off**: Larger than binary (~2x size)
**Acceptable**: State files are <10KB (2x = <20KB, negligible)

---

## Consequences

### Positive

1. **Reliability**:
   - Atomic writes → no corruption
   - Crash-safe → state survives
   - Process-safe → no race conditions

2. **Performance**:
   - Read: <1ms (OS cache hit)
   - Write: <2ms (atomic rename fast)
   - No contention (separate files)

3. **Simplicity**:
   - ~50 lines (load/save/migrate)
   - No dependencies
   - Easy to test

4. **Debuggability**:
   - Human-readable JSON
   - Easy to inspect/edit manually
   - Version field for migration

5. **Scalability**:
   - 40 sessions: 40 files (independent)
   - 100 sessions: 100 files (no contention)
   - Linear scaling

### Negative

1. **Orphan files**:
   - Deleted sessions leave state files
   - Cleanup needed (separate task)
   - Disk space waste (minimal: <1MB for 100 files)

2. **No transactions**:
   - Can't atomically update multiple sessions
   - Not a requirement for this use case

3. **No indexing**:
   - `listSessions()` requires directory scan
   - Acceptable (<1ms for 100 files)

4. **File system limits**:
   - Max files in directory (ext4: ~10M)
   - Not a concern (100s of files typical)

5. **Manual cleanup**:
   - No auto-expiry (unlike SQLite with DELETE)
   - Requires cron job or manual cleanup

---

## Implementation Notes

### Atomic Write Implementation

```typescript
static save(sessionId: string, state: ScannerState): void {
  const path = this.getStatePath(sessionId);
  const tempPath = `${path}.tmp`;

  try {
    // 1. Ensure directory exists
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // 2. Write to temp file
    writeFileSync(tempPath, JSON.stringify(state, null, 2), {
      encoding: 'utf-8',
      mode: 0o600  // Owner read/write only
    });

    // 3. Atomic rename
    renameSync(tempPath, path);

  } catch (error) {
    console.error(`[StateManager] Failed to save state:`, error);

    // Cleanup orphan temp file
    try {
      unlinkSync(tempPath);
    } catch {
      // Ignore cleanup errors
    }
  }
}
```

**Error handling**:
- Ensure dir exists (create if needed)
- Write to temp (isolated)
- Rename (atomic)
- Cleanup on error (best effort)

### Fast Read with Validation

```typescript
static load(sessionId: string): ScannerState | null {
  const path = this.getStatePath(sessionId);

  if (!existsSync(path)) {
    // Try migration from old formats
    return this.migrateFromOld(sessionId);
  }

  try {
    const content = readFileSync(path, 'utf-8');
    const state = JSON.parse(content) as ScannerState;

    // Validate version
    if (state.version !== 2) {
      console.warn(`[StateManager] Unknown version ${state.version}`);
      return null;
    }

    return state;

  } catch (error) {
    console.error(`[StateManager] Failed to load state:`, error);
    return null;  // Caller creates fresh state
  }
}
```

**Error handling**:
- File missing → try migration
- Parse error → return null (fresh state)
- Invalid version → return null

### Migration from Old Formats

```typescript
private static migrateFromOld(sessionId: string): ScannerState | null {
  // Try IncrementalTranscriptScanner state
  const oldPath = `${homedir()}/.claude/session-health/cooldowns/${sessionId}-transcript.state`;

  if (existsSync(oldPath)) {
    try {
      const old = JSON.parse(readFileSync(oldPath, 'utf-8'));

      const newState: ScannerState = {
        version: 2,
        lastOffset: old.lastReadOffset || 0,
        lastMtime: old.lastReadMtime || 0,
        lastScanAt: Date.now(),
        extractorData: {
          last_message: {
            timestamp: old.lastUserMessage?.timestamp || 0,
            preview: old.lastUserMessage?.preview || '',
            sender: 'human',
            turnNumber: old.messageCount || 0
          }
        }
      };

      // Save in new format
      this.save(sessionId, newState);

      console.log(`[StateManager] Migrated old state for ${sessionId}`);
      return newState;

    } catch (error) {
      console.error(`[StateManager] Migration failed:`, error);
    }
  }

  return null;
}
```

**Strategy**:
- Check old location
- Parse old format
- Map to new schema
- Save in new location
- Log migration

---

## Validation

### Test Cases

1. **Atomic write**:
   - Simulate crash during write
   - Verify: Old state intact OR new state complete
   - Never: Partial JSON

2. **Concurrent writes**:
   - 10 processes write to different sessions
   - Verify: All writes succeed
   - No lock errors

3. **Corruption recovery**:
   - Corrupt state file (invalid JSON)
   - Verify: load() returns null
   - Next scan creates fresh state

4. **Migration**:
   - Create old-format state
   - Call load()
   - Verify: Migrated to v2, data preserved

5. **Cleanup**:
   - Create temp file
   - Simulate crash
   - Verify: Orphan temp file cleaned up

---

## Operational Considerations

### Monitoring

**Key metrics**:
- State file count (alert if >1000)
- State file size (alert if >100KB)
- Read errors (alert if >1% failure rate)
- Write errors (alert if >0.1% failure rate)

**Log samples**:
```
[StateManager] Loaded state for session-abc (offset: 123KB)
[StateManager] Saved state for session-abc (8ms)
[StateManager] Migrated old state for session-xyz
[StateManager] ERROR: Failed to save state: ENOSPC
```

### Cleanup Strategy

**Orphan state files** (session deleted but state remains):

```bash
# Find state files older than 30 days
find ~/.claude/session-health/scanners \
  -name "*.state" \
  -mtime +30 \
  -delete
```

**Temp files** (failed writes):

```bash
# Clean orphan temp files
find ~/.claude/session-health/scanners \
  -name "*.state.tmp" \
  -mtime +1 \
  -delete
```

**Automation**: Add to daily cron or CleanupManager

### Backup

**State files are replaceable** (can be regenerated):
- State loss → full rescan (slower, not data loss)
- No critical data (transcript is source of truth)
- Backup not required, but useful for performance

**Backup strategy** (optional):
```bash
# Tar all state files
tar -czf scanner-state-backup.tar.gz \
  ~/.claude/session-health/scanners/*.state
```

---

## Future Enhancements

### Compression

**Problem**: Large extractorData (>10KB) for sessions with many secrets

**Solution** (future):
```typescript
// Compress large state
if (JSON.stringify(state).length > 10_000) {
  const compressed = gzipSync(JSON.stringify(state));
  writeFileSync(tempPath, compressed);
}
```

**Benefit**: Reduce disk usage, faster I/O

### Checksum

**Problem**: Detect silent corruption (bitrot)

**Solution** (future):
```json
{
  "version": 2,
  "checksum": "sha256:abc123...",
  "data": { /* state */ }
}
```

**Benefit**: Detect corruption early

### Expiry

**Problem**: Orphan state files accumulate

**Solution** (future):
```json
{
  "version": 2,
  "expiresAt": 1739000000000,
  "data": { /* state */ }
}
```

**Benefit**: Auto-cleanup old state

---

## Related Decisions

- **ADR-001**: Incremental reading (what state is used for)
- **ADR-002**: Pluggable extractors (what extractorData contains)

---

## References

- POSIX rename() semantics (atomic guarantee)
- Git object storage (similar atomic write pattern)
- SQLite journal mode (comparison for rejected alternative)
- LevelDB design (comparison for rejected alternative)

---

**Status**: ✅ Accepted
**Implementation**: Phase 0.3-0.4 (TDD with tests first)
**Validation**: Atomic write tests, corruption recovery tests
