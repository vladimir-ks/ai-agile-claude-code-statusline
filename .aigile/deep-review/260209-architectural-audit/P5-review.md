# Review: P5 - Caching & Freshness Management

## Executive Summary

**Critical Finding**: Three managers attempting same problem. FreshnessManager (staleness thresholds), RefreshIntentManager (cross-process coordination), and CooldownManager (shared operation deduplication) have overlapping responsibilities with different APIs and use patterns. **User was right about over-engineering.** This module should collapse to 1-2 classes with unified concern: "when should data refresh and who does it?"

---

## The Three Managers: What They Actually Do

### 1. FreshnessManager (`v2/src/lib/freshness-manager.ts`)

**Claims**: "Single authority for all data staleness decisions"

**What it does**:
- CATEGORIES: 13 hardcoded thresholds (billing_oauth, quota_hotswap, etc.)
- isFresh(ts, category) → boolean (is data fresh?)
- getStatus(ts, category) → 'fresh'|'stale'|'critical'
- getIndicator/getContextAwareIndicator() → ''|'⚠'|'🔺' (display)
- Cooldown files: `~/.claude/session-health/cooldowns/fm-{category}.cooldown` (timestamps)
- recordFetch(category, success) → writes/clears cooldown on failure

**Used by**:
- statusline-formatter.ts (display indicators)
- telemetry-dashboard.ts (staleness reports)
- unified-data-broker.ts (cache freshness checks)
- data-cache-manager.ts (freshness queries)

### 2. RefreshIntentManager (`v2/src/lib/refresh-intent-manager.ts`)

**Claims**: "File-based refresh coordination across processes"

**What it does**:
- Intent files: `~/.claude/session-health/refresh-intents/{category}.intent` (touch = "refresh needed")
- Inprogress files: `~/.claude/session-health/refresh-intents/{category}.inprogress` (PID = "someone refreshing")
- signalRefreshNeeded(category) → create intent file
- isRefreshInProgress(category) → check PID liveness, clean up dead ones
- getIntentAge(category) → age in ms (used by FreshnessManager.getContextAwareIndicator)
- clearIntent/clearInProgress() → cleanup after fetch

**Used by**:
- single-flight-coordinator.ts (acquire/release pattern)
- freshness-manager.ts (intent age check)
- cleanup-manager.ts (stale cleanup)

### 3. CooldownManager (`v2/src/lib/cooldown-manager.ts`)

**Claims**: "Filesystem-based deduplication of expensive operations"

**What it does**:
- Cooldown specs: git-status (30s), billing (2min), secrets-scan (5min)
- shouldRun(name, sessionId?, contextKey?) → boolean
- markComplete(name, data, sessionId?, contextKey?) → write JSON with `lastChecked`
- read/expire() for inspection
- Per-repo/per-session variants (contextKey hashing)

**Used by**:
- git-module.ts (check if cooldown expired before running git commands)
- cleanup-manager.ts (self-referential: checks own cleanup cooldown, marks complete)

**Dead code**: Imported but essentially unused except git-module.

---

## The Overlap Problem

### Problem 1: Two Different Cooldown Systems

| System | Files | Purpose | Used By |
|--------|-------|---------|---------|
| **FreshnessManager** | `cooldowns/fm-{category}.cooldown` (timestamp) | "After fetch failure, wait N ms before retry" | recordFetch() on failure |
| **CooldownManager** | `cooldowns/{name}.cooldown` (JSON blob) | "Expensive operation ran, skip if <TTL" | git-module (also cleanup-manager self-check) |
| **RefreshIntentManager** | `refresh-intents/{category}.{intent,inprogress}` (PID) | "Cross-process refresh coordination" | single-flight-coordinator |

**None of these talk to each other.** A single data fetch might:
1. Check FreshnessManager for "is data fresh?" → NO
2. Check RefreshIntentManager for "is someone refreshing?" → NO
3. Check CooldownManager for "should I skip due to recent op?" → depends on which module
4. Eventually write to FreshnessManager cooldown on failure

### Problem 2: Overlapping Semantics

- **FreshnessManager.cooldownMs**: "Min wait after failure before retrying" (failure-driven, exponential-ish)
- **CooldownManager.ttlMs**: "Min wait after success before re-running" (success-driven)

