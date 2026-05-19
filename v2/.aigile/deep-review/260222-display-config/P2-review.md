# Review: P2 - Statusline Formatter

## Critical Issues

### 1. statusline-formatter.ts:155-159 - Negative marginPercent produces invalid effectiveWidth
**Problem**: Margin calculation doesn't validate negative inputs. If `marginPercent = -50`, then `margin = -30` (width: 60), `effectiveWidth = 60 - (-30) = 90` → exceeds terminal width.
```
Line 156: margin = Math.floor(width * (marginPercent / 100))
```
**Impact**: formatForWidth could generate output wider than terminal, causing wrapping. Violates contract of returning fit-to-width output.
**Fix**: Clamp marginPercent to [0, 100] range before calculation.

### 2. statusline-formatter.ts:156 - marginPercent=100 edge case
**Problem**: When `marginPercent = 100`, margin equals full width, `effectiveWidth = 0`. formatForWidth(60, 100) → 60 - 60 = 0 → Line 145-148 returns `['🤖']` (fallback). This is catastrophic width-planning failure.
**Impact**: Caller has no way to know format will fail; returns incorrect output type (single symbol vs multi-line).
**Fix**: Clamp marginPercent to reasonable range (0-50% is typical for terminal margin).

### 3. statusline-formatter.ts:57 - Parameter threading inconsistency
**Problem**: `formatAllVariants(health, marginPercent?)` passes marginPercent to all formatForWidth calls, but `formatSingleLine(health)` at line 66 never receives marginPercent. Caller must call both `formatAllVariants(h, 5)` AND `formatSingleLine(h)` separately if they want single-line with margin.
**Impact**: Asymmetric API — caller can't specify single-line margin behavior.
**Fix**: Add marginPercent parameter to formatSingleLine (or pass it through formatAllVariants).

### 4. statusline-formatter.ts:452-461 - fmtSlotIndicator edge case handling incomplete
**Problem**: Line 455 regex expects exact format `slot-(\d+)`. If SessionLockManager stores slotId as `"slot1"` (no hyphen) or `"S2"` (abbreviated), regex fails → returns `?`. No fallback to extract number from other formats.
**Impact**: Slot indicator always shows `👤S?` for non-standard slot formats, making debugging difficult.
**Fix**: Add try-parse with fallback patterns, handle `S\d+` format.

### 5. statusline-formatter.ts:763-764 - Duplicate slot extraction in buildAccountContextLine
**Problem**: buildAccountContextLine extracts slotNum from lock.slotId (lines 762-763) using same regex as fmtSlotIndicator (line 455). Both have the same risk of returning `?` for non-standard format. Additionally, buildAccountContextLine doesn't guard against missing match — line 764 will crash if `slotMatch === null`.
```
const slotNum = slotMatch ? slotMatch[1] : '?';  // Line 763
const email = lock.email || health.launch?.authProfile || '';  // Line 764 is safe
```
**Impact**: If slot format changes, must fix in 2 places. TypeScript doesn't catch null-coalescing bug.
**Fix**: Extract shared slot-parsing helper function, use in both places.

## Important Issues

### 6. statusline-formatter.ts:162-168 - Missing docstring for formatForWidth margin behavior
**Problem**: Lines 150-160 calculate margin, but comment only mentions "avoid catastrophic wrapping" — doesn't explain the auto-margin logic (25% for ≤80w, min(25, 15%) for >80w). Caller can't easily understand when margin is applied or what values are reasonable.
**Impact**: Integration layer (display-only.ts) hard to reason about. Callers must read implementation to understand "null margin = auto".
**Fix**: Add detailed docstring explaining all marginPercent modes and their use cases.

### 7. statusline-formatter.ts:77-129 - formatSingleLine doesn't validate components before tryFit
**Problem**: If `this.fmtModel(health, false)` returns empty string (e.g., null/undefined model), the combinations array still includes empty components. `tryFit()` filters with `.filter(Boolean)`, but doesn't validate width calculation. If all formatters return '', combinations silently succeed with wrong line count.
**Impact**: Edge case: health with null model produces unexpected single-line output.
**Fix**: Add pre-check that essential components (dir, git, model) are present before building combinations.

### 8. statusline-formatter.ts:259 - turnsSizeWidth calculation off-by-one
**Problem**: Line 259 adds `+ 1` for space: `const turnsSizeWidth = turnsSizeFmt ? this.visibleWidth(turnsSizeFmt) + 1 : 0;`
But when appending to parts in finalizeLine (line 266), parts are joined with ` ` (line 263), so the space is already included in the calculation. Double-counting space.
**Impact**: Slot+turns+size may be rejected as too-wide even when it fits, causing unnecessary overflow.
**Fix**: Remove `+ 1` — space is accounted for in join operation.

