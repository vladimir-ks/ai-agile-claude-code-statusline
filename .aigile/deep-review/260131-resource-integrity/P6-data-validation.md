# Review: Data Validation

**Files Reviewed:**
- `/v2/src/validators/context-validator.ts`
- `/v2/src/validators/cost-validator.ts`
- `/v2/src/validators/timestamp-validator.ts`
- `/v2/src/validators/model-validator.ts`
- `/v2/src/validators/git-validator.ts`
- `/v2/src/lib/validation-engine.ts`
- `/v2/src/lib/data-gatherer.ts`
- `/v2/src/data-daemon.ts`
- `/v2/src/display-only.ts`

---

## Unused Validators

### CRITICAL: Validators Exist But Are NOT Called

**Finding:** All 5 validators and the ValidationEngine are fully implemented but NEVER invoked in production code.

| Component | Status |
|-----------|--------|
| `ContextValidator` | Unused - only in tests |
| `CostValidator` | Unused - only in tests |
| `TimestampValidator` | Unused - only in tests |
| `ModelValidator` | Unused - only in tests |
| `GitValidator` | Unused - only in tests |
| `ValidationEngine` | Unused - only in tests |

**Evidence:**
- `data-gatherer.ts` does NOT import any validators
- `data-daemon.ts` does NOT import any validators
- `display-only.ts` does NOT import any validators
- Grep for `validator|Validator` in production code yields ZERO matches in data-gatherer.ts
- Only test files (`*.test.ts`) and the validator definitions themselves reference validators

**Impact:** All multi-source validation, confidence scoring, and source agreement checking is bypassed. The elaborate validation system is dead code.

---

## Validation Gaps

### 1. data-gatherer.ts: Inline Validation Only

The `calculateContext()` method in data-gatherer.ts has INLINE validation but doesn't use validators:

```
Location: v2/src/lib/data-gatherer.ts:249-300 (calculateContext method)
```

**Inline checks present:**
- Window size bounds check (10k-500k)
- `Math.max(0, Number(...) || 0)` for token extraction
- tokensUsed capped at `windowSize * 1.5`
- percentUsed capped at 100 via `Math.min(100, ...)`

**Missing checks:**
- No `isFinite()` check after `Number()` conversion (could pass NaN)
- No explicit `typeof` check on input values
- No validation that `ctx.current_usage` exists before accessing nested properties

### 2. display-only.ts: Minimal Validation

Display layer has defensive formatting but no input validation:

```
Location: v2/src/display-only.ts:144-159 (formatTokens, formatMoney)
```

**Present:**
- `!tokens || tokens < 0` returns '0' (basic guard)
- `!amount || amount < 0` returns '$0' (basic guard)

**Missing:**
- No `isFinite()` check - could display "NaN" or "Infinity"
- No `typeof` check - could crash on non-number input

### 3. NaN/Infinity Propagation Paths

**Context tokens:**
```typescript
// data-gatherer.ts:274
const inputTokens = Math.max(0, Number(currentUsage?.input_tokens) || 0);
```
- `Number(undefined)` = NaN
- `NaN || 0` = 0 (OK - protected by fallback)
- BUT: `Number("not-a-number")` = NaN, `NaN || 0` = 0 (OK)

**Cost calculations:**
```typescript
// display-only.ts:322-329 (fmtCost)
const rate = formatMoney(h.billing.burnRatePerHour);
```
- No check if `burnRatePerHour` is valid number
- Could display `$NaN/h` if health file corrupted

### 4. Division by Zero Protection

**Context validator (GOOD):**
```typescript
// context-validator.ts:180-182
const pctDiff = jsonTotal > 0 ? (diff / jsonTotal) * 100 : 100;
```
- Protected with ternary

**Cost validator (GOOD):**
```typescript
// cost-validator.ts:181
sourceAgreement: Math.max(0, 100 - (diff / Math.max(ccusageCost, 0.01)) * 100)
```
- Protected with `Math.max(..., 0.01)`

**Data gatherer (GOOD):**
```typescript
// data-gatherer.ts:292-293
result.percentUsed = compactionThreshold > 0
  ? Math.min(100, Math.floor((result.tokensUsed / compactionThreshold) * 100))
  : 0;
```
- Protected with ternary

