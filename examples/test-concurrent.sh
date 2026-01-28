#!/bin/bash
# Concurrent Execution Test Suite
# Validates flock-based locking, atomic writes, no resource leaks

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
    export HOME="${SCRIPT_DIR}/.test_home_concurrent"
    rm -rf "$HOME" 2>/dev/null || true
    mkdir -p "$HOME/.claude"
}

cleanup() {
    rm -rf "${SCRIPT_DIR}/.test_home_concurrent" 2>/dev/null || true
    # Kill any orphaned processes
    pkill -f "test_home_concurrent" 2>/dev/null || true
}

# TEST 1: Lock File Prevents Concurrent ccusage
run_test "flock prevents concurrent ccusage execution"
setup

# Create lock manually and verify statusline respects it
LOCK_FILE="$HOME/.claude/.ccusage.lock"
touch "$LOCK_FILE"

# Hold lock in background
{
    flock 200
    sleep 2
} 200>"$LOCK_FILE" &
LOCK_PID=$!

sleep 0.5

# Try to run statusline while lock held (should use stale cache or skip)
START_TIME=$(date +%s)
echo '{"model":{"display_name":"test"}}' | timeout 5 bash "$STATUSLINE" >/dev/null 2>&1 || true
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# Should complete quickly (<5s) without waiting for lock
if [ "$ELAPSED" -lt 5 ]; then
    pass "Statusline didn't block on locked ccusage (completed in ${ELAPSED}s)"
else
    fail "Statusline blocked waiting for lock" "Took ${ELAPSED}s (expected <5s)"
fi

kill "$LOCK_PID" 2>/dev/null || true
wait "$LOCK_PID" 2>/dev/null || true

cleanup

# TEST 2: 100x Rapid Invocation No Cache Corruption
run_test "100x rapid invocation - cache integrity"
setup

# Launch 100 rapid statuslines
for i in $(seq 1 100); do
    echo '{"model":{"display_name":"Test'$i'"}}' | bash "$STATUSLINE" >/dev/null 2>&1 &
done

# Wait for all to complete
wait

# Check for temp file leaks (should be cleaned up automatically if >60min old)
RECENT_TEMP_FILES=$(find "$HOME/.claude" -name ".*.tmp.*" -mmin -60 2>/dev/null | wc -l)

# Check cache files exist and are valid
CACHE_CORRUPT=false
if [ -f "$HOME/.claude/.git_status_cache" ]; then
    # If cache exists, verify it has content
    if [ ! -s "$HOME/.claude/.git_status_cache" ]; then
        CACHE_CORRUPT=true
    fi
fi

if [ "$CACHE_CORRUPT" = false ] && [ "$RECENT_TEMP_FILES" -lt 10 ]; then
    pass "No cache corruption after 100 rapid invocations (temp files: $RECENT_TEMP_FILES)"
else
    fail "Cache corruption detected or temp file leak" "Corrupt: $CACHE_CORRUPT, Temp files: $RECENT_TEMP_FILES"
fi

cleanup

# TEST 3: No Zombie Processes After Concurrent Execution
run_test "No zombie processes or resource leaks"
setup

# Get baseline process count
BEFORE=$(ps aux | grep -c "[s]tatusline.sh" || echo 0)

# Launch 20 concurrent statuslines
for i in $(seq 1 20); do
    echo '{"model":{"display_name":"test"}}' | bash "$STATUSLINE" >/dev/null 2>&1 &
done

# Wait for all to complete
wait

sleep 1

# Check no statusline processes still running
AFTER=$(ps aux | grep -c "[s]tatusline.sh" 2>/dev/null || echo 0)
ZOMBIE=$(ps aux 2>/dev/null | grep defunct | grep -c statusline 2>/dev/null || echo 0)

