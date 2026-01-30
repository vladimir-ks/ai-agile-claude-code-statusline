# Review: Billing & Cost Calculations

**Reviewer:** Claude Opus 4.5
**Date:** 2026-01-30
**Scope:** ccusage-shared-module.ts, data-gatherer.ts, display-only.ts

---

## ccusage Output Analysis

**Actual command run:** `ccusage blocks --json --active`

**Actual JSON Structure (live data):**
```json
{
  "blocks": [
    {
      "id": "2026-01-30T06:00:00.000Z",
      "startTime": "2026-01-30T06:00:00.000Z",
      "endTime": "2026-01-30T11:00:00.000Z",
      "actualEndTime": "2026-01-30T10:58:11.140Z",
      "isActive": true,
      "isGap": false,
      "entries": 2972,
      "tokenCounts": {
        "inputTokens": 188119,
        "outputTokens": 13995,
        "cacheCreationInputTokens": 10162194,
        "cacheReadInputTokens": 250764155
      },
      "totalTokens": 261128463,
      "costUSD": 168.17917359999956,
      "models": ["<synthetic>", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001"],
      "burnRate": {
        "tokensPerMinute": 1036540.2317161822,
        "tokensPerMinuteForIndicator": 802.284400506292,
        "costPerHour": 40.05487817844956
      },
      "projection": {
        "totalTokens": 265269942,
        "totalCost": 170.85,
        "remainingMinutes": 4
      }
    }
  ]
}
```

**Key Observations:**
- Block has `id` field, NOT `blockId`
- No `usageLimitResetTime` field exists (falls back to `endTime` correctly)
- `projection.remainingMinutes` available but unused
- `burnRate.costPerHour` available and correctly mapped

---

## Field Mapping Accuracy

### ccusage-shared-module.ts

| Expected Field | Actual ccusage Field | Status |
|----------------|---------------------|--------|
| `activeBlock.blockId` (line 121) | `activeBlock.id` | **WRONG** - returns empty string |
| `activeBlock.costUSD` | `activeBlock.costUSD` | CORRECT |
| `activeBlock.burnRate.costPerHour` | `activeBlock.burnRate.costPerHour` | CORRECT |
| `activeBlock.totalTokens` | `activeBlock.totalTokens` | CORRECT |
| `activeBlock.burnRate.tokensPerMinute` | `activeBlock.burnRate.tokensPerMinute` | CORRECT |
| `activeBlock.usageLimitResetTime` (line 97) | N/A - falls back to `endTime` | OK (graceful fallback) |
| `activeBlock.startTime` | `activeBlock.startTime` | CORRECT |

### data-gatherer.ts

| Code Access | CCUsageData Interface | Status |
|-------------|----------------------|--------|
| `billingData.budgetMinutesLeft` (line 121) | `hoursLeft`, `minutesLeft` | **WRONG** - field doesn't exist |
| `billingData.budgetPercentUsed` (line 122) | `percentageUsed` | **WRONG** - field name mismatch |
| `billingData.costUSD` | `costUSD` | CORRECT |
| `billingData.costPerHour` | `costPerHour` | CORRECT |
| `billingData.resetTime` | `resetTime` | CORRECT |
| `billingData.isFresh` | `isFresh` | CORRECT |

---

## Time Calculation Accuracy

### Budget Remaining Calculation (ccusage-shared-module.ts:100-116)

```typescript
const startTime = new Date(startTimeStr);    // Block start
const endTime = new Date(resetTimeStr);       // Block end (11:00 UTC)
const now = new Date();                        // Current time

const totalMs = endTime.getTime() - startTime.getTime();   // 5 hours total
const elapsedMs = now.getTime() - startTime.getTime();     // Time since start
const remainingMs = Math.max(0, endTime.getTime() - now.getTime());  // Time until end

percentageUsed = Math.min(100, Math.floor((elapsedMs / totalMs) * 100));
hoursLeft = Math.floor(remainingMs / (1000 * 60 * 60));
minutesLeft = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
```

**Analysis:**
- Calculation logic is CORRECT
- Uses block window (startTime to endTime), not budget window
- This measures "time remaining in current block" not "budget remaining"
- Note: ccusage provides `projection.remainingMinutes` which could be used instead

### Reset Time Formatting (ccusage-shared-module.ts:117)

```typescript
resetTime = `${String(endTime.getUTCHours()).padStart(2, '0')}:${String(endTime.getUTCMinutes()).padStart(2, '0')}`;
```

**Status:** CORRECT - formats as HH:MM UTC

---

## Critical Issues

### 1. Constructor Signature Mismatch (data-gatherer.ts:52-58)
```typescript
this.ccusageModule = new CCUsageSharedModule({
  id: 'ccusage',
  name: 'CCUsage Module',
  enabled: true,
  cacheTTL: 120000,
  timeout: 25000
});
```

**Problem:** `CCUsageSharedModule` class has NO constructor accepting config object.
```typescript
// ccusage-shared-module.ts - no constructor defined
class CCUsageSharedModule implements DataModule<CCUsageData> {
  readonly moduleId = 'ccusage';
  config: DataModuleConfig = {
    timeout: 35000,
    cacheTTL: 900000
  };
  // No constructor!
}
```

**Impact:** TypeScript should error; if it passes, the config is silently ignored.
**Location:** data-gatherer.ts:52-58

### 2. Field Name Mismatch - budgetMinutesLeft (data-gatherer.ts:121)
```typescript
budgetRemaining: billingData.budgetMinutesLeft || 0,  // WRONG
```

