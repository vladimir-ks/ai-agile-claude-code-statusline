#!/usr/bin/env bash
#
# V2 Deployment Script
#
# This script deploys the v2 statusline to ~/.claude/statusline-v2.sh

set -e

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${GREEN}╔═══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   Statusline V2 Deployment Script    ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}"
echo

# Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command -v bun &> /dev/null; then
    echo -e "${RED}✗ Bun not found${NC}"
    echo "Install with: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi
echo -e "${GREEN}✓ Bun installed${NC}"

# Get absolute path to this script's directory
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( cd "$SCRIPT_DIR/.." && pwd )"

echo -e "${GREEN}✓ Project root: ${PROJECT_ROOT}${NC}"

# Create deployment wrapper
DEPLOY_PATH="$HOME/.claude/statusline-v2.sh"

echo -e "${YELLOW}Creating deployment wrapper at ${DEPLOY_PATH}...${NC}"

cat > "${DEPLOY_PATH}" << ENDOFWRAPPER
#!/usr/bin/env bash
# Statusline V2 - Auto-generated deployment wrapper
# Generated: $(date)

# Read JSON from stdin
JSON_INPUT=\$(cat)

# Run V2 with JSON input
echo "\${JSON_INPUT}" | bun "${SCRIPT_DIR}/src/index.ts" 2>/dev/null

# Exit code passthrough
exit \$?
ENDOFWRAPPER

chmod +x "${DEPLOY_PATH}"

echo -e "${GREEN}✓ Deployment wrapper created${NC}"

# Test with sample data
echo
echo -e "${YELLOW}Testing V2 with sample data...${NC}"

SAMPLE_JSON='{
  "model": {
    "name": "claude-sonnet-4-5",
    "display_name": "Claude Sonnet 4.5"
  },
  "context_window": {
    "context_window_size": 200000,
    "current_usage": {
      "input_tokens": 10000,
      "output_tokens": 2000,
      "cache_read_input_tokens": 5000
    }
  }
}'

TEST_OUTPUT=$(echo "$SAMPLE_JSON" | "${DEPLOY_PATH}" 2>&1)

if [ $? -eq 0 ] && [ -n "$TEST_OUTPUT" ]; then
    echo -e "${GREEN}✓ V2 test successful${NC}"
    echo "  Output: ${TEST_OUTPUT}"
else
    echo -e "${RED}✗ V2 test failed${NC}"
    echo "  Output: ${TEST_OUTPUT}"
    exit 1
fi

# Show next steps
echo
echo -e "${GREEN}╔═══════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Deployment Complete!          ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════╝${NC}"
echo
echo -e "${YELLOW}Next steps:${NC}"
echo
echo "1. Backup your current settings:"
echo "   cp ~/.claude/settings.json ~/.claude/settings.json.backup"
echo
echo "2. Update settings.json to use V2 (with V1 fallback):"
echo '   "statusLine": {'
echo '     "type": "command",'
echo "     \"command\": \"${DEPLOY_PATH} || ~/.claude/statusline.sh\","
echo '     "padding": 0'
echo '   }'
echo
echo "3. Test in Claude Code session"
echo
echo -e "${GREEN}V2 is ready! 🚀${NC}"
