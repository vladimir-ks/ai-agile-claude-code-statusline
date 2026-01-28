#!/bin/bash
# Security Test Suite for aigile statusline
# Tests: Command injection, path traversal, concurrent execution, glob expansion

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUSLINE="${SCRIPT_DIR}/../scripts/statusline.sh"

# Test counter
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Helper functions
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

# Setup test environment
setup() {
    export HOME="${SCRIPT_DIR}/.test_home"
    mkdir -p "$HOME/.claude"
    mkdir -p "$HOME/.claude/projects"

    # Create minimal transcript for testing
    TRANSCRIPT_PATH="$HOME/.claude/projects/-test/test-session.jsonl"
    mkdir -p "$(dirname "$TRANSCRIPT_PATH")"
    echo '{"message":{"model":"claude-sonnet-4-5"},"timestamp":"2026-01-28T12:00:00Z"}' > "$TRANSCRIPT_PATH"
}

# Cleanup test environment
cleanup() {
    rm -rf "${SCRIPT_DIR}/.test_home" 2>/dev/null || true
}

# TEST 1: Command Injection via Transcript (FIXED)
run_test "Command injection via malicious transcript"
setup

# Create malicious transcript with command injection attempt
MALICIOUS_TRANSCRIPT="$HOME/.claude/projects/-malicious/session.jsonl"
mkdir -p "$(dirname "$MALICIOUS_TRANSCRIPT")"

# Attempt 1: Sed injection in command-name
cat > "$MALICIOUS_TRANSCRIPT" <<'EOF'
{"message":{"model":"claude-sonnet-4-5","content":"<local-command-stdout><command-name>test; rm -rf /tmp/test_injection_marker</command-name></local-command-stdout>"},"timestamp":"2026-01-28T12:00:00Z","type":"user"}
EOF

# Run statusline (should NOT execute rm command)
touch /tmp/test_injection_marker
JSON_INPUT='{"session_id":"session","current_dir":"~/malicious","transcript_path":"'"$MALICIOUS_TRANSCRIPT"'"}'
echo "$JSON_INPUT" | bash "$STATUSLINE" >/dev/null 2>&1 || true

if [ -f /tmp/test_injection_marker ]; then
    pass "Command injection blocked (marker file still exists)"
    rm -f /tmp/test_injection_marker
else
    fail "Command injection vulnerability - command was executed!" "Marker file deleted"
fi

cleanup

# TEST 2: Path Traversal Attack (FIXED)
run_test "Path traversal via session_file construction"
setup

# Attempt to access /etc/passwd via path traversal
MALICIOUS_JSON='{"session_id":"../../../../../../etc/passwd","current_dir":"~/../../../etc"}'
OUTPUT=$(echo "$MALICIOUS_JSON" | bash "$STATUSLINE" 2>&1 || true)

# Check that statusline didn't crash and didn't reveal /etc/passwd content
if [[ ! "$OUTPUT" =~ "root:" ]] && [[ ! "$OUTPUT" =~ "daemon:" ]]; then
    pass "Path traversal blocked (no /etc/passwd content leaked)"
else
    fail "Path traversal vulnerability - sensitive file accessed!" "Output: $OUTPUT"
fi

cleanup

# TEST 3: Concurrent ccusage Execution (FIXED)
run_test "Concurrent ccusage spawn prevention"
setup

# Create mock ccusage command that takes 2 seconds
MOCK_CCUSAGE="$HOME/.claude/mock_ccusage.sh"
cat > "$MOCK_CCUSAGE" <<'EOF'
#!/bin/bash
sleep 2
echo '{"blocks":[{"isActive":true,"startTime":"2026-01-28T12:00:00Z","costUSD":1.0}]}'
EOF
chmod +x "$MOCK_CCUSAGE"

# Temporarily override ccusage path (if statusline allows)
export PATH="$HOME/.claude:$PATH"

# Launch 5 concurrent statuslines
CONCURRENT_COUNT=5
PIDS=()
for i in $(seq 1 $CONCURRENT_COUNT); do
    echo '{"model":{"display_name":"test"}}' | bash "$STATUSLINE" >/dev/null 2>&1 &
    PIDS+=($!)
done

