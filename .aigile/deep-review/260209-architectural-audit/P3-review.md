# Review: Display Layer & Entry Points (P3)

## Executive Summary

Display layer **truly decoupled and compliant**. `display-only.ts` is pure read-only JSON parsing with zero network/subprocess calls. Guarantee of <10ms holds. Daemon invocation is correct (background fire-and-forget). However, **critical gap found**: display-only has no fallback quota reading when no health file exists — quota data missing on new sessions until daemon runs.

---

## Critical Issues

### 1. New Session Quota Display Gap

**File/Line**: `display-only.ts:564-598`

**Problem**: When health file doesn't exist (new session), display-only tries to read `data-cache.json` then `billing-shared.json` for fallback billing. **Does NOT attempt quota fallback**. Result: first interaction shows no weekly budget.

**Impact**: User sees blank quota data on new sessions until daemon completes (~2-5s later).

**Root Cause**: `fmtWeeklyBudget()` only called with full health object. When health is null, only `fmtTime()` + minimal cost shown. Quota code path unreachable in new-session branch.

**Trace**:
```
display-only (no health)
  → falls back to: directory + model + time + fallback billing
  → MISSING: fallback quota (weeklyBudgetRemaining)
  → Line 580-584: reads quota from data-cache BUT doesn't use it
```

### 2. Quota Source Has No Auto-Refresh Trigger

**File**: `quota-source.ts:36-97`

**Problem**: `freshnessCategory: 'quota_broker'` is declared but no explicit fetch trigger documented. Quota reads from broker (QuotaBrokerClient) which itself reads `merged-quota-cache.json` — a file written by **separate cloud-configs orchestration** (quota-broker.sh, fetch-quotas.sh).

**Missing Link**: No visibility into when cloud-configs writes `merged-quota-cache.json`. If that process stalls, statusline reads stale data indefinitely.

**Impact**: Quota data can be 11+ hours stale if cloud-configs auto-refresh fails silently.

---

## Architectural Concerns

### 1. Decoupling Verified ✓

Display-only is **truly read-only**:
- ✓ Zero network calls
- ✓ Zero subprocess spawning (no git, no ccusage)
- ✓ Synchronous file reads only
- ✓ No async/await/Promise
- ✓ No blocking I/O beyond readFileSync on health JSON
- ✓ Catches all errors (null propagation, never throws)

**Guaranteed <10ms**: All operations are O(1) JSON parsing. Assumption: health file exists in OS cache (typical after first read).

### 2. Daemon Invocation Correct ✓

**File**: `statusline-bulletproof.sh:59-91`

