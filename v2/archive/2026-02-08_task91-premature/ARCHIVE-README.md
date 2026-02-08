# Archive: Task #91 Premature Implementation

**Date Archived**: 2026-02-08
**Reason**: Code written without specs/tests first (violated TDD principle)
**Status**: Reference only - DO NOT USE

---

## What Was Archived

6 files, ~1200 lines of code created on 2026-02-08 07:44-07:46:

1. `unified-transcript-scanner.ts` (320 lines) - Main coordinator
2. `transcript-scanner/types.ts` (150 lines) - TypeScript interfaces
3. `transcript-scanner/incremental-reader.ts` (120 lines) - Byte-level reading
4. `transcript-scanner/line-parser.ts` (130 lines) - JSONL parsing
5. `transcript-scanner/state-manager.ts` (220 lines) - State persistence
6. `transcript-scanner/result-cache.ts` (130 lines) - In-memory cache

**Total**: ~1170 lines

---

## Why Archived

**Violation**: SDD → BDD → TDD methodology

User directive (2026-02-08):
> "You can move forward, but be careful and plan carefully. Follow SDD, BDD, and TDD, and make sure that all of your planning is thorough... Specs and Tests before code... No placeholders..."

**Problem**: Implementation started WITHOUT:
- ❌ Complete API specification
- ❌ Behavior specification (.feature file)
- ❌ Test harness
- ❌ Any tests (RED state)

**Correct order**:
1. SDD: Write specs ✅ (done in Phase 0.2)
2. BDD: Write .feature files ✅ (done in Phase 0.2)
3. TDD: Write tests (RED) ⏳ (Phase 0.3)
4. Implementation: Make tests pass (GREEN) ⏳ (Phase 1)
5. Refactor: Clean up code ⏳ (Phase 1)

**Task #91 skipped steps 2-3** and went straight to implementation.

---

## What's Good (To Reuse)

Per code inventory matrix (`.ai-logs/docs/0208_08-24_code-inventory-matrix.md`):

### Architectural Patterns ✅

1. **Static class pattern**:
   ```typescript
   class UnifiedTranscriptScanner {
     private static extractors = new Map<string, DataExtractor<any>>();
     static register() { /* ... */ }
     static scan() { /* ... */ }
   }
   ```
   - Clean API
   - No instance management
   - **Reuse**: Copy structure to new implementation

2. **Pluggable extractors**:
   ```typescript
   interface DataExtractor<T> {
     id: string;
     extract(lines: ParsedLine[]): T;
   }
   ```
   - Good interface design
   - **Reuse**: Port to new types.ts

3. **Cache layering**:
   ```
   Memory cache (10s) → State file (persistent) → Disk read
   ```
   - Correct architecture
   - **Reuse**: Same pattern in new code

4. **Atomic writes**:
   ```typescript
   writeFileSync(tempPath, ...);
   renameSync(tempPath, finalPath);
   ```
   - Correct pattern
   - **Reuse**: Copy to new StateManager

### Algorithm Patterns ✅

1. **Cache hit detection** (incremental-reader.ts):
   ```typescript
   if (stats.mtimeMs === lastMtime && stats.size === lastOffset) {
     return { cacheHit: true, ... };
   }
   ```
   - **Reuse**: Port to new IncrementalReader

2. **Byte-level read** (incremental-reader.ts):
   ```typescript
   const newBytes = size - lastOffset;
   readSync(fd, buffer, 0, newBytes, lastOffset);
   ```
   - **Reuse**: Port to new IncrementalReader

3. **Parallel extractor execution** (unified-transcript-scanner.ts):
   ```typescript
   await Promise.all(
     extractors.map(ext => ext.extract(lines))
   );
   ```
   - **Reuse**: Copy to new UnifiedScanner

---

## What's Bad (Don't Reuse)

### Missing Tests ❌

- **ZERO tests** for any module
- No test harness
- No fixtures
- No mocks
- **Coverage**: 0%

