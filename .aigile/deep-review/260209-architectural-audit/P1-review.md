# P1 Review: Quota Data Flow & Readers

**Date:** 2026-02-09
**Reviewer:** AI Agent (Architectural Audit)
**Status:** CRITICAL ISSUES FOUND

---

## Executive Summary

Quota data routing is **broken at the architectural level**. Three independent readers (QuotaBrokerClient, HotSwapQuotaReader, SubscriptionReader) all compete for the same data without coordination. Data-daemon spawns broker refresh but **never waits for it or verifies success**. Display-only reads stale cache while daemon background refresh fails silently.

**Root Cause:** Broker refresh is fire-and-forget. Quota-source fallback chain has no retry logic. No integration between what broker.sh writes and what statusline actually reads.

---

## Critical Issues

### Issue 1: Broker Spawn is Fire-and-Forget with No Verification
**File:** `quota-broker-client.ts:369-390`

```typescript
private static spawnBroker(): void {
  try {
    const brokerScript = this.getBrokerScript();
    if (!existsSync(brokerScript)) { /* warn but return */ }
    const child = spawn('bash', [brokerScript], {
      detached: true,
      stdio: 'ignore'  // <-- CRITICAL: Lost all output
    });
    child.unref();  // <-- Fire-and-forget, no wait
  } catch (error) {
    console.warn(...);  // Non-critical, move on
  }
}
```

**Problem:**
- Script spawned detached with stdio: 'ignore' — all errors vanish
- No wait/monitoring — caller doesn't know if refresh succeeded
- Quota data remains stale while refresh silently fails in background
- After 11+ hours of stale data, script probably failing due to auth expiry (documented in OAUTH_TOKEN_ARCHITECTURE.md)

**Evidence:** OAUTH_TOKEN_ARCHITECTURE.md line 241-242:
> "Failure Point: Cron output to /dev/null, failures went unnoticed"

Same bug pattern exists here — spawn() + stdio: 'ignore' = silent failure.

---

### Issue 2: No Coordination Between Broker Write and Reader Read
**Files:** `quota-broker-client.ts:56-130`, `quota-source.ts:38-62`

QuotaBrokerClient reads merged-quota-cache.json and triggers spawn. But:
- Spawn is asynchronous — file doesn't exist yet when reader checks
- Reader falls through to HotSwapQuotaReader (stale data)
- Broker finishes writing 5 seconds later — reader never knows
- Next statusline invocation reads new data, but this invocation showed stale

**No synchronization primitive:**
- No event/notify when broker finishes
- No "please wait" for fresh data
- Lock file (.quota-fetch.lock) exists but used only to prevent duplicate spawns, not to signal completion

---

### Issue 3: Path Resolution Fragmentation — Three Sources, Three Path Systems
**Files:** `quota-broker-client.ts:33-47`, `hot-swap-quota-reader.ts:74-83`

Hardcoded paths in multiple readers:

**QuotaBrokerClient:**
```typescript
// Priority: ENV var → cloud_configs → legacy _claude-configs
const cloudConfigsPath = `${homedir()}/cloud_configs/hot-swap/scripts/quota-broker.sh`;
if (existsSync(cloudConfigsPath)) return cloudConfigsPath;
return `${homedir()}/_claude-configs/hot-swap/scripts/quota-broker.sh`;
```

**HotSwapQuotaReader (claude-sessions.yaml):**
```typescript
const HOT_SWAP_SESSIONS_PATHS = [
  `${homedir()}/_claude-configs/hot-swap/claude-sessions.yaml`,
  `${homedir()}/.claude/hot-swap/claude-sessions.yaml`,
  `${homedir()}/.claude/config/claude-sessions.yaml`,
];
```

**SubscriptionReader:**
```typescript
private static readonly CONFIG_PATH = `${homedir()}/.claude/config/subscription.yaml`;
```

**Problem:**
- Each reader scans different paths (none centralized)
- If user migrated from `_claude-configs` to `cloud_configs`, readers might read from different slots
- No single source of truth for active slot
- Broker reads quota from one directory; reader looks in another

---

### Issue 4: Cascade Logic Doesn't Verify Data Freshness at Each Level
**File:** `quota-source.ts:38-96` (fetch method)

