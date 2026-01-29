# P3 Validation Review: Test Coverage + Edge Cases

**Date:** 2026-01-28
**Scope:** HEIGHTENED SCRUTINY for test coverage gaps, edge cases, boundary conditions, and production blind spots
**Status:** CRITICAL FINDINGS - Multiple high-impact edge cases NOT tested

---

## Executive Summary

The test suite is **broad but shallow** - covers major paths but misses critical edge cases, boundary conditions, and long-running session behavior. Key gaps identified:

- **TTL Boundary Conditions**: 1-hour TTL at exact boundary untested rigorously
- **Cache Invalidation Race Windows**: Between check-exists and use-value
- **Timeout Edge Cases**: Commands completing at exactly the timeout limit
- **Memory Leaks**: Unbounded temp file cleanup under extreme load
- **Long-Running Sessions**: Model detection behavior >1 hour after session start
- **Upgrade/Downgrade Paths**: Version mismatch scenarios
- **ccusage Integration Gaps**: Block boundary crossing at UTC midnight
- **File Corruption Recovery**: Partial writes interrupted mid-flush

---

## Test Coverage Analysis

### Present Test Suites (34 tests total)
- `test.sh` - 10 tests (basic functionality, deps, cache creation)
- `test-security.sh` - 6 tests (injection, traversal, concurrency)
- `test-model-detection.sh` - 6 tests (priority order, TTL, fallbacks)
- `test-concurrent.sh` - 6 tests (locking, atomic writes, zombies)
- `test-error-recovery.sh` - 10 tests (corrupted cache, missing tools, edge inputs)
- `test-performance.sh` - 6 tests (speed, memory, throughput)

**Coverage:** Good breadth, weak on edge cases and boundary conditions

---

## CRITICAL GAPS IDENTIFIED

### 1. BOUNDARY CONDITIONS (HIGH SEVERITY)

#### 1.1 Transcript TTL Boundary at 3600 Seconds
**Issue:** Test "Transcript at exactly 1 hour boundary" (test-model-detection.sh:128-149) is unreliable
- Creates timestamp "1 hour ago" but testing is problematic
- No explicit test for:
  - 3599 seconds old (should use)
  - 3601 seconds old (should NOT use)
  - Exact 3600 second boundary behavior
- Problem: OS clock precision and timestamp rounding cause test to fail intermittently

**Example Edge Case:**
```bash
# Current approach creates timing uncertainty
TIMESTAMP=$(date -u -v-1H '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date -u -d '1 hour ago' '+%Y-%m-%dT%H:%M:%SZ')
# This may be 3599s or 3601s depending on when it executes
# No deterministic boundary test exists
```

**Recommendation:** Add explicit boundary tests:
- Create transcript with hardcoded timestamp 3599s in past → should use transcript
- Create transcript with hardcoded timestamp 3601s in past → should NOT use transcript
- Verify exact comparison operator used (< vs <=)

#### 1.2 Cache TTL Grace Period Behavior
**Issue:** Git cache (10s TTL) has no boundary test
- No test for cache at exactly 9s vs 11s old
- No test for cache at 10s boundary with high clock skew
- `read_cache` function uses `$cache_age -lt $ttl` but behavior under:
  - NTP clock adjustment
  - Rounding errors in stat output
  - Negative age values (clock goes backwards)
  - Is untested

**Recommendation:** Add explicit tests:
- Cache at 9s (just valid) → should use
- Cache at 11s (just expired) → should refresh
- Test stat command behaves consistently on macOS (BSD stat) vs Linux

#### 1.3 Timeout Edge Cases
**Issue:** Multiple timeout commands used (2s for jq, 5s for find, 20s for ccusage) but NOT tested at boundaries
- Commands that complete in exactly 2000ms - does timeout kill them?
- Commands that complete in 2001ms - behavior?
- Multiple concurrent timeouts - do they interfere?

