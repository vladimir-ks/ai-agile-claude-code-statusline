# Deep Review Summary: Resource Integrity & Optimization

**Date**: 2026-01-31
**Session**: swift-tinkering-glade
**Review Scope**: 6 parallel deep-dive analyses

---

## Executive Summary

Conducted comprehensive parallel code review across 6 critical areas using specialized Haiku agents. Found **3 critical issues**, **5 high-priority gaps**, and **8 medium-priority improvements**. Overall assessment: architecture is sound but has specific gaps requiring immediate attention.

---

## Critical Issues (P0 - Fix Immediately)

### 1. Model Detection Priority Inversion
**File**: `v2/src/lib/model-resolver.ts:102-149`
**Severity**: CRITICAL
**Impact**: Displays wrong model when switching sessions

Stale transcript data (up to 1 hour old) takes precedence over real-time JSON input. A 59-minute-old Sonnet session transcript overrides current Haiku session's JSON.

**Root Cause**: Priority order in `selectBest()` method
- Current: Transcript (<1h) → JSON input → Settings
- Should be: JSON input → Fresh transcript (<5m) → Settings

**Fix**: 5-line change to invert priority + reduce transcript TTL from 3600s to 300s

**Details**: `.aigile/deep-review/260131-resource-integrity/P1-model-detection.md`

---

### 2. Secrets Detection False Positives
**File**: `v2/src/lib/data-gatherer.ts:322`
**Severity**: CRITICAL (UX Impact)
**Impact**: Alert persists despite no actual secrets

Regex pattern `/-----BEGIN.*PRIVATE KEY-----/g` matches text *mentions* of keys in conversation, not just actual keys. User discussing "How do private keys work?" triggers alert.

**Root Cause**: Pattern too broad - matches 30-char header mentions instead of requiring actual 500-3000 char key content

**Fix**: Require BEGIN/END pair with substantial content between
```
/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]{50,4096}?-----END[A-Z ]*PRIVATE KEY-----/g
```

**Details**: `.aigile/deep-review/260131-resource-integrity/P2-secrets-detection.md`

---

### 3. Billing Cache Race Condition
**File**: `v2/src/lib/data-gatherer.ts:144-146`
**Severity**: CRITICAL
**Impact**: File corruption under load (10+ concurrent sessions)

`billing-shared.json` write uses direct `writeFileSync` (non-atomic) AND occurs AFTER lock is released.

**Root Causes**:
1. No atomic write (rest of system uses temp+rename pattern)
2. Lock released by ccusage module BEFORE caller writes cache
3. 10 sessions writing simultaneously = corrupted JSON

**Fix**:
1. Use `atomicWrite()` pattern from health-store
2. Hold lock during cache write OR move write inside lock scope

**Details**: `.aigile/deep-review/260131-resource-integrity/P5-cache-coordination.md`

---

## High Priority Issues (P1)

### 4. Transcript Full-File Read (Memory Risk)
**File**: `v2/src/lib/transcript-monitor.ts:94`
**Impact**: OOM risk with 10MB+ transcripts

`getLastUserMessageFromTail()` reads ENTIRE file with `readFileSync()`, then slices - defeats purpose of "tail reading".

**Fix**: Use `fs.open()` + seek to read only last 2MB
```pseudo
fd = fs.openSync(path)
pos = Math.max(0, fileSize - 2MB)
fs.readSync(fd, buffer, pos, 2MB)
```

**Details**: `.aigile/deep-review/260131-resource-integrity/P4-memory-management.md`

---

### 5. Cache Eviction Bug
**File**: `v2/src/broker/data-broker.ts:187-204`
**Impact**: Burst loads temporarily exceed cache size

`enforceMaxCacheSize()` removes only ONE entry when cache exceeds limit. Should loop until within bounds.

**Fix**:
```pseudo
while cache.size > maxCacheSize:
  evict_lru()
```

**Details**: `.aigile/deep-review/260131-resource-integrity/P4-memory-management.md`

---

### 6. Duplicate Secret Scanners
**Files**:
- `v2/src/lib/data-gatherer.ts:305-338` (5 patterns)
- `v2/src/modules/secrets-detector-module.ts` (22+ patterns)

Two independent implementations with different pattern sets = maintenance burden + inconsistent behavior.

**Fix**: Consolidate to single scanner, preferably secrets-detector-module (more comprehensive)

**Details**: `.aigile/deep-review/260131-resource-integrity/P2-secrets-detection.md`

---

### 7. Lock Retry Timeout Too Short
**File**: `v2/src/lib/process-lock.ts:34`
**Impact**: Sessions give up on lock, use stale data

`maxRetries: 3` at 100ms interval = 300ms total wait, but ccusage takes 20-30s.

**Fix**: Increase retries or implement exponential backoff
- Suggested: 5 retries with doubling (100, 200, 400, 800, 1600ms = 3.1s total)

**Details**: `.aigile/deep-review/260131-resource-integrity/P5-cache-coordination.md`

---

### 8. No Session Cleanup
**File**: `v2/src/lib/health-store.ts:286-291`
**Impact**: Unbounded growth of session health files

`deleteSession()` method exists but never called. Sessions accumulate forever in `~/.claude/session-health/`.

**Fix**: Add cleanup timer (e.g., delete sessions >7 days old on daemon start)