```typescript
async fetch(ctx: GatherContext): Promise<QuotaSourceData> {
  // Strategy 1: Try broker
  if (QuotaBrokerClient.isAvailable()) {
    const brokerQuota = QuotaBrokerClient.getActiveQuota(...);
    if (brokerQuota) {  // <-- Only checks existence, not staleness
      return { source: 'broker', ... };
    }
  }

  // Strategy 2: Try hot-swap (fallback)
  const hotSwapQuota = HotSwapQuotaReader.getActiveQuota(configDir);
  if (hotSwapQuota) {  // <-- Falls through even if broker data was stale
    return { source: 'hotswap', ... };
  }
  // ...
}
```

**Problem:**
- Cascade only checks "does data exist" not "is data fresh"
- If broker writes stale cache, cascade doesn't detect — uses it anyway
- No logic to say "broker says stale, try next source"
- QuotaBrokerClient.getActiveQuota() returns `isStale` flag but quota-source ignores it

---

### Issue 5: Multiple Readers — Slot Selection Mismatch
**Files:** `quota-broker-client.ts:154-296`, `hot-swap-quota-reader.ts:294-377`

QuotaBrokerClient slot matching priorities:
1. keychainService (if provided)
2. authEmail (if detected)
3. configDir
4. active_slot from broker (REMOVED — unreliable)
5. Single slot
6. Lowest rank

HotSwapQuotaReader slot matching priorities:
1. configDir
2. active_account from claude-sessions.yaml
3. Single slot
4. Freshest slot

**Problem:**
- Different selection algorithms → same session might match different slots
- Broker might detect keychainService match; hot-swap falls through to configDir match
- If two readers pick different slots, display shows mismatched quota (quota-broker says slot-1, hot-swap says slot-2)
- No test ensuring both readers match same slot for same context

---

### Issue 6: Quota Stale Checking is Fragmented
**Files:** `quota-broker-client.ts:262-282`, `hot-swap-quota-reader.ts:357-359`

QuotaBrokerClient has complex stale logic:
```typescript
const WEEKLY_QUOTA_FRESH_THRESHOLD = 300_000; // 5 minutes
const dataAge = Date.now() - (slot.last_fetched || 0);
const actuallyStale = dataAge > WEEKLY_QUOTA_FRESH_THRESHOLD;
const isStale = data.is_fresh === false || !slot.is_fresh || actuallyStale;
```

HotSwapQuotaReader simpler:
```typescript
const CACHE_FRESH_MS = 120000; // 2 minutes
const ageMs = Date.now() - slot.last_fetched;
const isStale = ageMs > CACHE_FRESH_MS || !slot.is_fresh;
```

**Problem:**
- Different thresholds (300s vs 120s) → inconsistent staleness signals
- Broker has fallback check (actuallyStale) in case is_fresh field is wrong
- Hot-swap trusts is_fresh field without validation
- No unified FreshnessManager usage across readers

---

## Architectural Concerns

### Over-Abstraction Without Necessity
UnifiedDataBroker, DataSourceRegistry, SingleFlightCoordinator, DataCacheManager — impressive abstraction. But:
- Quota refresh still happens via shell script (quota-broker.sh), not TypeScript
- Broker script works independently from statusline — no integration
- All this orchestration in TypeScript, then shell spawned as black box
- Added 200+ lines of abstraction overhead for what should be simple: "wait for fresh data"

**Better approach:** Shell script writes, TypeScript reads. One reader, one path, one freshness threshold.

---

### Misplaced Responsibility
**quota-broker-client.ts** has two conflicting responsibilities:
1. Read existing merged-quota-cache.json
2. Spawn refresh (shell script)

These should be separate:
- Reader: Read cache + report staleness
- Refresher: Spawn broker, wait for result, verify success

Currently reader is responsible for triggering refresh but can't wait for it.

---

## Dead Code / Over-Engineering

### Issue 7: Multiple Cache Layers Doing Nothing
**Files:** `quota-broker-client.ts:19-22`, `hot-swap-quota-reader.ts:59-72`

In-memory caches with TTLs:
- QuotaBrokerClient: 10s memory TTL on top of 120s fresh threshold
- HotSwapQuotaReader: 30s memory TTL on hot-swap cache + 60s TTL on active slot
- SubscriptionReader: 1 minute cache TTL