**Current Code:**
```bash
CMD_TIMEOUT=2
timeout 2 tail -50 "$transcript_path" 2>/dev/null
timeout 5 find "${HOME}/.claude" -name ".model_cache_*" -delete 2>/dev/null
```

**Recommendation:** Add timeout boundary tests:
- Command that sleeps 1999ms + work (should complete)
- Command that sleeps 2001ms + work (should timeout)
- Timeout signal propagation verification

---

### 2. CACHE INVALIDATION RACE CONDITIONS (CRITICAL)

#### 2.1 Check-Then-Use Window
**Issue:** Git cache and ccusage cache vulnerable to TOCTOU (Time-of-Check-Time-of-Use)

**Vulnerable Pattern:**
```bash
# Line 289-306: Git cache read-check-write
cached_git=$(read_cache "$GIT_CACHE_FILE" "$GIT_CACHE_TTL")  # Check 1: Is cache valid?
if [ -n "$cached_git" ]; then
    # Use cache ...
else
    # Cache miss - fetch fresh data
    if git rev-parse --git-dir >/dev/null 2>&1; then
        # ... execute git commands ...
        write_cache "$GIT_CACHE_FILE" "..."  # Write at T+100ms
    fi
fi

# RACE: Between check (T=0) and write (T=100ms), another process could:
# - Delete cache file
# - Truncate cache file
# - Start its own fetch after seeing empty result
# - Both processes fetch simultaneously
```

**Test Gap:** No concurrent test for:
- Process A: Checks cache (valid), starts using it
- Process B: Deletes cache between A's check and A's read
- Verify A doesn't crash or use stale data

**Recommendation:** Add TOCTOU test:
```bash
# Process A: Hold cache valid state while reading slowly
# Process B: Delete cache during A's read
# Verify A completes without error
```

#### 2.2 ccusage Lock Window
**Issue:** flock-based locking has timeout window but no test for:
- What happens if flock timeout reached?
- Stale cache age check vs lock wait time
- Multiple processes timing out simultaneously

**Current Implementation:**
```bash
# No timeout on flock visible in script (must be external)
# if lock held >20s, what happens? Silent fallback?
```

**Recommendation:** Add tests for:
- Lock held 25s (beyond ccusage timeout) - verify graceful degradation
- Verify stale cache is used rather than hanging

---

### 3. MEMORY LEAKS (HIGH SEVERITY)

#### 3.1 Unbounded Temp File Accumulation
**Issue:** Cleanup happens at startup but not during execution
```bash
# Line 392: Cleanup orphaned temp files
timeout 5 find "${HOME}/.claude" -name ".*.tmp.*" -mmin +60 -delete 2>/dev/null || true
```

**Problem:**
- Cleanup only removes files >60 minutes old
- Under sustained load (e.g., Claude Code polling every 100ms):
  - Could accumulate 1000s of temp files within 60 minutes
  - Each temp file = inode consumption
  - find command takes longer as count increases
  - On NFS or constrained filesystems, could exhaust inodes
  - Edge case: If script crashes repeatedly, cleanup orphans slower than creation

**Test Gap:** No load test for:
- 10,000 invocations → temp file count
- find command performance as temp files accumulate
- Cleanup behavior under sustained load

**Recommendation:** Add stress test:
```bash
# Create 5000 statusline processes rapidly
# Measure temp file accumulation
# Verify cleanup completes in <5s despite large count
# Check for stale temp files >60min old
```

#### 3.2 File Descriptor Leaks
**Issue:** Test-concurrent.sh:152-175 checks FD leak via lsof but:
- Only tests 50 iterations (minimal)
- Doesn't test long-running sessions
- Doesn't test error paths (e.g., jq crashes mid-stream)

**Recommendation:** Add extended FD leak tests:
- 1000+ iterations checking FD count doesn't grow linearly
- Error paths: jq timeout, git timeout, ccusage timeout

---

### 4. LONG-RUNNING SESSION BEHAVIOR (PRODUCTION RISK)

