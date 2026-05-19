# Deep Review Results

**Date**: 2026-02-22
**Scope**: DisplayConfig, margin system, slot indicator, formatter updates
**Partitions**: 4 (P1: display-only, P2: formatter, P3: tests, P4: not completed — rate limit)

## Critical Issues Found: 5

| # | File | Issue | Status |
|---|------|-------|--------|
| 1 | display-only.ts:623 | DisplayConfig.mode not validated | FIXED (P1: validateDisplayConfig) |
| 2 | display-only.ts:77-81 | DisplayConfig missing validation constraints | FIXED (P1: validateDisplayConfig) |
| 3 | formatter:155-159 | Negative marginPercent → invalid effectiveWidth | FIXED (clamping [0,50]) |
| 4 | formatter:156 | marginPercent=100 → effectiveWidth=0 catastrophic | FIXED (clamped to max 50) |
| 5 | formatter:57 | formatSingleLine not receiving marginPercent | FIXED (threaded through) |

## Important Issues Found: 10

| # | File | Issue | Status |
|---|------|-------|--------|
| 1 | display-only.ts:608-610 | Shallow merge loses marginPercent default | FIXED (P1: validateDisplayConfig post-merge) |
| 2 | display-only.ts:682 | marginPercent undefined → formatter crash | FIXED (P1: validation) |
| 3 | display-only.ts:696 | Duplicate stripAnsi definition | FIXED (P1: removed inner) |
| 4 | display-only.ts:629-642 | selectVariant no fallback for missing widths | FIXED (P1: fallback chains) |
| 5 | display-only.ts:687-690 | maxLines=0 eliminates output | FIXED (P1: validate ≥1) |
| 6 | formatter:452-461 | fmtSlotIndicator edge case handling | FIXED (parseSlotNumber helper) |
| 7 | formatter:763-764 | Duplicate slot extraction | FIXED (parseSlotNumber shared) |
| 8 | formatter:259 | turnsSizeWidth off-by-one | FIXED (removed +1) |
| 9 | formatter:667-669 | Secrets notification unconditionally cleared | KEPT (correct: detection disabled, must clear stale) |
| 10 | formatter:798-804 | Incomplete burnRate null-safety | FIXED (billing null check) |

## Test Issues Found: 4

| # | File | Issue | Status |
|---|------|-------|--------|
| 1 | spec-validation.test.ts:421 | Stale time assertion | FIXED (P3) |
| 2 | spec-validation.test.ts:424-428 | Stale time assertion (invalid JSON) | FIXED (P3) |
| 3 | display-only.test.ts:289 | Misleading Phase 0 comment | FIXED (P3) |
| 4 | safety.test.ts:55 | Orphan threshold undocumented | FIXED (P3: added comment) |

## Test Coverage Gaps (from P3)

1. Missing: marginPercent negative/100+ edge case tests
2. Missing: Width fallback chain tests (STATUSLINE_WIDTH → COLUMNS → 120)
3. Missing: Session resume loading→full transition test
4. Missing: maxLines parameter tests
5. Missing: Margin calculation correctness assertions

## Post-Review Fix

- Restored `NotificationManager.remove('secrets_detected')` after P2 agent incorrectly replaced it with a comment. Test "secrets notification cleared" now passes again.

## Final Test Results

- **1817 pass** / **2 fail** (pre-existing: E2E env, TelemetryDashboard CLI)
- No regressions from review fixes

## Action Items (Remaining)

1. Add edge-case tests for margin clamping (marginPercent=-5, 100, 150)
2. Add width fallback chain tests
3. Add maxLines parameter tests
4. Document marginPercent semantics in formatter docstring
5. Document component ordering contract
