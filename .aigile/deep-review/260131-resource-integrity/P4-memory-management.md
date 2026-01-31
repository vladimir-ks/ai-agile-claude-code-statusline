# Review: Memory Management

**Files Reviewed:**
- `/v2/src/broker/data-broker.ts`
- `/v2/src/lib/memory-monitor.ts`
- `/v2/src/lib/transcript-monitor.ts`
- `/v2/src/lib/health-store.ts`

---

## Memory Leak Risks

### 1. Event Listener Issues

| File | Issue | Severity |
|------|-------|----------|
| `data-broker.ts:69` | `setMaxListeners(100)` - arbitrary limit, no tracking | LOW |
| `memory-monitor.ts:78` | `setMaxListeners(100)` - same pattern | LOW |
| `data-broker.ts:283` | `removeAllListeners()` called in `shutdown()` - GOOD | OK |
| `memory-monitor.ts:646` | `removeAllListeners()` called in `destroy()` - GOOD | OK |

**Finding:** Both classes use `setMaxListeners(100)` but properly clean up listeners on shutdown. No listener accumulation risk observed.

### 2. Interval Leaks

| File | Line | Pattern | Status |
|------|------|---------|--------|
| `data-broker.ts:207` | `setInterval` in `startCleanupTimer()` | Cleared in `shutdown()` (line 271) - GOOD |
| `memory-monitor.ts:126` | `setInterval` in `start()` | Cleared in `stop()` (line 148) - GOOD |

**Finding:** All intervals properly tracked and cleared.

### 3. Cache Unbounded Growth

| File | Issue | Severity |
|------|-------|----------|
| `data-broker.ts:187-204` | `enforceMaxCacheSize()` - LRU eviction only removes 1 entry at a time | MEDIUM |

**Problem:** If cache size exceeds `maxCacheSize`, only ONE entry evicted per new entry. Under high burst load, cache can temporarily exceed limit.

**Code:**
```typescript
private enforceMaxCacheSize(): void {
  if (this.cache.size <= this.config.maxCacheSize) return;
  // Only removes ONE entry
  if (lruKey) {
    this.cache.delete(lruKey);
  }
}
```

**Recommendation:** Loop until cache size within bounds:
```pseudo
while cache.size > maxCacheSize:
  evict_lru()
```

### 4. In-Flight Promise Map

| File | Issue | Severity |
|------|-------|----------|
| `data-broker.ts:54` | `inFlight: Map<string, Promise<any>>` | LOW |
| `data-broker.ts:176` | Promise removed via `.finally()` - GOOD | OK |

**Finding:** Promises properly cleaned up in `finally()` block. No accumulation risk.

### 5. Measurements Array Growth

| File | Issue | Severity |
|------|-------|----------|
| `memory-monitor.ts:179-183` | `measurements[]` capped at 60 entries - GOOD | OK |
| `memory-monitor.ts:241-243` | `heapGrowthHistory[]` capped at 10 entries - GOOD | OK |

**Finding:** Both arrays properly bounded.

---

## Buffer Handling Issues

### 1. Large File Reads (CRITICAL)

| File | Line | Issue | Severity |
|------|------|-------|----------|
| `transcript-monitor.ts:94` | `readFileSync(path, 'utf-8')` reads ENTIRE file | HIGH |
| `transcript-monitor.ts:113` | Same pattern in `parseTranscript()` | HIGH |

**Problem:** Despite size check at line 57 (`if (stats.size > 1_000_000)`), the `getLastUserMessageFromTail()` method STILL reads entire file:

```typescript
// Line 92-98: READS FULL FILE, THEN SLICES
private getLastUserMessageFromTail(path: string) {
  const content = readFileSync(path, 'utf-8');  // OOM risk!
  const readSize = Math.min(2_000_000, content.length);
  const lastChunk = content.slice(-readSize);
  // ...
}
```

**Impact:** Transcript files can grow to 10MB+. Reading full file into memory defeats the purpose of "tail reading".

**Recommendation:** Use streaming or `fs.open()` with seek:
```pseudo
fd = fs.openSync(path)
pos = Math.max(0, fileSize - 2MB)
fs.readSync(fd, buffer, pos, 2MB)
```

### 2. Synchronous File Operations

| File | Pattern | Issue |
|------|---------|-------|
| `health-store.ts` | `readFileSync`, `writeFileSync`, `statSync`, `readdirSync` | Blocks event loop |
| `transcript-monitor.ts` | `readFileSync`, `statSync` | Blocks event loop |

**Finding:** All file operations synchronous. Acceptable for statusline (short-lived process), but could block under heavy disk I/O.

### 3. JSON Parsing Unbounded

| File | Line | Issue |
|------|------|-------|
| `transcript-monitor.ts:122` | `JSON.parse(lines[i])` - no size validation | MEDIUM |
| `health-store.ts:100` | `JSON.parse(content)` - no size limit | LOW |

**Problem:** Large JSON objects parsed without memory budgets. Malformed transcript with huge single-line entry could spike memory.

---

## Additional Findings

### 1. Session Memory Map Unbounded

| File | Issue | Severity |
|------|-------|----------|
| `memory-monitor.ts:54` | `sessionMemory: Map<string, SessionMemory>` | LOW |

**Finding:** No explicit limit on tracked sessions. `removeSession()` exists but relies on external cleanup.

### 2. Sessions Map in DataBroker

| File | Issue | Severity |
|------|-------|----------|
| `data-broker.ts:55` | `sessions: Map<string, SessionMeta>` | LOW |
| `data-broker.ts:206-224` | Cleanup timer removes inactive sessions - GOOD | OK |

**Finding:** Sessions cleaned up after 1 hour of inactivity.

### 3. No Memory Pressure Handling

**Finding:** `memory-monitor.ts` detects memory issues but has no circuit breaker to prevent OOM. Alerts emitted but no corrective action taken.

---

## Recommendations

### Critical (P0)
1. **Fix transcript tail read** - `getLastUserMessageFromTail()` must not read entire file. Use `fs.open()` + seek or streaming.

### High (P1)
2. **Batch cache eviction** - Loop until cache within bounds, not single eviction
3. **Add JSON size validation** - Reject lines >1MB in transcript parsing

### Medium (P2)
4. **Memory pressure circuit breaker** - When near budget, skip non-essential operations
5. **Session map cleanup timer** - Add TTL for `memory-monitor.ts` sessions

### Low (P3)
6. **Consider async file ops** - For future scalability (not urgent for current use case)

---

## Summary

| Category | Status | Issues Found |
|----------|--------|--------------|
| Event Listeners | GOOD | Properly cleaned up |
| Interval Leaks | GOOD | All intervals cleared |
| Cache Bounds | PARTIAL | Eviction one-at-a-time bug |
| Large File Reads | CRITICAL | Full file read despite >1MB check |
| Promise Chains | GOOD | Cleaned via finally() |
| Buffer/Stream | BAD | All sync reads, no streaming |

**Overall Risk: MEDIUM-HIGH**

Primary concern: `transcript-monitor.ts` reads entire file for "tail" operation. With 10MB+ transcripts, this can cause OOM or significant memory pressure during each statusline update.

**Quick Win:** Fix `getLastUserMessageFromTail()` to actually read only the tail.