**Details**: `.aigile/deep-review/260131-resource-integrity/P5-cache-coordination.md`

---

## Medium Priority Issues (P2)

### 9. Validators are Dead Code
**File**: `/v2/src/validators/*` (~2000 LOC)
**Impact**: Maintenance burden with zero benefit

All 5 validators (`ContextValidator`, `CostValidator`, `TimestampValidator`, `ModelValidator`, `GitValidator`) and `ValidationEngine` are fully implemented but NEVER called in production.

**Decision Required**:
- Option A: Integrate validators into data-gatherer (enable confidence-based display)
- Option B: Delete dead code (reduce maintenance)

**Details**: `.aigile/deep-review/260131-resource-integrity/P6-data-validation.md`

---

### 10. Display Layer Lacks Type Guards
**File**: `v2/src/display-only.ts:144-159`
**Impact**: Could display "NaN" or "Infinity" if data corrupted

`formatTokens()` and `formatMoney()` have basic guards but no `typeof` or `isFinite()` checks.

**Fix**:
```typescript
if (typeof tokens !== 'number' || !isFinite(tokens) || tokens < 0) return '0';
```

**Details**: `.aigile/deep-review/260131-resource-integrity/P6-data-validation.md`

---

### 11. No Upper Bounds on Display Values
**Files**: Various display formatters
**Impact**: Corrupted data could show "999999h" budget

Lower bounds enforced (`Math.max(0, ...)`), but no upper bounds.

**Fix**: Add sanity caps
```typescript
const mins = Math.max(0, Math.min(h.billing.budgetRemaining || 0, 99999));
```

**Details**: `.aigile/deep-review/260131-resource-integrity/P6-data-validation.md`

---

### 12-16. Additional Medium Priority Items
- Variable billing TTL based on burn rate (P5-cache-coordination.md)
- Reduce stale lock timeout for crashed processes (P5-cache-coordination.md)
- Add signal handlers to data-daemon (P3-process-lifecycle.md)
- Memory pressure circuit breaker (P4-memory-management.md)
- JSON size validation in transcript parsing (P4-memory-management.md)

---

## What's Working Well

### Process Lifecycle ✅
- `disown` + timeout pattern correctly implemented
- Shell script enforces 30s max lifecycle with SIGKILL
- Lock has PID check + age-based stale detection
- No `setInterval` leaks found
- Event listeners properly cleaned up

### Memory Management ✅
- All intervals tracked and cleared
- In-flight promises cleaned via `finally()` blocks
- Measurement arrays properly bounded (60 entries max)
- Heap growth history capped at 10 entries

### Data Protection ✅
- Division by zero protected everywhere
- Nested structure handling uses optional chaining
- `health-store.ts` uses atomic writes (temp+rename)
- Lock acquisition atomic via `wx` flag
- Clear separation between shared and session data

### Validation Foundations ✅
- NaN propagation prevented by `|| 0` fallbacks
- Percentage values capped at 100
- Token values have lower bounds
- Context window size validated (10k-500k range)

---

## Recommended Action Plan

### Phase 1: Critical Fixes (This Week)
1. Fix model resolver priority inversion (5 lines)
2. Fix secrets regex to require full key content (2 files)
3. Implement atomic write for billing-shared.json + hold lock during write

### Phase 2: High Priority (Next Sprint)
4. Fix transcript tail read to use seek instead of full read
5. Fix cache eviction loop
6. Consolidate secret scanners
7. Increase lock retry timeout
8. Add session cleanup timer

### Phase 3: Medium Priority (Technical Debt)
9. Decide validator strategy (integrate or remove)
10. Add type guards to display layer
11. Add upper bounds to display values
12-16. Additional improvements per individual reports

---

## Review Methodology

Used 6 parallel Haiku agents for deep-dive analysis:
1. **Model Detection** - Priority logic, source comparison
2. **Secrets Patterns** - Regex analysis, false positives
3. **Process Lifecycle** - Signal handling, orphan prevention
4. **Memory Management** - Leaks, buffers, unbounded growth
5. **Cache Coordination** - Race conditions, locks, staleness
6. **Data Validation** - Type checks, bounds, validators

Each agent produced detailed report in `.aigile/deep-review/260131-resource-integrity/P{N}-{topic}.md`

---

## Files with Issues

| File | Critical | High | Medium |
|------|----------|------|--------|
| `model-resolver.ts` | 1 | - | - |
| `data-gatherer.ts` | 2 | - | 1 |
| `transcript-monitor.ts` | - | 1 | - |
| `data-broker.ts` | - | 1 | - |
| `process-lock.ts` | - | 1 | - |
| `health-store.ts` | - | 1 | - |
| `display-only.ts` | - | - | 2 |
| `/validators/*` | - | - | 1 |

---

## Conclusion

Architecture is fundamentally sound - fire-and-forget daemon pattern works, lock mechanism is correct, memory management is mostly good. The critical issues are specific bugs (priority inversion, non-atomic write, regex too broad) rather than systemic failures.

**Priority**: Fix the 3 critical issues immediately to prevent user-visible problems (wrong model display, persistent alerts, cache corruption under load).

All detailed findings in individual reports:
- `P1-model-detection.md`
- `P2-secrets-detection.md`
- `P3-process-lifecycle.md`
- `P4-memory-management.md`
- `P5-cache-coordination.md`
- `P6-data-validation.md`
