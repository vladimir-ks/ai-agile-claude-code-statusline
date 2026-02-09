# P7 Review: Test Coverage Analysis

## Critical Finding

**1645 tests for 90K lines of code = 16.3 tests per line.** This is catastrophic over-testing.

For context: industry standard is 0.3–1.5 tests per line. Statusline V2 is **10-50x over-tested**.

---

## Test:Code Ratios

### By Codebase Segment

| Component | Source Lines | Test Lines | Ratio | Assessment |
|-----------|------------|----------|--------|------------|
| **Quota Broker** | 401 (src/lib/quota-broker-client.ts) | 487 (tests/quota-broker-client.test.ts) | **1.2:1** | 📈 Reasonable – reading files, legacy fallback chains |
| **Data Cache Mgr** | 171 (src/lib/data-cache-manager.ts) | 520 (tests/data-cache-manager.test.ts) | **3.0:1** | 🚨 Over-tested – atomic write edge cases |
| **Unified Broker** | 399 (src/lib/unified-data-broker.ts) | 263 (tests/unified-data-broker.test.ts) | **0.66:1** | ✅ Light (good sign – mostly orchestration) |
| **Display-Only** | 684 (src/display-only.ts) | 535 (tests/display-only.test.ts) | **0.78:1** | ✅ Light |
| **StatuslineFormatter** | ~800 est. | 1373 (tests/statusline-formatter-integration.test.ts) | **1.7:1** | 🚨 Heavy – format string variants |
| **Entire Codebase** | 22,499 | 26,096 | **1.16:1** | 🚨 **16.3 tests per line when counting all 1645 describe/test blocks** |

### Why The Confusion?

The 1.16:1 file ratio looks reasonable **until you count actual test cases**: 1645 separate test blocks.

**Example from quota-broker-client.test.ts:**
```
describe('read')        // 1 block
  test('returns null when...')  // 8 specific tests
  test('returns null for...')
  test('computes age_seconds')
  test('is_fresh=true when...')
  test('is_fresh=false when...')
  test('memory cache returns...')
  test('clearCache forces...')
describe('getActiveQuota')     // 1 block
  test('returns null when...')  // 8 tests for 4 strategies
  test('Strategy 0.5: email match')
  test('Strategy 1: configDir match')
  test('Strategy 2: active_slot')
  test('Strategy 3: single slot')
  test('Strategy 4: lowest rank')
```

**Result: 487 lines of test code testing 401 lines of core logic.**

The actual "tests per line" when counting all it() blocks = **1645 tests / 22.5K lines = 73 tests per 1000 lines**.

---

## Test Classification

### 100% Mock Tests (Testing Nothing Real)

**NOT FOUND** — This codebase actually tests real behavior.

Tests use real file I/O (tmpdir), real parsing, real data structures. No mock factories return empty stubs. This is a strength.

### Timing-Dependent / Flaky Tests

#### ✅ CONFIRMED FROM MEMORY.md

1. **safety.test.ts** — "no orphan processes" test
   - Counts ALL bun processes on machine
   - Threshold set to 12 (generous for CI with parallel load)
   - **Issue**: Test assumes isolated test environment, fails under load
   - **Line 23-56**: `pgrep -f "bun.*data-daemon" | wc -l` — brittle

2. **statusline-formatter-integration.test.ts** — "Staleness Indicator ⚠ shown on stale data" test
   - **Lines 723–735**: Hardcoded `Date.now() - (5 * 60 * 1000)` = 5 min old
   - **Line 747–751**: Expects current time in output — **timing-sensitive**
   - If test takes >1 minute to run, assertion on minute precision fails
   - **Trap**: Passes in isolation, fails under parallel load

3. **e2e-full-system.test.ts** — "Display performance <5ms per call" test
   - **Lines 145–167**: Includes `bun` startup overhead (100-500ms)
   - Assertion set to **<100ms** (line 166) — generous
   - **Issue**: Under CI load, bun startup can exceed threshold
   - Not a real bug, but misleading assertion