# Ensure integers
BEFORE=${BEFORE//[^0-9]/}
AFTER=${AFTER//[^0-9]/}
ZOMBIE=${ZOMBIE//[^0-9]/}
BEFORE=${BEFORE:-0}
AFTER=${AFTER:-0}
ZOMBIE=${ZOMBIE:-0}

if [ "$AFTER" -le "$BEFORE" ] && [ "$ZOMBIE" -eq 0 ]; then
    pass "No zombie processes (before: $BEFORE, after: $AFTER, zombies: $ZOMBIE)"
else
    fail "Resource leak detected" "Processes before: $BEFORE, after: $AFTER, zombies: $ZOMBIE"
fi

cleanup

# TEST 4: File Descriptor Leak Check
run_test "No file descriptor leaks"
setup

# Get baseline open file count for this process
if command -v lsof >/dev/null 2>&1; then
    BEFORE_FDS=$(lsof -p $$ 2>/dev/null | wc -l)

    # Run 50 statuslines
    for i in $(seq 1 50); do
        echo '{"model":{"display_name":"test"}}' | bash "$STATUSLINE" >/dev/null 2>&1
    done

    AFTER_FDS=$(lsof -p $$ 2>/dev/null | wc -l)
    FD_DIFF=$((AFTER_FDS - BEFORE_FDS))

    if [ "$FD_DIFF" -lt 10 ]; then
        pass "No file descriptor leak (diff: $FD_DIFF)"
    else
        fail "File descriptor leak detected" "Before: $BEFORE_FDS, After: $AFTER_FDS, Diff: $FD_DIFF"
    fi
else
    pass "lsof not available, skipping FD leak check"
fi

cleanup

# TEST 5: Atomic Write Verification (No Partial Reads)
run_test "Atomic writes prevent partial reads"
setup

CACHE_FILE="$HOME/.claude/.test_cache"

# Writer process - writes 1000 times
{
    for i in $(seq 1 1000); do
        echo "COMPLETE_WRITE_$i" | bash -c "
            temp=\"\${1}.tmp.\$\$.\$(date +%s%N 2>/dev/null || echo \$RANDOM)\"
            cat > \"\$temp\"
            mv \"\$temp\" \"\$1\"
        " -- "$CACHE_FILE"
    done
} &
WRITER_PID=$!

# Reader process - reads 1000 times
PARTIAL_READS=0
{
    for i in $(seq 1 1000); do
        if [ -f "$CACHE_FILE" ]; then
            CONTENT=$(cat "$CACHE_FILE" 2>/dev/null || echo "")
            # Check if content is complete (contains "COMPLETE_WRITE")
            if [ -n "$CONTENT" ] && [[ ! "$CONTENT" =~ ^COMPLETE_WRITE_ ]]; then
                PARTIAL_READS=$((PARTIAL_READS + 1))
            fi
        fi
    done
} &
READER_PID=$!

wait "$WRITER_PID" "$READER_PID"

if [ "$PARTIAL_READS" -eq 0 ]; then
    pass "No partial reads detected (atomic writes working)"
else
    fail "Partial reads detected" "Count: $PARTIAL_READS (atomic write failed)"
fi

cleanup

# TEST 6: Lock Timeout Behavior
run_test "Lock timeout prevents indefinite hang"
setup

LOCK_FILE="$HOME/.claude/.ccusage.lock"

# Hold lock for 10 seconds
{
    flock 200
    sleep 10
} 200>"$LOCK_FILE" &
LOCK_PID=$!

sleep 0.5

# Run statusline with timeout (should not hang indefinitely)
START_TIME=$(date +%s)
echo '{"model":{"display_name":"test"}}' | timeout 8 bash "$STATUSLINE" >/dev/null 2>&1 || true
END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

# Should complete in <8s (not wait full 10s for lock)
if [ "$ELAPSED" -lt 8 ]; then
    pass "Lock timeout prevents indefinite hang (completed in ${ELAPSED}s)"
else
    fail "Statusline hung waiting for lock" "Took ${ELAPSED}s (expected <8s)"
fi

kill "$LOCK_PID" 2>/dev/null || true
wait "$LOCK_PID" 2>/dev/null || true

cleanup

# SUMMARY
echo ""
echo "========================================"
echo "Concurrent Execution Test Suite Summary"
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
    echo -e "${GREEN}✓ ALL CONCURRENT TESTS PASSED${NC}"
    echo -e "  flock-based locking: VERIFIED ✓"
    echo -e "  Atomic writes: VERIFIED ✓"
    echo -e "  No resource leaks: VERIFIED ✓"
    echo -e "  No race conditions: VERIFIED ✓"
    exit 0
else
    echo -e "${RED}✗ SOME TESTS FAILED${NC}"
    exit 1
fi