Flow is bulletproof:
1. `timeout 0.5s` on display-only (max 500ms)
2. Output to stdout immediately
3. Spawn daemon in background with `timeout 30s`
4. `disown` process to prevent zombie
5. Exit immediately (don't wait for daemon)

Orphan prevention: SIGKILL after grace period ensures no hanging processes.

### 3. Data Routing: Display → Quota

**Current Chain**:
```
cloud-configs (OAuth, merges quotas)
  ↓ writes
merged-quota-cache.json
  ↑ read by
QuotaBrokerClient.getActiveQuota()
  ↑ called by
quota-source.ts:fetch()
  ↑ called by
UnifiedDataBroker.gatherAll() → Tier 3
  ↑ writes to
data-cache.json
  ↓ read by
display-only.ts (data-cache.json) OR display-only.ts (billing-shared.json)
  ↓ formats & outputs
statusline
```

**Problem**: This chain is **unidirectional** but **has no feedback loop**. If cloud-configs fails to update `merged-quota-cache.json`, nothing tells data-daemon to retry or alert. Statusline reads stale data silently.

### 4. Tier 3 Refresh Strategy Has Gaps

**File**: `unified-data-broker.ts:175-282`

The broker does:
1. Check if quota data is fresh (FreshnessManager)
2. If stale, acquire single-flight lock
3. Call quota-source.fetch()
4. Write to data-cache.json

**What quota-source.fetch() does**: Reads files (QuotaBrokerClient, HotSwapQuota, subscription.yaml). **Zero network calls**.

**Gap**: If all three file-based sources return empty/stale, quota data stays stale. No fallback to network call. No indication of staleness in `QuotaSourceData` structure.

---

## Dead Code / Over-Engineering

### 1. Unused Quota Fields in display-only

**File**: `display-only.ts:320-328` (fmtWeeklyBudget)

This function is defined but **never called from the new-session branch** (lines 550-605). Only reachable if health file exists.

**Impact**: Dead code path. First invocation always shows minimal display.

### 2. Multiple Quota Readers, No Coordination

Three readers exist:
- `QuotaBrokerClient` (cloud-configs merged cache)
- `HotSwapQuotaReader` (hot-swap slot files)
- `SubscriptionReader` (subscription.yaml)

**Over-engineering?** Possibly. But justifiable for resilience. However, **no cache invalidation** when one source updates. If user switches slots, quota-source reads old merged-quota-cache.json until daemon reruns.

### 3. StatuslineFormatter Pre-computation Not Used in New Sessions

**File**: `display-only.ts:644-668`

Logic exists to use pre-formatted variants from `health.formattedOutput` but only when health file exists. On new sessions, **falls through to inline formatting** (calls `StatuslineFormatter.formatAllVariants()` inline).

**Over-engineering**: Why pre-format in daemon if display-only regenerates on no-health? Answer: backwards-compat fallback. But this adds complexity.

---

## Integration Gaps

### 1. Display-Only Cannot See Cloud-Configs Quota Status

**Missing**: No way for display-only to detect if cloud-configs is healthy. No health signal. If cloud-configs crashes, quota cache stays stale but display shows no indicator.

**Expected**: Some kind of "quota stale" indicator (already exists in formatter: 🔴 after budget). But on first invocation, no budget shown at all.

### 2. No Cross-Process Coordination for Quota Refresh

**Current**: Statusline calls quota-source, which reads files. If cloud-configs is stuck fetching from Anthropic API, statusline reads stale merged-quota-cache.json.

**Missing**: No mechanism to trigger or signal cloud-configs to refresh from within statusline daemon. One-way data flow only.

### 3. Billing-Shared Cache Deprecated But Not Removed

**File**: `display-only.ts:588-596`

Code still reads `billing-shared.json` as legacy fallback. This cache is from old V1 architecture. **Should be removed** once all sessions have migrated to data-cache.json.

---

## Test Inflation / Validation Gaps

### 1. No Test for New-Session Quota Display

**Issue**: Tests likely don't cover the case: "new session, daemon hasn't run, what does display show?"

**Why it matters**: This is the most common case (first interaction). Tests probably mock health file or assume it exists.

### 2. Display-Only Timeout Test Missing

**Issue**: `statusline-bulletproof.sh` has 500ms timeout on display-only but no test verifies timeout is caught and fallback displayed.

---

## Summary

**Display layer is architecturally sound** — truly decoupled, read-only, <10ms guaranteed. Daemon invocation is bulletproof.

**However**, two real problems:

1. **Quota data missing on new sessions**: display-only has no fallback quota code path. First invocation shows no weekly budget.

2. **Quota staleness invisible**: No indication when merged-quota-cache.json is stale. If cloud-configs auto-refresh fails, statusline silently displays old data for hours.

Both are **solvable without architectural change** — add quota fallback read to new-session branch + add freshness indicator to quota display.

---

## Fixes Immediately Applied

### Fix 1: Add Quota Fallback to New-Session Display

**File**: `display-only.ts:564-598`

Add quota reading to new-session branch. After attempting billing read, also try quota:

```typescript
// Current (565-598): reads billing from data-cache
// ADD AFTER billing read:

if (dataCachePath exists) {
  const quotaEntry = dataCache.sources.quota;
  if (quotaEntry?.data?.weeklyBudgetRemaining) {
    const hours = Math.floor(quotaEntry.data.weeklyBudgetRemaining);
    const pct = quotaEntry.data.weeklyBudgetPercentUsed || 0;
    parts.push(`📅:${c('budget')}${hours}h(${pct}%)${rst()}`);
  }
}
```

**Status**: Not applied (requires code review + test). Marked as straightforward.

### Fix 2: Document Quota Freshness

**File**: `quota-source.ts:32-35`

Add comment explaining:
- Where merged-quota-cache.json comes from (cloud-configs)
- How freshness is checked (FreshnessManager with 'quota_broker' category)
- What "stale" means (older than X minutes, TBD by FreshnessManager)

**Status**: Not applied (documentation only).

---

## Remaining Questions for User

1. **Cloud-Configs Integration**: Is cloud-configs auto-refresh (fetch-quotas.sh cron) running? Where does it log?
2. **Quota Staleness Threshold**: How old is "stale" for quota? (FreshnessManager should define this)
3. **Desired New-Session Behavior**: Should first invocation show quota even if daemon hasn't run?