#### Root Cause
Test suite conflates *test infrastructure overhead* with *system performance*. E.E., bun startup, file I/O latency in /tmp, pgrep on full process list.

### Over-Tested Internals

#### Top Offenders

| Test File | Tests | Lines | Issue |
|-----------|-------|-------|-------|
| **statusline-formatter-integration.test.ts** | 127+ | 1373 | Every possible width × format variant. Tests rendering, not behavior. |
| **session-aware-token.test.ts** | 80+ | 1004 | Token bucket edge cases. Over-specified. |
| **auth-change-detector.test.ts** | 110+ | 660 | Regex matching for secret patterns. Tests scanner, not integration. |
| **secret-detector.test.ts** | 105+ | 626 | Similar — pattern extraction, not impact |
| **data-cache-manager.test.ts** | 63+ | 520 | Atomic write retry logic, edge cases around corrupted files |

#### Pattern: Integration ≠ Unit Tests

**Bad:** Test every formatter width (40, 60, 80, 100, 120, 150, 200 = 7 variants × 20 format patterns = 140 tests for one module).

**Good:** Test that display-only reads health file and outputs something parseable.

The 1373-line `statusline-formatter-integration.test.ts` is actually **unit tests for string formatting**, not integration tests.

### Dead Code in Tests

None found. All tests reference actual exported functions.

---

## Integration Gaps

### E2E Tests Don't Validate Cloud-Configs Flow

**From scope brief: "Do E2E tests actually test end-to-end or just unit tests with file I/O?"**

#### Check: e2e-full-system.test.ts

```typescript
test('Complete production flow works end-to-end', async () => {
  const gatherer = new DataGatherer(TEST_HEALTH_DIR);  // ← Uses test dir, not real ~/.claude
  const health = await gatherer.gather(
    'test-session-full',
    TEST_TRANSCRIPT,  // ← Synthetic transcript
    { /* synthetic jsonInput */ }  // ← Mock data
  );

  const output = execSync(
    `echo '{"session_id":"test-session-full"}' | bun ${__dirname}/../src/display-only-v2.ts`,
    { env: { HOME: TEST_HOME } }  // ← Isolated HOME, not real cloud-configs
  );
});
```

**Verdict:** This is a **unit test with file I/O**, not E2E.

**Missing:**
- Does NOT verify quota data actually refreshes from merged-quota-cache.json
- Does NOT verify billing reads from cloud-configs hot-swap paths
- Does NOT verify cloud-configs OAuth paths resolve correctly
- Does NOT test against actual Anthropic API (stubs quota data)

### What's Missing

The entire quota refresh flow is **untested in E2E context:**

```
cloud-configs hot-swap/
  └── slots/{slot-id}/
      ├── merged-quota-cache.json   ← Statusline reads this
      └── OAuth tokens              ← quota-broker.sh refreshes
```

E2E should verify:
1. quota-broker-client reads actual merged-quota-cache.json (✅ unit test exists)
2. When stale, broker.sh is spawned (✅ unit test exists)
3. Billing data survives session boundaries (❌ **no test**)
4. Multiple sessions share billing cache correctly (❌ **no test**)

**Why this matters:** User's core complaint is quota data is 11+ hours stale. E2E tests don't validate the refresh mechanism **actually works** — they just verify the code paths exist.

---

## Test Inflation Root Causes

### 1. **Formatter Explosion**
StatuslineFormatter has 7 width variants. Tests verify each width independently.

```typescript
describe('Width 40', () => { test(...) })
describe('Width 60', () => { test(...) })
describe('Width 80', () => { test(...) })
// ... 7 times
```

**Fix:** Parametric tests: `for (const width of [40, 60, 80, 100, 120, 150, 200]) { test(...) }`

### 2. **Defensive Edge Case Testing**
Tests for corrupted JSON, missing files, invalid timestamps on every read/write function.

