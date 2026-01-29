# Review: P2 - Architecture & Documentation

## Critical Issues

### 1. Model Detection Priority Contradicts Implementation
**Files affected:** DATA_SOURCES.md:163-184 vs CLAUDE.md:92-96 vs statusline.sh:340-430

**Issue:** Documentation claims:
- PRIMARY: JSON `model.display_name`
- FALLBACK: Transcript (if JSON missing, max 1 hour old)
- NEVER: settings.json

But actual implementation (statusline.sh lines 340-430) uses OPPOSITE priority:
- PRIMARY: Transcript `.message.model` (lines 374-405)
- FALLBACK: JSON input (lines 407-411)
- NEVER: settings.json (correct)

**Impact:** Medium. Documented behavior doesn't match code. If transcript is missing/stale, JSON should be used but docs say JSON is primary source. This causes confusion for debugging and maintenance.

**Evidence:**
- ARCHITECTURE.md Phase 4 doesn't mention model detection at all (gaps below)
- CLAUDE.md line 94 states "FALLBACK: Transcript" but code line 417-420 shows transcript FIRST

---

### 2. Cache TTL for ccusage Documented as 15min but Code Has 35s Timeout
**File:** statusline.sh:825, ARCHITECTURE.md:83, CACHE-MANAGEMENT.md:36

**Issue:**
- CACHE-MANAGEMENT.md line 36 says "15 minute TTL"
- ARCHITECTURE.md line 83 says "15 min"
- But statusline.sh line 825 uses `timeout 35` (35 seconds)
- Line 712 says "CCUSAGE_CACHE_TTL=900 # 15 minutes"

**Actually:**
- Cache TTL validation (line 774-816) checks if block is from TODAY (not 15 min)
- If cache is fresh from today, it's used (line 811-812)
- Fresh fetch only if block ended >5min ago (line 798)
- So actual behavior: SAME-DAY cache is valid regardless of 15min TTL

**Impact:** Medium. Documentation is misleading. TTL is NOT 15 minutes for same-day blocks. It's "until end of day" effectively, with fresh fetch only if active block changed in last 5 minutes. This confuses users about when cache invalidates.

---

### 3. Data Freshness File (.data_freshness.json) Not Actually Implemented
**Files:** CACHE-MANAGEMENT.md:130-156 vs statusline.sh:714-769

**Issue:** Documentation describes comprehensive staleness tracking:
- CACHE-MANAGEMENT.md line 130: ".data_freshness.json" with timestamps
- CACHE-MANAGEMENT.md line 135-140: JSON format with per-source timestamps
- ARCHITECTURE.md line 168-191: "Staleness Tracking" section

But implementation (statusline.sh lines 714-769):
- `record_fetch_time()` function exists (line 718-740)
- `calculate_data_indicator()` function exists (line 743-769)
- **BUT:** Neither function is called for GIT status (no git staleness tracking)
- **BUT:** Only called for ccusage_blocks (lines 828, 1096, 1117, 1132)
- Git cache has NO freshness tracking at all (lines 276-295)
- Weekly quota fetch doesn't call `record_fetch_time()` (lines 921-936)

**Impact:** Medium. Documentation describes staleness tracking for all sources but only 1 of 4 sources (ccusage) actually tracks it. Users expect 🔴 indicators for ALL stale data but only get them for ccusage. Git can be 10+ seconds old with no indicator.

---

### 4. Timeout Values Inconsistent with Documentation
**Files:** PROCESS-SAFETY.md:44-50 vs statusline.sh

**Documented timeouts:**
- ccusage: 20s (PROCESS-SAFETY.md line 46)
- jq: 2s (PROCESS-SAFETY.md line 47)

**Actual timeouts in code:**
- ccusage: 35s (statusline.sh line 825, 924)
- jq: 2s (statusline.sh lines 385, 389, 619) ✅
- Git: implicit (correct)

**Impact:** Low. 35s timeout is actually BETTER than documented 20s (more reliable), but documentation should be updated. Could cause confusion if debugging timeout issues.

---

## Important Issues

### 5. Last Prompt Session File Path Logic Unclear
**File:** statusline.sh:604-608 vs DATA_SOURCES.md

**Issue:** Session file construction:
```bash
proj_path=$(echo "$current_dir" | sed "s|~|$HOME|g" | sed 's|/|-|g' | sed 's|\.|-|g' | sed 's|_|-|g' | sed 's|^-||')
session_file="$HOME/.claude/projects/-${proj_path}/${session_id}.jsonl"
```

Problems:
1. `-${proj_path}` creates filenames like `~/.claude/projects/--Users-vmks-...` (double dash)
2. Replaces slashes with dashes, making `/Users/vmks/.claude` → `-Users-vmks-.claude`
3. No validation that this file path actually matches transcript_path provided in JSON
4. If transcript_path from JSON and computed session_file don't match, transcript_path is ignored for last-message extraction

