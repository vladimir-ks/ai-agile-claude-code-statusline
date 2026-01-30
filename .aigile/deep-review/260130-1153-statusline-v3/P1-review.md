# Review: Context Window & Token Calculations

**Reviewer**: P1 Deep Review Agent
**Date**: 2026-01-30
**Scope**: Context window accuracy, 78% threshold validation, formula correctness

---

## Data Source Validation

### What Claude Code ACTUALLY provides (JSON stdin):

```json
{
  "context_window": {
    "context_window_size": 200000,
    "total_input_tokens": 50000,
    "total_output_tokens": 10000,
    "current_usage": {
      "input_tokens": 5000,
      "output_tokens": 1000,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 500
    }
  }
}
```

**Key observation**: Token counts are NESTED inside `current_usage`, NOT directly on `context_window`.

### Validation Evidence

```bash
# Health file check - ALL sessions show 0 tokens:
for file in ~/.claude/session-health/*.json; do jq '.context' "$file"; done

# Result:
{
  "tokensUsed": 0,
  "tokensLeft": 156000,
  "percentUsed": 0,
  "windowSize": 200000,
  "nearCompaction": false
}
```

Every single session shows `tokensUsed: 0` - data is NOT being captured.

---

## Critical Issues

### CRITICAL-1: data-gatherer.ts reads wrong JSON path [file:v2/src/lib/data-gatherer.ts:224-226]

**Location**: `calculateContext()` method

**Bug**:
```typescript
// data-gatherer.ts lines 224-226 (WRONG)
const inputTokens = ctx.current_input_tokens || 0;       // Does NOT exist
const cacheTokens = ctx.cache_read_input_tokens || 0;    // Does NOT exist
const outputTokens = ctx.current_output_tokens || 0;     // Does NOT exist
```

**Should be**:
```typescript
// context-module.ts lines 57-62 (CORRECT)
const currentUsage = parsed.context_window?.current_usage || {};
const currentInputTokens = currentUsage.input_tokens || 0;
const cacheReadTokens = currentUsage.cache_read_input_tokens || 0;
const currentOutputTokens = currentUsage.output_tokens || 0;
```

**Impact**: All V2 sessions show `tokensUsed: 0` because fields don't exist at expected path.

**Evidence**: Every health file shows identical context data with 0 tokens.

---

### CRITICAL-2: ClaudeCodeInput interface wrong [file:v2/src/types/session-health.ts:171-176]

**Location**: Type definition

**Bug**:
```typescript
// session-health.ts lines 171-176 (WRONG interface)
context_window?: {
  context_window_size?: number;
  current_input_tokens?: number;      // Does NOT exist at this level
  cache_read_input_tokens?: number;   // Does NOT exist at this level
  current_output_tokens?: number;     // Does NOT exist at this level
};
```

**Should be**:
```typescript
context_window?: {
  context_window_size?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  current_usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
};
```

**Impact**: TypeScript doesn't catch the bug because the wrong interface allows the wrong access pattern.

---

### CRITICAL-3: 78% threshold may be incorrect [file:multiple]

**Documented**: Codebase uses 78% compaction threshold everywhere:
- `scripts/statusline.sh:511`: `COMPACT_THRESHOLD_PCT=78`
- `v2/src/lib/data-gatherer.ts:230`: `0.78`
- `v2/src/modules/context-module.ts:68`: `compactThreshold = 78`