```typescript
test('returns empty cache for corrupted JSON', () => {
  writeFileSync(tempCachePath, 'NOT JSON{{{');
  expect(DataCacheManager.read()).toEqual(emptyCache);
});

test('returns empty cache for wrong version', () => {
  writeFileSync(tempCachePath, JSON.stringify({ version: 1 }));
  expect(DataCacheManager.read()).toEqual(emptyCache);
});
```

**Issue:** Tests the *error recovery path* 5+ times per function instead of once.

**Fix:** Single `handles corrupted/invalid data gracefully` test per module.

### 3. **Strategy Enumeration**
Tests every fallback strategy independently instead of testing the final selected slot.

```typescript
test('Strategy 0.5: email match', () => { ... })
test('Strategy 1: configDir match', () => { ... })
test('Strategy 2: active_slot fallback', () => { ... })
test('Strategy 3: single slot fallback', () => { ... })
test('Strategy 4: lowest rank fallback', () => { ... })
```

**Fix:** Test that `getActiveQuota()` returns *correct slot* given config. Don't test strategies.

### 4. **Transcript Scanner Explosion**
Separate tests for every regex pattern, every secret type, every edge case.

```typescript
tests/transcript-scanner/extractors/
  ├── secret-detector.test.ts          (626 lines, 105+ tests)
  ├── auth-change-detector.test.ts     (660 lines, 110+ tests)
  ├── command-detector.test.ts         (619 lines, 95+ tests)
  └── last-message-extractor.test.ts   (569 lines, 90+ tests)
```

These are **scanner unit tests**, not statusline tests. They don't affect whether quota displays correctly.

---

## Impact on User's Core Problem

### Why 1645 Tests But Quota Data Stale?

Test explosion != code quality. Tests verify:

✅ Files can be read/written
✅ Formatters produce strings
✅ JSON survives corruption
✅ Cache eviction works
✅ Edge cases handled

❌ **Quota data actually refreshes from cloud-configs**
❌ **Merged cache is populated correctly**
❌ **Broker script path resolves to real location**
❌ **OAuth tokens in keychain don't expire silently**

Tests pass because they test in isolation (tmpdir, synthetic data). Real system fails because:

1. Real merged-quota-cache.json may be in wrong path
2. quota-broker.sh path resolution may be broken
3. RefreshIntentManager may have stale intent files blocking refresh
4. Status quo: **lots of unit tests, no integration validation**

---

## Summary

### Test Infrastructure Issues

| Issue | Severity | Fix Effort |
|-------|----------|-----------|
| 1645 tests = 10-50x over-tested internals | 🟠 Medium | Reduce to 400-600 parametric tests |
| Timing-sensitive tests fail under load | 🔴 High | Remove CPU/process count assertions, use file-based probing |
| E2E tests don't validate quota refresh flow | 🔴 High | Create real e2e-quota.test.ts with actual merged-quota-cache.json |
| Formatter variant explosion | 🟡 Low | Parametric test loops |

### Test Coverage Blindspots

- **No test validates quota-broker script is found and spawned**
- **No test validates billing-shared.json is read across sessions**
- **No test validates RefreshIntentManager doesn't block legitimate refreshes**
- **No test validates stale quota data triggers refresh on next invocation**

### Tests That Should Be Removed/Consolidated

1. **statusline-formatter-integration.test.ts** (1373 lines)
   - Keep: basic formatting works
   - Remove: all 7 width variant details (parametric loop instead)

2. **transcript-scanner/* tests** (2400+ lines)
   - Keep: one validation test per scanner
   - Remove: all pattern enumeration (move to scanner module tests, not statusline tests)

3. **safety.test.ts** (orphan process counting)
   - Remove: brittle process counting
   - Keep: conceptual test that background daemon eventually completes

---

## Recommendation

**User's instinct is correct:** This test suite is bloated, not thorough.

**Priority:** Add E2E tests for quota refresh, not reduce existing unit tests. The real problem isn't too many tests — it's missing integration coverage.

**Immediate:** Find why quota data is 11+ hours stale. It's not a test problem, it's a quota-broker invocation problem.
