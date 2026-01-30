#!/usr/bin/env bash
# Deploy Thin Statusline to ~/.claude/
#
# This creates a wrapper that:
# 1. Reads JSON from stdin
# 2. Passes to statusline-thin.ts
# 3. Suppresses errors (critical for CLI UI)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
STATUSLINE_THIN="$PROJECT_DIR/src/statusline-thin.ts"
DEPLOY_PATH="${HOME}/.claude/statusline-v3.sh"

echo "=== Deploying Thin Statusline ==="
echo "Source: $STATUSLINE_THIN"
echo "Target: $DEPLOY_PATH"
echo ""

# Verify source exists
if [[ ! -f "$STATUSLINE_THIN" ]]; then
  echo "ERROR: Source file not found: $STATUSLINE_THIN"
  exit 1
fi

# Create wrapper script
cat > "$DEPLOY_PATH" << EOF
#!/usr/bin/env bash
# Statusline V3 (Thin) - Auto-generated deployment wrapper
# Generated: $(date)
#
# Features:
# - Health-based caching (5 min for billing, real-time for context)
# - Transcript sync indicator (📝)
# - Secrets detection (🔐)
# - 28-30ms cached performance

# Read JSON from stdin
JSON_INPUT=\$(cat)

# Run thin statusline with JSON input
echo "\${JSON_INPUT}" | bun "$STATUSLINE_THIN" 2>/dev/null

# Exit code passthrough
exit \$?
EOF

chmod +x "$DEPLOY_PATH"

echo "✅ Deployed to: $DEPLOY_PATH"
echo ""
echo "To enable, add to ~/.claude/settings.json:"
echo '  "statusLine": {'
echo '    "type": "command",'
echo "    \"command\": \"$DEPLOY_PATH\","
echo '    "padding": 0'
echo '  }'
echo ""

# Test the deployment
echo "=== Testing deployment ==="
TEST_OUTPUT=$(echo '{"session_id":"deploy-test","model":{"name":"sonnet"}}' | "$DEPLOY_PATH" 2>/dev/null || echo "ERROR")

if [[ "$TEST_OUTPUT" == "ERROR" ]]; then
  echo "❌ Test failed"
  exit 1
fi

echo "Output: $TEST_OUTPUT"

# Verify no trailing newline
if [[ "$TEST_OUTPUT" =~ $'\n'$ ]]; then
  echo "❌ WARNING: Output has trailing newline (may break UI)"
else
  echo "✅ No trailing newline"
fi

echo ""
echo "=== Deployment Complete ==="