#### 4.1 Model Detection >1 Hour Into Session
**Issue:** Transcript TTL = 1 hour, but what if:
- User starts Claude Code session at 12:00 PM
- Works for 2 hours (until 2:00 PM)
- Switches models at 2:15 PM
- Statusline should detect new model BUT:
  - Transcript is >1 hour old → falls back to JSON
  - JSON still shows old model (stale)
  - Result: Wrong model displayed for extended period

**Test Gap:** No test for:
- Session age >1 hour
- Model switch in that scenario
- Fallback behavior when both sources stale

**Scenario:**
```bash
# Session created at T=0 with Haiku
# At T=70min, user switches to Opus (transcript updated)
# At T=70min, statusline checks:
#   - Transcript: valid, shows Opus ✓
#   - Should work correctly
#
# At T=65min (different testing):
# User switches to Opus at T=65min
# At T=70min, statusline checks:
#   - Transcript: 5min old, shows Opus ✓
#   - JSON: stale, shows Haiku ✗
# Should still use Opus because transcript valid
#
# At T=125min:
# Opus session, transcript >1 hour old
# JSON says Haiku (stale default from .claude/settings.json)
# Statusline shows Haiku (WRONG) - BUG!
```

**Recommendation:** Add long-session test:
- Create session at T=0 with model A
- Advance system time to T=70min, switch to model B
- Advance to T=130min
- Verify still shows model B (or degraded but correct fallback)

#### 4.2 Cache Staleness at Session Boundary
**Issue:** ccusage cache TTL is "same-day" but:
- Block starts at 11:50 PM UTC
- At 12:10 AM UTC (next day), what happens?
- CLAUDE.md says: "valid if block started today AND block hasn't ended"
- But test checks for block "end time" - how is this detected?

**Test Gap:** No test for:
- Block crossing UTC midnight
- Old block ending and new block starting simultaneously
- Cache invalidation at boundary

**Recommendation:** Add UTC midnight crossing test:
- Create ccusage cache for block starting 11:55 PM
- Run statusline at 12:05 AM
- Verify cache is invalidated (different day)

---

### 5. ERROR RECOVERY GAPS (MEDIUM SEVERITY)

#### 5.1 Corrupted JSONL in Transcript
**Issue:** Test-error-recovery.sh:105-124 tests malformed JSONL but:
- Only creates 2 lines of garbage (unrealistic)
- Doesn't test partial JSONL records (most common corruption)
- Doesn't test 50K lines with one corrupted line in middle

**Example Real Corruption:**
```jsonl
{"message":{"model":"claude-haiku-4-5"},"timestamp":"2026-01-28T12:00:00Z"}
{"message":{"model":"claude-sonnet-4-5"},"timestamp":"2026-01-28T12:05:00Z"}
{"message":{"model":INCOMPLETE_JSON_HERE...
{"message":{"model":"claude-opus-4-5"},"timestamp":"2026-01-28T12:10:00Z"}
```

Current test with jq tail-1 might:
- Miss the opus model if last line is valid
- But also not detect the corruption
- No assertion that valid model found despite corruption

**Recommendation:** Add realistic corruption tests:
- Large file (10K lines) with one corrupted line in middle
- Incomplete record at EOF
- Mixed valid/invalid JSONL lines

#### 5.2 Missing jq Error Message Quality
**Issue:** Test-error-recovery.sh doesn't verify:
- Error message is actually helpful
- Error message appears on stderr (not stdout)
- Error message includes installation command
- Script exits with clear exit code (not 0)

**Current Code (Lines 19-24):**
```bash
if command -v jq >/dev/null 2>&1; then
    # ...
else
    if [ -n "$input" ] && [[ "$input" == "{"* ]]; then
        echo "ERROR: jq is required..." >&2
        exit 1
    fi
fi
```

**Test Gap:**
- Doesn't verify exit code = 1
- Doesn't verify message on stderr
- Doesn't verify installation instructions included

