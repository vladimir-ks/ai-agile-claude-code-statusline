# Review: P2 - Billing & CCUsage Module

## Critical Issues

### 1. ccusage-shared-module.ts:73 - Cooldown Gate Preventing Billing Refresh
**Issue**: `CCUsageSharedModule.fetch()` checks cooldown BEFORE attempting lock/ccusage.
```
Line 73: if (!this.cooldownManager.shouldRun('billing')) {
           return this.getDefaultData();  // Returns isFresh: false
```
**Problem**: With 5min cooldown (COOLDOWN_SPECS line 30), any session within 5 minutes of the last fetch returns stale default data without trying ccusage. This means:
- First session fetches at T+0
- Sessions at T+1, T+2, T+3, T+4 ALL return isFresh:false (stale indicators)
- Only at T+5 does cooldown expire and ccusage runs again

**Impact**: Billing always shows ⚠⚠ if sessions run within 5min window. With frequent polling (every message), this is nearly constant staleness.

**Root Cause**: Cooldown spec at `/Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/cooldown-manager.ts:30` sets 5min (300000ms) for billing. Module comment at line 11 says "2min cooldown" but code uses different value.

---

### 2. cooldown-manager.ts:30 - Billing Cooldown TTL Mismatch
**Issue**: Configuration defines TWO different cooldown values:
- ccusage-shared-module.ts:60 sets `cacheTTL: 120000` (2 minutes)
- cooldown-manager.ts:30 sets `ttlMs: 300000` (5 minutes)

**Problem**: When `CCUsageSharedModule.shouldRun('billing')` calls cooldown manager, it uses the 5min TTL instead of the 2min value the module expects.

**Data Flow**:
```
CCUsageSharedModule tries to fetch
  → cooldownManager.shouldRun('billing')  [uses 5min TTL]
  → Returns false if age < 300000ms
  → Returns isFresh: false (never tries lock/ccusage)
```

Result: Even fresh ccusage data ages out of cooldown but still appears stale (isFresh: false) for 3 extra minutes.

---

### 3. ccusage-shared-module.ts:74-76 - Cooldown Returns isFresh:false
**Issue**: When cooldown is active, fetch returns `getDefaultData()` which has `isFresh: false`:
```
Line 74-76: if (!this.cooldownManager.shouldRun('billing')) {
              return this.getDefaultData();  // isFresh: false
            }
```

**Problem**:
- Cooldown SHOULD mean "data is fresh from recent fetch, skip ccusage"
- Instead it means "pretend we have no data" (isFresh: false)
- Display layer shows ⚠⚠ stale indicator for data that's actually only 30s old

**Expected Behavior**: Should return last successful fetch data with isFresh: true, OR read from shared billing cache

---

### 4. ccusage-shared-module.ts:179 - Cooldown Marked AFTER Successful Fetch
**Issue**: `markComplete('billing')` is called ONLY on success:
```
Line 178-179: return ccusageData;
            // Cool
down marked AFTER return (success path only)
```

**Problem**: Implicit - no guarantee cooldown is written if serialization fails. Also, ProcessLock failure (line 98) returns default data WITHOUT marking cooldown, meaning lock contention causes rapid retry spamming.

---

## Important Issues

### 5. ccusage-shared-module.ts:98-99 - Lock Failure Returns Stale Data
**Issue**: When ProcessLock fails to acquire lock:
```
Line 98-100: if (!result) {
               return this.getDefaultData();  // isFresh: false
             }
```

**Problem**: Lock failure signals "another session is fetching". Should wait 1-2s and return shared billing cache, not instant stale marker. Current behavior causes all waiting sessions to show stale immediately.

**Expected Behavior**: Caller (data-gatherer) has fallback to shared cache, but module signals staleness instead of "waiting for other session".

---

### 6. budget-module.ts:35-37 - Duplicate ccusage Call
**Issue**: BudgetModule still calls ccusage directly instead of using shared module:
```
Line 35: const { stdout } = await execAsync('ccusage blocks --json --active', {
```

**Problem**: BudgetModule was meant to be deprecated (uses CCUsageSharedModule). But this code STILL spawns independent ccusage, defeating the purpose of shared module.