**Display only (GOOD):**
```typescript
// display-only.ts:410-414
if (currentInput > 0 || cacheRead > 0) {
  const totalEligible = currentInput + cacheRead;
  if (totalEligible > 0) { ... }
}
```
- Protected with condition check

### 5. Nested Structure Handling

**CRITICAL FIX PRESENT:**
```typescript
// data-gatherer.ts:270-276 (Comment explicitly addresses this)
// CRITICAL FIX: Use nested current_usage structure
const currentUsage = ctx.current_usage;
const inputTokens = Math.max(0, Number(currentUsage?.input_tokens) || 0);
```
- Uses optional chaining (`?.`)
- Handles nested `context_window.current_usage.input_tokens` correctly

**Display also handles nested:**
```typescript
// display-only.ts:408-409
const currentInput = parsed?.context_window?.current_usage?.input_tokens || 0;
const cacheRead = parsed?.context_window?.current_usage?.cache_read_input_tokens || 0;
```
- Uses optional chaining throughout

### 6. Bounds Checking Gaps

**Context (PARTIAL):**
- `tokensUsed > windowSize * 1.5` capped (arbitrary 1.5x threshold)
- `percentUsed` capped at 100
- `tokensLeft` uses `Math.max(0, ...)` (negative protected)
- BUT: No upper bound on `tokensLeft`

**Billing (MISSING in display-only.ts):**
```typescript
// display-only.ts:311
const mins = Math.max(0, h.billing.budgetRemaining || 0);
```
- Lower bound (0) enforced
- No upper bound - could show "999999h" if corrupted

---

## Recommendations

### Priority 1: Decide Validator Strategy

**Option A:** Remove validators (dead code cleanup)
- Delete `/v2/src/validators/` directory
- Delete `/v2/src/lib/validation-engine.ts`
- Delete `/v2/src/types/validation.ts`
- Remove associated tests
- Rationale: If not used, it's maintenance burden

**Option B:** Integrate validators into data-gatherer
- Import and instantiate validators in data-gatherer.ts
- Call `validator.validate()` before returning data
- Log validation warnings to daemon.log
- Rationale: Enable confidence-based display

### Priority 2: Harden Display Layer

Add defensive checks in display-only.ts formatters:

```typescript
function formatTokens(tokens: number): string {
  if (typeof tokens !== 'number' || !isFinite(tokens) || tokens < 0) return '0';
  // ... existing logic
}

function formatMoney(amount: number): string {
  if (typeof amount !== 'number' || !isFinite(amount) || amount < 0) return '$0';
  // ... existing logic
}
```

### Priority 3: Add Upper Bounds

```typescript
// Budget remaining sanity check
const mins = Math.max(0, Math.min(h.billing.budgetRemaining || 0, 99999));

// Tokens sanity check
const tokens = Math.max(0, Math.min(inputTokens, 10000000)); // 10M max
```

### Priority 4: Validate Nested Access

Add explicit structure checks before accessing nested properties:

```typescript
if (ctx && typeof ctx === 'object' &&
    ctx.current_usage && typeof ctx.current_usage === 'object') {
  // safe to access ctx.current_usage.input_tokens
}
```

---

## Summary

| Area | Status | Severity |
|------|--------|----------|
| **Validators unused** | CRITICAL | High - entire validation system is dead code |
| **Division by zero** | OK | Protected in all locations |
| **Nested structure** | OK | Properly handled with optional chaining |
| **typeof checks** | PARTIAL | Present in validators, missing in display |
| **isFinite checks** | PARTIAL | Present in validators, missing in display |
| **Bounds clamping** | PARTIAL | Lower bounds OK, upper bounds missing |
| **NaN propagation** | LOW RISK | Fallback `|| 0` catches most cases |

### Key Decision Required

The validators represent significant engineering effort (~2000 LOC) that is completely unused. Either:
1. **Integrate them** - wire into data-gatherer, use confidence for display decisions
2. **Remove them** - clean dead code, simplify codebase

Current state: elaborate validation infrastructure with zero production benefit.
