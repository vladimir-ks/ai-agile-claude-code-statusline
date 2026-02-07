# Immediate Action Plan - Transcript Scanner Unification

**Date**: 2026-02-07
**Priority**: P0 (Critical - Perfection Protocol)
**Estimated Duration**: 2-3 weeks

---

## Executive Summary

**What**: Unify 3 fragmented transcript scanning modules into single ultra-efficient system
**Why**: 40 concurrent sessions, <10ms performance, account switch detection
**How**: Incremental implementation with backward compatibility

**Current State**:
- ✅ Account mismatch bug fixed (email matching)
- ✅ Staleness elimination complete (triple defense)
- ✅ Architecture audit complete
- ⚠️ Transcript scanning fragmented (3 independent modules)
- ❌ Account switch detection missing
- ❌ Notifications not showing for new sessions

**Target State**:
- ✅ Single unified TranscriptScanner module
- ✅ Account switch detection working
- ✅ Notifications showing immediately
- ✅ <10ms per session, <400ms for 40 concurrent

---

## Critical Gaps Identified

### Gap 1: Account Switch Detection (P0)
**Issue**: User runs `/login` → statusline still shows old account
**Root Cause**: No mechanism to detect login commands in transcript
**Impact**: Confusing UX, wrong quota displayed
**Solution**: Implement AuthChangeDetector + session lock updates

### Gap 2: Notification Display for New Sessions (P1)
**Issue**: Notifications only show after daemon runs (~50ms delay)
**Root Cause**: display-only.ts doesn't render notifications independently
**Impact**: New sessions miss account switch messages
**Solution**: Already working as designed — document this behavior

### Gap 3: Fragmented Scanning (P1)
**Issue**: 3 modules scan transcript independently (3x file reads)
**Root Cause**: IncrementalTranscriptScanner + GitLeaksScanner + TranscriptMonitor
**Impact**: Redundant I/O, higher CPU/memory for 40 sessions
**Solution**: Unified TranscriptScanner with single-pass extraction

---

## Implementation Roadmap

### Week 1: Core Module + Account Switch Detection

**Day 1-2: Core TranscriptScanner Module**
- [ ] Create `v2/src/lib/unified-transcript-scanner.ts`
- [ ] Implement `IncrementalReader` class (reuse existing logic from IncrementalTranscriptScanner)
- [ ] Implement `LineParser` class (JSONL parsing with validation)
- [ ] Implement `StateManager` class (unified state file management)
- [ ] Implement `ResultCache` class (10s in-memory TTL)
- [ ] Write unit tests (IncrementalReader, LineParser, StateManager)

**Day 3-4: Extractors**
- [ ] Define `DataExtractor<T>` interface
- [ ] Implement `LastMessageExtractor` (port from IncrementalTranscriptScanner)
- [ ] Implement `SecretDetector` (native regex patterns, no CLI)
- [ ] Implement `CommandDetector` (NEW: detect /login, /swap-auth)
- [ ] Implement `AuthChangeDetector` (NEW: detect login success)
- [ ] Write unit tests for each extractor

**Day 5: Integration + Account Switch**
- [ ] Create `TranscriptScannerSource` (Tier 2 data source)
- [ ] Update `auth-source.ts` to use AuthChangeDetector results
- [ ] Implement session lock updates on login detection
- [ ] Register account switch notifications
- [ ] Integration tests (scanner → auth detection → lock update → notification)

**Deliverable**: Account switch detection working end-to-end

---

### Week 2: Migration + Performance Optimization

**Day 6-7: Migrate Existing Code**
- [ ] Update `TranscriptSource` to use `TranscriptScannerSource`
- [ ] Update `SecretsSource` to use `TranscriptScanner.scan().secrets`
- [ ] Remove dependency on `GitLeaksScanner` (keep as fallback)
- [ ] Update `TranscriptMonitor` calls to use `TranscriptScanner.getHealth()`
- [ ] Backward compatibility tests (ensure no regressions)

**Day 8-9: Performance Benchmarks**
- [ ] Benchmark: Single session (incremental scan)
  - Target: <10ms
  - Measure: parse time, extraction time, state I/O
- [ ] Benchmark: 40 concurrent sessions
  - Target: <400ms aggregate
  - Measure: CPU usage, memory footprint
- [ ] Benchmark: Large transcript (10MB)
  - Target: <100ms full scan, <10ms incremental
- [ ] Memory profiling (ensure <5MB per session)

**Day 10: Cross-Session Cache (Optional)**
- [ ] Implement `SharedScannerCache` (if benchmarks show need)
- [ ] Add global memory cache for parsed transcripts
- [ ] 30s TTL, per-session offset tracking
- [ ] Benchmark improvement (40 sessions → 10x speedup expected)

**Deliverable**: All existing functionality migrated to unified scanner