**Problem:**
- Display-only reads once per invocation, doesn't benefit from memory cache
- Data-daemon reads once, waits for broker refresh
- Memory cache only benefits multiple reads in same process
- Adds complexity without real win

---

### Issue 8: Unused Slot Matching Code in QuotaBrokerClient
**File:** `quota-broker-client.ts:227-229`

```typescript
// Strategy 2: active_slot from broker - REMOVED (unreliable)
// This fallback was causing wrong quota data in multi-account scenarios.
```

Comment says REMOVED but strategy 3 (single slot) is still there. Code has conflicting comments about what strategies do what.

---

### Issue 9: Test Infrastructure Probably Mocking the Real Problem
**Configuration:** 1645 tests yet quota doesn't refresh

Tests likely mock QuotaBrokerClient, HotSwapQuotaReader, spawn() calls. But real failure is:
- Broker script itself dies (auth expired)
- Shell spawn with stdio: 'ignore' hides the death
- Tests pass because they never spawn real shell

Solution: Stop testing mocks, test real broker script execution and failure recovery.

---

## Integration Gaps

### Issue 10: Statusline Doesn't Know if Broker Refresh Succeeded
**Evidence:**

1. `quota-broker-client.ts:123` spawns broker
2. `quota-source.ts:46` calls QuotaBrokerClient.getActiveQuota() — this is fallback logic, not "wait for fresh"
3. No way to say "I just triggered refresh, wait 5 seconds then retry"
4. Display shows stale data because statusline gave up immediately

**Missing integration:**
- After spawning broker, should wait (with timeout) for fresh data
- Should retry reading cache until fresh or timeout
- Should show indicator while waiting
- Should report "refresh pending" to user

---

### Issue 11: Quota-Source Doesn't Honor "Stale" Flag in Cascade
**File:** `quota-source.ts:46`

```typescript
const brokerQuota = QuotaBrokerClient.getActiveQuota(...);
if (brokerQuota) {  // <-- Uses it regardless of brokerQuota.isStale
  return { source: 'broker', ... };
}
```

QuotaBrokerClient.getActiveQuota() returns `isStale` but quota-source doesn't check it. Falls through silently to next source even when broker has data (just stale).

---

### Issue 12: No Verification That Cloud-Configs Broker Actually Runs
**File:** `quota-broker-client.ts:33-47`

Code checks for cloud_configs path:
```typescript
const cloudConfigsPath = `${homedir()}/cloud_configs/hot-swap/scripts/quota-broker.sh`;
if (existsSync(cloudConfigsPath)) {
  return cloudConfigsPath;
}
```

But nowhere verifies that:
1. cloud_configs broker is executable
2. cloud_configs system is installed
3. cloud_configs path is correct (maybe it's `~/cloud-configs` not `~/cloud_configs`)
4. Script has correct parameters

Missing: centralized path/config validation.

---

## Summary

### Core Problem
Quota refresh is **decoupled with no handshake**. Statusline triggers shell script refresh, then immediately abandons it. Script might fail, or succeed but take 10 seconds. Display layer doesn't wait, doesn't check status, doesn't know.

### Why Simple Fix Doesn't Work
- Moving refresh to TypeScript requires OAuth token access (complex, hidden in keychain)
- Keeping shell script requires synchronization (fire-and-forget won't work)
- Current design assumes "broker always works" — wrong assumption

### Why Tests Pass But System Fails
- Tests mock spawn() and file I/O
- Real failures: shell script auth expiry, file permission issues, race conditions
- No tests verify: "spawn() succeeded", "file was written", "data became fresh"

### Recommended Fix (in priority order)
1. **Immediate:** Change spawn() to use stdio: 'pipe' and log output. Detect broker script failures.
2. **Short-term:** Add "wait for fresh" logic after spawning broker (with 5s timeout + retry)
3. **Medium-term:** Single reader with unified path resolution (not 3 competing readers)
4. **Long-term:** Move quota refresh to TypeScript (OAuth + cache update in-process)

---

## Fixes Immediately Applied

None. This audit is read-only discovery phase. Fixes require architectural changes (see recommendations).

However, one dangerous pattern can be fixed immediately without refactoring:
- **quota-broker-client.ts:369-390** — Add stderr capture to detect spawn failures
- **quota-source.ts:46** — Check brokerQuota.isStale and fall through if true

Will apply these low-risk fixes after user approves approach.