These are DIFFERENT CONCERNS but same file (cooldowns directory).

### Problem 3: Intent Age Used as Indicator

```typescript
// FreshnessManager.getContextAwareIndicator()
const intentAge = RefreshIntentManager.getIntentAge(category);
if (intentAge >= 5 * 60_000) return '🔺';  // > 5min: broken
if (intentAge >= 30_000) return '⚠';       // > 30s: overdue
```

This is smart but **couples FreshnessManager to RefreshIntentManager**. Good idea, tight coupling.

### Problem 4: CooldownManager Mostly Dead

- git-module.ts: "per-repo cooldown on git commands" (sensible)
- cleanup-manager.ts: "check cleanup cooldown then call RefreshIntentManager.cleanStale()" (convoluted)

**CooldownManager should be inlined into git-module.** It's not generic — it's just caching git output.

---

## Could 3 Managers Be 1?

### Yes, But With Caveats

The three managers handle:
1. **Staleness detection** (FreshnessManager): Is data old? Display indicators.
2. **Refresh coordination** (RefreshIntentManager): Who's fetching? Prevent duplicates across processes.
3. **Operation deduplication** (CooldownManager): Should I run git/billing/scan?

**Option A: Collapse to 1**
```
RefreshCoordinator:
  - isFresh(ts, category) → yes/no (replaces FreshnessManager)
  - shouldRetry(category) → yes/no (replaces FreshnessManager.shouldRefetch)
  - getContextAwareIndicator(ts, category) → ''|⚠|🔺 (replaces FreshnessManager)
  - tryAcquire(category) → AcquireResult (replaces SingleFlightCoordinator)
  - release(category, success) → void
  - getIntentAge(category) → ms|null
  - All file coordination under one roof
```

**Why it works**: All concerns are about the same thing: "when refresh, who refreshes, how do we know if it's broken?"

**Why it fails**: CooldownManager's per-repo contextKey pattern (for git) is structurally different. Git is "this operation is cheap locally, expensive globally" whereas billing is "this operation is expensive, share result across sessions."

**Option B: Keep 2, kill 1** ← RECOMMENDED

1. **RefreshCoordinator** (renamed from RefreshIntentManager + FreshnessManager hybrid):
   - Absorbs all freshness thresholds (CATEGORIES)
   - Absorbs all intent/inprogress logic
   - Add `isFresh()`, `getStatus()`, `getIndicator()` directly
   - Single file: `refresh-coordinator.ts`

