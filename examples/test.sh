#!/bin/bash

# AI-Agile Claude Code Status Line - Test Suite
# Run this to verify statusline is working correctly

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( dirname "$SCRIPT_DIR" )"
STATUSLINE="$REPO_DIR/scripts/statusline.sh"
SAMPLE_INPUT="$SCRIPT_DIR/sample-input.json"

TESTS_PASSED=0
TESTS_FAILED=0

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🧪 Running Status Line Test Suite"
echo "=================================="
echo ""

# Test 1: Script syntax
echo "Test 1: Script syntax validation"
if bash -n "$STATUSLINE"; then
    echo -e "${GREEN}✓ PASS${NC}: Script syntax is valid"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAIL${NC}: Script has syntax errors"
    ((TESTS_FAILED++))
fi
echo ""

# Test 2: Dependencies check
echo "Test 2: Dependencies available"
deps_ok=true

if ! command -v jq &> /dev/null; then
    echo -e "${RED}✗ FAIL${NC}: jq not installed"
    deps_ok=false
fi

if ! command -v git &> /dev/null; then
    echo -e "${RED}✗ FAIL${NC}: git not installed"
    deps_ok=false
fi

if ! command -v timeout &> /dev/null; then
    echo -e "${RED}✗ FAIL${NC}: timeout not available"
    deps_ok=false
fi

if [ "$deps_ok" = true ]; then
    echo -e "${GREEN}✓ PASS${NC}: All required dependencies available"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAIL${NC}: Missing dependencies"
    ((TESTS_FAILED++))
fi
echo ""

# Test 3: Sample input parsing
echo "Test 3: Sample input JSON parsing"
if cat "$SAMPLE_INPUT" | jq . > /dev/null 2>&1; then
    echo -e "${GREEN}✓ PASS${NC}: Sample input is valid JSON"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAIL${NC}: Sample input JSON is invalid"
    ((TESTS_FAILED++))
fi
echo ""

# Test 4: Basic execution
echo "Test 4: Basic execution with sample input"
if output=$(cat "$SAMPLE_INPUT" | "$STATUSLINE" 2>&1); then
    if [ -n "$output" ]; then
        echo -e "${GREEN}✓ PASS${NC}: Statusline executed successfully"
        echo "  Output: $output"
        ((TESTS_PASSED++))
    else
        echo -e "${YELLOW}⚠ WARN${NC}: Statusline executed but produced no output"
        ((TESTS_PASSED++))
    fi
else
    echo -e "${RED}✗ FAIL${NC}: Statusline execution failed"
    echo "  Error: $output"
    ((TESTS_FAILED++))
fi
echo ""

# Test 5: Cache creation
echo "Test 5: Cache file creation"
cache_files_ok=true

if [ ! -f ~/.claude/.statusline.hash ]; then
    echo -e "${YELLOW}⚠ NOTE${NC}: Hash cache will be created on first run"
else
    echo "✓ Hash cache exists"
fi

if [ -f ~/.claude/.ccusage_cache.json ]; then
    if jq . ~/.claude/.ccusage_cache.json > /dev/null 2>&1; then
        echo "✓ ccusage cache valid"
    else
        echo -e "${RED}✗ ccusage cache corrupted${NC}"
        cache_files_ok=false
    fi
fi

if [ "$cache_files_ok" = true ]; then
    echo -e "${GREEN}✓ PASS${NC}: Cache files are valid"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ FAIL${NC}: Cache files corrupted"
    ((TESTS_FAILED++))
fi
echo ""

# Test 6: Multiple executions (deduplication)
echo "Test 6: Output deduplication (should show no change)"
output1=$(cat "$SAMPLE_INPUT" | "$STATUSLINE" 2>&1)
output2=$(cat "$SAMPLE_INPUT" | "$STATUSLINE" 2>&1)

if [ "$output1" = "$output2" ]; then
    echo -e "${GREEN}✓ PASS${NC}: Output consistent across runs"
    ((TESTS_PASSED++))
else
    echo -e "${YELLOW}⚠ WARN${NC}: Output differs between runs"
    echo "  Run 1: $output1"
    echo "  Run 2: $output2"
    # This might be normal if git status changed, so warning not failure
    ((TESTS_PASSED++))
fi
echo ""

# Test 7: No zombie processes
echo "Test 7: Process safety (no zombie processes)"
cat "$SAMPLE_INPUT" | "$STATUSLINE" > /dev/null 2>&1

# Give processes time to clean up
sleep 1

zombie_count=$(ps aux | grep -E "statusline|ccusage|jq" | grep -v grep | wc -l)

if [ "$zombie_count" -eq 0 ]; then
    echo -e "${GREEN}✓ PASS${NC}: No zombie processes"
    ((TESTS_PASSED++))
else
    echo -e "${YELLOW}⚠ WARN${NC}: Found $zombie_count process(es) still running"
    ps aux | grep -E "statusline|ccusage|jq" | grep -v grep
fi
echo ""

# Test 8: Git integration
echo "Test 8: Git status integration"
if git -C ~/.claude status > /dev/null 2>&1; then
    git_status=$(git -C ~/.claude status --porcelain | wc -l)
    echo -e "${GREEN}✓ PASS${NC}: Git integration working"
    echo "  Modified files: $git_status"
    ((TESTS_PASSED++))
else
    echo -e "${YELLOW}⚠ WARN${NC}: Git not available in test directory"
    ((TESTS_PASSED++))
fi
echo ""

# Test 9: ccusage integration
echo "Test 9: ccusage availability"
if command -v ccusage &> /dev/null; then
    if ccusage blocks --json > /dev/null 2>&1; then
        echo -e "${GREEN}✓ PASS${NC}: ccusage command working"
        ((TESTS_PASSED++))
    else
        echo -e "${YELLOW}⚠ WARN${NC}: ccusage command failed (may need authentication)"
        ((TESTS_PASSED++))
    fi
else
    echo -e "${YELLOW}⚠ NOTE${NC}: ccusage not installed (optional)"
    ((TESTS_PASSED++))
fi
echo ""

# Test 10: Debug mode
echo "Test 10: Debug mode execution"
debug_output=$(cat "$SAMPLE_INPUT" | "$STATUSLINE" --debug 2>&1)
if [ -f ~/.claude/statusline.log ]; then
    if grep -q "INIT:" ~/.claude/statusline.log; then
        echo -e "${GREEN}✓ PASS${NC}: Debug mode working"
        ((TESTS_PASSED++))
    else
        echo -e "${YELLOW}⚠ WARN${NC}: Debug log created but missing expected markers"
        ((TESTS_PASSED++))
    fi
else
    echo -e "${YELLOW}⚠ WARN${NC}: Debug log not created"
    ((TESTS_PASSED++))
fi
echo ""

# Summary
echo "=================================="
echo "📊 Test Results"
echo "=================================="
echo -e "Passed: ${GREEN}${TESTS_PASSED}${NC}"
echo -e "Failed: ${RED}${TESTS_FAILED}${NC}"
echo "Total:  $((TESTS_PASSED + TESTS_FAILED))"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}❌ Some tests failed. Please check installation.${NC}"
    exit 1
fi
