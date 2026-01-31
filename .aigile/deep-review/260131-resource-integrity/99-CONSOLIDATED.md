# Deep Review Results: Statusline V2 Resource & Data Integrity

**Date**: 2026-01-31
**Scope**: Resource management, memory safety, data accuracy, multi-instance coordination
**Partitions**: 6

---

## Executive Summary

| Category | Status | Issues Found |
|----------|--------|--------------|
| **Model Detection** | 🔴 BROKEN | Priority inversion - shows wrong model |
| **Secrets Detection** | 🔴 FALSE POS | Regex triggers on discussion text |
| **Process Lifecycle** | ✅ ACCEPTABLE | Self-healing via timeout |
| **Memory Management** | 🟡 MEDIUM-HIGH | Full file reads, no streaming |
| **Cache Coordination** | 🔴 HIGH RISK | Non-atomic write, race conditions |
| **Data Validation** | 🟡 DEAD CODE | Validators implemented but unused |

---

## Critical Issues (Must Fix)

### 1. Model Detection Wrong (P1-model-detection.md)
**User-Reported**: Shows "Sonnet" when running "Haiku"

**Root Cause**: Priority inversion in `model-resolver.ts:108-130`
- Transcript (<1h old) has priority OVER JSON input (real-time)
- Stale transcript from previous session pollutes current

**Fix**: Invert priority - JSON input FIRST, transcript only if <5min and JSON missing

**Files**:
- `v2/src/lib/model-resolver.ts` - Reorder selectBest()
- `v2/src/display-only.ts:405` - Add model.id extraction

---

### 2. Secrets Detection False Positives (P2-secrets-detection.md)
**User-Reported**: `🔐SECRETS!(Private Key)` when discussing keys

**Root Cause**: Regex `/-----BEGIN.*PRIVATE KEY-----/` matches text mentions

**Fix**: Require BEGIN/END pair with 50+ chars of content

**Files**:
- `v2/src/lib/data-gatherer.ts:322`
- `v2/src/modules/secrets-detector-module.ts:42-44`

---

### 3. billing-shared.json Race Condition (P5-cache-coordination.md)
**Issue**: Non-atomic write + lock released before write

**Root Cause**: `data-gatherer.ts:144` uses `writeFileSync` instead of atomicWrite

**Fix**:
1. Use atomicWrite pattern (temp+rename)
2. Move cache write inside lock scope

**Files**:
- `v2/src/lib/data-gatherer.ts:144-146`

---

### 4. Transcript Full File Read (P4-memory-management.md)
**Issue**: `getLastUserMessageFromTail()` reads entire file, then slices

**Root Cause**: `transcript-monitor.ts:94` does `readFileSync(path)` for "tail"

**Impact**: 10MB+ transcripts cause memory spikes

**Fix**: Use `fs.open()` with seek to file end, read backwards

**Files**:
- `v2/src/lib/transcript-monitor.ts:92-98`

---

## High Priority Issues

### 5. Validators Are Dead Code (P6-data-validation.md)
~2000 LOC of validators never called in production

**Decision Required**:
- Option A: Remove validators (simplify codebase)
- Option B: Integrate into data-gatherer (enable confidence display)

### 6. Session Health Files Unbounded (P5-cache-coordination.md)
No cleanup mechanism - files accumulate indefinitely

**Fix**: Add cleanup timer (delete sessions >7 days old)

### 7. Display Layer NaN Protection (P6-data-validation.md)
`formatMoney()` and `formatTokens()` lack `isFinite()` checks

**Fix**: Add type/finite guards to formatters

---

## Acceptable (No Action Required)

### Process Lifecycle (P3-process-lifecycle.md)
- Shell wrapper enforces 30s timeout with SIGKILL
- Lock self-heals via 35s stale detection
- disown pattern correct

### Division by Zero (P6-data-validation.md)
- All division operations protected with ternary checks

### Data Separation (P5-cache-coordination.md)
- Clear shared vs session boundary
- Object spread creates safe copies

---

## Fix Priority Order

| Priority | Issue | Files | Effort |
|----------|-------|-------|--------|
| P0 | Model priority inversion | model-resolver.ts | ~10 lines |
| P0 | Secrets regex false positive | data-gatherer.ts, secrets-detector-module.ts | ~5 lines |
| P1 | billing-shared.json atomic write | data-gatherer.ts | ~10 lines |
| P1 | Display model.id extraction | display-only.ts | ~1 line |
| P2 | Transcript tail read optimization | transcript-monitor.ts | ~30 lines |
| P2 | Display NaN protection | display-only.ts | ~10 lines |
| P3 | Session cleanup timer | data-gatherer.ts | ~20 lines |
| P3 | Decision on validators | - | Architectural |

---

## Data Point Reliability Matrix

| Data Point | Source | Risk Level | Validation |
|------------|--------|------------|------------|
| **Model** | JSON input, transcript, settings | 🔴 HIGH (wrong source selected) | Fix priority order |
| **Context Tokens** | stdin JSON nested | ✅ LOW | Optional chaining works |
| **Cost/Billing** | ccusage | 🟡 MEDIUM (stale possible) | 2-min TTL acceptable |
| **Git Status** | git commands | ✅ LOW | 10s cache, SIGKILL timeout |
| **Transcript Health** | File stats | ✅ LOW | mtime check reliable |
| **Secrets** | Transcript regex | 🔴 HIGH (false positives) | Fix regex patterns |

---

## Verification Plan

After fixes applied:

1. **Model Detection**
   - Start session with Haiku, verify 🤖:Haiku4.5 displays
   - Switch models mid-session, verify update

2. **Secrets Detection**
   - Discuss "private key format" in chat
   - Verify NO alert triggers
   - Paste actual key, verify alert DOES trigger

3. **Cache Coordination**
   - Start 5+ Claude Code sessions simultaneously
   - Verify no JSON corruption in billing-shared.json

4. **Memory**
   - Monitor memory during 10MB+ transcript session
   - Verify no OOM or >100MB spike

---

## Reports Location

```
.aigile/deep-review/260131-resource-integrity/
├── 00-COMMON-BRIEF.md
├── P1-model-detection.md
├── P2-secrets-detection.md
├── P3-process-lifecycle.md
├── P4-memory-management.md
├── P5-cache-coordination.md
├── P6-data-validation.md
└── 99-CONSOLIDATED.md (this file)
```
