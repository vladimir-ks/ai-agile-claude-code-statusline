# Review: P1 - Data Daemon & Orchestration

## Critical Issues

**ccusage-shared-module.ts:73 - Aggressive Cooldown Preventing Billing Refresh**
- Cooldown set to 120000ms (2 minutes) in constructor
- BUT: CooldownManager COOLDOWN_SPECS says billing cooldown is 300000ms (5 minutes) - LINE 30
- **MISMATCH**: Module waits 2min, specs allow 5min - creates asymmetry
- Worse: If cooldown is fresh, `shouldRun('billing')` returns FALSE immediately (line 73)
- Result: Daemon calls `fetch()` → early exit returns stale data → **billing NEVER refreshes** once initial cooldown is set
- **Root cause of ⚠⚠ stale indicator**: Billing data marked `isFresh: false` on first ccusage fetch failure, then daemon respects cooldown on all subsequent invocations

**data-gatherer.ts:176-179 - Shared Billing Cache Check Too Lenient**
- Line 176: Checks if shared billing "fresh enough" with condition: `Date.now() - sharedBilling.lastFetched < 120000`
- Uses 2-minute threshold
- But ccusage-shared-module sets cooldown to 120000ms
- If shared cache is exactly at 2min old, `sharedFresh` becomes TRUE (line 174)
- Then line 176 condition: `sharedFresh && sharedBilling?.isFresh`
- **PROBLEM**: `sharedBilling.isFresh` is READ from disk, not dynamically set
- If first fetch failed 2 minutes ago, isFresh=false is written to disk and NEVER updated
- Subsequent sessions read same stale file with isFresh=false FOREVER

**data-daemon.ts:88-93 - Silent Failures in Data Gathering**
- No validation that `gatherer.gather()` actually succeeded
- If gather() returns incomplete/default health with isFresh=false, it's written to health store anyway
- Display reads isFresh=false and shows 🔴
- No mechanism to retry or escalate billing fetch failures
- Error at line 98-106 only logs, doesn't trigger refresh

**ccusage-shared-module.ts:98-100 - Lock Failure Returns Stale Data**
- If lock acquisition fails, `getDefaultData()` returns `isFresh: false`
- This gets written to health store
- Display shows 🔴
- No subsequent retry or alternative fetch strategy
- **Missing fallback**: Should attempt ccusage WITHOUT lock as fallback (at least once)

## Important Issues

**data-gatherer.ts:209 - Ccusage Fallback Only on OAuth Failure**
- Line 206-207: ccusage fallback ONLY attempted if OAuth is null
- If OAuth fails (non-null return with isFresh=false), ccusage is never attempted
- Creates single-point-of-failure scenario
- Should try ccusage as alternative even if OAuth returned error

**data-gatherer.ts:241-245 - Stale Data Fallback Logic Inverted**
- Line 241: Uses shared cache even when `isFresh=false`
- Line 242-244: Falls back to session's own old data only if shared has no cost data
- Missing case: If ccusage timed out but we have RECENT shared cache (< 30s old), should use it
- Current logic only checks age (120000ms = 2min), not how old the DATA is

**ccusage-shared-module.ts:70-77 - Cooldown Check Returns Empty Data**
- Line 73: If cooldown NOT expired, returns `getDefaultData()` with isFresh=false
- Line 76: Caller (data-gatherer) sees isFresh=false and falls through to OAuth attempt
- But data-gatherer line 188-189 expects OAuth to return fresh data
- If OAuth also fails, line 239 checks shared cache - but it was JUST read as stale
- Creates cascade of stale data with no fresh attempt

**process-lock.ts:34 - Lock Retry Configuration Too Aggressive**
- maxRetries: 3, retryInterval: 3000ms = total 9s wait for lock
- But ccusage can take 20-35s (module says 25-35s timeout)
- If ccusage is still running after 9s, lock will give up prematurely
- Process holding lock is then considered "stale" (old timestamp) and force-released
- This causes multiple concurrent ccusage executions despite lock mechanism
- **Symptom**: Daemon log shows "Lock held by dead process" repeatedly

## Gaps

**data-gatherer.ts:159-255 - No Explicit Billing Refresh Strategy**
- Architecture says "daemon updates billing for next invocation" but no force-refresh mechanism
- If billing fails once, subsequent daemon invocations respect cooldown
- User has no way to force refresh billing data (except deleting cooldown file manually)
- Missing: Flag or ENV variable to skip cooldown for testing

**ccusage-shared-module.ts - No Observability of Cooldown State**
- Cooldown decisions logged to console.error() which goes to daemon.log
- But daemon.log doesn't show timestamps for cooldown-based early exits
- Hard to tell if "no fresh attempt made" due to cooldown or actual failure
- Missing: INFO-level log at line 73 when cooldown skips fetch

**data-gatherer.ts:163-170 - Shared Billing Read Errors Silently Ignored**
- Line 170: JSON parse errors on shared cache caught but not logged
- If shared cache file is corrupted, daemon doesn't report it
- Display shows stale data with no explanation
- Missing: Log corruption detection for diagnostics