**Impact**:
- If BudgetModule is called alongside CostModule, BOTH call ccusage
- Creates lock contention between Cost and Budget fetches
- Wastes time spawning separate ccusage processes

---

### 7. cost-module.ts:35-37 - Another Duplicate ccusage Call
**Issue**: CostModule ALSO calls ccusage directly:
```
Line 49: const command = 'ccusage blocks --json --active';
```

**Problem**: Both Cost and Budget modules have their own ccusage calls. Defeats CCUsageSharedModule design.

**Architecture Intent**: CCUsageSharedModule is the SINGLE source, Cost/Budget should call it, not ccusage directly.

---

### 8. data-gatherer.ts:209 - Billing Fallback Logic Bug
**Issue**: ccusage fallback path doesn't check isFresh from shared cache properly:
```
Line 209: const billingData = await this.ccusageModule.fetch(sessionId);
Line 210: if (billingData && billingData.isFresh) {
  ...
  } else if (sharedBilling?.costToday > 0) {
Line 239:   health.billing = { ...sharedBilling, isFresh: sharedBilling.isFresh };
```

**Problem**:
- If ccusage returns isFresh:false (due to cooldown), skips to line 239
- Uses sharedBilling.isFresh (whatever it was)
- If shared is 10min old, will mark as isFresh: false (stale)
- Never actually writes fresh data to shared cache

**Root Cause**: Cooldown prevents isFresh: true returns even when data IS fresh.

---

## Gaps

### 9. process-lock.ts:34 - Aggressive Retry Settings
**Issue**: ProcessLock retries only 3 times with 100ms interval:
```
Line 34: maxRetries: 3  // Only retry 3 times (300ms total)
```

**Problem**: With 35s ccusage timeout, 300ms total retry window is too aggressive. If ccusage takes 30s, second session gives up after 300ms instead of waiting.

**Better**: Should retry for ~45 seconds to match ccusage timeout.

---

### 10. anthropic-oauth-api.ts - No Retry or Fallback Integration
**Issue**: OAuth API is fetched once, no fallback to ccusage if it fails:
```
Line 182-186: let oauthBilling: BillingInfo | null = null;
              try {
                oauthBilling = await AnthropicOAuthAPI.fetchUsage(...);
              } catch {
                // Falls through to ccusage
```

**Gap**: If OAuth API network fails but returns 5xx, both OAuth AND ccusage may timeout (70s total), blocking all sessions.

**Missing**:
- Timeout on OAuth fetch
- Fast-fail if OAuth server is down
- Reuse recent OAuth data instead of re-fetching on every session

---

### 11. ccusage-shared-module.ts:88-94 - Swallows All Parse Errors
**Issue**: JSON parse errors are logged but return default data silently:
```
Line 88: return JSON.parse(stdout);
  ...
Line 91-93: console.error(...);
            return null;
```

**Gap**: If ccusage returns malformed JSON, callers can't distinguish:
- ccusage not installed / failed
- ccusage returned invalid JSON

Would benefit from explicit error types.

---

## Summary

**Primary Blocker**: Cooldown gate at ccusage-shared-module.ts:73 prevents billing refresh for 5 minutes after first fetch. This alone causes ⚠⚠ staleness.

**Secondary Issues**:
1. Cooldown TTL mismatch (2min vs 5min) - module expects 2min but gets 5min
2. isFresh:false when cooldown active - should return fresh data from cache instead
3. BudgetModule and CostModule bypass shared module - create duplicate ccusage calls
4. ProcessLock retry timeout too aggressive - gives up before ccusage completes
5. OAuth API has no fallback timeout or retry logic

**Cascade Effect**:
- Session 1 fetches at T+0 (isFresh: true)
- Session 2 at T+10s sees cooldown, returns isFresh: false
- Display shows ⚠⚠ even though data is only 10s old
- This repeats every 10s for 5 minutes

**Why This Persists**:
1. Cooldown was meant to skip expensive ccusage calls when data is fresh
2. But it was implemented as "return stale indicator" instead of "return cached fresh data"
3. Module design split data fetch (CCUsageSharedModule) from consumption (Cost/Budget/Usage)
4. But Cost/Budget modules were never refactored - they still call ccusage directly

---

## Fixes Immediately Applied

None - see recommendations in P3-recommendations.md