**Evidence:** Lines 319-320 use transcript_path directly for conversation analytics, but lines 605-608 compute a DIFFERENT path. If they don't align, last prompt won't extract.

**Impact:** Medium. Last message feature may silently fail if path computation doesn't match actual transcript location. No error handling or fallback.

---

### 6. Git Status TTL Validation Uses Stat Fallback That May Fail
**File:** statusline.sh:83, 380, 620

**Issue:** `stat` command uses different flags on macOS vs Linux:
```bash
stat -f %m "$file"        # macOS
stat -c %Y "$file"        # Linux
```

Code tries macOS first (line 83):
```bash
$(stat -f %m "$cache_file" 2>/dev/null || stat -c %Y "$cache_file" 2>/dev/null || echo 0)
```

If both fail (e.g., `stat` command missing), defaults to `0`, making cache_age = NOW - 0 = very large, forcing refresh on EVERY call (wasting resources).

**Impact:** Low on macOS (stat exists). High risk on systems without stat (edge case). Documents don't mention this fallback behavior.

---

### 7. Model Cache Cleanup Has Race Condition
**File:** statusline.sh:369-372

**Issue:**
```bash
if [ ! -f "$SAVED_MODEL_FILE" ]; then
    find "${HOME}/.claude" -name ".model_cache_*" -mtime +7 -delete 2>/dev/null || true
fi
```

Logic: "If current session's model cache doesn't exist, delete old caches"

**Problem:**
- On first invocation of a NEW session_id, $SAVED_MODEL_FILE doesn't exist yet (line 349)
- So find/delete runs even though we're about to CREATE the cache (line 439)
- This creates race condition: if cleanup happens while another session is reading cache, that session gets stale data

**Impact:** Low. Edge case (multiple concurrent sessions in first invocation). But not atomic.

---

### 8. Context Window Calculation Uses "Current" Not "Cumulative"
**File:** statusline.sh:511-554 vs ARCHITECTURE.md:136-144

**Documented:**
```
total_tokens_used = total_input + total_output + cache_creation
```

**Actual code:**
```bash
current_context_tokens=$((current_input + cache_read))  # Line 513
```

**Contradiction:** Docs say use total_input_tokens (cumulative from session start), but code uses current_input (resets after /compact). Comments (line 511-512) explain this is intentional ("NOT total_input_tokens which is cumulative").

**Impact:** Low. The implementation is actually MORE CORRECT than docs (shows actual context window usage, not cumulative). But documentation is misleading. Code comments are accurate (lines 511-512) but main docs aren't.

---

### 9. Json_input_provided Flag Not Used Consistently
**File:** statusline.sh:13-18, 194-230, 409

**Issue:** Variable `json_input_provided` is set (line 13-18) but only used in:
- Line 409: Fallback check for model_name

But many other JSON extractions (lines 195-213) don't check this flag first. If JSON is missing/invalid:
- model_name gets parsed from empty input → defaults to "Claude" ✅
- current_dir gets parsed from empty input → defaults to "unknown" ✅
- BUT: git_status, context_window_size etc. may still try to parse empty input

Minor issue since jq falls through to line 215 defaults, but inconsistent pattern.

**Impact:** Negligible. Works correctly due to fallback defaults, but code pattern is inconsistent.

---

## Gaps

### 10. ARCHITECTURE.md Missing Model Detection Section
**File:** docs/ARCHITECTURE.md

**Gap:**
- Sections: Phase 1 (Parse JSON), Phase 2 (Cache), Phase 3 (Fetch), Phase 4 (Metrics), Phase 5 (Staleness), Phase 6 (Display), Phase 7 (Dedup)
- **MISSING:** Phase that explains model detection priority (transcript vs JSON)
- Code has entire section for this (lines 338-439) with detailed comments

**Impact:** Medium. Model detection is critical but undocumented in architecture. New maintainers won't understand why transcript is checked first.

---

### 11. Git Cache Invalidation on Model Change Not Documented
**File:** CACHE-MANAGEMENT.md, ARCHITECTURE.md

**Gap:** Implementation (statusline.sh lines 432-436) invalidates git cache when model changes:
```bash
if [ -n "$last_model_name" ] && [ "$last_model_name" != "$model_name" ]; then
    MODEL_CHANGED=1
    rm -f "$GIT_CACHE_FILE" 2>/dev/null || true
fi
```

**Why?** Probably to ensure git status is fresh when user switches projects/models.

But this is NOT documented in:
- CACHE-MANAGEMENT.md (no mention of model-based invalidation)
- ARCHITECTURE.md (no mention of cross-cache dependencies)