**Actual Claude Code threshold**: According to [GitHub Issue #15719](https://github.com/anthropics/claude-code/issues/15719):
- **Default is 95%**, not 78%
- Users can request configurable range 25%-95%

**Discrepancy sources**:
1. Original comment says "22.5% autocompact buffer" = 77.5%
2. Claude Code may have evolved threshold over time
3. Threshold may vary by model/plan

**Impact**: Progress bar marker at position 9 (78%) may be misleading. User sees "close to compact" when actually 17% headroom remains.

---

## Important Issues

### IMPORTANT-1: Formula inconsistency between modules

**context-module.ts** (lines 65-66):
```typescript
const totalCurrentTokens = currentInputTokens + cacheReadTokens;
// Does NOT include output tokens
```

**data-gatherer.ts** (lines 227):
```typescript
result.tokensUsed = inputTokens + cacheTokens + outputTokens;
// INCLUDES output tokens
```

**V1 bash script** (line 535):
```typescript
current_context_tokens=$((current_input + cache_read))
// Does NOT include output tokens
```

**Uncertainty**: Should output tokens count toward compaction?
- Argument FOR: Output tokens consume context window space
- Argument AGAINST: V1 and context-module.ts both exclude it
- Need Claude Code documentation to verify

---

### IMPORTANT-2: display-only.ts uses hardcoded progress bar position

**Location**: `display-only.ts:152`

```typescript
const thresholdPos = 9; // 78% of 12
```

Hardcoded instead of calculated from threshold percentage.

---

### IMPORTANT-3: Progress bar calculation inconsistency

**display-only.ts** (lines 150-163):
```typescript
function generateProgressBar(percentUsed: number): string {
  const width = 12;
  const thresholdPos = 9; // 78% of 12
  const pct = Math.max(0, Math.min(100, percentUsed || 0));
  const usedPos = Math.floor(width * pct / 100);
  // ...
}
```

**context-module.ts** (lines 217-238):
```typescript
private generateProgressBar(percentUsed: number): string {
  const totalWidth = 12;
  const thresholdPct = 78;
  const usedPos = Math.floor(totalWidth * Math.max(0, Math.min(100, percentUsed)) / 100);
  const markerPos = Math.floor(totalWidth * thresholdPct / 100);  // Position 9 of 12
  // ...
}
```

Both implementations exist - duplication risk.

---

## Edge Cases

### Edge Case 1: Zero tokens (Fresh session)

**Current behavior**: Shows `156kleft` (78% of 200k)
**Correct?**: Yes, but only if 78% threshold is accurate

### Edge Case 2: Null/undefined context_window

**data-gatherer.ts:216**:
```typescript
if (!jsonInput?.context_window) {
  return result;  // Returns defaults: 0 used, 156k left
}
```

**Correct**: Yes, handles gracefully.

### Edge Case 3: Max tokens (at threshold)

**context-module.ts:194-198**:
```typescript
if (data.tokensUntilCompact > 0) {
  return `🧠:${tokensDisplay}left[${progressBar}]`;
} else {
  return `🧠:COMPACT![${progressBar}]`;  // Shows COMPACT!
}
```

**Correct**: Yes, shows "COMPACT!" when at threshold.

### Edge Case 4: Negative tokens

**context-module.ts:231**:
```typescript
result.tokensLeft = Math.max(0, compactionThreshold - result.tokensUsed);
```

**Correct**: Clamped to 0.

### Edge Case 5: Window size = 0

**context-module.ts:73-75**:
```typescript
const percentageUsedWindow = contextWindowSize > 0
  ? Math.floor((totalCurrentTokens * 100) / contextWindowSize)
  : 0;
```

**Correct**: Protected against divide-by-zero.

---

## Formula Accuracy

### Calculation verified:

```
Given:
  window_size = 200000
  threshold = 0.78

Math:
  compaction_threshold = 200000 * 0.78 = 156000
  tokens_left = 156000 - tokens_used
  percent_used = (tokens_used / 156000) * 100
```

**Formula is mathematically correct**, but:
1. Data source is broken (CRITICAL-1)
2. 78% threshold may be wrong (CRITICAL-3)

---

## Recommendations

### Priority 1: Fix data path in data-gatherer.ts

```typescript
// v2/src/lib/data-gatherer.ts - calculateContext method
private calculateContext(jsonInput: ClaudeCodeInput | null): ContextInfo {
  // ... existing setup ...

  const ctx = jsonInput.context_window;
  const currentUsage = ctx?.current_usage || {};  // ADD THIS LINE

  result.windowSize = ctx.context_window_size || 200000;

  // FIX THESE LINES:
  const inputTokens = currentUsage.input_tokens || 0;           // FIXED
  const cacheTokens = currentUsage.cache_read_input_tokens || 0; // FIXED
  const outputTokens = currentUsage.output_tokens || 0;         // FIXED (or remove)

  // ... rest unchanged ...
}
```

### Priority 2: Fix ClaudeCodeInput interface

```typescript
// v2/src/types/session-health.ts
export interface ClaudeCodeInput {
  session_id?: string;
  transcript_path?: string;
  model?: { name?: string; display_name?: string; };
  context_window?: {
    context_window_size?: number;
    total_input_tokens?: number;    // Cumulative, do NOT use
    total_output_tokens?: number;   // Cumulative, do NOT use
    current_usage?: {               // ADD nested structure
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
  start_directory?: string;
}
```

### Priority 3: Verify 78% threshold

Options:
1. Confirm with Anthropic documentation
2. Test empirically with real Claude Code sessions
3. Make threshold configurable (safest option)

### Priority 4: Unify formula (include/exclude output tokens)

Recommend: Match V1 behavior (exclude output) until verified otherwise.

---

## Summary

| Area | Status | Severity |
|------|--------|----------|
| Data extraction | **BROKEN** | CRITICAL |
| Type interface | **WRONG** | CRITICAL |
| 78% threshold | **UNVERIFIED** | HIGH |
| Formula math | Correct | OK |
| Edge cases | Handled | OK |
| Code duplication | Present | LOW |

**Bottom line**: V2 context window is completely non-functional due to wrong JSON path. All sessions show 0 tokens because `context_window.current_input_tokens` doesn't exist - the actual path is `context_window.current_usage.input_tokens`.

The 78% threshold is also questionable - Claude Code documentation suggests 95% is the actual default. This requires verification before production deployment.

---

## References

- [GitHub Issue #15719: Configurable Compaction Threshold](https://github.com/anthropics/claude-code/issues/15719)
- Sample input: `/examples/sample-input.json`
- V1 correct implementation: `scripts/statusline.sh:534-546`
- V2 broken implementation: `v2/src/lib/data-gatherer.ts:220-227`
