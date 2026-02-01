# Review: P4 - Display Layer & Data Flow

## Critical Issues

**v2/src/lib/cooldown-manager.ts:30**
Billing cooldown set to 5min but ccusage-shared-module declares 2min cache TTL. Mismatch causes display to respect 5min cooldown while ccusage module thinks 2min is sufficient. This is THE ROOT CAUSE of stale billing data - daemon skips ccusage call after 2min but cooldown file prevents next 3 more minutes.

**v2/src/modules/ccusage-shared-module.ts:70-77**
Cooldown check `shouldRun('billing')` on line 73 returns false during cooldown period, but function still attempts lock acquisition and ccusage call. This is inconsistent - if cooldown says "skip", entire fetch should return early without acquiring lock or calling ccusage. Currently: returns `getDefaultData()` (stale) after unnecessary lock wait.

**v2/src/display-only.ts:599-620**
Display reads `health.formattedOutput` variants (pre-computed by daemon) but has NO FALLBACK CHECK for stale formatting. If daemon hasn't run since data was gathered (gap between `health.gatheredAt` and `health.formattedOutput.timestamp`), display shows pre-formatted output that may be hours old. No `formattedOutput.generatedAt` timestamp exists to detect stale formatting.

**v2/src/lib/statusline-formatter.ts:555-608**
Staleness detection uses `lastFetched` with 3min threshold (line 568), but ccusage-shared-module cooldown is 5min. If ccusage skips due to cooldown, `lastFetched` is NOT updated, so age grows beyond 3min and output shows ⚠⚠ "very stale" even though data is only 2-3min old from previous fetch. Mismatch between cooldown duration and staleness threshold.

## Important Issues

**v2/src/lib/data-gatherer.ts:72-75**
ccusageModule cache TTL set to 120000ms (2min) but cooldown is 5min. Cache says "data is fresh for 2min" but cooldown prevents using even if fresh. Redundant TTL - cooldown is what matters but should match.

**v2/src/display-only.ts:620-624**
Fallback formatting logic regenerates on-the-fly when stdin has overrides BUT:
- Check for `stdinContext && stdinContext.tokensUsed > 0` is too strict. If context changes but tokensUsed stays 0, no regenerate.
- Status line formatter calls StatuslineFormatter.formatAllVariants() which creates NEW pre-formatted variants, but these are never persisted. Next invocation will use old cached variants.

**v2/src/display-only.ts:546-547**
Health file path is `healthPath = ${HEALTH_DIR}/${sessionId}.json` - reads per-session file. BUT daemon may write to file DURING display's read, causing partial/corrupt JSON if write happens mid-read. No retry logic if parse fails. File is small enough that read/write race is unlikely but possible under heavy load.

**v2/src/types/session-health.ts:134-144**
SessionHealth interface has `formattedOutput` but NO `formattedOutputGeneratedAt` timestamp. Display can't tell if pre-formatted output is stale vs current. formattedOutput should include its own timestamp to validate freshness independently.

## Gaps

**v2/src/display-only.ts - Missing staleness propagation**
Display reads `health.billing.lastFetched` but this timestamp is set by daemon during gather. If daemon runs but ccusage is skipped due to cooldown, `lastFetched` is NOT updated. Display then ages this old timestamp naturally, showing "stale" marker. No way to detect "stale because skipped due to cooldown" vs "stale because ccusage failed".

**v2/src/lib/statusline-formatter.ts:565-569**
Staleness check uses `health.billing?.lastFetched || health.gatheredAt || Date.now()` as fallback. If both are missing (shouldn't happen but could in corrupted health file), uses Date.now() - shows everything as fresh even if stale. No error handling for clearly invalid timestamps.

**v2/src/lib/cooldown-manager.ts - No context for billing**
Billing cooldown uses `shouldRun('billing')` with NO contextKey/sessionId, so ALL sessions share same global cooldown. This is intentional for cost savings BUT display shows stale ⚠⚠ even when data is "intentionally deferred for 5 more minutes". No indicator to user why they're seeing stale marker - is it failed fetch or intentional cooldown?

**v2/src/modules/ccusage-shared-module.ts:73**
When cooldown returns false, function returns `getDefaultData()` which has `isFresh: false`. This flows to data-gatherer which should use shared billing cache BUT no code shown here - assumed it falls back to reading `billing-shared.json`. But if that file is also stale or missing, billing data becomes completely missing with no error.

## Summary

Root cause of stale data: **Misaligned cooldown timings and lack of freshness tracking for pre-formatted output.**

The system has THREE layers of caching/deduplication:
1. **Cooldown manager** (5min for billing) - prevents redundant ccusage calls
2. **ccusage module cache** (2min TTL) - internal cache, mismatch with cooldown
3. **Pre-formatted output** - StatuslineFormatter creates variants, NO staleness check

When ccusage cooldown skips (after 2min), `lastFetched` stops advancing, display ages the timestamp, and at 3min shows ⚠⚠ "very stale". User sees RED WARNING even though:
- Data is intentionally deferred by cooldown (good, saves cost)
- Data is actually only 2-3min old (acceptable)
- Display has no way to distinguish "intentionally deferred" from "failed to fetch"

Additionally, pre-formatted output (formattedOutput variants) can outlive the data it represents. If daemon generates formatting at T=0 and next invocation is at T=1hr, display shows old variants without knowing they're stale.

## Fixes Immediately Applied

**None yet.** Fixes require decisions:

1. **Align cooldown with staleness threshold**: Change cooldown to 3min OR staleness threshold to 5min (not both at 2min TTL)
2. **Add formattedOutput.generatedAt**: Track when pre-formatted variants were created, regenerate if older than data
3. **Clarify cooldown behavior in display**: Add "🔄" indicator when data is "intentionally cached" vs "🔴" for failed/missing
4. **Update cooldown check logic**: If cooldown returns false, skip ccusage entirely without acquiring lock

Ready for implementation once design is reviewed.
