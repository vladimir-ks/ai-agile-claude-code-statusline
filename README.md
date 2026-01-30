# Claude Code Statusline V2

Real-time cost tracking and session monitoring for Claude Code. See your hourly burn rate, daily spend, token usage, and git status—all in one compact statusline.

## Features

- **Real-time cost tracking** - Cost, burn rate, tokens from ccusage
- **tmux-aware** - Auto-detects pane width for optimal display
- **Shared billing** - All sessions share billing data (no lock contention issues)
- **Fast** - Display layer is <50ms (read-only, no network calls)
- **Decoupled architecture** - Display never blocked by data gathering

## Quick Start

### Install

```bash
# Clone the repo
git clone https://github.com/anthropics/claude-code-statusline ~/.claude/statusline

# Deploy V2
cp ~/.claude/statusline/v2/src/statusline-bulletproof.sh ~/.claude/statusline-v2.sh
chmod +x ~/.claude/statusline-v2.sh
```

### Configure

Add to `~/.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline-v2.sh",
    "padding": 0
  }
}
```

### Requirements

- **bun** - `brew install oven-sh/bun/bun`
- **ccusage** - `npm install -g @anthropic-sdk/ccusage`
- **tmux** (optional, for width detection)

## Display Example

```
📁:~/project 🌿:main+12*3 🤖:Opus4.5 🧠:154kleft[---------|--] 🕐:12:06
⌛:1h53m(62%)14:00 💰:$40.3|$15.1/h 📊:83.4Mtok(521ktpm) 💾:16% 💬:42t
💬:(<5m) What does the main function do in this file?
```

### Components

| Symbol | Example | Meaning |
|--------|---------|---------|
| 📁 | ~/project | Current directory |
| 🌿 | main+12*3 | Git branch, ahead, dirty files |
| 🤖 | Opus4.5 | Active model |
| 🧠 | 154kleft | Tokens until auto-compact |
| [---\|--] | Progress bar | Context usage (| at 78% threshold) |
| 🕐 | 12:06 | Current time |
| ⌛ | 1h53m(62%)14:00 | Budget remaining, %, reset time |
| 💰 | $40.3\|$15.1/h | Daily cost \| hourly burn rate |
| 📊 | 83.4Mtok | Total tokens (tokens per minute) |
| 💾 | 16% | Cache hit ratio |
| 💬 | 42t | Turn count |
| 💬 | (<5m) msg | Last message (elapsed time) + preview |

### Indicators

| Indicator | Meaning |
|-----------|---------|
| 🔴 | Billing data is stale (ccusage not fresh) |
| ⏳ | Health data loading (new session) |
| 📝:5m⚠ | Transcript not saved in 5 minutes |

## Architecture

V2 uses a **decoupled architecture**:

1. **Display layer** (`display-only.ts`) - Fast, read-only, <50ms
   - Reads from JSON health files
   - Never makes network calls or spawns processes
   - Always outputs something (graceful degradation)

2. **Data daemon** (`data-daemon.ts`) - Background, async
   - Runs AFTER display completes
   - Updates health files for next invocation
   - Handles ccusage, git, transcript monitoring

3. **Shared billing cache** - Cross-session
   - Any successful ccusage fetch writes to shared cache
   - All sessions read from shared cache
   - Eliminates lock contention issues

## Troubleshooting

### Check daemon log
```bash
tail ~/.claude/session-health/daemon.log
```

### Force refresh billing
```bash
rm ~/.claude/session-health/billing-shared.json
```

### Verify health file
```bash
cat ~/.claude/session-health/*.json | jq '.billing'
```

## Documentation

- `v2/docs/ARCHITECTURE.md` - System architecture
- `v2/docs/VALIDATION.md` - Multi-source validation
- `v2/docs/MEMORY.md` - Memory optimization

## License

MIT

---

**Version:** 2.0.0 | **Status:** Production Ready
