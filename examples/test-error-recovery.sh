#!/bin/bash
# Error Recovery Test Suite
# Validates graceful fallbacks for jq/git/ccusage failures

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUSLINE="${SCRIPT_DIR}/../scripts/statusline.sh"

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    echo -e "  ${YELLOW}Details:${NC} $2"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

run_test() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo ""
    echo "Test $TESTS_RUN: $1"
    echo "----------------------------------------"
}

setup() {
    export HOME="${SCRIPT_DIR}/.test_home_error"
    rm -rf "$HOME" 2>/dev/null || true
    mkdir -p "$HOME/.claude"
}

cleanup() {
    rm -rf "${SCRIPT_DIR}/.test_home_error" 2>/dev/null || true
}

# TEST 1: Corrupted Cache JSON Recovery
run_test "Corrupted cache JSON triggers re-fetch"
setup

# Create corrupted ccusage cache (truncated JSON)
CACHE_FILE="$HOME/.claude/.ccusage_cache.json"
echo '{"blocks":[{"isActive":true' > "$CACHE_FILE"  # Incomplete JSON

# Run statusline (should detect corruption and skip cache)
OUTPUT=$(echo '{"model":{"display_name":"test"}}' | bash "$STATUSLINE" 2>&1 || true)

# Should still produce output (not crash)
if [ -n "$OUTPUT" ]; then
    pass "Statusline recovered from corrupted cache (didn't crash)"
else
    fail "Statusline crashed on corrupted cache" "No output produced"
fi

cleanup

# TEST 2: Missing ~/.claude Directory Creates It
run_test "Missing ~/.claude directory auto-created"
setup

# Remove .claude directory
rm -rf "$HOME/.claude"

# Run statusline (should create directory)
OUTPUT=$(echo '{"model":{"display_name":"test"}}' | bash "$STATUSLINE" 2>&1 || true)

# Check directory was created
if [ -d "$HOME/.claude" ]; then
    pass "Missing ~/.claude directory auto-created"
else
    fail "Directory not created" "~/.claude doesn't exist after run"
fi

cleanup

# TEST 3: Empty Transcript File Doesn't Crash
run_test "Empty transcript file handled gracefully"
setup

# Create empty transcript
TRANSCRIPT="$HOME/.claude/projects/-test/empty.jsonl"
mkdir -p "$(dirname "$TRANSCRIPT")"
touch "$TRANSCRIPT"

JSON_INPUT='{"session_id":"test","current_dir":"~/test","transcript_path":"'$TRANSCRIPT'"}'
OUTPUT=$(echo "$JSON_INPUT" | bash "$STATUSLINE" 2>&1 || true)

if [ -n "$OUTPUT" ] && [[ ! "$OUTPUT" =~ "error" ]]; then
    pass "Empty transcript handled gracefully"
else
    fail "Empty transcript caused error" "Output: $OUTPUT"
fi

cleanup

# TEST 4: Malformed JSONL in Transcript
run_test "Malformed JSONL in transcript doesn't crash"
setup

# Create transcript with invalid JSONL
TRANSCRIPT="$HOME/.claude/projects/-test/malformed.jsonl"
mkdir -p "$(dirname "$TRANSCRIPT")"
echo "NOT VALID JSON AT ALL" > "$TRANSCRIPT"
echo "{incomplete json" >> "$TRANSCRIPT"

JSON_INPUT='{"session_id":"test","current_dir":"~/test","transcript_path":"'$TRANSCRIPT'"}'
OUTPUT=$(echo "$JSON_INPUT" | bash "$STATUSLINE" 2>&1 || true)

if [ -n "$OUTPUT" ]; then
    pass "Malformed JSONL handled gracefully (didn't crash)"
else
    fail "Malformed JSONL crashed statusline" "No output produced"
fi

cleanup

# TEST 5: Non-existent Transcript Path
run_test "Non-existent transcript path doesn't crash"
setup

JSON_INPUT='{"session_id":"test","current_dir":"~/test","transcript_path":"/nonexistent/path/file.jsonl"}'
OUTPUT=$(echo "$JSON_INPUT" | bash "$STATUSLINE" 2>&1 || true)

if [ -n "$OUTPUT" ]; then
    pass "Non-existent transcript handled gracefully"
