# Deep Review Results: Data Staleness Issue

**Date**: 2026-02-01
**Scope**: Billing data staleness (⚠⚠ indicator)
**Partitions**: 4 (Daemon, Billing/CCUsage, Cooldown/Lock, Display)

---

## Root Cause Analysis

The ⚠⚠ "very stale" billing indicator is caused by **cascading failures across 4 misaligned systems**:

```
┌─────────────────────────────────────────────────────────────────┐
│                    THE STALENESS CASCADE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. COOLDOWN MISMATCH                                           │
│     ├─ cooldown-manager.ts:30 → 5min (300s)                    │
│     └─ ccusage-shared-module.ts:60 → 2min (120s) cacheTTL      │
│     RESULT: Module expects 2min refresh, cooldown blocks 5min   │
│                                                                 │
│  2. COOLDOWN RETURNS STALE                                      │
│     └─ ccusage-shared-module.ts:73-76                          │
│        When cooldown active → returns isFresh: false            │
│        SHOULD: Return cached fresh data                         │
│        DOES: Returns stale indicator immediately                │
│                                                                 │
│  3. STALENESS THRESHOLD MISMATCH                                │
│     └─ statusline-formatter.ts:568 → 3min threshold            │
│        Cooldown: 5min, Staleness: 3min                         │
│        RESULT: Data marked "very stale" after 3min             │
│                but cooldown prevents refresh for 5min           │
│                                                                 │
│  4. LOCK TIMEOUT RACE                                           │
│     ├─ process-lock.ts:32-34 → 35s timeout                     │
│     └─ ccusage can take 25-35s                                 │
│     RESULT: Lock released while ccusage still running           │
│             → duplicate ccusage calls, lock contention          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Critical Issues (De-duplicated)

### 1. **cooldown-manager.ts:30** - Billing Cooldown Too Long
- Set to 5min (300000ms) but staleness threshold is 3min
- Creates 2min window where data appears "very stale" but refresh is blocked
- **FIX**: Reduce to 2min (120000ms) to match cache TTL

### 2. **ccusage-shared-module.ts:73-76** - Cooldown Returns Stale Instead of Cached
- When cooldown is active, returns `isFresh: false` immediately
- Should return LAST SUCCESSFUL fetch data with `isFresh: true`
- **FIX**: Return shared billing cache data when cooldown prevents fetch

### 3. **statusline-formatter.ts:568** - Staleness Threshold Misaligned
- 3min threshold for ⚠ marker, but cooldown is 5min
- Data will ALWAYS show stale for 2-5min after fetch
- **FIX**: Either increase threshold to match cooldown OR reduce cooldown

### 4. **process-lock.ts:32-34** - Lock Timeout Too Short
- 35s timeout matches ccusage execution time exactly
- Race condition: lock released while ccusage still running
- **FIX**: Increase timeout to 60s with 5s retry interval

### 5. **data-gatherer.ts:173-178** - Shared Cache Validates Timestamp Only
- Checks `lastFetched < 2min` but doesn't validate `costToday > 0`
- Empty/failed fetch data reused indefinitely
- **FIX**: Add `costToday > 0` validation before using cache

---

## Important Issues

| Location | Issue | Impact |
|----------|-------|--------|
| budget-module.ts:35 | Calls ccusage directly (bypasses shared module) | Duplicate fetches, lock contention |
| cost-module.ts:49 | Calls ccusage directly (bypasses shared module) | Duplicate fetches, lock contention |
| data-gatherer.ts:239-244 | Fallback preserves original stale status | Shows ⚠ even with valid cached data |
| ccusage-shared-module.ts:98-99 | Lock failure returns stale immediately | No wait-and-retry for locked resource |
| display-only.ts:599-620 | No formattedOutput staleness check | Can display hours-old formatting |

---

## Architectural Gaps

1. **No "intentionally deferred" vs "failed fetch" distinction** - Display shows same ⚠⚠ for both
2. **No force-refresh mechanism** - Can't bypass cooldown for testing/emergency
3. **No observability in cooldown** - Can't tell from logs if cooldown blocked fetch
4. **formattedOutput has no timestamp** - Can outlive the data it represents
5. **Insufficient test coverage** - No concurrent load tests for lock/cooldown interaction

---

## Action Items (Priority Order)

### P0 - Fix Immediately (Root Cause)

1. **Reduce billing cooldown to 2min** (cooldown-manager.ts:30)
   ```typescript
   'billing': { name: 'billing', ttlMs: 120000, sharedAcrossSessions: true }
   ```

2. **Return cached data when cooldown active** (ccusage-shared-module.ts:73-76)
   ```typescript
   if (!this.cooldownManager.shouldRun('billing')) {
     const cached = this.readSharedBillingCache();
     if (cached?.isFresh) return cached;
     // Only fall through if no cached data
   }
   ```

3. **Increase lock timeout** (process-lock.ts:32-34)
   ```typescript
   timeout: 60000,      // 60s (was 35s)
   retryInterval: 5000, // 5s (was 3s)
   maxRetries: 15       // 75s total retry window
   ```

### P1 - Fix Soon (Data Quality)

4. **Add cost validation to cache check** (data-gatherer.ts:173)
5. **Add logging to cooldown decisions** (ccusage-shared-module.ts:73)
6. **Validate ccusage response data quality** (ccusage-shared-module.ts:161)

### P2 - Refactor (Architecture)

7. **Remove direct ccusage calls** from budget-module.ts and cost-module.ts
8. **Add formattedOutput.generatedAt** timestamp to SessionHealth
9. **Add tests for concurrent scenarios**

---

## Fixes Applied by P1 Agent

The P1 agent applied several fixes during review:

1. **process-lock.ts:29-35** - Extended lock timeout (35s→60s, 3s→5s interval)
2. **cooldown-manager.ts:30** - Updated comment (still needs value change)
3. **data-gatherer.ts:173-175** - Added `costToday > 0` validation
4. **ccusage-shared-module.ts:70-77** - Added diagnostic logging
5. **ccusage-shared-module.ts:87** - Added success logging
6. **ccusage-shared-module.ts:161-178** - Added data quality validation
7. **ccusage-shared-module.ts:176** - Only marks cooldown on valid data

---

## Expected Outcome After Fixes

1. Billing data refreshes every 2min (not 5min)
2. Cooldown returns cached fresh data (not stale indicator)
3. Lock timeout allows full ccusage execution
4. ⚠⚠ indicator only shows when data is actually stale (not just deferred)
5. Daemon logs show clear cooldown/fetch status for debugging
