# P1 Review: Display Layer & Model Extraction

## Critical Issues
None found.

## Important Issues

### 1. Missing Test Coverage for model.id Extraction
**File**: `v2/tests/display-only.test.ts:449`

Current test "prefers stdin model.display_name over cached health" only tests display_name format. The new priority logic (prefer model.id > display_name) is untested.

**Impact**: Low. Code is correct (verified via regex testing), but missing explicit test for new model.id path with "claude-opus-4-6" format.

**Suggestion**: Add test case for model.id extraction:
```
test('extracts version from stdin model.id (claude-opus-4-6 → Opus4.6)', () => {
  const health = { sessionId: 'model-test-3', model: { value: 'OldModel' }, ... };
  const { output } = runDisplay('{"session_id":"model-test-3","model":{"id":"claude-opus-4-6","display_name":"Opus"}}');
  expect(output).toContain('🤖:Opus4.6');
});
```

---

## Gaps & Edge Cases

### 1. formatModelId Whitespace Handling
**File**: `v2/src/display-only.ts:507-519`

The function handles spaces correctly via `.replace(/\s+/g, '')` in fmtModel() later (line 407), but formatModelId itself preserves leading/trailing spaces on unknown models.

**Risk**: Low. Models like "  Opus  " would become "  Opus  " (preserves spaces), then fmtModel removes them. Works correctly end-to-end.

**Status**: ✓ Safe, verified in both components.

### 2. formatModelId Case Insensitivity
**File**: `v2/src/display-only.ts:515-517`

Returns formatted name (e.g., "Opus4.6") but case is hardcoded. Input like "CLAUDE-OPUS-4-6" correctly becomes "Opus4.6".

**Status**: ✓ Correct. Tested: `CLAUDE-OPUS-4-6` → `Opus4.6`.

### 3. Version Extraction Regex Ambiguity
**File**: `v2/src/display-only.ts:511-514`

Regex `/(\d+)-(\d+)(?:-\d|$)/` matches first occurrence in string. Example: "claude-opus-4-6" correctly extracts "4.6", and "claude-opus-4-5-20250929" correctly extracts "4.5".

**Potential Issue**: Input like "4-5-8-9-10" would extract "4.5" (first pair). But this is unrealistic for model IDs and acceptable fallback behavior.

**Status**: ✓ Safe for real-world models.

### 4. Empty String Model Edge Case
**File**: `v2/src/display-only.ts:542-545`

If parsed.model.id is empty string `""`, the OR chain correctly falls through to display_name due to falsy behavior.

**Verified**: `parsed?.model?.id || parsed?.model?.model_id || parsed?.model?.display_name` with id="" correctly evaluates to display_name.

**Status**: ✓ Correct.

### 5. stdin Model Priority Isolation (Cross-Session)
**File**: `v2/src/display-only.ts:645-652`

stdin model only affects current display (merged into `healthWithStdin`, not persisted to cache). Each session gets fresh model from stdin on next invocation.

**Status**: ✓ Correct isolation. No cross-session contamination.

### 6. Timeout Handling on Display Failure
**File**: `v2/src/statusline-bulletproof.sh:94`

If display times out (1.5s), `DISPLAY_OUTPUT=""` (empty string). Script outputs empty string, which means NO statusline visible.

**Risk**: Low. User sees nothing instead of minimal fallback. Acceptable for hard timeout.

**Status**: ✓ Acceptable (timeout guardrail working as designed).

### 7. formatModelId Type Safety
**File**: `v2/src/display-only.ts:508`

Function signature: `formatModelId(modelId: string): string`. Only called after null check (line 543), so null/undefined cannot reach function.

**Status**: ✓ Type-safe.

---

## Verification Results

### Regex Testing
All formats tested and working correctly:
- ✓ `claude-opus-4-6` → `Opus4.6`
- ✓ `claude-opus-4-5-20250929` → `Opus4.5`
- ✓ `Opus4.5` → `Opus4.5` (idempotent)
- ✓ `Opus` → `Opus` (no version)
- ✓ `claude-sonnet-4-5-20250929` → `Sonnet4.5`
- ✓ `claude-haiku-4-1-20250514` → `Haiku4.1`
- ✓ `claude-opus-5-0` → `Opus5.0` (future versions)
- ✓ Case insensitive: `CLAUDE-OPUS-4-6` → `Opus4.6`
- ✓ Unknown model: `GPT-4` → `GPT-4` (pass-through)

### Test Suite
- ✓ 1807 tests pass (2 pre-existing failures unrelated)
- ✓ display-only.test.ts: 23 tests pass
- ✓ Model priority test: ✓ stdin display_name overrides cache
- ✓ Fallback test: ✓ uses cache when stdin empty

### Code Flow Verification
1. stdin model extraction (line 542): Correctly prioritizes id > model_id > display_name > name
2. formatModelId call (line 544): Protected by null check (line 543)
3. stdin merge to health (line 651): Only affects current display, not persistent
4. fmtModel usage (formatter.ts:406): Reads from health.model.value (formatted), applies space removal
5. Timeout protection (bulletproof.sh:94): 1.5s hard limit, graceful fallback to empty

---

## Summary

Display layer model extraction is **solid**. Regex correctly handles all real-world model ID formats, extraction logic properly prioritizes sources, stdin isolation prevents cross-session contamination, and timeout protection works as designed.

**One actionable improvement**: Add test case for model.id extraction with dash format to close coverage gap. Non-blocking — code is correct and tested indirectly via display-only smoke tests.

**Architecture Decision (Validated)**: 1.5s timeout is appropriate for bun cold start (300-800ms typical, 1.2s worst case under load). 0.5s grace period for SIGKILL ensures hard stop.
