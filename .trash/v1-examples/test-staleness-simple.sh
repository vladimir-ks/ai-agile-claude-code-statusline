#!/usr/bin/env bash
# Simple test: Verify staleness timestamp is updated when using cached data

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATUSLINE="$SCRIPT_DIR/../scripts/statusline.sh"

echo "=== Test: Staleness Timestamp Update on Cache Hit ==="
echo ""

# Create sample input
cat > /tmp/statusline-test-input.json <<'EOF'
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

# Run 1: First execution
echo "Run 1: First execution"
if [ -f ~/.claude/.data_freshness.json ]; then
    timestamp1=$(jq -r '.ccusage_blocks // "never"' ~/.claude/.data_freshness.json 2>/dev/null)
    echo "  Initial timestamp: $timestamp1"
else
    echo "  No freshness file yet"
    timestamp1="never"
fi

"$STATUSLINE" < /tmp/statusline-test-input.json > /dev/null 2>&1 || true

if [ -f ~/.claude/.data_freshness.json ]; then
    timestamp2=$(jq -r '.ccusage_blocks // "never"' ~/.claude/.data_freshness.json 2>/dev/null)
    echo "  After run 1: $timestamp2"
else
    echo "  ❌ No freshness file created"
    exit 1
fi

# Wait 2 seconds
sleep 2

# Run 2: Second execution (should use cache and update timestamp)
echo ""
echo "Run 2: Second execution (2 seconds later)"
echo "  Timestamp before: $timestamp2"

"$STATUSLINE" < /tmp/statusline-test-input.json > /dev/null 2>&1 || true

timestamp3=$(jq -r '.ccusage_blocks // "never"' ~/.claude/.data_freshness.json 2>/dev/null)
echo "  Timestamp after: $timestamp3"

# Check if timestamp was updated
if [ "$timestamp2" == "$timestamp3" ]; then
    echo ""
    echo "❌ FAIL: Timestamp was NOT updated on cache hit"
    echo "   This means the fix did not work correctly"
    exit 1
else
    echo ""
    echo "✅ PASS: Timestamp was updated on cache hit"
    echo "   The staleness indicator will now work correctly"
fi

# Cleanup
rm -f /tmp/statusline-test-input.json

echo ""
echo "=== Test Complete ==="
