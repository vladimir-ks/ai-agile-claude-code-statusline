# Context Window Calculation Analysis

**Status**: 🔍 Audit Complete
**Date**: 2026-01-29

---

## Current v1 Implementation (scripts/statusline.sh)

### Calculation Logic (lines 534-546)

```bash
# Extract from JSON
current_input = .context_window.current_usage.input_tokens
cache_read = .context_window.current_usage.cache_read_input_tokens
context_window_size = .context_window.context_window_size  # 200k

# Calculate
current_context_tokens = current_input + cache_read
context_used_pct = (current_context_tokens * 100) / context_window_size
usable_tokens = (context_window_size * 78) / 100  # 156k for 200k window
tokens_until_compact = usable_tokens - current_context_tokens
```

### Display Logic (line 1132-1150)

```bash
# Progress bar shows % of window (NOT % toward compact threshold)
context_bar = progress_bar_with_marker(context_used_pct, 78%, 12)

# Output format
if tokens_until_compact > 0:
    display: "🧠:154kleft[=========|---]"
else:
    display: "🧠:COMPACT![=========|---]"
```

---

## Issues Found

### ❌ Issue #1: Progress Bar Misleading (CRITICAL)

**Problem**: Progress bar shows percentage of WINDOW, not percentage toward COMPACT threshold

**Current Behavior**:
```
Window: 200k, Compact at: 156k (78%)
Current tokens: 100k

Calculation:
  context_used_pct = 100k / 200k = 50%
  Bar shows: [======|------] (50% filled)

Visual message: "Halfway to compact" ❌ WRONG
Reality: 100k / 156k = 64% toward compact (much closer!)
```

**Should Be**:
```
Window: 200k, Compact at: 156k (78%)
Current tokens: 100k

Calculation:
  compact_progress_pct = 100k / 156k = 64%
  Bar shows: [========|----] (64% filled up to marker)

Visual message: "64% toward compact" ✅ CORRECT
```

**Impact**: Users think they have more space than they actually do. Bar visually misleading.

---

### ❓ Issue #2: Missing Output Tokens (NEEDS VERIFICATION)

**Question**: Should `current_output_tokens` be included in compaction calculation?

**Current Formula**:
```bash
current_context_tokens = current_input + cache_read
```

**Potential Formula**:
```bash
current_context_tokens = current_input + cache_read + current_output
```

**Reasoning**:
- Compaction is triggered by total context usage
- Output tokens consume context window space
- Claude Code may compact based on total (input + output)

**Action Required**: Verify Claude Code compaction behavior
1. Test scenario: Fill 78% with input only → does compact trigger?
2. Test scenario: Fill 60% input + 18% output → does compact trigger at 78% total?

**Recommendation**: Investigate before implementing fix

---

### ✅ Issue #3: Uses Correct Fields (NO ISSUE)

**Current**: Uses `current_usage.input_tokens` (resets after compact) ✅

**NOT Using**: `total_input_tokens` (cumulative, never resets) ✅

**Verification**: Confirmed correct in v1

---

### ✅ Issue #4: Hardcoded Threshold (MINOR)

**Current**: `COMPACT_THRESHOLD_PCT=78` (line 511) ✅

**Status**: Already a variable, just needs to be exposed in config

**v2 Fix**: Move to `config/statusline.config.json`:
```json
{
  "contextWindow": {
    "compactionThreshold": 0.78,
    "warningThreshold": 0.75
  }
}
```

---

## Root Cause Analysis

### Why Progress Bar is Wrong

**The Problem**: Two different percentages are confused

1. **Percentage of WINDOW** (what v1 shows):
   - `context_used_pct = current_tokens / window_size`
   - Range: 0% - 100% (full window)
   - Example: 100k/200k = 50%

2. **Percentage toward COMPACT** (what should be shown):
   - `compact_progress_pct = current_tokens / usable_tokens`
   - Range: 0% - 100% (until compact triggers)
   - Example: 100k/156k = 64%

**The Confusion**:
- Progress bar displays `context_used_pct` (percentage of window)
- But marker at 78% suggests bar represents progress toward compact
- Visual inconsistency: Bar at 50%, marker at 78% → misleading

---

## Proposed Fixes

### Fix #1: Correct Progress Bar (HIGH PRIORITY)

**Option A**: Bar represents progress toward compact (RECOMMENDED)
```bash
# NEW calculation
usable_tokens = context_window_size * 0.78  # 156k
compact_progress_pct = current_tokens * 100 / usable_tokens

# NEW bar (marker at 100%)
progress_bar_with_marker(compact_progress_pct, 100%, 12)

# Display
# At 50%: [======------] (50% toward compact)
# At 78%: [=========---] (78% toward compact)
# At 100%: [============] (COMPACT!)
```

**Option B**: Bar represents % of window, remove marker (ALTERNATIVE)
```bash
# Keep current calculation
context_used_pct = current_tokens * 100 / window_size

# NEW bar (no marker)
progress_bar_simple(context_used_pct, 12)

# Display
# At 39%: [====----] (39% of window, actually 50% toward compact)
# At 78%: [=========---] (78% of window, compact triggers)
```

**Recommendation**: **Option A** - More intuitive for users

---

### Fix #2: Add Output Tokens (IF VERIFIED)

**After verification**, if output tokens should be included:

```typescript
// v2/src/modules/context-module.ts

const current_input = usage.input_tokens || 0;
const cache_read = usage.cache_read_input_tokens || 0;
const current_output = usage.output_tokens || 0;  // NEW

// Include output in calculation
const totalCurrentTokens = current_input + cache_read + current_output;
```

**Test Plan**:
1. Create Claude Code session
2. Use 100k input + 50k output = 150k total
3. Check if compact triggers at 156k total (not 156k input only)
4. Document findings

---

### Fix #3: Configurable Threshold (LOW PRIORITY)

```json
// v2/config/statusline.config.json
{
  "contextWindow": {
    "compactionThreshold": 0.78,    // Default 78%
    "warningThreshold": 0.75,        // Yellow warning at 75%
    "progressBarWidth": 12           // Characters
  }
}
```

---

### Fix #4: Add Debug Mode (HELPFUL)

```bash
# v1 enhancement (optional)
export STATUSLINE_DEBUG_CONTEXT=1

# Output
Context Window Debug:
  Window Size: 200000
  Current Input: 50000
  Cache Read: 100000
  Current Output: 5000  # NEW
  Total Current: 155000
  Compaction Threshold: 156000 (78%)
  Tokens Until Compact: 1000
  Percentage Used (window): 77.5%
  Percentage Used (compact): 99.4%  # NEW
  Status: NEAR COMPACT (< 5%)
```

---

## v2 Implementation Plan

### Module: `v2/src/modules/context-module.pseudo.ts`

**Current pseudocode** (lines 63-76):
```typescript
// STEP 3: Calculate total current tokens
// IMPORTANT: Use current_input + cache_read (NOT total_input which is cumulative)
const totalCurrentTokens = currentInputTokens + cacheReadTokens;

// STEP 4: Calculate tokens until compact
const compactThreshold = 78;  // 78% of window
const usableTokens = Math.floor(contextWindowSize * compactThreshold / 100);
const tokensUntilCompact = Math.max(0, usableTokens - totalCurrentTokens);

// STEP 5: Calculate percentage used
const percentageUsed = contextWindowSize > 0
  ? Math.floor((totalCurrentTokens * 100) / contextWindowSize)
  : 0;
```

**NEEDS UPDATE**:
1. Add `currentOutputTokens` to formula (pending verification)
2. Add `compactProgressPct` calculation (for correct progress bar)
3. Make threshold configurable from config

**Updated pseudocode**:
```typescript
// STEP 3: Calculate total current tokens
// OPTION 1: Input + Cache only (current v1 behavior)
const totalCurrentTokens = currentInputTokens + cacheReadTokens;

// OPTION 2: Include output tokens (pending verification)
// const totalCurrentTokens = currentInputTokens + cacheReadTokens + currentOutputTokens;

// STEP 4: Calculate tokens until compact
const compactThreshold = config.compactionThreshold || 0.78;
const usableTokens = Math.floor(contextWindowSize * compactThreshold);
const tokensUntilCompact = Math.max(0, usableTokens - totalCurrentTokens);

// STEP 5: Calculate percentages
// A. Percentage of window (for debug/logs)
const percentageUsedWindow = contextWindowSize > 0
  ? Math.floor((totalCurrentTokens * 100) / contextWindowSize)
  : 0;

// B. Percentage toward compact (for progress bar) - NEW
const percentageUsedCompact = usableTokens > 0
  ? Math.floor((totalCurrentTokens * 100) / usableTokens)
  : 0;
```

---

## Testing Verification Matrix

| Test Case | Input | Cache Read | Output | Total | Window | Compact At | Should Show |
|-----------|-------|------------|--------|-------|--------|------------|-------------|
| Fresh | 0 | 0 | 0 | 0 | 200k | 156k | `🧠:156kleft[------------|]` |
| Half full | 50k | 28k | 0 | 78k | 200k | 156k | `🧠:78kleft[=====|------]` (50% toward) |
| Near compact | 140k | 10k | 0 | 150k | 200k | 156k | `🧠:6kleft[==========|--]` (96% toward) |
| At compact | 150k | 6k | 0 | 156k | 200k | 156k | `🧠:COMPACT![============]` (100%) |
| With output? | 100k | 30k | 26k | 156k? | 200k | 156k? | Needs verification |

---

## Decision Matrix

| Issue | Priority | Action | v2 Module | Status |
|-------|----------|--------|-----------|--------|
| Progress bar wrong | **HIGH** | Fix formula | context-module | ✅ Documented |
| Missing output tokens | **MEDIUM** | Verify first | context-module | 🔍 Needs testing |
| Hardcoded threshold | **LOW** | Make configurable | config.json | ✅ Planned |
| Debug mode missing | **LOW** | Add to v2 | context-module | ✅ Planned |

---

## Next Steps

1. ✅ Document current v1 behavior (this file)
2. 🔄 Verify Claude Code compaction logic (output tokens?)
3. [ ] Update `context-module.pseudo.ts` with fixes
4. [ ] Implement in TypeScript
5. [ ] Add unit tests for calculation
6. [ ] Add integration tests with real data
7. [ ] Create debug mode implementation
8. [ ] Update v2/README.md with correct formula

---

## References

- v1 source: `scripts/statusline.sh` (lines 509-576, 1130-1154)
- v2 pseudocode: `v2/src/modules/context-module.pseudo.ts`
- Plan: `/Users/vmks/.claude/plans/shimmying-meandering-shell.md` (Phase 3)
