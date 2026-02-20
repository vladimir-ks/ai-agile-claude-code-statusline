#!/usr/bin/env bash
# install-quota-refresh.sh - Install launchd agent for scheduled quota refresh
#
# Creates and loads a macOS launchd agent that runs quota-broker.sh --background
# every 5 minutes. Also fixes the cron job to not swallow errors.
#
# Usage: ./install-quota-refresh.sh [--uninstall]
#
# Idempotent: safe to run multiple times.

set -euo pipefail

PLIST_LABEL="com.claude.quota-refresh"
PLIST_PATH="$HOME/Library/LaunchAgents/${PLIST_LABEL}.plist"
SCRIPTS_DIR="$HOME/_claude-configs/hot-swap/scripts"
LOG_DIR="$HOME/.claude/session-health"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Uninstall mode
if [[ "${1:-}" == "--uninstall" ]]; then
  echo -e "${YELLOW}Uninstalling quota refresh agent...${NC}"
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || \
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
  rm -f "$PLIST_PATH"
  echo -e "${GREEN}Done. Agent removed.${NC}"
  exit 0
fi

# Verify dependencies
if [[ ! -f "$SCRIPTS_DIR/quota-broker.sh" ]]; then
  echo -e "${RED}Error: quota-broker.sh not found at $SCRIPTS_DIR${NC}" >&2
  exit 1
fi

# Ensure directories exist
mkdir -p "$HOME/Library/LaunchAgents"
mkdir -p "$LOG_DIR"

# Unload existing agent if present (idempotent)
if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
  echo -e "${YELLOW}Unloading existing agent...${NC}"
  launchctl bootout "gui/$(id -u)/${PLIST_LABEL}" 2>/dev/null || \
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

# Create the plist
cat > "$PLIST_PATH" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${SCRIPTS_DIR}/quota-broker.sh</string>
        <string>--background</string>
    </array>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/quota-refresh.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/quota-refresh-error.log</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>

    <key>ProcessType</key>
    <string>Background</string>

    <key>Nice</key>
    <integer>10</integer>

    <key>ThrottleInterval</key>
    <integer>60</integer>
</dict>
</plist>
PLIST

echo -e "${GREEN}Created: $PLIST_PATH${NC}"

# Load the agent
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null || \
  launchctl load "$PLIST_PATH" 2>/dev/null

echo -e "${GREEN}Loaded: $PLIST_LABEL${NC}"

# Verify
if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
  echo -e "${GREEN}✓ Agent is running${NC}"
else
  echo -e "${YELLOW}⚠ Agent loaded but not visible in launchctl list (may start on next interval)${NC}"
fi

# Fix cron job: stop swallowing errors
echo ""
echo -e "${YELLOW}Checking cron job...${NC}"
current_cron=$(crontab -l 2>/dev/null || echo "")
if echo "$current_cron" | grep -q "refresh-token.sh.*>/dev/null 2>&1"; then
  echo -e "${YELLOW}  Fixing cron: removing >/dev/null 2>&1 (errors were hidden)${NC}"
  new_cron=$(echo "$current_cron" | sed 's|refresh-token.sh --daemon >/dev/null 2>&1|refresh-token.sh --daemon 2>>'$LOG_DIR'/token-refresh-error.log|')
  echo "$new_cron" | crontab -
  echo -e "${GREEN}  ✓ Cron updated: errors now logged to $LOG_DIR/token-refresh-error.log${NC}"
elif echo "$current_cron" | grep -q "refresh-token.sh"; then
  echo -e "${GREEN}  ✓ Cron entry exists (errors not swallowed)${NC}"
else
  echo -e "${YELLOW}  No cron entry for refresh-token.sh${NC}"
fi

echo ""
echo -e "${GREEN}=== Installation Complete ===${NC}"
echo "  Agent:    $PLIST_LABEL (every 5 min)"
echo "  Logs:     $LOG_DIR/quota-refresh*.log"
echo "  Heartbeat: $LOG_DIR/quota-heartbeat.json"
echo ""
echo "  Manual trigger: launchctl start $PLIST_LABEL"
echo "  Uninstall:      $(basename "$0") --uninstall"