**Problem:** `CCUsageData` interface has `hoursLeft` and `minutesLeft`, not `budgetMinutesLeft`.
**Result:** `budgetRemaining` is always 0.
**Location:** data-gatherer.ts:121

### 3. Field Name Mismatch - budgetPercentUsed (data-gatherer.ts:122)
```typescript
budgetPercentUsed: billingData.budgetPercentUsed || 0,  // WRONG
```

**Problem:** `CCUsageData` interface has `percentageUsed`, not `budgetPercentUsed`.
**Result:** `budgetPercentUsed` is always 0.
**Location:** data-gatherer.ts:122

### 4. blockId Field Mismatch (ccusage-shared-module.ts:121)
```typescript
blockId: activeBlock.blockId || '',  // WRONG
```

**Problem:** ccusage output has `id`, not `blockId`.
**Result:** `blockId` is always empty string.
**Location:** ccusage-shared-module.ts:121

---

## Important Issues

### 1. Cache TTL Inconsistency
| Location | Value | Comment |
|----------|-------|---------|
| ccusage-shared-module.ts:56 | 900000 (15 min) | Class default |
| data-gatherer.ts:56 | 120000 (2 min) | Passed to constructor (IGNORED) |
| data-gatherer.ts:108 | 120000 (2 min) | Manual freshness check |

**Problem:** Config passed to constructor is ignored due to missing constructor.
**Effective TTL:** The 2-minute TTL check in data-gatherer.ts:108 works because it's manual, not via module config.

### 2. Staleness Indicator Threshold
- CLAUDE.md documents: "🔴 appears when ccusage data >1 hour old"
- display-only.ts:235: `if (!h.billing.isFresh) result += '🔴'`
- `isFresh` is set to false only when fetch fails (ccusage-shared-module.ts:154)

**Problem:** No time-based staleness check for 1-hour threshold. The `isFresh` flag only indicates fetch failure, not data age.

### 3. Unused projection.remainingMinutes
ccusage provides `projection.remainingMinutes` (actual remaining minutes in current rate) but code calculates it manually from block times. The manual calculation shows "time until block ends" not "budget minutes remaining at current rate".

---

## display-only.ts Analysis

### fmtBudget Function (lines 225-237)
```typescript
function fmtBudget(h: SessionHealth): string {
  if (!h.billing?.budgetRemaining && h.billing?.budgetRemaining !== 0) return '';
  const mins = h.billing.budgetRemaining || 0;  // Gets 0 due to data-gatherer bug
  const hours = Math.floor(mins / 60);           // = 0
  const m = mins % 60;                           // = 0
  const pct = h.billing.budgetPercentUsed || 0;  // Gets 0 due to data-gatherer bug
  // Output: ⌛:0h0m(0%)...
}
```

**Status:** Function logic is correct, but receives zeroed data.

### fmtCost Function (lines 239-247)
```typescript
function fmtCost(h: SessionHealth): string {
  if (!h.billing?.costToday) return '';
  const cost = formatMoney(h.billing.costToday);  // CORRECT
  if (h.billing.burnRatePerHour > 0) {
    const rate = formatMoney(h.billing.burnRatePerHour);  // CORRECT
    return `💰:${cost}|${rate}/h`;
  }
}
```

**Status:** CORRECT - properly displays cost and burn rate.

---

## Recommendations

### Immediate Fixes Required

1. **Fix blockId mapping** in ccusage-shared-module.ts:121
   ```typescript
   blockId: activeBlock.id || '',  // Use .id not .blockId
   ```

2. **Fix data-gatherer.ts field mappings** (lines 121-122)
   ```typescript
   budgetRemaining: (billingData.hoursLeft * 60) + billingData.minutesLeft || 0,
   budgetPercentUsed: billingData.percentageUsed || 0,
   ```

3. **Add constructor to CCUsageSharedModule** or remove config from instantiation
   ```typescript
   // Option A: Add constructor
   constructor(config?: Partial<DataModuleConfig>) {
     if (config) {
       this.config = { ...this.config, ...config };
     }
   }

   // Option B: Remove config from data-gatherer.ts
   this.ccusageModule = new CCUsageSharedModule();
   ```

4. **Implement time-based staleness** for billing data
   ```typescript
   // In display-only.ts or data-gatherer.ts
   const billingAge = Date.now() - (health.billing.lastFetched || 0);
   const STALE_THRESHOLD = 3600000; // 1 hour per docs
   if (billingAge > STALE_THRESHOLD) {
     health.billing.isFresh = false;
   }
   ```

### Consider Using projection.remainingMinutes
The ccusage `projection.remainingMinutes` field provides actual remaining time at current burn rate, which may be more meaningful than "time until block ends".

---

## Summary

**Severity: HIGH** - Multiple critical field mapping errors cause budget display to always show zeros.

**Root Cause:** Interface mismatch between:
1. `CCUsageData` interface in ccusage-shared-module.ts
2. Field access in data-gatherer.ts
3. Actual ccusage JSON output

**Impact:**
- Budget remaining shows `0h0m(0%)` always
- blockId field always empty
- Constructor config silently ignored
- 1-hour staleness indicator never triggers based on time

**Cost and burn rate calculations are CORRECT.**
**Time remaining calculation logic is CORRECT but receives wrong field names.**

**Is 2-minute billing cache TTL reasonable?** Yes, for the daemon. The manual check in data-gatherer.ts:108 correctly implements 2-minute freshness. The module's 15-minute TTL is ignored.
