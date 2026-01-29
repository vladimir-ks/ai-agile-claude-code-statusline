#!/usr/bin/env bash
# Test: Staleness indicator should NOT show red when using valid cached data

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUSLINE="$SCRIPT_DIR/../scripts/statusline.sh"
TEST_DIR="/tmp/statusline-staleness-test-$$"

echo "=== Test: Staleness Indicator with Valid Cache ==="

# Setup
mkdir -p "$TEST_DIR/.claude"
mkdir -p "$TEST_DIR/.local/bin"
export HOME="$TEST_DIR"

# Create mock ccusage that returns same-day block
TODAY=$(date +%Y-%m-%d)
cat > "$TEST_DIR/.local/bin/ccusage" <<EOF
#!/usr/bin/env bash
if [[ "\$1" == "blocks" ]]; then
    cat <<JSON
{
  "blocks": [{
    "id": "${TODAY}T12:00:00.000Z",
    "startTime": "${TODAY}T12:00:00.000Z",
    "endTime": "${TODAY}T17:00:00.000Z",
    "isActive": true,
    "entries": 100,
    "tokenCounts": {
      "inputTokens": 10000,
      "outputTokens": 5000,
      "cacheCreationInputTokens": 50000,
      "cacheReadInputTokens": 100000
    },
    "totalTokens": 165000,
    "costUSD": 5.25,
    "models": ["claude-sonnet-4-5"],
    "burnRate": {
      "tokensPerMinute": 1000,
      "costPerHour": 2.5
    },
    "projection": {
      "totalTokens": 300000,
      "totalCost": 15.0,
      "remainingMinutes": 180
    }
  }]
}
JSON
fi
EOF
chmod +x "$TEST_DIR/.local/bin/ccusage"
export PATH="$TEST_DIR/.local/bin:$PATH"

# Create sample input
cat > "$TEST_DIR/input.json" <<'EOF'
{
  "model": {
    "display_name": "Sonnet 4.5",
    "context_window": 200000
  },
  "context": {
    "budget": 200000,
    "used": 46000
  }
}
EOF

# Test 1: First run - should fetch fresh and update timestamp
echo ""
echo "Test 1: First run - fetch fresh data"
output1=$("$STATUSLINE" < "$TEST_DIR/input.json" 2>/dev/null || echo "ERROR")
if [[ "$output1" == *"🔴"* ]]; then
    echo "❌ FAIL: Red dot appeared on first fetch (should be fresh)"
    cat "$TEST_DIR/.claude/.data_freshness.json"
    exit 1
fi
echo "✓ First run: No red dot"

# Get timestamp from first run
timestamp1=$(jq -r '.ccusage_blocks' "$TEST_DIR/.claude/.data_freshness.json" 2>/dev/null)
echo "  Freshness timestamp: $timestamp1"

# Test 2: Second run 5 seconds later - should use cache and update timestamp
echo ""
echo "Test 2: Second run (5s later) - use cached data"
sleep 5
output2=$("$STATUSLINE" < "$TEST_DIR/input.json" 2>/dev/null || echo "ERROR")
if [[ "$output2" == *"🔴"* ]]; then
    echo "❌ FAIL: Red dot appeared when using valid cache"
    cat "$TEST_DIR/.claude/.data_freshness.json"
    exit 1
fi
echo "✓ Second run: No red dot"

# Check that timestamp was updated
timestamp2=$(jq -r '.ccusage_blocks' "$TEST_DIR/.claude/.data_freshness.json" 2>/dev/null)
echo "  Freshness timestamp: $timestamp2"

if [ "$timestamp1" == "$timestamp2" ]; then
    echo "❌ FAIL: Timestamp was NOT updated when using cache"
    echo "  Expected: Timestamp to be updated"
    echo "  Got: Same timestamp as first run"
    exit 1
fi
echo "✓ Timestamp updated correctly"

# Test 3: Third run after longer delay - should still use cache (same-day TTL)
echo ""
echo "Test 3: Third run (10s later) - still using cached data"
sleep 10
output3=$("$STATUSLINE" < "$TEST_DIR/input.json" 2>/dev/null || echo "ERROR")
if [[ "$output3" == *"🔴"* ]]; then
    echo "❌ FAIL: Red dot appeared when cache is still valid (same-day)"
    cat "$TEST_DIR/.claude/.data_freshness.json"
    exit 1
fi
echo "✓ Third run: No red dot"

timestamp3=$(jq -r '.ccusage_blocks' "$TEST_DIR/.claude/.data_freshness.json" 2>/dev/null)
echo "  Freshness timestamp: $timestamp3"

# Cleanup
rm -rf "$TEST_DIR"

echo ""
echo "=== ✅ All staleness tests passed ==="
echo ""
echo "Summary:"
echo "  - Fresh fetch: Timestamp recorded ✓"
echo "  - Cache hit: Timestamp updated ✓"
echo "  - Same-day cache: No false staleness indicator ✓"