---

### Week 3: Deprecation + Polish

**Day 11-12: Deprecate Old Modules**
- [ ] Mark `IncrementalTranscriptScanner` as deprecated
- [ ] Mark `GitLeaksScanner` as deprecated
- [ ] Mark `TranscriptMonitor` as deprecated
- [ ] Update all callsites to use `TranscriptScanner`
- [ ] Remove old state files migration (cooldowns/ → scanners/)

**Day 13: Documentation**
- [ ] Update ARCHITECTURE.md with unified scanner design
- [ ] Add code comments (JSDoc for public API)
- [ ] Create migration guide for future extensions
- [ ] Update README with performance characteristics

**Day 14: Final Testing**
- [ ] Full regression test suite (1291+ tests)
- [ ] Manual E2E testing (account switch, large transcripts, 40 sessions)
- [ ] Performance validation (meet all targets)
- [ ] Security review (secret patterns comprehensive)

**Deliverable**: Production-ready unified scanner

---

## Implementation Details

### File Structure

```
v2/src/lib/
├── unified-transcript-scanner.ts    (NEW - main module)
├── transcript-scanner/              (NEW - subfolder)
│   ├── incremental-reader.ts
│   ├── line-parser.ts
│   ├── state-manager.ts
│   ├── result-cache.ts
│   └── extractors/
│       ├── extractor-interface.ts
│       ├── last-message-extractor.ts
│       ├── secret-detector.ts
│       ├── command-detector.ts
│       └── auth-change-detector.ts
├── sources/
│   ├── transcript-scanner-source.ts (NEW - replaces transcript-source.ts)
│   └── ...
├── incremental-transcript-scanner.ts (DEPRECATED)
├── gitleaks-scanner.ts               (DEPRECATED)
└── transcript-monitor.ts             (DEPRECATED)

v2/tests/
├── unified-transcript-scanner.test.ts (NEW)
├── transcript-scanner/               (NEW)
│   ├── incremental-reader.test.ts
│   ├── line-parser.test.ts
│   ├── extractors/
│   │   ├── last-message-extractor.test.ts
│   │   ├── secret-detector.test.ts
│   │   ├── command-detector.test.ts
│   │   └── auth-change-detector.test.ts
│   └── ...
└── integration/
    └── account-switch-flow.test.ts  (NEW)

~/.claude/session-health/
├── scanners/                         (NEW - unified state)
│   └── {sessionId}.state
└── cooldowns/                        (OLD - to be migrated)
    ├── {sessionId}-transcript.state
    └── {sessionId}-gitleaks.state
```

### Key Interfaces

```typescript
// unified-transcript-scanner.ts
export interface ScanResult {
  lastMessage: MessageInfo;
  secrets: string[];
  commands: Command[];
  authChanges: AuthChange[];
  health: TranscriptHealth;
  scanDuration: number;
}

export class UnifiedTranscriptScanner {
  static scan(sessionId: string, path: string): ScanResult;
  static register(extractor: DataExtractor<any>): void;
  static clearCache(): void;
}

// extractor-interface.ts
export interface DataExtractor<T> {
  id: string;
  shouldCache: boolean;
  cacheTTL?: number;
  extract(lines: ParsedLine[]): T;
}

// state-manager.ts
export interface ScannerState {
  version: 2;
  lastOffset: number;
  lastMtime: number;
  lastScanAt: number;
  extractorData: Record<string, any>;
}
```

---

## Testing Checklist

### Unit Tests (Target: 100+ tests)

**IncrementalReader** (10 tests):
- [ ] Cache hit (mtime/size unchanged)
- [ ] New bytes only (incremental read)
- [ ] Large file (>10MB)
- [ ] Empty file
- [ ] File deleted mid-scan

**LineParser** (15 tests):
- [ ] Valid JSONL
- [ ] Malformed lines (syntax errors)
- [ ] Mixed valid/invalid
- [ ] Empty lines
- [ ] Very long lines (>10KB)

**LastMessageExtractor** (10 tests):
- [ ] Find last human message
- [ ] No human messages
- [ ] Multiple messages
- [ ] Message count accuracy

**SecretDetector** (20 tests):
- [ ] Detect GitHub PAT
- [ ] Detect AWS keys
- [ ] Detect API keys
- [ ] Detect private keys (with validation)
- [ ] False positives (code snippets)
- [ ] Multiple secrets in one line

**CommandDetector** (10 tests):
- [ ] Detect /login
- [ ] Detect /swap-auth
- [ ] Detect with arguments
- [ ] Ignore false matches (in code)

**AuthChangeDetector** (15 tests):
- [ ] Detect login command
- [ ] Detect login success
- [ ] Detect swap command
- [ ] Multiple logins in session
- [ ] Login without success (cancelled)