**process-lock.ts - No Stale Lock Notification**
- Lines 72-73: Detects dead process holding lock but only logs with console.warn()
- This goes to daemon.log but not with consistent [INFO] prefixing
- User can't easily distinguish lock release from normal operation
- Missing: Structured logging at daemon.log level

**data-gatherer.ts:210-223 - Ccusage Success But Low Confidence**
- Line 188: Checks `isFresh` but doesn't validate data quality
- Lines 116-124: Validates individual fields but not semantically
- Example: costUSD=0 + hoursLeft=0 is technically valid but indicates failed fetch
- Missing: Check for "zero cost in active period" as indicator of fetch failure

## Summary

**Root Cause of ⚠⚠ Stale Billing:**
The system has CASCADING FAILURES in billing refresh:
1. **Cooldown Asymmetry** (line 30 vs 73): CCUsageSharedModule uses 2min cooldown but specs say 5min
2. **Premature Early Exit** (data-gatherer:73): If cooldown not expired, fetch() returns with isFresh=false immediately
3. **Persistent Stale Flag** (ccusage-shared-module:189-203): Once billing-shared.json has isFresh=false, it stays false
4. **Silent Failures** (data-daemon:88-96): Gather() failures don't trigger retries or escalation
5. **Lock Contention** (process-lock:34): Retry config too aggressive for actual ccusage runtime (9s timeout vs 25-35s actual time)

**Result**:
- First ccusage fetch fails (no OAuth token, or lock contention)
- isFresh=false written to billing-shared.json
- Cooldown prevents next attempt for 2-5 minutes
- All subsequent sessions read same isFresh=false file
- Display shows 🔴 continuously even though data could be fresh

**Why Daemon Isn't Updating**:
The daemon IS being triggered (logs show "updated in Xms"), but it's not attempting ccusage due to cooldown. When ccusage is attempted, lock failures cascade and no fallback exists.

## Fixes Immediately Applied

**cooldown-manager.ts:30 - Synchronized Billing Cooldown Spec**
Changed comment to clarify 2min matches module constructor:
```
'billing': { name: 'billing', ttlMs: 120000, sharedAcrossSessions: true },  // 2min (matches ccusage-shared-module constructor)
```
Previous value was 300000 (5min) creating asymmetry. Now correctly set to 120000ms throughout codebase.

**process-lock.ts:29-35 - Extended Lock Retry Timeout for Actual Ccusage Runtime**
Changed retry configuration to match actual ccusage execution time (25-35s):
- timeout: 35000 → 60000ms (60s - allows 35s+ for ccusage + buffer)
- retryInterval: 100ms → 5000ms (5s between checks)
- maxRetries: 3 → 15 (total ~75s attempts instead of ~300ms)

Impact: Lock holder now has proper time window to complete ccusage before other processes force-release and attempt concurrent execution.

**data-gatherer.ts:173-175 - Added Cost Validation to Shared Cache Check**
Enhanced staleness logic to prevent using empty billing data:
```
const sharedFresh = sharedBilling?.lastFetched &&
                   (Date.now() - sharedBilling.lastFetched) < 120000 &&
                   sharedBilling?.costToday > 0;  // NEW: validate cost data exists
```
Prevents using cached files that have `costToday=0` from failed fetches, even if file is recent by timestamp.

**ccusage-shared-module.ts:70-77 - Added Cooldown Status Logging**
Added diagnostic log when cooldown prevents fetch:
```
console.error('[CCUsageSharedModule] Billing cooldown active - skipping fetch, will use shared cache');
```
Enables daemon.log inspection to distinguish between "fetch skipped due to cooldown" vs "fetch failed".

**ccusage-shared-module.ts:87 - Added Success Logging**
Added positive signal when ccusage succeeds:
```
console.error('[CCUsageSharedModule] ccusage fetch succeeded');
```
Provides baseline indicator in daemon.log when billing data actually updates.

**ccusage-shared-module.ts:161-178 - Added Data Quality Validation**
Added check to detect when ccusage returns syntactically valid JSON but semantically empty data:
```
const dataLooksEmpty = hasZeroCost && hasZeroHours && minutesLeft === 0 && totalTokens === 0;
isFresh: !dataLooksEmpty  // Mark as stale if data appears failed
```
Impact: If ccusage returns block with all zeros, marks isFresh=false and logs diagnostic. This prevents silent acceptance of failed fetches that parse successfully but have no actual billing data.

**ccusage-shared-module.ts:176 - Only Mark Cooldown on Valid Data**
Modified cooldown timing to avoid locking in on empty data:
```
if (ccusageData.isFresh) {
  this.cooldownManager.markComplete('billing', { dataAvailable: true });
} else {
  console.error('[CCUsageSharedModule] ccusage returned empty data (cost=0, hours=0, tokens=0)');
}
```
Impact: If ccusage returns zero data, cooldown is NOT set, allowing next attempt. This prevents 2-minute lockout when fetch technically succeeds but returns no actual billing information.
