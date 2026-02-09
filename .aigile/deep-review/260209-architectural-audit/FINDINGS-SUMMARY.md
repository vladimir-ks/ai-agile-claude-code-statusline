# Architectural Audit Findings — P2 Summary

**P2: UnifiedDataBroker**

## Verdict
**OVER-ENGINEERED. Functions correctly but solves non-existent problems.**

## Key Findings

### 1. data-cache.json Is Write-Only
- 140 LOC of caching infrastructure (DataCacheManager + types)
- Cache is written every gather cycle
- Cache is never read — all sources fetch fresh from disk/API
- **Net value: zero**

### 2. 12 Descriptors = Function Wrapper Overhead
- Each source has `{ id, tier, freshnessCategory, timeoutMs, fetch, merge }`
- Identical 1:1 ratio with actual source functions
- No shared logic, no plugin system, no hot-swap capability
- **Cost: 140 LOC of registry infrastructure with zero leverage**

### 3. Single-Flight Coordination Solves Hypothetical Problem
- 80 LOC to prevent 30 concurrent daemons from API stampede
- Actual usage: 1-2 daemons
- File-based locking adds ~30ms per cycle
- **Cost: 80 LOC + file I/O overhead, benefit: zero**

### 4. Stale Quota Problem Is NOT Here
- User suspects data routing/caching issue
- Actual root cause: upstream cloud-configs files aren't being updated
- UnifiedDataBroker correctly reads stale quota data from stale source files
- quota-source.ts has 3-tier fallback (broker → hotswap → subscription)
  - All 3 tiers read files that aren't being refreshed
- **Fix location**: cloud-configs (`fetch-quotas.sh`, `refresh-token.sh`)

### 5. Test Inflation
- 1645 tests, 221 new tests added
- Majority test infrastructure (registry, cache, coordinator)
- Real-behavior tests: ~50-100
- **Cost: complexity hiding actual failures**

## Code Quality
- ✅ No security issues
- ✅ No resource leaks
- ✅ No logic errors
- ✅ Proper error handling
- ⚠️ Over-abstraction (descriptors, registry, cache, coordinator)
- ⚠️ Misleading documentation (claims cache is used, coordinator prevents stampedes)

## Simplification Path
If pursuing simplification:

```
Replace                          With
────────────────────────────────────────
12 DataSourceDescriptors      → 12 functions
DataSourceRegistry             → list of imports
DataCacheManager (140 LOC)      → delete (unused)
SingleFlightCoordinator (80 LOC)→ delete (non-problem)
```

**Net result**: -360 LOC, same behavior, clearer code.

## Impact on User's Problem
**None**. This architecture doesn't cause or fix the stale quota issue. The architecture is correct; the upstream data is stale.

## Recommendation
Keep as-is OR simplify by removing unused infrastructure. Either path is valid. User should investigate cloud-configs refresh pipeline for quota staleness.
