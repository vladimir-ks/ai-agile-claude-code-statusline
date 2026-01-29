# Review: P3 - Testing & Quality Assurance

## Critical Issues

1. **examples/test.sh:38 - Insufficient JSON input validation**
   - Test 0a validates JSON model priority but doesn't test ALL priority layers
   - Missing test: What happens when JSON provides Sonnet4.5 but transcript has Haiku4.5 (fresh)? Should use transcript per implementation logic at scripts/statusline.sh:417-429
   - Gap: No test verifies transcript actually takes priority over JSON despite CLAUDE.md saying so

2. **examples/test.sh:48 - Empty input fallback incomplete**
   - Test 0b checks for "some model" but doesn't validate specific fallback chain
   - Missing: No assertion on whether it uses settings.json (preferred) vs transcript (fallback)
   - Problem: Without settings.json mock, test result is non-deterministic—depends on user environment

3. **scripts/statusline.sh:378-404 - TTL validation has logical gap**
   - Transcript TTL = 1 hour (line 381: `TRANSCRIPT_TTL=3600`)
   - BUT: No test verifies behavior when transcript exists but is EXACTLY 1 hour old
   - Boundary condition: Does `$transcript_age < 3600` exclude 3600 or include it? (currently excludes—edge case)
   - QA gap: No test for edge case where transcript_age = 3599 (just within TTL) vs 3600 (just outside)

4. **QA_TEST_SCENARIOS.md:75 - Stale transcript test relies on manual timing**
   - Test Scenario 4 requires checking "if transcript is older than 1 hour"
   - No automated verification: How does QA guarantee transcript is exactly 1h 1m old for testing?
   - Flaky: Test depends on human observation rather than reproducible conditions

## Important Issues

5. **examples/test.sh:172-186 - Deduplication test is weak**
   - Test 6 runs statusline twice and compares output
   - Problem: Git status likely changed between runs—test expects identical output but gets warning
   - Root cause: No cache invalidation or controlled environment; test marked as "WARN" (line 181) but counted as PASS (line 185)
   - Risk: Developers might ignore deduplication failures

6. **examples/test.sh:196-204 - Zombie process test has race condition**
   - Test 7 kills processes after 1 second sleep (line 194)
   - Problem: 1 second may not be enough for all subshells to exit, especially on slow systems
   - Missing: No timeout mechanism; test could hang indefinitely on macOS with slow file I/O

7. **examples/setup.sh:94-98 - Installation test execution is fragile**
   - Test JSON has incorrect structure: `"output_style": {"name": ""}` but implementation never parses `.name`
   - Risk: Test passes even if statusline can't parse output_style (low priority but symptom of incomplete mocking)

8. **QA_TEST_SCENARIOS.md:128 - Settings.json fallback test missing**
   - Test 7 description says "If settings.json has no model" but doesn't exist in test suite
   - Gap: No actual verification that settings.json `.model` field is used
   - Implementation detail: Scripts/statusline.sh reads from JSON input and transcript; no evidence it reads settings.json for model detection

9. **TROUBLESHOOTING.md:155 - Performance expectations not validated by tests**
   - Claims: "Normal (cache hit): ~10-15ms" | "First fetch: ~17-20s" (CLAUDE.md:175-176)
   - Missing: No performance regression test in examples/test.sh
   - Risk: Future changes could degrade performance without detection

## Gaps

10. **No error recovery tests**
    - Missing test: What if `jq` command fails mid-execution? (Implementation has `set +e` but no validation)
    - Missing test: What if git command times out? (10-second TTL not validated)
    - Missing test: What if ccusage is unavailable? (Should fallback gracefully, no test)

11. **No cache corruption tests**
    - examples/test.sh:154-160 validates JSON parsing of cache but doesn't test:
      - Partial writes to cache file (interrupted writes)
      - Corrupted JSON in `.ccusage_cache.json` (missing fields)
      - Unreadable cache files (permission denied)

