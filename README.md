# aigile - Claude Code Status Line

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Version: 1.0.1](https://img.shields.io/badge/Version-1.0.1-green.svg)
![Status: Production Ready](https://img.shields.io/badge/Status-Production%20Ready-brightgreen.svg)

Real-time cost tracking and session monitoring for Claude Code. See your hourly burn rate, daily spend, token usage, and git status—all in one compact line. No flickering. Sub-100ms response time.

## Quick Start

### Install
```bash
git clone https://github.com/anthropics/aigile ~/_dev_tools/aigile
cp ~/_dev_tools/aigile/scripts/statusline.sh ~/.claude/statusline.sh
chmod +x ~/.claude/statusline.sh
```

### Configure
Add to `~/.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "padding": 0
  }
}
```

### Requirements
- **bash** 4.0+
- **jq** - `brew install jq`
- **ccusage** - `npm install -g @anthropic-sdk/ccusage`
- **git** (for status tracking)

### Verify
```bash
bash -n ~/.claude/statusline.sh
cat ~/_dev_tools/aigile/examples/sample-input.json | ~/.claude/statusline.sh
```

## Display Example

```
📁:~/.claude 🌿:main+12/-0*1 🤖:Haiku4.5 📟:v1.0 🧠:154kleft [---------|--]
🕐:12:06 ⌛:1h53m(62%)14:00 💰:$40.3|$15.1/h 📊:83.4Mtok(521ktpm) 💾:16%
```

### What Each Component Shows

| Symbol | Example | Meaning |
|--------|---------|---------|
| 📁 | ~/.claude | Current directory |
| 🌿 | main+12/-0*1 | Git branch, ahead/behind, dirty files |
| 🤖 | Haiku4.5 | Active model |
| 📟 | v1.0 | Claude Code version |
| 🧠 | 154kleft | Tokens until auto-compact (78% threshold) |
| [---\|--] | Progress bar | Position towards compact trigger |
| 🕐 | 12:06 | Current time |
| ⌛ | 1h53m(62%)14:00 | Hours left, session %, reset time (UTC) |
| 💰 | $40.3\|$15.1/h | Daily spend \| hourly burn rate |
| 📊 | 83.4Mtok(521ktpm) | Total tokens, tokens per minute |
| 💾 | 16% | Cache hit ratio |
| 🔴 | (red dot) | Data >1 hour stale |

## Features

- ✅ **Real-time cost tracking** - Burn rate updates every interaction
- ✅ **No flicker** - Hash-based deduplication (only updates on data changes)
- ✅ **Fast** - Sub-100ms on cache hits, ~20s first fetch per day
- ✅ **Safe** - 100% synchronous, atomic writes, no background processes
- ✅ **Cross-platform** - macOS, Linux, BSD support

## Configuration

### Budget Tracking
```bash
export WEEKLY_BUDGET=500  # Set your weekly budget (default $456)
```

### Debug Mode
```bash
~/.claude/statusline.sh --debug
tail ~/.claude/statusline.log
```

## Troubleshooting

### Statusline is blank
```bash
# Check dependencies
jq --version
ccusage --version
git --version
```

### Old cost still showing
```bash
rm ~/.claude/.ccusage_cache.json
rm ~/.claude/.data_freshness.json
```

### Red dot (🔴) appears
Data is >1 hour stale. Check if ccusage is working:
```bash
ccusage blocks --json
```

### Model switching is slow
Clear model cache:
```bash
rm ~/.claude/.last_model_name
```

### Rapid blinking/flickering
Rate-limited to 100ms. Enable debug mode to see which field is changing.

### 20-second freeze on startup
Normal - first ccusage fetch of the day (happens once at UTC midnight).

## Testing

```bash
# Run syntax check
bash -n ~/.claude/statusline.sh

# Test with sample input
cat ~/_dev_tools/aigile/examples/sample-input.json | ~/.claude/statusline.sh

# Full test suite
~/_dev_tools/aigile/examples/test.sh
```

## Performance

| Scenario | Time |
|----------|------|
| Normal (cache hit) | ~10-15ms |
| First fetch (cache miss) | ~17-20s |
| Memory | <5 MB |
| CPU | <1% (I/O bound) |

## Documentation

- **[CLAUDE.md](CLAUDE.md)** - Complete technical reference
- See subdirectory `docs/` for architecture, cache management, process safety, and additional troubleshooting

## Contributing

All changes must:
- Pass: `bash -n statusline.sh`
- No background processes
- Use timeouts on external commands
- Use atomic file writes
- Include tests in `examples/test.sh`

## Process Safety

✅ No background processes
✅ All commands have timeouts
✅ Atomic file operations
✅ No orphaned processes
✅ Safe error handling

Verify:
```bash
ps aux | grep statusline | grep -v grep  # Should be empty
ps aux | grep ccusage | grep -v grep     # Should be empty
```

## License

Dependencies:
- **ccusage** - MIT License
- **jq** - CC0 1.0 Universal
- **Bash** - GPL v3

---

**Version:** 1.0.1 | **Status:** Production Ready ✅ | **Updated:** 2026-01-15
