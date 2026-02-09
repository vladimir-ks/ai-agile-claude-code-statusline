# Review: P6 — Billing Data Sources

## Critical Issues

**billing-source.ts:18, ccusage-shared-module.ts:26** — Shared cache initialized as module constant
- `const ccusageModule = new CCUsageSharedModule({...})` instantiates once
- `const SHARED_CACHE_PATH = $HOME/.claude/session-health/billing-shared.json` hardcoded module-level
- Every process that imports billing-source.ts creates NEW CCUsageSharedModule instance
- **Impact**: Multiple readers but lock contention on SAME billing-shared.json file across processes

**ccusage-shared-module.ts:98-106** — Freshness computed TWICE (inconsistently)
- Line 100: `FreshnessManager.isFresh(cache?.lastFetched, 'billing_ccusage') && cache?.costToday >= 0`
- Line 216: `const computedIsFresh = FreshnessManager.isFresh(cache.lastFetched, 'billing_ccusage')`
- First check includes cost validity gate (`costToday >= 0`), second does not
- If cache.costToday is 0 or negative, cache appears "stale" in fetch() but "fresh" in cacheToData()
- **Result**: Silent logic divergence, billing shows empty when data exists

**billing-source.ts:115-147** — Local cost fallback broken
- Line 115: `if (transcriptPath && existsSync(transcriptPath))`
- Line 161: `if (billingData && billingData.costUSD >= 0)` — fallback tries stale ccusage
- If ccusage returned falsy (not fresh), local cost is calculated
- BUT local cost result is ONLY returned if `costUSD > 0` (line 119)
- If transcript has 0 cost or is empty, ccusage stale fallback wins (line 161)
- **Result**: Zero-cost sessions can't display; always shows stale indicator

**ccusage-shared-module.ts:32-37** — Lock timeout too aggressive for daemon
- 15s timeout, 2s retry interval, 5 retries = ~10s total wait
- Daemon itself times out at 30s (hardcoded in harness)
- If ccusage takes 25-30s, lock holder still alive when next daemon tries to acquire
- Daemon gives up after 10s, returns stale cache
- **Result**: High-frequency daemons (multiple sessions) create thundering herd, all get stale data

## Architectural Concerns

**Duplicate billing readers**
- CostModule (cost-module.ts:46-49): Raw ccusage call, 35s timeout, 15m cache TTL
- CCUsageSharedModule (ccusage-shared-module.ts:96-165): Shared cache, ProcessLock, 2m cache TTL
- cost-module.ts is registered in tests but NOT in UnifiedDataBroker
- **Status**: Dead code — never called in production, bloats test suite
- **Why**: Historical artifact, replaced by CCUsageSharedModule but tests kept old module

**session-cost-source.ts vs billing-source.ts local cost**
- session-cost-source.ts: Calculates transcript cost for THIS session only
- billing-source.ts:118-147: Also calculates transcript cost, but as fallback when ccusage fails
- Both use same LocalCostCalculator, same transcript file
- **Logic**: session_cost is "session only" (Tier 2), billing is "account billing + fallback" (Tier 3)
- **Problem**: No clear contract — which is used? Both? Neither if transcript is small?

**No atomic writes on billing-shared.json until merge**
- CCUsageSharedModule: writeSharedCache() uses temp file + rename (safe)
- SmartRefreshManager: Also does temp file + rename (safe, but reads from different code path)
- TelemetryDashboard: Only reads, no write
- But UnifiedDataBroker writes final SessionHealth to disk AFTER all sources merge
- **Gap**: If daemon crashes between "fetch from ccusage" and "write to file", data lost
- Not critical (stale indicator shows), but unnecessary risk

## Lock Contention on billing-shared.json

**ProcessLock design**
- Uses `.ccusage.lock` file (separate from billing-shared.json)
- Lock holds PID, checks if process alive via `process.kill(pid, 0)`
- Timeout: 15s stale, retries 2s × 5 = ~10s total

**Contention scenario**
1. Session A daemon starts, tries to fetch ccusage
2. ccusage takes 20-25s
3. Session B daemon starts 5s later, tries to fetch
4. Session B waits for lock (Session A holds it for 20s+)
5. Session B gives up after 10s retry attempts
6. Session B returns stale billing-shared.json cache
7. Result: Concurrent daemons all see stale data

