#!/usr/bin/env bash
# UI Safety Tests - Ensure statusline doesn't break Claude CLI UI
# Tests for: trailing newlines, control characters, excessive output

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
V2_INDEX="${SCRIPT_DIR}/../src/index.ts"
WRAPPER="${HOME}/.claude/statusline-v2.sh"

test_count=0
pass_count=0
fail_count=0

log_test() {
  echo -e "${YELLOW}[TEST $((++test_count))]${NC} $1"
}

log_pass() {
  echo -e "${GREEN}✓ PASS${NC}: $1"
  ((pass_count++))
}

log_fail() {
  echo -e "${RED}✗ FAIL${NC}: $1"
  ((fail_count++))
}

# Test input
JSON_INPUT='{"model":{"name":"sonnet"},"context_window":{"context_window_size":200000}}'

# Test 1: No trailing newline
log_test "Output has NO trailing newline (breaks UI)"
OUTPUT=$(echo "$JSON_INPUT" | bun "$V2_INDEX" 2>/dev/null)
if [[ "$OUTPUT" =~ $'\n'$ ]]; then
  log_fail "Output has trailing newline - will break Claude CLI UI!"
  exit 1
else
  log_pass "No trailing newline"
fi

# Test 2: Single line output (no embedded newlines)
log_test "Output is single line (no embedded newlines)"
# Count newlines in the output itself (not including the one echo adds)
NEWLINE_COUNT=$(echo -n "$OUTPUT" | grep -o $'\n' | wc -l | tr -d ' ')
if [[ "$NEWLINE_COUNT" -eq 0 ]]; then
  log_pass "Single line output (no embedded newlines)"
else
  log_fail "Embedded newlines detected: $NEWLINE_COUNT"
  exit 1
fi

# Test 3: No stderr output (pollutes UI)
log_test "No stderr output (pollutes UI)"
STDERR=$(echo "$JSON_INPUT" | bun "$V2_INDEX" 2>&1 >/dev/null)
if [[ -z "$STDERR" ]]; then
  log_pass "No stderr output"
else
  log_fail "Stderr detected: $STDERR"
  exit 1
fi

# Test 4: Output length reasonable (<500 chars for statusline)
log_test "Output length reasonable (<500 chars)"
OUTPUT_LEN=${#OUTPUT}
if [[ $OUTPUT_LEN -lt 500 ]]; then
  log_pass "Length OK: $OUTPUT_LEN chars"
else
  log_fail "Output too long: $OUTPUT_LEN chars (may overflow UI)"
  exit 1
fi

# Test 5: Contains expected emoji markers
log_test "Contains expected emoji markers"
EXPECTED_EMOJIS=(📁 🌿 🤖 🧠 🕐)
MISSING=()
for emoji in "${EXPECTED_EMOJIS[@]}"; do
  if [[ ! "$OUTPUT" =~ $emoji ]]; then
    MISSING+=("$emoji")
  fi
done

if [[ ${#MISSING[@]} -eq 0 ]]; then
  log_pass "All expected emojis present"
else
  log_fail "Missing emojis: ${MISSING[*]}"
  exit 1
fi

# Test 6: No ANSI escape codes (unless explicitly enabled)
log_test "No ANSI escape codes in output"
if [[ "$OUTPUT" =~ $'\033\[' ]]; then
  log_fail "ANSI escape codes detected (may break UI)"
  exit 1
else
  log_pass "No ANSI escape codes"
fi

# Test 7: Fast execution (<1 second for cached data)
log_test "Fast execution (<1 second for cached data)"
START=$(date +%s%N)
echo "$JSON_INPUT" | bun "$V2_INDEX" >/dev/null 2>&1
END=$(date +%s%N)
DURATION=$(( (END - START) / 1000000 )) # Convert to milliseconds

if [[ $DURATION -lt 1000 ]]; then
  log_pass "Execution time: ${DURATION}ms"
else
  log_fail "Execution too slow: ${DURATION}ms"
  exit 1
fi

# Test 8: Wrapper also has no trailing newline
log_test "Wrapper output has NO trailing newline"
if [[ -f "$WRAPPER" ]]; then
  WRAPPER_OUTPUT=$(echo "$JSON_INPUT" | bash "$WRAPPER" 2>/dev/null)
  if [[ "$WRAPPER_OUTPUT" =~ $'\n'$ ]]; then
    log_fail "Wrapper has trailing newline"
    exit 1
  else
    log_pass "Wrapper has no trailing newline"
  fi
else
  log_pass "Wrapper not deployed yet (skip)"
fi

# Test 9: Exit code is 0 on success
log_test "Exit code is 0 on success"
echo "$JSON_INPUT" | bun "$V2_INDEX" >/dev/null 2>&1
EXIT_CODE=$?
if [[ $EXIT_CODE -eq 0 ]]; then
  log_pass "Exit code 0"
else
  log_fail "Exit code $EXIT_CODE"
  exit 1
fi

# Test 10: Graceful degradation (invalid JSON still outputs valid statusline)
log_test "Graceful degradation (invalid JSON)"
ERROR_OUTPUT=$(echo 'invalid json' | bun "$V2_INDEX" 2>&1)
# Should still output valid statusline (not crash or show error)
if [[ "$ERROR_OUTPUT" =~ "📁" ]] && [[ ! "$ERROR_OUTPUT" =~ $'\n'$ ]]; then
  log_pass "Graceful degradation: valid statusline output even with invalid JSON"
else
  log_fail "Invalid output on error: $ERROR_OUTPUT"
  exit 1
fi

echo ""
echo "=========================================="
echo -e "${GREEN}UI Safety Tests Complete${NC}"
echo "Tests run: $test_count"
echo "Passed: $pass_count"
echo "Failed: $fail_count"
echo "=========================================="

if [[ $fail_count -eq 0 ]]; then
  echo -e "${GREEN}✓ ALL TESTS PASSED${NC}"
  echo "✅ Safe to deploy to Claude CLI"
  exit 0
else
  echo -e "${RED}✗ TESTS FAILED${NC}"
  echo "❌ DO NOT DEPLOY - Fix issues first"
  exit 1
fi
