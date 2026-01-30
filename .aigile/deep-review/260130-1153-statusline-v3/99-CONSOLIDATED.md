# Deep Review Results: Statusline V3

**Date**: 2026-01-30 11:53
**Scope**: V3 Bulletproof Statusline - Data Accuracy & Safety
**Partitions**: 6
**Reviewers**: Parallel Haiku agents

---

## 🔴 CRITICAL ISSUES (Data Accuracy Broken)

### C1. Context Window - Wrong JSON Path
**File**: `v2/src/lib/data-gatherer.ts:224-226`
**Impact**: ALL context window data shows 0 tokens

Code reads:
```typescript
const inputTokens = ctx.current_input_tokens || 0;
const cacheTokens = ctx.cache_read_input_tokens || 0;
```

Claude Code actually provides:
```typescript
ctx.current_usage.input_tokens
ctx.current_usage.cache_read_input_tokens
```

**Evidence**: Every health file shows `tokensUsed: 0, percentUsed: 0`

### C2. Budget Minutes - Field Name Mismatch
**File**: `v2/src/lib/data-gatherer.ts:121-122`
**Impact**: Budget always shows `0h0m(0%)`

Code reads:
```typescript
billingData.budgetMinutesLeft    // doesn't exist
billingData.budgetPercentUsed    // doesn't exist
```

CCUsageData actually has:
```typescript
billingData.minutesLeft
billingData.percentageUsed
```

### C3. Model Resolver - Wrong JSON Field
**File**: `v2/src/lib/model-resolver.ts:50`
**Impact**: Model detection may fail from JSON input

Code reads `model.name` but Claude Code provides `model.display_name` and `model.id`.

### C4. ccusage blockId - Wrong Field Name
**File**: `v2/src/modules/ccusage-shared-module.ts:121`
**Impact**: blockId always empty string

Code: `activeBlock.blockId` → Actual: `activeBlock.id`

---

## 🟠 IMPORTANT ISSUES

### I1. 78% Compaction Threshold May Be Wrong
**File**: `v2/src/lib/data-gatherer.ts:232`

Code hardcodes 78% but Claude Code may use 95% by default. Progress bar marker could be misleading.

### I2. Git Format Inconsistency
**Files**: `git-module.ts` vs `display-only.ts`

Module outputs: `main+37/-0*1` (always shows both ahead/behind)
Display outputs: `main+37*1` (hides zeros)

V1 format was: `main+12/-0*1`

### I3. Data Loss Risk Logic Inverted
**File**: `v2/src/lib/data-gatherer.ts:283-285`

```typescript
private isSessionActive(jsonInput): boolean {
  return jsonInput !== null;  // WRONG: this means session IS active
}
```

Currently triggers data loss warning WHEN session is active, not when it might be inactive.

### I4. Staleness Indicator Not Time-Based
**CLAUDE.md says**: "🔴 appears when ccusage data >1 hour old"
**Code does**: Only shows 🔴 when fetch fails, not based on elapsed time

### I5. CCUsageSharedModule Constructor Missing
**File**: `v2/src/modules/ccusage-shared-module.ts`

data-gatherer.ts passes config `{ cacheTTL: 120000, timeout: 25000 }` but class has no constructor to receive it.

### I6. Transcript Message Count Inaccurate
**File**: `v2/src/lib/transcript-monitor.ts:77-78`

Assumes ~1KB per line but actual lines vary 100 bytes to 50KB+. Produces 2-10x inaccuracy.

### I7. TypeScript Types Don't Match Reality
**File**: `v2/src/types/session-health.ts:167-176`

ClaudeCodeInput interface expects flat structure but Claude Code provides nested objects.

---

## 🟡 MINOR ISSUES

### M1. Process Lock TOCTOU Race
**File**: `v2/src/lib/process-lock.ts`

Minor race condition in stale lock cleanup. Mitigated by exclusive create flag. Impact is low.

### M2. 5-Minute Staleness Threshold Too Aggressive
**File**: `v2/src/lib/transcript-monitor.ts`

May cause false positives during normal reading pauses. Consider 10-15 minutes.

### M3. Large Transcript Memory Inefficiency
**File**: `v2/src/lib/transcript-monitor.ts:84-101`

Reads entire file into memory before slicing last chunk. Could be optimized.

---

## ✅ WORKING CORRECTLY

- Resource safety (timeouts, SIGKILL, orphan prevention)
- Log rotation (100KB limit)
- Memory bounds (maxBuffer on exec calls)
- Color support (NO_COLOR respected)
- Git branch detection
- Git ahead/behind counts (when upstream exists)
- Cost extraction (costUSD, burnRate)
- Time formatting
- Display-only architectural guarantee

---

## ACTION ITEMS (Priority Order)

### P0 - CRITICAL (Fix Immediately)

1. **Fix context window JSON path** in data-gatherer.ts
   ```typescript
   // Change from:
   const inputTokens = ctx.current_input_tokens || 0;
   // To:
   const inputTokens = ctx.current_usage?.input_tokens || 0;
   ```

2. **Fix budget field names** in data-gatherer.ts
   ```typescript
   // Change from:
   budgetRemaining: billingData.budgetMinutesLeft
   budgetPercentUsed: billingData.budgetPercentUsed
   // To:
   budgetRemaining: (billingData.hoursLeft * 60) + billingData.minutesLeft
   budgetPercentUsed: billingData.percentageUsed
   ```

3. **Fix ccusage blockId field** in ccusage-shared-module.ts
   ```typescript
   // Change from:
   blockId: activeBlock.blockId
   // To:
   blockId: activeBlock.id
   ```

4. **Fix model resolver JSON field** in model-resolver.ts
   ```typescript
   // Use display_name or id, not name
   ```

### P1 - IMPORTANT (Fix Soon)

5. Add time-based staleness to billing (>1 hour shows 🔴)
6. Fix data loss risk logic (invert the condition)
7. Add constructor to CCUsageSharedModule
8. Make git format consistent with V1

### P2 - LOW (Nice to Have)

9. Make compaction threshold configurable (default 78% or 95%)
10. Improve transcript message count estimation
11. Add TypeScript interfaces for actual Claude Code JSON structure
12. Optimize large transcript handling

---

## VERIFICATION COMMANDS

After fixes, verify with:

```bash
# Check context window is non-zero
cat ~/.claude/session-health/*.json | grep tokensUsed

# Check budget shows real values
cat ~/.claude/session-health/*.json | grep budgetRemaining

# Run ccusage and compare
ccusage blocks --json --active | head -50
```

---

## SUMMARY

**Data accuracy is severely compromised** due to JSON field path mismatches. The statusline currently shows:
- Context: Always 0 (broken)
- Budget: Always 0h0m(0%) (broken)
- Model: May fail from JSON input (partially broken)
- Cost: Working (extracts correct fields)
- Git: Working (minor format inconsistency)
- Transcript: Partially working (logic errors)

**Resource safety is solid** - no orphans, timeouts work, memory bounded.

**Estimated fix time**: 30-60 minutes for P0 critical issues.
