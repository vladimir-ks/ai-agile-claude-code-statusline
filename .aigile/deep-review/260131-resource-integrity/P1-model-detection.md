# Review: Model Detection

## Root Cause

**Priority Inversion Bug**: `model-resolver.ts` prioritizes transcript (old session data) OVER JSON input (real-time).

Current priority in `selectBest()` (lines 102-149):
1. Fresh transcript (<1 hour) - confidence 75-98
2. JSON input - confidence 80
3. Settings - confidence 30
4. Default "Claude" - confidence 10

**Problem**: Transcript can be 59 minutes old from a PREVIOUS session using Sonnet. New session starts with Haiku (in JSON input), but resolver picks stale Sonnet from transcript because "age < 3600".

## Critical Issues

### Issue 1: Transcript Source is Session-Agnostic
- `extractModelFromTranscript()` reads last `message.model` from file
- Does NOT verify model belongs to CURRENT session
- Stale data from old conversation pollutes new session

### Issue 2: JSON Input Has Lower Priority Than Stale Transcript
- JSON input is REAL-TIME (age=0, confidence=80)
- Transcript <1h has confidence 75-98
- Logic picks transcript over JSON even when JSON is newer

### Issue 3: Display Layer Has Partial Fix
`display-only.ts` (lines 258-263, 404-405):
```typescript
// fmtModel prefers stdinModel over cached
let model = stdinModel || h.model?.value || 'Claude';

// But stdinModel extraction only checks display_name/name
stdinModel = parsed?.model?.display_name || parsed?.model?.name || null;
```
Missing `model.id` and `model.model_id` extraction - partial coverage.

### Issue 4: Data Gatherer Stores Wrong Model
`data-gatherer.ts` (line 84):
```typescript
health.model = this.modelResolver.resolve(transcriptPath, jsonInput, settingsModel);
```
Writes incorrect model to health file. Display layer's partial fix doesn't persist.

## Fix Recommendations

### Fix 1: Invert Priority (CRITICAL - 5 lines)
In `model-resolver.ts` `selectBest()`:
```
BEFORE:
  1. Transcript (<1h) → JSON input → Settings → Default

AFTER:
  1. JSON input (real-time) → Fresh transcript (<5m) → Settings → Default
```

Change `selectBest()`:
1. Check `jsonInput` FIRST (real-time always wins)
2. Only use transcript if JSON has no model AND transcript <5min (not 1h)

### Fix 2: Display Layer - Complete stdin Model Extraction
In `display-only.ts` line 405:
```
BEFORE:
  stdinModel = parsed?.model?.display_name || parsed?.model?.name || null;

AFTER:
  stdinModel = parsed?.model?.display_name || parsed?.model?.id || parsed?.model?.model_id || parsed?.model?.name || null;
```

### Fix 3: Add Session Validation to Transcript Source (Optional)
Pass `sessionId` to `extractModelFromTranscript()` to verify transcript belongs to current session.

## Summary

| Severity | Issue | Fix Effort |
|----------|-------|------------|
| P1 | Priority inversion (transcript > JSON) | 5 lines |
| P2 | Display missing model.id extraction | 1 line |
| P3 | Transcript session validation | Optional |

**Recommended Action**: Apply Fix 1 + Fix 2 immediately (<20 lines total).

---

## Applied Fixes

**Status**: PENDING - Plan mode active, fixes ready to apply.

Fix 1 (`model-resolver.ts` lines 108-130):
- Reorder: JSON input FIRST, then transcript only if <300s (5min)
- Change threshold from 3600s to 300s

Fix 2 (`display-only.ts` line 405):
- Add `model.id` and `model.model_id` to extraction chain