**Better solution**: Separate daemon process (like data-daemon.ts) that fetches ONCE and writes to shared cache. All sessions read, one writes.
- Current approach: N processes × M daemons = N×M potential lock contention
- Better: 1 background fetcher, N×M readers only

## Dead Code / Over-Engineering

**CostModule (cost-module.ts)** — Complete duplicate, never used
- Same ccusage call as CCUsageSharedModule (lines 48-51)
- No shared cache (ignores lock, no cross-session benefit)
- Registered ONLY in test suite (billing-flow-simulation.test.ts)
- **Action**: Remove — it's dead code from V1 migration

**CostWrapperModule (cost-wrapper-module.ts)** — Thin formatter, not data source
- Takes CCUsageData as input, formats for display
- Not registered in UnifiedDataBroker
- Used only in manual tests
- **Status**: Dead code or misclassified (not a DataModule, just a formatter)
- **Action**: Move to display layer if needed, remove from modules/

**FreshnessManager cooldown gate (ccusage-shared-module.ts:110-113)**
- Line 110: `if (!FreshnessManager.shouldRefetch('billing_ccusage'))`
- Prevents retry storms when ccusage is broken
- BUT: Blocks ALL refetch attempts, even if cache is ancient (11+ hours old)
- **Problem**: User symptom "quota 11+ hours stale" — daemon respects cooldown, never retries
- **Better**: Cooldown should apply to FAILURES, not to ancient cache

## Integration Gaps

**billing-source.ts does NOT read from cloud-configs**
- Line 52-54: Checks HotSwapQuotaReader for slot status ONLY
- Line 61-64: Uses `ctx.existingHealth?.launch?.authProfile` not current OAuth refresh
- **Issue**: OAuth tokens may have expired; no check if hot-swap has fresh token
- **Expected**: Should read from `~/.claude-configs/hot-swap/` for current merged quota
- **Actual**: Relies on data-gatherer to pass authProfile (which is stale)

**quota-source.ts vs billing-source.ts**
- quota-source is Tier 3 (global, shared cache)
- billing-source is Tier 3 (global, shared cache)
- Both fetch from different sources (Anthropic API vs ccusage)
- quota-source does NOT cascade to billing-source
- **Gap**: If billing fails to fetch, quota is still fresh (independent path)
- **Problem**: User sees fresh quota, stale billing — confusion about which is authoritative

**No cross-process coordination on ccusage fetch**
- ProcessLock prevents concurrent calls within a machine
- But no coordination ACROSS machines (if statusline runs on multiple systems)
- billing-shared.json is machine-local only (~/.claude/session-health/)
- **Not critical** (single-user tool), but worth noting

## Test Inflation

**Billing flow simulation test** (billing-flow-simulation.test.ts)
- Tests CostModule (dead code)
- Does not test actual cascade: OAuth → ccusage → local cost
- Does not test lock contention scenarios
- Does not test stale cache fallback with zero-cost sessions
- **Status**: Tests mock instead of integration

**Local cost calculator tests** (local-cost-calculator.test.ts)
- Tests pricing matrix (good)
- Does not test fallback logic (line 115-147 in billing-source.ts)
- Does not test edge case: transcript with cost < $0.01

## Summary

**Billing architecture has three independent readers** (CostModule dead, CCUsageSharedModule active, SmartRefreshManager re-reads), each competing for lock on billing-shared.json. Lock timeout is too short for slow ccusage (20-30s), causing concurrent daemons to retry and eventually show stale data. Freshness logic is inconsistent: initial check includes cost validity gate, but conversion back to data format does not, causing silent fallback to zero-cost. Local cost fallback is underspecified: zero-cost sessions always show stale indicator. No synchronization with cloud-configs hot-swap system — OAuth tokens may have expired.

**Immediate fixes:**
1. Remove CostModule (dead code)
2. Fix freshness gate consistency in ccusage-shared-module.ts line 100 vs 216
3. Increase lock timeout to 35s (match ccusage timeout)
4. Add explicit integration test: OAuth → ccusage → local with zero cost
5. Document which source is authoritative: billing vs quota

---

## Fixes Immediately Applied

None. This review is analysis only. Fixes require user decision:
- Should we remove CostModule? (Yes, it's dead.)
- Should we consolidate billing readers? (Yes, but requires refactor.)
- Should billing integrate with hot-swap OAuth? (Yes, but affects data flow.)