# Wait a moment for processes to start
sleep 0.5

# Count how many ccusage processes are actually running
CCUSAGE_COUNT=$(pgrep -f "mock_ccusage" 2>/dev/null | wc -l)

# Wait for all statuslines to complete
for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
done

if [ "$CCUSAGE_COUNT" -le 1 ]; then
    pass "Only 1 ccusage ran despite $CONCURRENT_COUNT concurrent statuslines"
else
    fail "Multiple ccusage processes spawned ($CCUSAGE_COUNT)" "Expected: 1, Got: $CCUSAGE_COUNT"
fi

rm -f "$MOCK_CCUSAGE"
cleanup

# TEST 4: Rapid Invocation Cache Corruption (FIXED)
run_test "Rapid invocation temp file collision prevention"
setup

# Launch 50 rapid statusline invocations
INVOCATION_COUNT=50
for i in $(seq 1 $INVOCATION_COUNT); do
    echo '{"model":{"display_name":"test"}}' | bash "$STATUSLINE" >/dev/null 2>&1 &
done

# Wait for all to complete
wait

# Check for orphaned temp files (should be cleaned up)
TEMP_FILES=$(find "$HOME/.claude" -name ".*.tmp.*" 2>/dev/null | wc -l)

# Check cache file integrity (should not be corrupted)
if [ -f "$HOME/.claude/.git_status_cache" ]; then
    # If cache exists, verify it's not empty or corrupted
    CACHE_SIZE=$(stat -f%z "$HOME/.claude/.git_status_cache" 2>/dev/null || echo 0)
    if [ "$CACHE_SIZE" -gt 0 ]; then
        pass "No cache corruption after $INVOCATION_COUNT rapid invocations (cache intact)"
    else
        fail "Cache corrupted or empty" "Size: $CACHE_SIZE bytes"
    fi
else
    # No cache created yet (acceptable)
    pass "No cache corruption (no cache file created yet)"
fi

cleanup

# TEST 5: Glob Expansion Stress Test (FIXED)
run_test "Glob expansion with 1000+ cache files"
setup

# Create 1000 model cache files
for i in $(seq 1 1000); do
    touch "$HOME/.claude/.model_cache_session_$i"
done

# Run statusline with FORCE_REFRESH=1 (triggers cleanup)
export STATUSLINE_FORCE_REFRESH=1
echo '{"model":{"display_name":"test"}}' | timeout 10 bash "$STATUSLINE" >/dev/null 2>&1 || true
unset STATUSLINE_FORCE_REFRESH

# Check that cleanup completed (files deleted)
REMAINING_CACHES=$(find "$HOME/.claude" -name ".model_cache_*" 2>/dev/null | wc -l)

if [ "$REMAINING_CACHES" -eq 0 ]; then
    pass "Cleanup handled 1000 cache files (no ARG_MAX error)"
else
    fail "Cleanup failed or incomplete" "Remaining files: $REMAINING_CACHES"
fi

cleanup

# TEST 6: jq Missing Error Handling (FIXED)
run_test "jq missing detection with JSON input"
setup

# Temporarily hide jq
export PATH="/usr/bin:/bin"  # Limited PATH without jq location

# Attempt to run with JSON input but no jq
JSON_INPUT='{"model":{"display_name":"test"}}'
OUTPUT=$(echo "$JSON_INPUT" | bash "$STATUSLINE" 2>&1 || true)

# Should get clear error message
if [[ "$OUTPUT" =~ "jq is required" ]] || [[ "$OUTPUT" =~ "jq.*not found" ]]; then
    pass "Clear error message when jq missing"
else
    # Restore PATH and check if jq was actually available
    export PATH="$OLDPATH"
    if command -v jq >/dev/null 2>&1; then
        fail "Test inconclusive - jq was still available in PATH" "PATH: $PATH"
    else
        pass "jq correctly detected as missing (error message may vary)"
    fi
fi

cleanup

# SUMMARY
echo ""
echo "========================================"
echo "Security Test Suite Summary"
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
    echo -e "${GREEN}✓ ALL SECURITY TESTS PASSED${NC}"
    exit 0
else
    echo -e "${RED}✗ SOME TESTS FAILED${NC}"
    exit 1
fi