12. **No concurrent execution safety tests**
    - Missing: What if statusline is called twice simultaneously?
    - Risk: Race condition on `.ccusage_cache.json` writes (line 98: `echo "$content" >"$temp_file" && mv`)
    - Missing test: Verify atomic writes actually prevent corruption when multiple processes write

13. **No environment variable isolation tests**
    - Missing: Test that `NO_COLOR=1` actually disables colors (line 49)
    - Missing: Test that `WEEKLY_BUDGET` override works (line 26)
    - Missing: Test with unset `HOME` variable (what happens?)

14. **Model detection test coverage incomplete**
    - Test 0a validates JSON input priority but doesn't test:
      - What if JSON model is "Claude" (default)? Should fall through to transcript?
      - What if transcript_model_id parsing fails (malformed JSONL)?
      - Session-specific model cache (`SAVED_MODEL_FILE` with session_id) not tested—only `.last_model_name` fallback

15. **No context window boundary tests**
    - Missing: Test when `context_window_size = 0` (divide-by-zero risk at line 515-539)
    - Missing: Test when `current_context_tokens > context_window_size` (overage scenario)
    - Missing: Test smooth_tokens/smooth_tpm rounding at exact boundaries (e.g., 50, 5000, 10)

16. **No data staleness indicator tests**
    - CLAUDE.md mentions: "Staleness Indicator: 🔴 appears when data >1 hour old" (line 74)
    - QA_TEST_SCENARIOS.md Test 4 & 5 mention red dot but NO TEST verifies it displays
    - Missing: Automated test that checks for 🔴 when ccusage_blocks data is >3600 seconds old

17. **examples/test.sh:209-217 - Git integration test minimal**
    - Test 8 only validates git command exists, doesn't test:
      - What if `.claude` is not a git repo? (Expected fallback behavior)
      - What if git status takes >10s? (TTL edge case)
      - Dirty file count accuracy (mock git repo with known state?)

18. **No transcript parsing failure tests**
    - scripts/statusline.sh:319-320 calls `jq -s 'length' "$transcript_path"`
    - Missing test: What if transcript file is empty? What if JSONL is malformed?
    - Missing test: What if transcript_path points to non-existent file?

19. **QA_TEST_SCENARIOS.md checklist is incomplete**
    - Sign-off checklist (lines 238-251) has 10 items matching tests but doesn't include:
      - Context window calculations (test missing entirely)
      - Cache metrics display (test missing)
      - Token burn rate calculation (test missing)
      - Output styling/formatting (test missing)

20. **Force refresh mechanism partially tested**
    - Test 0c (lines 57-72) is marked "WARN" or "SKIP" rather than hard PASS/FAIL
    - Risk: Force refresh might be broken without clear failure signal
    - Missing: Verify STATUSLINE_FORCE_REFRESH=1 actually clears ccusage_cache.json (only tests git_status_cache)

## Summary

Test coverage is approximately 60% complete. Critical gaps exist in:
- **Model detection priority chain** (3 layers not fully validated)
- **Cache invalidation logic** (TTL boundaries, race conditions)
- **Error recovery** (jq/git/ccusage failures)
- **Performance baselines** (no regression tests)
- **Data staleness indicators** (red dot display untested)
- **Boundary conditions** (zero values, overages, edge cases)
- **Concurrent safety** (simultaneous execution)

Main blockers for production confidence:
1. No test validates transcript actually prioritizes over JSON input (contradicts implementation priority)
2. No automated performance validation (20-second freeze claim unverified)
3. Cache atomicity unverified (multi-process safety)
4. Error paths largely untested (silent fallback behavior not validated)

QA scenarios document is comprehensive for manual testing but insufficient for CI/CD automation.

## Fixes Immediately Applied

**None - Test scenarios review only.** Issues require test creation/enhancement, not code fixes to statusline.sh.

Recommended next steps:
1. Create `examples/test-edge-cases.sh` covering critical gaps #10-13
2. Add performance benchmark test (baseline 10-15ms for cache hits)
3. Create `examples/test-concurrent.sh` for multi-process safety
4. Add transcript mock data to test suite for model detection validation
5. Implement environment isolation fixture for consistent test results