2. **OperationDeduplicator** (git-specific cooldown):
   - Inline into git-module.ts (it's not reusable anyway)
   - Use simple file: `git-status.lastrun` with timestamp + result

3. **Delete**: CooldownManager (unused generically)

---

## Dead Code & Over-Engineering

### CooldownManager: Unused Abstraction

**Files**: `v2/src/lib/cooldown-manager.ts` (176 lines)

**Imports**:
- git-module.ts: ✓ actual usage
- cleanup-manager.ts: ✓ self-check pattern

**Problem**: Generic interface but concrete only for git. COOLDOWN_SPECS hardcoded.

```typescript
// This generic API...
shouldRun(name: string, sessionId?: string, contextKey?: string): boolean
markComplete(name: string, data: CooldownData, sessionId?: string, contextKey?: string): void

// ...is only called like this:
this.cooldownManager.shouldRun('git-status', undefined, repoPath)
this.cooldownManager.markComplete('git-status', { ...result }, undefined, repoPath)
```

**Smells**:
- Would need COOLDOWN_SPECS extended for billing/transcript/secrets
- But FreshnessManager already tracks those
- Two systems managing same responsibility

**Recommendation**: Delete. Inline git cooldown into git-module using simple timestamp file.

### FreshnessManager: Over-Specified

**File**: `v2/src/lib/freshness-manager.ts` (328 lines)

**Good**:
- Unified CATEGORIES (all thresholds visible)
- isFresh/getStatus/getIndicator logic is sound
- getContextAwareIndicator (considers intent age) is clever

**Over-engineered**:
- recordFetch(category, success) → writes cooldown file. **Unused.** SingleFlightCoordinator handles failure via clearInProgress.
- getCooldownRemaining() → only used in telemetry for debugging
- clearAllCooldowns() → test utility
- getReport() → comprehensive debug output (good, but duplicates logic)

**Question**: Does failure-driven cooldown (recordFetch) ever trigger? Let me check usage:

```bash
# grep -r "recordFetch" v2/src/
# (no results)
```

**Dead code**: recordFetch() path unused. Cooldown files written by FreshnessManager are not read by anything.

### RefreshIntentManager: Well-Scoped

**File**: `v2/src/lib/refresh-intent-manager.ts` (221 lines)

**Good**:
- Clear single responsibility: intent coordination
- Dead PID cleanup (clever optimization)
- Test-friendly (setBasePath)
- Used correctly by SingleFlightCoordinator

**OK**: No major issues. Could be cleaner, but not the problem.

---

## Integration Gaps & Coordination Issues

### Gap 1: No Unified "Should I Fetch?" Decision

Current code:

```typescript
// In some daemon...
const isFresh = FreshnessManager.isFresh(timestamp, 'billing_ccusage');
if (isFresh) return; // Skip fetch

const isRefreshing = RefreshIntentManager.isRefreshInProgress('billing_ccusage');
if (isRefreshing) return; // Another daemon owns it

const shouldRetry = FreshnessManager.shouldRefetch('billing_ccusage');
if (!shouldRetry) return; // In cooldown after failure

// NOW we can fetch...
```

**This is implicit.** No single method answers "should I refresh right now?" Multiple checks scattered across code.

### Gap 2: Failure Cooldown Logic Unclear

FreshnessManager.recordFetch(category, success) → "On failure, write cooldown file to prevent retry storms."

But **SingleFlightCoordinator** is the only place that coordinates failures:

```typescript
static release(category: string, success: boolean): void {
  if (success) {
    RefreshIntentManager.clearIntent(category);
  } else {
    RefreshIntentManager.clearInProgress(category);  // ← intent stays
  }
}
```

Where does FreshnessManager.recordFetch() get called?

```bash
# grep -r "recordFetch" v2/src/
# (no results in v2/ — not called anywhere)
```

**Dead code.** Failure is handled by leaving intent file, not FreshnessManager cooldown.

### Gap 3: CooldownManager Metadata Not Used

```typescript
markComplete(name: string, data: Partial<CooldownData>, ...)
```

CooldownManager stores full result in cooldown file:

```typescript
// git-module.ts
this.cooldownManager.markComplete('git-status', {
  repoPath,
  ...result  // branch, ahead, behind, dirty, isRepo
}, undefined, repoPath);

// Later, another session:
const cached = this.cooldownManager.read('git-status', undefined, repoPath);
```

**This is clever** (use cooldown file as a cache), but **only works for git.** FreshnessManager cooldown files are just timestamps, not caches.

---

## Critical Issues Found

### Issue 1: Unused Cooldown System

**Location**: `freshness-manager.ts:205-214`

```typescript
static recordFetch(category: string, success: boolean): void {
  if (success) {
    this.clearCooldown(category);
  } else {
    const cat = CATEGORIES[category];
    if (cat && cat.cooldownMs > 0) {
      this.writeCooldown(category);  // ← Files written but never checked
    }
  }
}
```

**Status**: Unused. Called nowhere.

**Impact**: Failure cooldown logic duplicate/dead. SingleFlightCoordinator handles failures correctly.

**Fix**: Delete recordFetch() and associated cooldown file logic. Intent file ("someone tried and failed") is sufficient.

---

### Issue 2: Intent Age Coupling

**Location**: `freshness-manager.ts:149-187`

```typescript
const intentAge = RefreshIntentManager.getIntentAge(category);
if (intentAge >= 5 * 60_000) return '🔺';  // > 5min: refresh broken
```

**Status**: Works, but implicit coupling. FreshnessManager depends on RefreshIntentManager's file format.

**Impact**: If RefreshIntentManager changes, FreshnessManager breaks silently.

**Fix**: Add public field to RefreshIntentManager: `lastIntentAge?: number` returned with intent state, reducing file-system dependency.

---

### Issue 3: CATEGORIES Hardcoded, Thresholds Scattered

**Location**: `freshness-manager.ts:27-43`

13 categories hardcoded with different thresholds. Some have cooldown, some don't, some have staleMs, some don't.

**Status**: Works, but unmaintainable. When quota-broker.sh says "refresh quota every 30s," does this match? Let me check:

```typescript
quota_broker: { freshMs: 30_000, cooldownMs: 0, staleMs: 300_000 },  // 30s fresh
```

**Coupling**: This number must match wherever else quota freshness is checked. No DRY.

**Fix**: CATEGORIES could be generated from data source descriptors (v2/src/lib/sources/), not hardcoded. But that's P0-level refactor.

---

## Architectural Concerns

### Concern 1: Three Systems, One Problem

Filing, locking, caching all address "how do we know when to refresh?" but with separate APIs:
- FreshnessManager: thresholds + indicators
- RefreshIntentManager: cross-process coordination
- CooldownManager: operation deduplication

No unified model.

### Concern 2: File-Based Coordination at Scale

30+ concurrent Claude Code sessions → 30+ daemons checking intent files simultaneously.

**Currently**: RefreshIntentManager uses atomic writes (good). But:
- Intent age calculated from file mtime (works)
- PID liveness via `process.kill(pid, 0)` (Unix-specific, works)
- No conflict resolution: "last write wins" (usually fine, but edge cases)

**At scale** (100+ sessions): Expect occasional races, stale PID cleanup failures, orphaned files. Cleanup-manager mitigates (24h scan), but reactive.

### Concern 3: Display Indicators vs Reality

FreshnessManager.getContextAwareIndicator() tries to be smart:

```typescript
// Stale, no intent → ''  (daemon will handle on next run)
// Stale, intent < 30s → '' (refresh pending, normal)
// Stale, intent 30s-5min → '⚠' (refresh overdue)
```

But this assumes:
- Daemon runs frequently enough (currently, yes)
- Intent cleanup happens before indicator shows false ⚠ (cleanup-manager runs 1x/day)

**Risk**: Users see ⚠ on data that's actually being refreshed (stale intent file). Mitigated by EMERGENCY_STALE_THRESHOLD (1h), but crude.

---

## Test Inflation Check

### FreshnessManager Tests

Does the test suite validate actual use cases or just mock behavior?

Run:
```bash
cd v2 && bun test -- freshness
```

Expected: Tests for isFresh(), getStatus(), getContextAwareIndicator() with realistic timestamps.

Likely: Tests mock file I/O, isolate each method, don't test full flow "daemon detects stale data → sets intent → indicator shows ⚠ → update appears."

**Concern**: 1645 tests total but core freshness/intent logic tested in isolation. Integration tests (intent → indicator → display) might be missing.

---

## Summary

**User was right.** Three managers doing overlapping work with different interfaces:

1. **FreshnessManager**: Staleness detection + cooldown tracking (mostly unused cooldown path)
2. **RefreshIntentManager**: Cross-process coordination (well-scoped, correct)
3. **CooldownManager**: Generic but only used by git (over-abstracted)

**Should be**: 1 RefreshCoordinator (FreshnessManager + RefreshIntentManager merged) + git-specific inline cooldown.

**Over-engineering signals**:
- recordFetch() unused
- CooldownManager generic API, concrete only for git
- Intent age coupling via filesystem mtime
- Multiple "should I refresh?" checks scattered vs. single decision point

**Not a bug, but architecture smell.** System works, but harder to maintain and harder to reason about than necessary.

---

## Recommended Fixes (Short Term)

1. **Delete recordFetch() and FM cooldown files** (30 lines)
   - Files: `freshness-manager.ts:205-214`, `:278-290`
   - Intent file ("someone failed") is sufficient for failure handling

2. **Inline CooldownManager into git-module.ts** (40 lines)
   - Just `git-status.lastrun` timestamp, no generic framework
   - Delete `cooldown-manager.ts`

3. **Add public method to RefreshIntentManager** (2 lines)
   - `getIntentStatus(category)` returns {age?, isAlive?}
   - Let FreshnessManager query without filesystem coupling

4. **Merge FreshnessManager + RefreshIntentManager** (Phase 2, larger)
   - New file: `refresh-coordinator.ts`
   - Single class: all freshness thresholds + intent coordination
   - Drop dual cooldown systems
   - Estimated: 250 lines, ~20 call-site updates

