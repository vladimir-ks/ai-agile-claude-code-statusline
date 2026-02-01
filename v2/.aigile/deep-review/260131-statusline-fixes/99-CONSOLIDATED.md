# Deep Review Results

**Date**: 260131-23-07
**Scope**: Statusline data flow and display fixes
**Partitions**: 4

## Critical Issues Fixed

### 1. Budget Percentage Shows 0% (FIXED)
**File**: `src/lib/data-gatherer.ts:276-280`
**Problem**: ccusage doesn't provide `percentageUsed` directly, was calculating from elapsed time
**Fix**: Added `SubscriptionReader.getCurrentSessionQuota()` to read user-managed percentage from subscription.yaml

### 2. Cost Drop Order Wrong (FIXED)
**File**: `src/lib/statusline-formatter.ts:395-426`
**Problem**: Was dropping total cost first, keeping burn rate
**Fix**: Reversed priority - now keeps total cost, drops burn rate when space is tight

### 3. Weekly Quota Stale (FIXED)
**File**: `src/lib/data-gatherer.ts:257-275`
**Problem**: Shared billing cache had old weekly data overwriting subscription.yaml
**Fix**: subscription.yaml is now ALWAYS authoritative for weekly quota, explicitly clears stale data

### 4. Component Drop Priority (FIXED)
**File**: `src/lib/statusline-formatter.ts:175-203, 428-451`
**Problem**: Cost was dropping before Usage
**Fix**: Corrected drop order:
1. First drop: Usage (📊) - increased threshold to 35 chars
2. Then drop: Turns (💬)
3. Then drop: Burn rate (keep total cost)
4. Never drop: Time|Budget|Weekly

### 5. Context Color Coding (ENHANCED)
**File**: `src/lib/statusline-formatter.ts:273-320`
**Problem**: Context always showed green regardless of pressure
**Fix**: Added dynamic color based on percentUsed:
- Green: <70%
- Yellow: 70-94%
- Red: ≥95%

## Runtime Issues Identified

### YAML Parsing Error
**File**: `~/.claude/session-health/runtime-state.yaml`
**Problem**: Duplicate keys causing parse failures
**Impact**: Daemon crashes, billing data not written to session health
**User Action Required**: Delete runtime-state.yaml to reset

### OAuth 401 Errors
**Status**: Expected - Anthropic API doesn't support OAuth authentication
**Mitigation**: Falls back to ccusage + subscription.yaml

## Data Flow Verification

```
subscription.yaml (user-managed)
    ↓ weeklyBudgetPercentUsed, budgetPercentUsed
    ↓
data-gatherer.ts
    ↓ merge into health.billing
    ↓
StatuslineFormatter.formatAllVariants()
    ↓ pre-format for 7 widths
    ↓
{session}.json (formattedOutput)
    ↓
display-only.ts (lookup by width)
    ↓
stdout
```

## Test Results
- 47 tests passing
- Formatter integration tests: PASS
- Cost/budget formatting: PASS

## Action Items (User Required)

1. **Update subscription.yaml** - Set weekly `percentUsed: 83` (currently shows 73%)
2. **Delete corrupted runtime-state.yaml** to reset daemon
3. **Refresh billing** - Run `bun src/force-billing-refresh.ts` after updating YAML

## Files Modified

| File | Changes |
|------|---------|
| `src/lib/statusline-formatter.ts` | Fixed cost priority, context colors, drop order |
| `src/lib/data-gatherer.ts` | Added session quota, fixed weekly authority |
| `src/lib/subscription-reader.ts` | Added `getCurrentSessionQuota()` method |