**Recommendation:** Add test:
```bash
OUTPUT=$(echo '{"test":1}' | bash statusline 2>&1)
EXIT_CODE=$?
[ $EXIT_CODE -ne 0 ] && [[ "$OUTPUT" =~ "brew install jq" ]]
```

---

### 6. UPGRADE/DOWNGRADE PATHS (OPERATIONAL RISK)

#### 6.1 Cache Format Version Mismatch
**Issue:** No test for:
- Script v1.1 creates cache format X
- Script v1.0 tries to read it
- Backward compatibility verification

**Current Status:** Cache format is simple (text-based), but:
- No version marker in caches
- If future version changes format, no detection
- Could silently read garbage data

**Recommendation:** Add version detection to caches:
```bash
# .ccusage_cache.json should include version marker
# If version mismatch, invalidate cache
```

#### 6.2 ccusage API Change Breaking
**Issue:** Dependency on `ccusage blocks --json` output format
- No test for ccusage returning unexpected JSON structure
- No test for ccusage changing field names
- Script assumes specific JSON schema (isActive, startTime, costUSD)

**Test Gap:** No resilience test for:
- ccusage API returns completely different JSON
- Missing required fields
- Unexpected data types (string vs number for cost)

**Recommendation:** Add ccusage schema validation:
```bash
# Validate ccusage response has required fields
# Graceful fallback if schema changed
```

---

### 7. SESSION-SPECIFIC CACHE EDGE CASES (MEDIUM SEVERITY)

#### 7.1 Session ID Collision
**Issue:** Model cache file named `.model_cache_${session_id}`
- If two sessions get same ID (unlikely but possible):
  - Both write to same cache file
  - Cross-chat contamination (the issue being fixed)
  - Concurrent writes cause race condition

**Test Gap:** No test for:
- Session ID = "null" or empty string
- Very long session IDs (>255 chars)
- Session IDs with special chars
- Session ID collision between rapid sessions

**Current Code (Lines 363-367):**
```bash
if [ -n "$session_id" ] && [ "$session_id" != "null" ]; then
    SAVED_MODEL_FILE="${HOME}/.claude/.model_cache_${session_id}"
else
    SAVED_MODEL_FILE="${HOME}/.claude/.last_model_name"
fi
```

**Risk:** If session_id contains `../` or `/`, could be path traversal

**Recommendation:** Add validation:
```bash
# Sanitize session_id: only alphanumeric + dash/underscore
[[ "$session_id" =~ ^[a-zA-Z0-9_-]+$ ]] || session_id="null"
```

#### 7.2 Cache Pollution from Stale Sessions
**Issue:** Cleanup removes caches older than 7 days
- But what if user never runs script for 7 days?
- Cache files accumulate for sessions never touched again
- On shared system, could accumulate 1000s of old session caches

**Test Gap:** No test for:
- 100+ sessions, 7+ days old
- find -mtime +7 performance with thousands of files
- Cleanup completeness verification

**Recommendation:** Add cleanup stress test:
```bash
# Create 1000 session model cache files (7+ days old)
# Run statusline
# Verify all >7-day caches deleted
# Measure find command execution time
```

---

### 8. INSTALLATION & SETUP GAPS (USER-FACING)

#### 8.1 Installation Documentation Accuracy
**Issue:** CLAUDE.md Quick Start says:
```bash
cp scripts/statusline.sh ~/.claude/statusline.sh
chmod +x ~/.claude/statusline.sh
```

**But:**
- No test that script is actually executable after chmod
- No test that symlink installation works (if user prefers)
- No test that relative path in settings.json fails appropriately
- No documentation for what to do if ~/.claude doesn't exist (auto-created but not mentioned)

**Test Gap:** No installation flow test:
1. From fresh system
2. Following exact CLAUDE.md steps
3. Verify statusline produces output in Claude Code settings

**Recommendation:** Add end-to-end installation test:
```bash
# Clean slate
# Run exact install steps from CLAUDE.md
# Verify statusline works when invoked from settings.json
```