**StateManager** (10 tests):
- [ ] Load existing state
- [ ] Create new state (first scan)
- [ ] Update state after scan
- [ ] Migrate from old format
- [ ] Handle corrupted state

**ResultCache** (10 tests):
- [ ] Cache hit (within TTL)
- [ ] Cache miss (expired)
- [ ] Cache invalidation
- [ ] Memory limits

### Integration Tests (Target: 20+ tests)

**Full Pipeline** (10 tests):
- [ ] Scan → Extract → Update State → Cache
- [ ] Multiple invocations (incremental)
- [ ] Session isolation (40 concurrent)
- [ ] Large transcript (10MB)
- [ ] Transcript deleted mid-session

**Account Switch Flow** (5 tests):
- [ ] /login detected → auth re-detection → lock update → notification
- [ ] /swap-auth detected
- [ ] Same account (no change)
- [ ] Multiple switches in session
- [ ] Switch without success

**Performance** (5 tests):
- [ ] <10ms per scan (incremental)
- [ ] <100ms full scan (1000 lines)
- [ ] <400ms for 40 concurrent sessions
- [ ] <5MB memory per session
- [ ] CPU usage <2% per session

### E2E Tests (Target: 5+ tests)

- [ ] New session → account detected → quota displayed
- [ ] Mid-session /login → account switched → notification shown
- [ ] Large transcript (10MB) → no performance degradation
- [ ] 40 concurrent sessions → all display correct data
- [ ] Notification lifecycle (30s show, 5min hide, repeat)

---

## Performance Targets

| Metric | Current | Target | Method |
|---|---|---|---|
| **Incremental scan (100 new lines)** | 5ms | 3ms | Unified parsing |
| **Full scan (1000 lines)** | 100ms | 50ms | Single-pass |
| **Secret detection (1000 lines)** | 150ms | 2ms | Native regex |
| **40 concurrent sessions** | 4000ms | 400ms | Cross-session cache |
| **Memory per session** | 15MB | 5MB | Unified state |
| **CPU per session (idle)** | 5% | <2% | Efficient polling |

---

## Risk Mitigation

### Risk 1: Breaking Changes
**Mitigation**: Backward compatible API, keep old modules as fallback

### Risk 2: Performance Regression
**Mitigation**: Comprehensive benchmarks, rollback plan

### Risk 3: Secret Detection Accuracy
**Mitigation**: Hybrid approach (fast regex + CLI fallback on cooldown)

### Risk 4: State Migration Issues
**Mitigation**: Automated migration, handle both old and new formats

---

## Success Criteria

✅ **Functional**:
- Account switch detection working end-to-end
- Notifications displaying immediately (after daemon runs)
- All 1291+ tests passing
- Zero regressions in existing functionality

✅ **Performance**:
- <10ms per incremental scan
- <400ms for 40 concurrent sessions
- <5MB memory per session
- <2% CPU per session (idle)

✅ **Architecture**:
- Single unified TranscriptScanner module
- Pluggable extractor interface
- Clean deprecation path for old modules

✅ **Documentation**:
- Architecture diagrams complete
- Code comments comprehensive
- Migration guide for future extensions

---

## Next Immediate Steps

**TODAY (Day 1)**:
1. Create branch: `feature/unified-transcript-scanner`
2. Implement core TranscriptScanner class
3. Implement IncrementalReader (port from existing)
4. Implement LineParser
5. Write initial unit tests

**TOMORROW (Day 2)**:
6. Implement StateManager
7. Implement ResultCache
8. Complete unit tests for core
9. Start LastMessageExtractor

**This Week**:
- Complete all extractors
- Implement account switch detection
- Integration tests
- **Deliverable**: Account switch working

---

## Open Questions

1. **Gitleaks CLI**: Keep as fallback or fully remove?
   - **Decision**: Hybrid — native regex always, CLI on 5min cooldown (background)

2. **State file migration**: Automatic or manual?
   - **Decision**: Automatic — detect old format, migrate on first read

3. **Cross-session cache**: Implement Week 2 or defer?
   - **Decision**: Defer to Week 2, only if benchmarks show need

4. **Account detection on /swap-auth**: Verify keychain hash?
   - **Decision**: Yes — compare keychain service name to confirm actual change

---

## Commit Strategy

1. **Spec docs** (now): Commit architecture + spec documents
2. **Core module** (Day 2): Commit TranscriptScanner + IncrementalReader + LineParser
3. **Extractors** (Day 4): Commit all extractors
4. **Integration** (Day 5): Commit account switch detection
5. **Migration** (Day 7): Commit removal of old modules
6. **Final** (Day 14): Commit deprecation + docs

---

This plan provides a clear, executable path to implementing the unified transcript scanner system with account switch detection, maintaining strict performance targets and backward compatibility.