**Impact:** Low. Edge case behavior. But if troubleshooting git cache issues, this won't be obvious.

---

### 12. Concurrent ccusage Execution Prevention Not Documented
**File:** statusline.sh:824, 923 vs PROCESS-SAFETY.md

**Gap:** Code prevents concurrent ccusage calls:
```bash
if ! pgrep -f "ccusage blocks" > /dev/null 2>&1; then
    blocks_output=$(timeout 35 "$CCUSAGE_CMD" blocks --json 2>/dev/null)
```

**Why?** Prevents multiple statuslines from hammering the API simultaneously.

But PROCESS-SAFETY.md doesn't mention:
- pgrep usage
- Concurrency handling
- What happens if another ccusage is already running (falls back to stale cache silently)

**Impact:** Low-Medium. Users debugging "why is my cost data old?" won't know it's because another statusline blocked it. Should be documented in concurrency section.

---

### 13. Smoothing Functions Behavior Not Documented
**File:** statusline.sh:569-586 vs ARCHITECTURE.md

**Gap:** Implementation uses smoothing to reduce flicker:
- `smooth_tokens()` rounds to nearest 100
- `smooth_tpm()` rounds to nearest 10
- `smooth_cache_ratio()` rounds to nearest 5%

**Why?** Reduces statusline updates when Claude is working (tokens/cache rapidly changing).

But nowhere in docs is this trade-off explained. Users might see:
- Tokens jump from "50kleft" to "50kleft" (no change for 30+ seconds)
- TPM showing "510tpm" when actual is "517tpm"
- And wonder why statusline isn't updating

**Impact:** Low. Nice feature but undocumented reduces discoverability.

---

### 14. ccusage Command Search Paths Hardcoded
**File:** statusline.sh:702-708

**Issue:** Command paths are hardcoded for specific user (vmks):
```bash
elif [ -x "/Users/vmks/.nvm/versions/node/system/bin/ccusage" ]; then
```

This won't work for other users. Should be removed or made generic.

**Impact:** Medium. Installation on other systems will fail to find ccusage even if it's in PATH.

---

### 15. Rate Limiting Disabled When Output Changes
**File:** statusline.sh:1237-1258

**Documented (CLAUDE.md line 166):** "Rate-limited to 100ms minimum between updates"

**Actual:** Rate limiting only applies to IDENTICAL output (line 1240):
```bash
RATE_LIMIT_MS=500  # Minimum 500ms between identical prints
```

But the logic (lines 1249-1258) says:
- Model changed: ALWAYS print (no rate limit)
- Output changed (hash differs): ALWAYS print immediately
- Only rate limit applies to IDENTICAL output

So rate limiting is actually "500ms between identical outputs" not "100ms minimum between all updates".

**Impact:** Low. Documentation says 100ms but code does 500ms ONLY for identical output. Users won't notice since changing output prints immediately anyway.

---

## Summary

**Critical (3):** Model detection priority inverted, cache TTL misleading, freshness tracking incomplete

**Important (6):** Session file path logic unclear, git cache TTL race condition, ccusage timeout mismatch, model cache cleanup race, json_input_provided inconsistency

**Gaps (6):** Missing model detection architecture section, git cache model-based invalidation undocumented, concurrent ccusage handling undocumented, smoothing behavior undocumented, hardcoded user path, rate limiting threshold mismatch

**Stability:** Code is robust with good fallbacks. Issues are documentation/clarity, not crashes. Safety mechanisms are sound (atomic writes, timeouts, error isolation all verified).

**Maintainability:** Contradiction between docs and code creates confusion. Transcript-first model detection is harder to understand than JSON-first (which is what most would expect). Missing architecture docs for key features.

---

## Fixes Immediately Applied

None - documentation review only. Recommend addressing critical issues in next PR:

1. **CRITICAL:** Update DATA_SOURCES.md and CLAUDE.md to match actual transcript-first model detection
2. **CRITICAL:** Clarify ccusage cache invalidation logic (TTL vs same-day vs block-end detection)
3. **CRITICAL:** Document that .data_freshness.json only tracks ccusage, not git/weekly
4. **IMPORTANT:** Add "Phase 2.5: Model Detection" to ARCHITECTURE.md explaining transcript priority
5. **IMPORTANT:** Update PROCESS-SAFETY.md with actual timeouts (35s ccusage, not 20s)
6. **IMPORTANT:** Document concurrent ccusage prevention and fallback behavior
7. **LOW:** Remove hardcoded user path /Users/vmks from statusline.sh line 704

---

**Review Date:** 2026-01-28
**Reviewer:** Architecture & Documentation Analysis
**Status:** Complete - 15 issues found, 3 critical
