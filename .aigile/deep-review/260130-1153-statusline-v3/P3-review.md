# Review: Model Detection & Multi-Source Validation

## Actual Model Names Found in Production

### From Transcripts (`.message.model` field)
```
152578x  "claude-sonnet-4-5-20250929"      // Most common
131302x  "claude-haiku-4-5-20251001"
 45703x  "claude-opus-4-5-20251101"
  1095x  "kimi-k2-thinking"               // Non-Anthropic models
   616x  "haiku"                          // Legacy short form
   226x  "<synthetic>"                    // Edge case
   146x  "kimi-k2-thinking-turbo"
   136x  "kimi-k2-0905-preview"
   119x  "sonnet"                         // Legacy short form
    46x  "x-ai/grok-code-fast-1"
    33x  "google/gemini-3-flash-preview"
    22x  "z-ai/glm-4.7"
```

### From JSON Input (Claude Code provides)
```json
{
  "model": {
    "display_name": "Haiku4.5",           // Human-readable (pre-formatted)
    "id": "claude-haiku-4-5-20251001"     // Full model ID
  }
}
```

**Key Finding**: JSON input provides BOTH `display_name` (already formatted like "Haiku4.5") AND raw `id`. V1 uses `display_name` directly; V2 tries to format raw IDs.

## Source Priority Validation

### Documented Priority (CLAUDE.md)
```
1. Transcript .message.model (actual API, <1hr)
2. JSON model.display_name (if transcript stale)
3. settings.json .model (NEVER for current session)
4. Default: "Claude"
```

### V1 Implementation (`statusline.sh:439-451`)
```
Priority 1: transcript_model     -> Correct
Priority 2: json_model_name      -> Correct
Priority 3: "Claude" default     -> Correct (no settings.json)
```

### V2 Implementation (`model-resolver.ts:101-148`)
```
Priority 1: transcript (<1h)     -> Correct
Priority 2: jsonInput            -> Correct
Priority 3: settings             -> EXTRA (not in V1)
Priority 4: default "Claude"     -> Correct
```

**Issue**: V2 adds settings.json as Priority 3, but CLAUDE.md says "NEVER for current session". This is a priority difference, but not a bug since settings is lower priority than the others.

## Normalization Accuracy Analysis

### V2 `formatModelName()` Logic (`model-resolver.ts:205-218`)
```typescript
formatModelName(modelId: string): string {
  const lower = modelId.toLowerCase();
  if (lower.includes('opus')) return 'Opus4.5';
  if (lower.includes('sonnet')) return 'Sonnet4.5';
  if (lower.includes('haiku')) return 'Haiku4.5';
  return modelId; // Pass through unknown
}
```

### Normalization Test Results

| Input | Expected | V2 Output | Correct? |
|-------|----------|-----------|----------|
| `claude-sonnet-4-5-20250929` | Sonnet4.5 | Sonnet4.5 | YES |
| `claude-opus-4-5-20251101` | Opus4.5 | Opus4.5 | YES |
| `claude-haiku-4-5-20251001` | Haiku4.5 | Haiku4.5 | YES |
| `sonnet` | Sonnet4.5 | Sonnet4.5 | YES |
| `haiku` | Haiku4.5 | Haiku4.5 | YES |
| `Sonnet 4.5` (display_name) | Sonnet4.5 | Sonnet4.5 | YES |
| `kimi-k2-thinking` | kimi-k2-thinking | kimi-k2-thinking | YES (passthrough) |
| `google/gemini-3-flash-preview` | as-is | google/gemini-3-flash-preview | YES |

### V1 Normalization (`statusline.sh:416-424`)
```bash
case "$transcript_model_id" in
  *"opus-4-5"*) transcript_model="Opus4.5" ;;
  *"opus"*) transcript_model="Opus" ;;        # V1 differs: no version
  *"sonnet-4-5"*) transcript_model="Sonnet4.5" ;;
  *"sonnet"*) transcript_model="Sonnet" ;;     # V1 differs: no version
  *"haiku-4-5"*) transcript_model="Haiku4.5" ;;
  *"haiku"*) transcript_model="Haiku" ;;       # V1 differs: no version
  *) transcript_model="" ;;
esac
```

**Key Difference**: V1 outputs "Opus" vs "Opus4.5" for short model names. V2 always appends "4.5" version.

## Critical Issues

### 1. V2 Always Adds "4.5" to Short Model Names
**File**: `/v2/src/lib/model-resolver.ts:208-214`

V1 distinguishes:
- `*opus-4-5*` -> "Opus4.5"
- `*opus*` -> "Opus"

