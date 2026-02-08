# ADR-002: Pluggable Extractor Architecture

**Date**: 2026-02-08 08:25
**Status**: Accepted
**Context**: UnifiedTranscriptScanner Phase 0

---

## Context

Current transcript scanning is fragmented across 3 hard-coded modules:

1. **IncrementalTranscriptScanner**: Last message + message count
2. **GitLeaksScanner**: Secret detection
3. **TranscriptMonitor**: Health metrics (deprecated, duplicate logic)

**Problems**:

- **Tight coupling**: Data extraction logic mixed with file I/O
- **No extensibility**: Adding new data type requires modifying core
- **Code duplication**: Each module re-reads same transcript
- **Single-threaded**: Extractors run sequentially, not parallel

**New requirements** (Task #93):

- Command detection (`/login`, `/swap-auth`)
- Auth change detection (account switch)
- Future: Custom extractors for user-specific needs

---

## Decision

**Use pluggable DataExtractor interface with registry pattern.**

### Core Interface

```typescript
interface DataExtractor<T> {
  id: string;                    // Unique identifier
  shouldCache: boolean;          // Cache results in state?
  cacheTTL?: number;             // Optional cache duration

  extract(lines: ParsedLine[]): T | Promise<T>;
}
```

### Registration

```typescript
// Core module initialization
UnifiedTranscriptScanner.register(new LastMessageExtractor());
UnifiedTranscriptScanner.register(new SecretDetector());
UnifiedTranscriptScanner.register(new CommandDetector());
UnifiedTranscriptScanner.register(new AuthChangeDetector());

// User can add custom extractors
UnifiedTranscriptScanner.register(new CustomExtractor());
```

### Execution

```typescript
// Scan once, extract in parallel
const lines = LineParser.parse(newBytes);

const results = await Promise.all(
  extractors.map(ext => ext.extract(lines))
);
```

---

## Alternatives Considered

### Alternative 1: Hard-Coded Extractors

**Approach**: Keep extraction logic inside UnifiedScanner.scan()

```typescript
async scan(sessionId, path) {
  // Read + parse
  const lines = parse(newBytes);

  // Hard-coded extraction
  const lastMessage = extractLastMessage(lines);
  const secrets = detectSecrets(lines);
  const commands = detectCommands(lines);

  return { lastMessage, secrets, commands };
}
```

**Pros**:
- Simpler (no interface, no registry)
- All logic in one place
- Direct function calls (no indirection)

**Cons**:
- ❌ Not extensible (need to modify core for new data types)
- ❌ Tight coupling (file I/O + extraction mixed)
- ❌ Not testable in isolation
- ❌ Can't parallelize (sequential calls)

**Rejected**: Violates Open/Closed Principle (SOLID).

---

### Alternative 2: Event-Based (Observer Pattern)

**Approach**: Emit events for each line, extractors subscribe

```typescript
scanner.on('line', (line) => {
  // Each extractor handles line
  lastMessageExtractor.onLine(line);
  secretDetector.onLine(line);
});

scanner.scan(path);
```

**Pros**:
- Decoupled (extractors don't know about scanner)
- Streaming (process lines one at a time)

**Cons**:
- ❌ Complex (event system overhead)
- ❌ Hard to parallelize (sequential event loop)
- ❌ State management harder (extractors must track context)
- ❌ Debugging harder (event flow obscure)

**Rejected**: Over-engineered for this use case.

---

### Alternative 3: Pipeline Pattern

**Approach**: Chain extractors, each transforms data

```typescript
const result = scan(path)
  .pipe(new LastMessageExtractor())
  .pipe(new SecretDetector())
  .pipe(new CommandDetector())
  .run();
```

**Pros**:
- Functional style
- Composable

**Cons**:
- ❌ Sequential (can't parallelize)
- ❌ Each extractor must pass data to next
- ❌ Hard to share parsed lines (each has own copy)

**Rejected**: Sequential execution is slower.

---

### Alternative 4: Strategy Pattern (Single Extractor)

**Approach**: One extractor interface, scanner calls multiple

```typescript
interface Extractor {
  extract(path: string): any;
}

// Each extractor reads file independently
const msg = new LastMessageExtractor().extract(path);
const secrets = new SecretDetector().extract(path);
```

**Pros**:
- Simple interface
- Independent extractors

**Cons**:
- ❌ Each extractor reads file separately (3x I/O)
- ❌ Each extractor parses separately (3x CPU)
- ❌ No shared state

**Rejected**: Wasteful I/O and parsing.

---

## Rationale

### Why Pluggable Interface?

1. **Extensibility** (Open/Closed Principle):
   - Add new extractors without modifying core
   - Users can add custom extractors
   ```typescript
   // No core changes needed
   scanner.register(new MyCustomExtractor());
   ```

2. **Separation of Concerns**:
   - Scanner: File I/O + parsing
   - Extractors: Data extraction logic
   - Clear boundaries, easier testing

3. **Parallel Execution**:
   - All extractors receive same `ParsedLine[]`
   - Run concurrently via `Promise.all()`
   - Total time = max(durations), not sum

4. **Testability**:
   - Test extractors in isolation (mock ParsedLine[])
   - Test scanner with mock extractors
   - Unit test coverage easier

### Why Registry Pattern?

1. **Dynamic registration**:
   - Extractors registered at init
   - No compile-time coupling

2. **Discovery**:
   - List all registered extractors
   - Inspect capabilities

3. **Configuration**:
   - Enable/disable extractors
   - Override defaults

### Why Single Parse?

**Problem**: Old architecture parses 3 times

```
IncrementalTranscriptScanner.checkHealth()
  → Read file, parse JSONL, extract last message

GitLeaksScanner.scan()
  → Read file again, parse JSONL, detect secrets

TranscriptMonitor.checkHealth()
  → Read file again, parse JSONL, extract health
```

**Solution**: Parse once, share with all extractors

```
UnifiedTranscriptScanner.scan()
  → Read file once
  → Parse JSONL once
  → Pass lines to all extractors (parallel)
```

**Benefit**: 3x faster (one parse vs three)

---

## Consequences

### Positive

1. **Extensible**:
   - Add CommandDetector: 50 lines (isolated)
   - No changes to core scanner

2. **Parallel**:
   - 3 extractors @ 5ms each = 5ms total (not 15ms)
   - Scales with CPU cores

3. **Testable**:
   - Mock extractors for scanner tests
   - Mock lines for extractor tests
   - High coverage achievable

4. **Cacheable**:
   - Extractor results stored in state
   - Expensive operations (secrets) cached

5. **Observable**:
   - Per-extractor timing metrics
   - Easy to identify slow extractors

### Negative

1. **Complexity**:
   - Registry management
   - Interface compliance checking
   - ~100 lines overhead

2. **Indirection**:
   - Harder to trace execution
   - IDE "go to definition" less useful

3. **Memory overhead**:
   - All extractors receive same `ParsedLine[]`
   - Large arrays duplicated in memory (ref counted)

4. **Ordering constraints**:
   - Some extractors may depend on others
   - Current design: all independent (no ordering)

---

## Implementation Notes

### Extractor Interface

```typescript
interface DataExtractor<T> {
  id: string;               // "last_message", "secrets", etc.
  shouldCache: boolean;     // Store in state for fast access
  cacheTTL?: number;        // Override default cache TTL

  extract(lines: ParsedLine[]): T | Promise<T>;
}
```

**Contract**:
- `id`: Unique (enforced at registration)
- `shouldCache`: true → results stored in state
- `cacheTTL`: Optional override (default: 10s)
- `extract()`: MUST NOT throw (return default on error)

### Registration

```typescript
class UnifiedTranscriptScanner {
  private static extractors = new Map<string, DataExtractor<any>>();

  static register(extractor: DataExtractor<any>): void {
    if (!extractor.id) {
      throw new Error('Extractor ID required');
    }
    if (this.extractors.has(extractor.id)) {
      console.warn(`Extractor ${extractor.id} already registered, replacing`);
    }
    this.extractors.set(extractor.id, extractor);
  }
}
```

### Parallel Execution

```typescript
async runExtractors(lines: ParsedLine[]): Promise<Record<string, any>> {
  const results: Record<string, any> = {};

  const promises = Array.from(this.extractors.entries()).map(
    async ([id, extractor]) => {
      const start = Date.now();
      try {
        results[id] = await extractor.extract(lines);
        results._durations[id] = Date.now() - start;
      } catch (error) {
        console.error(`Extractor ${id} failed:`, error);
        results[id] = state.extractorData?.[id] || null; // Fallback
      }
    }
  );

  await Promise.all(promises);
  return results;
}
```

**Benefits**:
- Timeout per extractor (5s)
- Fallback to cached data on error
- Timing metrics per extractor

### Example Extractor

```typescript
class LastMessageExtractor implements DataExtractor<MessageInfo> {
  id = 'last_message';
  shouldCache = true;
  cacheTTL = 10_000;

  extract(lines: ParsedLine[]): MessageInfo {
    // Scan backward for last user message
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.data) continue;

      if (line.data.type === 'user' && line.data.message?.content) {
        return {
          timestamp: new Date(line.data.timestamp).getTime(),
          preview: this.extractText(line.data.message.content),
          sender: 'human',
          turnNumber: this.countMessages(lines.slice(0, i + 1))
        };
      }
    }

    // No message found
    return { timestamp: 0, preview: '', sender: 'unknown', turnNumber: 0 };
  }

  private extractText(content: any): string { /* ... */ }
  private countMessages(lines: ParsedLine[]): number { /* ... */ }
}
```

---

## Validation

### Test Cases

1. **Registration**:
   - Register extractor → exists in registry
   - Re-register → replaces old
   - Invalid ID → throws

2. **Parallel execution**:
   - 3 extractors @ 5ms each → total <10ms (not 15ms)
   - Measure with performance.now()

3. **Error handling**:
   - Extractor throws → fallback to cached data
   - Extractor timeout → killed, cached data used

4. **Caching**:
   - shouldCache=true → result in state
   - shouldCache=false → not stored

---

## Future Enhancements

### Extractor Dependencies

**Problem**: AuthChangeDetector may depend on CommandDetector

**Solution** (future):
```typescript
interface DataExtractor<T> {
  dependencies?: string[];  // IDs of required extractors

  extract(lines: ParsedLine[], deps: Record<string, any>): T;
}

class AuthChangeDetector implements DataExtractor<AuthChange[]> {
  dependencies = ['commands'];

  extract(lines, deps) {
    const commands = deps.commands; // Use command results
    // ...
  }
}
```

**Implementation**: Topological sort of extractors by dependencies

### Stream Processing

**Problem**: Large transcripts (10MB+) may exhaust memory

**Solution** (future):
```typescript
interface StreamExtractor<T> {
  onLine(line: ParsedLine): void;
  finalize(): T;
}
```

**Benefit**: Process line-by-line, O(1) memory

---

## Related Decisions

- **ADR-001**: Incremental reading (why single parse is possible)
- **ADR-003**: State management (where extractor data is cached)

---

## References

- Strategy Pattern (Gang of Four)
- Open/Closed Principle (SOLID)
- Observer Pattern (for rejected alternative)
- Webpack Plugin System (similar registry pattern)

---

**Status**: ✅ Accepted
**Implementation**: Phase 0.3-0.4 (TDD with tests first)
**Validation**: Parallel execution benchmarks in Phase 2