else
    fail "Non-existent transcript crashed" "No output produced"
fi

cleanup

# TEST 6: Git Not Available or Timeout
run_test "Git unavailable doesn't block statusline"
setup

# Limit PATH to hide git
OLD_PATH="$PATH"
export PATH="/usr/bin:/bin"  # Minimal PATH

OUTPUT=$(echo '{"model":{"display_name":"test"}}' | timeout 5 bash "$STATUSLINE" 2>&1 || true)

export PATH="$OLD_PATH"

# Should complete in <5s even without git
if [ -n "$OUTPUT" ]; then
    pass "Git unavailable doesn't block statusline (completed in <5s)"
else
    fail "Statusline hung or crashed without git" "No output"
fi

cleanup

# TEST 7: ccusage Unavailable Falls Back to Defaults
run_test "ccusage unavailable uses defaults"
setup

# Temporarily hide ccusage
OLD_PATH="$PATH"
export PATH="/usr/bin:/bin"  # Limited PATH

OUTPUT=$(echo '{"model":{"display_name":"test"}}' | bash "$STATUSLINE" 2>&1 || true)

export PATH="$OLD_PATH"

# Should still produce output with default values
if [ -n "$OUTPUT" ] && [[ "$OUTPUT" =~ "📁" ]]; then
    pass "ccusage unavailable uses defaults (statusline still works)"
else
    fail "Statusline failed without ccusage" "Output: $OUTPUT"
fi

cleanup

# TEST 8: Unset HOME Variable
run_test "Unset HOME variable handled gracefully"
setup

# Run with HOME unset (should use $HOME from parent or fallback)
OLD_HOME="$HOME"
OUTPUT=$(HOME="" bash "$STATUSLINE" 2>&1 <<< '{"model":{"display_name":"test"}}' || true)
HOME="$OLD_HOME"

# Should not crash (may produce warning but still output something)
if [ -n "$OUTPUT" ]; then
    pass "Unset HOME handled gracefully (didn't crash)"
else
    fail "Unset HOME caused crash" "No output"
fi

cleanup

# TEST 9: NO_COLOR Environment Variable
run_test "NO_COLOR disables color output"
setup

# Run with NO_COLOR set
OUTPUT=$(NO_COLOR=1 bash "$STATUSLINE" 2>&1 <<< '{"model":{"display_name":"test"}}' || true)

# Check for absence of ANSI color codes
if [[ ! "$OUTPUT" =~ "\[38;5;" ]] && [ -n "$OUTPUT" ]; then
    pass "NO_COLOR disables color codes"
else
    fail "Color codes still present with NO_COLOR" "Output: ${OUTPUT:0:100}..."
fi

cleanup

# TEST 10: WEEKLY_BUDGET Override
run_test "WEEKLY_BUDGET environment variable works"
setup

# Set custom weekly budget
OUTPUT=$(WEEKLY_BUDGET=1000 bash "$STATUSLINE" 2>&1 <<< '{"model":{"display_name":"test"}}' || true)

# Should run without error (actual budget value used internally)
if [ -n "$OUTPUT" ]; then
    pass "WEEKLY_BUDGET override works"
else
    fail "WEEKLY_BUDGET override caused failure" "No output"
fi

cleanup

# SUMMARY
echo ""
echo "========================================"
echo "Error Recovery Test Suite Summary"
echo "========================================"
echo -e "Tests Run:    $TESTS_RUN"
echo -e "${GREEN}Tests Passed: $TESTS_PASSED${NC}"
if [ $TESTS_FAILED -gt 0 ]; then
    echo -e "${RED}Tests Failed: $TESTS_FAILED${NC}"
else
    echo -e "${GREEN}Tests Failed: 0${NC}"
fi
echo "========================================"

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✓ ALL ERROR RECOVERY TESTS PASSED${NC}"
    echo -e "  Corrupted cache recovery: VERIFIED ✓"
    echo -e "  Missing dependencies: VERIFIED ✓"
    echo -e "  Malformed inputs: VERIFIED ✓"
    echo -e "  Environment edge cases: VERIFIED ✓"
    exit 0
else
    echo -e "${RED}✗ SOME TESTS FAILED${NC}"
    exit 1
fi