V2 always returns "Opus4.5" regardless of whether the input has a version. This could be incorrect if Claude 5 models are introduced.

**Impact**: LOW - Current models all have 4.5 version

### 2. V1 JSON Uses `display_name` Directly Without Normalization
**File**: `/scripts/statusline.sh:209,431-432`

V1 reads:
```bash
model_name=$(echo "$input" | jq -r '.model.display_name // "Claude"')
```

Then uses it directly as `json_model_name`. This means JSON input shows "Sonnet 4.5" (with space) while transcript shows "Sonnet4.5" (no space).

**Impact**: LOW - Display inconsistency only

## Important Issues

### 1. Transcript Freshness Threshold Mismatch
**V1**: Uses file mtime < 1 hour
**V2**: Uses message timestamp < 1 hour

These are different! If transcript file is modified but last message is old, V2 will reject it while V1 accepts it.

**File**: `/v2/src/lib/model-resolver.ts:43` - Uses `transcriptModel.timestamp`
**File**: `/scripts/statusline.sh:401` - Uses `stat -f %m` (file mtime)

### 2. V2 Reads `model.name` Before `model.display_name`
**File**: `/v2/src/lib/model-resolver.ts:50`

```typescript
const modelName = jsonInput.model.name || jsonInput.model.display_name;
```

But Claude Code's JSON input uses:
- `.model.id` for raw model ID
- `.model.display_name` for formatted name

V2 reads `.model.name` which may not exist. Sample input shows this structure:
```json
{"model": {"display_name": "Haiku4.5", "id": "claude-haiku-4-5-20251001"}}
```

**Recommendation**: Should be `jsonInput.model.display_name || jsonInput.model.id`

### 3. No Tests for Non-Anthropic Models
**File**: `/v2/tests/model-resolver.test.ts`

Tests only cover Anthropic models. No tests for:
- `kimi-k2-thinking`
- `google/gemini-3-flash-preview`
- `x-ai/grok-code-fast-1`

These are real models found in production transcripts.

### 4. TypeScript Type Mismatch
**File**: `/v2/src/types/session-health.ts:167-170`

```typescript
model?: {
  name?: string;
  display_name?: string;
};
```

Missing `.id` field. Actual Claude Code input has:
```json
{"model": {"display_name": "...", "id": "..."}}
```

## Recommendations

### HIGH Priority
1. **Fix V2 JSON input field order**: Change to `display_name || id` instead of `name || display_name`
2. **Add `.model.id` to TypeScript types**: Match actual Claude Code JSON structure
3. **Align freshness check**: Decide if file mtime or message timestamp is correct (recommend message timestamp for accuracy)

### MEDIUM Priority
4. **Add non-Anthropic model tests**: Test passthrough behavior for third-party models
5. **Version handling improvement**: Consider not hardcoding "4.5" version - extract from model ID or use passthrough

### LOW Priority
6. **Display consistency**: Decide on "Sonnet 4.5" vs "Sonnet4.5" format and apply consistently
7. **Document settings.json priority**: Update CLAUDE.md to clarify V2 uses settings as fallback

## Source Disagreement Handling

V2 correctly implements disagreement logging:
```typescript
detectDisagreement(sources) {
  const uniqueValues = [...new Set(availableSources.map(s => s.value))];
  if (uniqueValues.length > 1) {
    return `Sources disagree: ${details}`;
  }
}
```

This logs when transcript and JSON input report different models. Example:
```
Sources disagree: transcript=Opus4.5, jsonInput=Sonnet4.5
```

**Note**: Disagreement is logged but doesn't affect priority - transcript still wins if fresh.

## 1-Hour Transcript Threshold Assessment

The 1-hour threshold (`3600 seconds`) is REASONABLE because:
1. Claude Code sessions typically last <1 hour of active use
2. Model switching is uncommon mid-session
3. After 1 hour of inactivity, session is likely stale anyway
4. JSON input provides real-time backup when transcript expires

However, consider making configurable for power users with long sessions.

## Summary

Model detection is **largely accurate** with minor issues:

| Aspect | Status |
|--------|--------|
| Transcript parsing | CORRECT |
| JSON input parsing | MOSTLY CORRECT (wrong field order) |
| Normalization | CORRECT (minor version difference from V1) |
| Priority order | CORRECT |
| Non-Anthropic models | CORRECT (passthrough) |
| Disagreement logging | CORRECT |
| Freshness threshold | REASONABLE |

**Overall Grade**: B+

Main improvements needed:
1. Fix `model.name` -> `model.display_name` in V2
2. Add `.model.id` to TypeScript types
3. Add tests for non-Anthropic models