#### 8.2 settings.json Configuration Validation
**Issue:** CLAUDE.md shows config example but:
- No test that misconfigured settings.json is handled gracefully
- No validation of command path (absolute vs relative)
- No error if command doesn't exist

**Test Gap:** No error handling test for:
- Wrong command path (statusline.sh doesn't exist)
- Relative path (expected to fail)
- Missing padding parameter
- Invalid command syntax

**Recommendation:** Add configuration validation test

---

### 9. PERFORMANCE UNDER PATHOLOGICAL CONDITIONS (LOW PROBABILITY, HIGH IMPACT)

#### 9.1 Extreme Transcript Size
**Test-performance.sh:156-186** tests 10K lines, but what about:
- 1M line transcript (real possibility for multi-month sessions)
- Network file system (NFS) latency on tail -50
- Slow jq parsing on old machines
- Memory exhaustion on jq -s (not used anymore, good)

**Recommendation:** Add pathological load test:
```bash
# 1M line transcript
# Measure parse time
# Verify completes in <500ms
```

#### 9.2 Extremely Deep Directory Nesting
**Issue:** Git cache uses git commands
- What if current_dir is 500 levels deep?
- What if .claude is on NFS with high latency?
- git rev-parse could timeout

**Test Gap:** No test for:
- Deep directory (>100 levels) git status
- NFS latency simulation
- symlink-heavy directory structure

---

### 10. UNDOCUMENTED EDGE CASES (OPERATIONAL)

#### 10.1 Multiple TTL Policies Mixed
**Issue:** Script has 3 different TTL strategies:
- Git cache: 10s TTL (line 85)
- ccusage cache: same-day (dynamic)
- Transcript model: 1 hour (line 401)
- Cleanup: 60 minutes for temp files (line 392)
- Session cache: 7 days (line 387)

**Problem:** No clear mental model of which cache lives how long
- User sees inconsistent behavior (some fast, some stale)
- No documentation of cross-cache invalidation
- No test verifying TTL consistency

**Test Gap:** No orchestration test showing:
- All caches invalidate together on model change
- TTL policies don't conflict
- "Stale" data doesn't leak between caches

**Recommendation:** Add cache coherency test

#### 10.2 Color Code Behavior with NO_COLOR
**Issue:** Test-error-recovery.sh:202-213 tests NO_COLOR but:
- Only checks absence of ANSI codes (simple)
- Doesn't verify output is still readable
- Doesn't test color codes are present when NO_COLOR not set
- Doesn't test behavior with TERM=dumb

**Recommendation:** Add comprehensive color test:
- With NO_COLOR=1 → no ANSI codes
- Without NO_COLOR → has ANSI codes
- With TERM=dumb → no ANSI codes
- Verify output is readable in all modes

---

## Test Quality Issues

### 11. FLAKY TESTS (Timing-Dependent)

#### 11.1 Concurrent Execution Timing
**Test-concurrent.sh:115-149** example:
```bash
for i in $(seq 1 20); do
    echo '{"model":{"display_name":"test"}}' | bash "$STATUSLINE" >/dev/null 2>&1 &
done
wait
sleep 1
```

**Problem:**
- Timing-dependent (may race on slow systems)
- 1s sleep may not be enough on overloaded CI
- Test passes/fails based on system load, not correctness
- No deterministic verification mechanism

**Recommendation:** Replace timing checks with:
- Deterministic lock-based verification
- Process completion checking (not just sleep)
- System-load-independent assertions

#### 11.2 Performance Tests with Loose Bounds
**Test-performance.sh:73-95** example:
```bash
TARGET_MS=20
ACCEPTABLE_MS=500  # 500ms is acceptable for bash scripts
```

**Problem:**
- 25x difference between target and acceptable
- Useless for regression detection
- Passes on slow systems, fails on fast systems
- Does NOT catch 3x slowdown

**Recommendation:** Add:
- Baseline measurement step
- Regression detection relative to baseline (not absolute)
- System normalization (measure baseline first, adjust expectations)

---

## Missing Test Suites

### 12. MISSING TEST FILES (HIGH PRIORITY)

#### 12.1 Integration Tests
**No integration test exists for:**
- Full statusline output format validation
- All components present in output
- Emoji rendering correctness
- Output line breaks
- Data coherence (e.g., cost + tokens align)

**Recommendation:** Create `test-integration.sh`:
```bash
# Verify output contains all required emojis
# Verify output formatting (2 lines, proper spacing)
# Verify numeric values make sense (cost positive, tokens non-negative)
# Verify git status accurate
```

#### 12.2 Upgrade/Downgrade Tests
**No test for:**
- Cache format changes
- Backward compatibility
- Migration from v1.0 to v2.0

**Recommendation:** Create `test-upgrade.sh`

#### 12.3 Long-Running Session Tests
**No test for:**
- Session lasting >1 hour
- Model detection after 1+ hours
- Cache TTL enforcement over long duration

**Recommendation:** Create `test-long-session.sh` (mocking time if needed)

#### 12.4 System Dependency Tests
**No comprehensive test for:**
- macOS (BSD stat/date) vs Linux (GNU stat/date)
- Different shell versions (bash 3.x vs 4.x vs 5.x)
- Minimal environment (Alpine, busybox)
- Path extremes (/path/with spaces/etc)

**Recommendation:** Create `test-compatibility.sh`

#### 12.5 Documentation Tests
**No test for:**
- CLAUDE.md examples actually work
- Installation steps are complete
- Troubleshooting advice is accurate
- Sample JSON is valid

**Recommendation:** Create `test-documentation.sh`

---

## Summary of Critical Findings

| Category | Severity | Impact | Count |
|----------|----------|--------|-------|
| Boundary Conditions | CRITICAL | TTL edge cases may fail silently | 3 |
| Race Conditions | CRITICAL | Cache corruption possible | 2 |
| Memory Leaks | HIGH | Resource exhaustion under load | 2 |
| Long-Running Sessions | HIGH | Model detection fails after 1 hour | 2 |
| Error Recovery | MEDIUM | Unhelpful error messages | 2 |
| Upgrade Paths | MEDIUM | No forward compatibility test | 1 |
| Session Cache | MEDIUM | Path traversal risk if not validated | 1 |
| Installation | MEDIUM | Installation flow never tested | 1 |
| Flaky Tests | MEDIUM | Tests unreliable on slow systems | 2 |
| Missing Test Files | HIGH | 5 major test suites missing | 5 |

**Total Issues Found:** 21 high/critical items

---

## Recommended Next Steps

### Priority 1 (Fix Before Production)
1. Add deterministic TTL boundary tests (3599s vs 3601s)
2. Add TOCTOU race condition tests
3. Test model detection in >1 hour sessions
4. Add session cache path validation (prevent traversal)
5. Create installation flow end-to-end test

### Priority 2 (Add Before 1.1 Release)
1. Add UTC midnight cache boundary test
2. Add load test for temp file accumulation
3. Add long-running session test (mocked time)
4. Create integration test suite
5. Replace flaky timing tests with deterministic ones

### Priority 3 (Documentation + Quality)
1. Document all cache TTL policies clearly
2. Add cache coherency test
3. Create upgrade compatibility tests
4. Add comprehensive color mode test
5. Create system compatibility test matrix

---

## Conclusion

The test suite covers **happy paths and major security issues well**, but **edge cases, boundary conditions, and production scenarios are weakly tested**. Highest risk is:

1. **Model detection failure in long sessions** (>1 hour) - would show wrong model to user
2. **TTL boundary conditions** - silent cache staleness possible
3. **Temp file accumulation** - resource leak under sustained load
4. **TOCTOU race conditions** - cache corruption under concurrent load

These should be addressed before declaring 1.0 production-ready.
