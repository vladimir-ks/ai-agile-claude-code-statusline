#!/bin/bash

# AI-Agile Claude Code Status Line - Installation Script
# This script sets up the statusline hook for Claude Code

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( dirname "$SCRIPT_DIR" )"
CLAUDE_DIR="${HOME}/.claude"
STATUSLINE_SCRIPT="${REPO_DIR}/scripts/statusline.sh"
INSTALL_PATH="${CLAUDE_DIR}/statusline.sh"

echo "🚀 Installing AI-Agile Claude Code Status Line..."
echo ""

# Step 1: Check requirements
echo "📋 Checking requirements..."

if ! command -v bash &> /dev/null; then
    echo "❌ bash not found (need bash 4.0+)"
    exit 1
fi

bash_version=$(bash --version | head -1)
echo "✓ bash installed: $bash_version"

if ! command -v jq &> /dev/null; then
    echo "❌ jq not found. Install with: brew install jq"
    exit 1
fi

echo "✓ jq installed: $(jq --version)"

if ! command -v ccusage &> /dev/null; then
    echo "⚠️  ccusage not found. Install with: npm install -g @anthropic-sdk/ccusage"
    echo "   Without ccusage, cost tracking will not work."
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
else
    echo "✓ ccusage installed: $(ccusage --version 2>/dev/null || echo 'v?.?.?')"
fi

if ! command -v git &> /dev/null; then
    echo "❌ git not found"
    exit 1
fi

echo "✓ git installed: $(git --version)"

echo ""

# Step 2: Create .claude directory if needed
echo "📁 Setting up directories..."

if [ ! -d "$CLAUDE_DIR" ]; then
    mkdir -p "$CLAUDE_DIR"
    echo "✓ Created $CLAUDE_DIR"
else
    echo "✓ $CLAUDE_DIR exists"
fi

echo ""

# Step 3: Install statusline.sh
echo "📝 Installing statusline.sh..."

if [ ! -f "$STATUSLINE_SCRIPT" ]; then
    echo "❌ Source script not found: $STATUSLINE_SCRIPT"
    exit 1
fi

cp "$STATUSLINE_SCRIPT" "$INSTALL_PATH"
chmod +x "$INSTALL_PATH"

echo "✓ Installed to: $INSTALL_PATH"

# Verify syntax
if ! bash -n "$INSTALL_PATH"; then
    echo "❌ Script has syntax errors"
    exit 1
fi

echo "✓ Script syntax validated"

echo ""

# Step 4: Test execution
echo "🧪 Testing execution..."

if echo '{"cwd": "/tmp", "workspace": {"current_dir": "/tmp", "project_dir": "/tmp"}, "model": {"display_name": "Test", "id": "test"}, "session_id": "test", "transcript_path": "/tmp/t.jsonl", "version": "1.0", "context_window": {"context_window_size": 200000, "total_input_tokens": 0, "total_output_tokens": 0, "current_usage": {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}}' | "$INSTALL_PATH" > /dev/null 2>&1; then
    echo "✓ Test execution successful"
else
    echo "⚠️  Test execution had issues, but continuing..."
fi

echo ""

# Step 5: Configure Claude Code settings
echo "⚙️  Configuring Claude Code hook..."

SETTINGS_FILE="${CLAUDE_DIR}/settings.json"

if [ ! -f "$SETTINGS_FILE" ]; then
    echo "📝 Creating settings.json..."
    mkdir -p "$(dirname "$SETTINGS_FILE")"
    cat > "$SETTINGS_FILE" << 'EOF'
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "padding": 0
  }
}
EOF
    echo "✓ Created settings.json"
else
    if grep -q '"statusLine"' "$SETTINGS_FILE"; then
        echo "✓ statusLine already configured in settings.json"
    else
        echo "⚠️  Please manually add statusLine configuration to $SETTINGS_FILE:"
        cat << 'EOF'

  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "padding": 0
  }
EOF
    fi
fi

echo ""

# Step 6: Summary
echo "✅ Installation complete!"
echo ""
echo "📋 Next steps:"
echo "  1. Restart Claude Code (or reload settings)"
echo "  2. Run a command and verify statusline appears"
echo "  3. Check for cost data (💰 component)"
echo ""
echo "🔧 Optional configuration:"
echo "  • Set custom budget: export WEEKLY_BUDGET=500"
echo "  • Enable debug logs: ~/.claude/statusline.sh --debug"
echo ""
echo "📚 Documentation:"
echo "  • README:          $REPO_DIR/README.md"
echo "  • Architecture:    $REPO_DIR/docs/ARCHITECTURE.md"
echo "  • Troubleshooting: $REPO_DIR/docs/TROUBLESHOOTING.md"
echo ""
echo "✨ Status line should now appear on every Claude Code interaction!"
