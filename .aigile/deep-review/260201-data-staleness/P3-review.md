# Review: P3 - Cooldown & Lock Management

## Critical Issues

**cooldown-manager.ts:30** - Billing cooldown INCREASED from 2min to 5min
- Changed from `ttlMs: 120000` to `ttlMs: 300000` (5min)
- Rationale stated: "reduced from 2min to reduce lock contention" but value INCREASED (contradiction)
- **IMPACT**: Billing data will not refresh for 5 minutes between fetches, causing very stale ⚠⚠ indicators
- **ROOT CAUSE OF REPORTED ISSUE**: This is the primary cause of billing staleness complaints

**ccusage-shared-module.ts:25-26** - Lock retry strategy is insufficient
- `retryInterval: 3000` (3s between retries) with `maxRetries: 15` = 45s total wait time
- ccusage timeout is `timeout: 60000` (60s in lock config, but 35s in module config at line 59)
- **CONFLICT**: Lock retries (45s max) may timeout BEFORE ccusage completes
- **IMPACT**: With 10+ concurrent sessions, sessions waiting for lock will timeout and fail to fetch billing

**process-lock.ts:32-34** - Lock timeout misconfigured
- Lock timeout: `timeout: 35000` (35s)
- ccusage module timeout: `timeout: 35000` (35s)
- **RACE CONDITION**: If ccusage takes full 35s, lock age becomes 35s, exactly at timeout boundary
- **IMPACT**: Stale lock may be released while ccusage is still running, allowing second session to acquire and spawn duplicate ccusage

**ccusage-shared-module.ts:73-77** - Cooldown check returns stale data instead of triggering refresh
- Line 73: `if (!this.cooldownManager.shouldRun('billing'))` returns default stale data
- This short-circuits the lock acquisition entirely
- **INTERACTION WITH BILLING FALLBACK**: data-gatherer.ts:206-245 has OAuth+ccusage fallback logic
- **IMPACT**: When cooldown is active, ccusage module returns `isFresh: false`, but data-gatherer still attempts OAuth
- **HIDDEN PROBLEM**: Shared billing cache fallback at line 239-241 doesn't mark as fresh even if OAuth succeeded

---

## Important Issues

**process-lock.ts:70-90** - Lock cleanup logic has timing gaps
- Process alive check (line 70) uses `process.kill(pid, 0)` - safe but can't distinguish zombie from running
- Stale lock detection at line 74-79 has branching paths:
  - Path A: Process dead → force release (correct)
  - Path B: Process alive BUT lock stale → force release anyway (line 82)
  - Path C: Process doesn't exist but lock exists → still force release
- **ISSUE**: No delay between stale detection and force release
- **RISK**: If process.kill check is unreliable (e.g., sudo context issues), stale lock may block fresh fetches indefinitely

**data-gatherer.ts:173-178** - Shared billing cache freshness check is too loose
- `sharedFresh` condition: `(Date.now() - sharedBilling.lastFetched) < 120000` (< 2min)
- BUT cooldown is now 5min (300s)
- **INCONSISTENCY**: Cache will be marked fresh for 2min, but cooldown prevents refresh for 5min
- **IMPACT**: Users will see ⚠⚠ for 3 minutes even though data is technically "fresh" by cache rules

**data-gatherer.ts:239-244** - Fallback chain doesn't preserve freshness metadata
- When ccusage fails, code falls back to shared billing but doesn't mark as fresh
- Line 241: `isFresh: sharedBilling.isFresh` (preserves original stale status)
- **IMPACT**: Even if shared cache has good data, fallback marks it as stale
- **CONSEQUENCE**: Display shows 🔴 stale indicator even with valid billing info

**ccusage-shared-module.ts:22-27** - Lock configuration misses ccusage timeout variance
- Real ccusage calls vary: 5-30s typical, occasionally 35s+ under load
- Lock timeout (60s in config) vs module timeout (35s) mismatch
- **SCENARIO**: ccusage takes 40s → module times out and returns null → lock still held for ~25s more
- **IMPACT**: Next session acquires lock, spawns NEW ccusage while first is still running = CPU spike

---

## Gaps

**Missing cooldown documentation in code** - No comment explaining why billing cooldown is 5min
- CLAUDE.md project instructions state: "Shared Billing: Any successful ccusage fetch writes here"
- But 5min cooldown effectively prevents fetches more frequently than 5min
- **GAP**: Reconcile public promise (shared cache) with 5min throttling reality

**No metrics for cooldown effectiveness**
- cooldown-manager.ts has no observability (no event emitters, no log calls)
- Can't tell from daemon log if cooldowns are preventing work or just optimizing
- **GAP**: Add logging to cooldown checks (especially when they prevent work)

**No lock holder identification in output**
- process-lock.ts stores PID but lock file is single-value
- When lock is stale, we log PID but no way to map to session
- **GAP**: Add session ID or context info to lock file for debugging

**Insufficient test coverage for concurrent scenarios**
- No tests simulating 10+ concurrent sessions hitting lock simultaneously
- No tests for lock timeout race conditions
- No tests for cooldown + lock interaction under load

---

## Summary

The **primary root cause** of very stale billing data (⚠⚠) is the 5min billing cooldown in cooldown-manager.ts:30. The comment suggests it was increased to "reduce lock contention" but the logic is backwards - longer cooldowns increase staleness, not reduce it.

Secondary issues compound the problem:
1. **Lock timeout boundary condition** (35s) exactly matches ccusage timeout, creating race conditions
2. **Insufficient retry strategy** - Lock retries (45s max) may timeout before ccusage completes
3. **Fallback chain loses freshness metadata** - Even when shared cache has good data, fallback marks it stale
4. **Cooldown bypass doesn't respect freshness** - Cooldown returns stale data instead of checking if OAuth/ccusage could fetch fresh

The architecture INTENDS to solve lock contention via shared cache + cooldowns, but the implementation has:
- **Aggressive cooldown** (5min) that prevents timely refreshes
- **Inadequate lock strategy** for ccusage's variable duration (5-30s+)
- **Inconsistent freshness tracking** across cache layers

### Key Misconception
The code treats "cooldown" as purely an optimization, but 5min cooldown is a **hard throttle** on billing updates. With ccusage taking 20-30s typically, a 5min cooldown means billing data stales 2-3 minutes after successful fetch - even without lock contention.

---

## Fixes Immediately Applied

None. This review identifies systemic design issues requiring careful fixes:

1. **Cooldown timing needs coordination with actual data needs** (user-facing refresh frequency)
2. **Lock timeout should exceed ccusage max runtime** with safety margin
3. **Fallback chain should preserve/propagate freshness metadata**
4. **Shared cache freshness timeout should match or exceed cooldown period**

These fixes require understanding product requirements (how frequently should billing refresh for user?) and testing under realistic concurrent load.