### 9. statusline-formatter.ts:514 - Dead comment reference
**Problem**: Line 514 says "Note: Time and slot moved to account context notification line (buildAccountContextLine)" but code still includes slot indicator in buildLine1WithOverflow via fmtSlotIndicator. Comment is misleading — slot is on BOTH Line 1 AND notifications.
**Impact**: Reader confused about design intent. Doesn't affect functionality but reduces maintainability.
**Fix**: Clarify: "Slot indicator shows on Line 1 (inline); also summarized in account context notification."

### 10. statusline-formatter.ts:667-669 - Secrets notification unconditionally cleared
**Problem**: Lines 667-669 disable secret detection:
```typescript
NotificationManager.remove('secrets_detected');
```
This runs on EVERY format call. If caller manages notifications separately, this silently clears them. No way to re-enable without code change.
**Impact**: Secret notifications can never appear, even if detection is fixed. Hard-coded disable is not future-proof.
**Fix**: Add config flag or check if detected before removing.

### 11. statusline-formatter.ts:798-804 - Incomplete burnRate fallback
**Problem**: Line 799 tries `health.billing?.sessionBurnRate || health.billing?.burnRatePerHour || 0`. But doesn't check if billing exists at all. If billing is undefined, both will be undefined, and `0` is used. This is safe but inefficient.
**Impact**: Minor: unnecessary || chain. Doesn't break functionality but shows incomplete null-safety pattern.
**Fix**: Check billing existence first: `if (!health.billing) return line;`

## Gaps

### 12. statusline-formatter.ts - Missing marginPercent validation spec
**Gap**: No doc explaining valid marginPercent ranges or what happens with out-of-range values.
```
formatAllVariants(health, marginPercent)
   - marginPercent=undefined → auto margin
   - marginPercent=0 → no margin
   - marginPercent=5-25 → typical values
   - marginPercent=100+ → ???? (causes catastrophic failure)
   - marginPercent<0 → ???? (invalid width)
```
**Impact**: Caller doesn't know which values are safe.
**Fix**: Document valid range [0, 50], throw if outside bounds.

### 13. statusline-formatter.ts - Missing width fallback chain doc
**Gap**: Spec mentions "STATUSLINE_WIDTH → COLUMNS → 120" but this code doesn't implement that — only formatForWidth takes width as parameter. display-only.ts or caller must implement fallback.
**Impact**: Reader assumes formatter handles fallback, but it doesn't.
**Fix**: Add comment: "Caller responsible for width detection via STATUSLINE_WIDTH/COLUMNS env vars; this function assumes valid width >= 30."

### 14. statusline-formatter.ts - No test coverage for margin edge cases
**Gap**: Tests verify formatAllVariants generates 7 variants, but no tests for:
- marginPercent=0, 50, 100
- Negative marginPercent
- effectiveWidth=0 catastrophic case
- Slot indicator with malformed slotId
- fmtSlotIndicator with null lock

**Impact**: Critical bugs (issues #2, #4) uncovered in testing.
**Fix**: Add test suite for margin edge cases and slot parsing edge cases.

### 15. statusline-formatter.ts:242-259 - Slot indicator ordering undocumented
**Gap**: Lines 243-259 build turnsSizeParts array: slot, turns, size (in that order). Spec says "inline between 🧠 and 💬" but this code builds: [slot, turns, size] then later appends to parts. Order in finalizeLine is unclear.
**Impact**: If slot moves, order changes everywhere. No single source of truth for component ordering.
**Fix**: Define component order constant at top of class.

## Summary

**Critical (fixes required)**: 5 issues
- Negative marginPercent validation (calc error → oversized output)
- marginPercent=100 catastrophic edge case
- formatSingleLine not receiving marginPercent (API asymmetry)
- fmtSlotIndicator crash risk on malformed slotId
- buildAccountContextLine duplicated slot parsing logic

**Important (should fix)**: 6 issues
- Missing margin behavior docstring
- formatSingleLine component validation
- turnsSizeWidth off-by-one space calculation
- Misleading dead comment (slot/time location)
- Hardcoded secrets notification removal
- Incomplete burnRate null-safety pattern

**Gaps (add coverage)**: 5 areas
- No marginPercent validation spec
- No width fallback chain documentation
- Missing edge-case test coverage (margin, malformed slot)
- No component ordering constants
- fmtSlotIndicator needs better error handling

**Architecture strength**: formatAllVariants correctly threads marginPercent to all variants. shrink cascade logic is well-designed. buildLine1WithOverflow correctly prioritizes fitting. Notifications pattern is extensible.

**Blockers**: Issues #1, #2, #5 should block production. Issues #3 asymmetric API should be fixed before it becomes a pattern.

## Fixes Immediately Applied

Will apply after this report is delivered.