**Impact**: Cannot validate correctness

### Missing Validation ❌

1. **No sessionId validation** (state-manager.ts):
   ```typescript
   static getStatePath(sessionId: string): string {
     return `${this.STATE_DIR}/${sessionId}.state`;
     // VULNERABLE: Path traversal if sessionId = "../../../etc/passwd"
   }
   ```

2. **No file size limits** (incremental-reader.ts):
   ```typescript
   const buffer = Buffer.alloc(newBytes);
   // VULNERABLE: OOM if newBytes = 1GB
   ```

3. **No timeout on extractors** (unified-transcript-scanner.ts):
   ```typescript
   await Promise.all(extractors.map(ext => ext.extract(lines)));
   // VULNERABLE: Hangs forever if extractor loops
   ```

### Missing Error Handling ❌

1. **Uncaught errors propagate** (line-parser.ts):
   ```typescript
   const obj = JSON.parse(line);
   // Throws on invalid JSON, no try-catch
   ```

2. **No graceful degradation** (result-cache.ts):
   ```typescript
   return JSON.stringify(result).length * 2;
   // Throws if result has circular refs
   ```

---

## Migration Strategy

### Step 1: Extract Good Patterns (Phase 0.4)

Create pseudocode files with proven patterns:

```typescript
// v2/src/lib/transcript-scanner/incremental-reader.ts (NEW)
class IncrementalReader {
  static read(path, lastOffset, lastMtime) {
    // TODO: Port cache hit detection from archived code
    // TODO: Port byte-level read from archived code
    // TODO: ADD validation (file size limit)
    // TODO: ADD error handling (try-catch)
  }
}
```

### Step 2: Write Tests First (Phase 0.3)

```typescript
// v2/tests/transcript-scanner/incremental-reader.test.ts (NEW)
test('Cache hit: mtime + size unchanged → no read', () => {
  // Test logic from API spec
  // Implementation will make this pass
});

test('File size limit: 60MB file → throw error', () => {
  // New test (not in archived code)
  // Forces us to add validation
});
```

### Step 3: Implement with TDD (Phase 1)

1. Run tests → RED (all fail)
2. Copy proven patterns from archive
3. Add missing validation/error handling
4. Run tests → GREEN (all pass)
5. Refactor

---

## Lessons Learned

### What Went Wrong

1. **Rushed implementation**: Went straight to code without specs/tests
2. **No validation**: Skipped security checks (path traversal, OOM)
3. **No tests**: Cannot verify correctness
4. **No review**: Violated user's explicit directive

### What To Do Instead

1. **Specs first**: Write complete API spec (DONE ✅)
2. **Behaviors first**: Write .feature file (DONE ✅)
3. **Tests first**: Write test harness + all tests (RED state)
4. **Then implement**: Make tests pass (GREEN)
5. **Then refactor**: Clean up code

**Mantra**: RED → GREEN → REFACTOR (TDD)

---

## References

- Phase 0 Plan: `.ai-logs/plans/0208_08-24_unified-scanner-phase0-plan.md`
- Code Inventory: `.ai-logs/docs/0208_08-24_code-inventory-matrix.md`
- API Spec: `.ai-logs/specs/0208_08-25_unified-scanner-api-spec.md`
- Behavior Spec: `.ai-logs/specs/0208_08-25_unified-scanner-behaviors.feature`

---

## Next Steps

1. ✅ Archive complete (you are here)
2. ⏳ Phase 0.3: Write test harness
3. ⏳ Phase 0.3: Write all tests (RED state)
4. ⏳ Phase 0.4: Create pseudocode structure
5. ⏳ Phase 1: TDD implementation (reuse patterns from archive)

**Remember**: Tests before code. Always.

---

**Archive Status**: ✅ COMPLETE
**Preserved for**: Pattern reference only
**Do not use**: Lacks tests, validation, error handling
