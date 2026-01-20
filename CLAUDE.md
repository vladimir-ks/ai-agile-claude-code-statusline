---
metadata:
  status: approved
  purpose: "aigile - Real-time status monitoring for Claude Code sessions"
  version: "1.0.0"
  author: "Vladimir K.S."
  last_updated: "2026-01-15"
  requires:
    - bash 4.0+
    - jq
    - ccusage
    - git
---

# aigile - Claude Code Status Line

A production-ready status line for Claude Code displaying real-time session metrics, costs, context usage, and git status.

**Display Example:**
```
📁:~/.claude 🌿:main+12/-0*1 🤖:Haiku4.5 📟:v1.0 🧠:154kleft [---------|--]
🕐:12:06 ⌛:1h53m(62%)14:00 💰:$40.3|$15.1/h 📊:83.4Mtok(521ktpm) 💾:16%
```

---

## Quick Start

### Install
```bash
cp scripts/statusline.sh ~/.claude/statusline.sh
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

### Optional Environment Variables
```bash
export WEEKLY_BUDGET=500                    # Set your weekly budget (default $456)
export STATUSLINE_FORCE_REFRESH=1          # Force cache refresh (bypasses all caches)
export NO_COLOR=1                          # Disable colored output

~/.claude/statusline.sh --debug            # Enable debug logs
```

---

## Display Components

| Component | Format | Meaning |
|-----------|--------|---------|
| 📁 | `~/.claude` | Current directory |
| 🌿 | `main+12/-0*1` | Git branch, ahead/behind, dirty files |
| 🤖 | `Haiku4.5` | Active model |
| 📟 | `v1.0` | Claude Code version |
| 🧠 | `154kleft [---\|--]` | Tokens until compact (78% threshold) |
| 🕐 | `12:06` | Current time |
| ⌛ | `1h53m(62%)14:00` | Hours left, session %, reset time (UTC) |
| 💰 | `$40.3\|$15.1/h` | Daily cost \| hourly burn rate |
| 📊 | `83.4Mtok(521ktpm)` | Total tokens (tokens per minute) |
| 💾 | `16%` | Cache hit ratio |
| 💬 | `14:30(2h43m) What is...` | Last message time (elapsed), preview |

**Staleness Indicator:** 🔴 appears when data >1 hour old

---

## Architecture

### Data Sources (Priority Order)
The statusline intelligently selects data sources with smart fallback logic:

1. **JSON input** (instant, freshest): Model, context window, session ID
2. **settings.json** (stable global config): Fallback model if JSON unavailable
3. **Git cache** (10s TTL): Branch, commits, dirty files
4. **ccusage cache** (15 min TTL): Costs, tokens, burn rate
5. **Transcript** (1 hour TTL): Conversation turns, model fallback only if fresh
6. **Default values** (safe fallback): Prevents blank/missing data

**Model Detection Priority:** JSON → settings.json → Transcript (if fresh) → "Claude"
- Prevents stale transcript data from overriding stable settings.json
- Transcript data only used if file modified <1 hour ago
- Use `STATUSLINE_FORCE_REFRESH=1` to bypass all caches

### Cache Files
| File | TTL | Purpose |
|------|-----|---------|
| `.ccusage_cache.json` | 15 min | Billing data |
| `.git_status_cache` | 10 sec | Git status (refreshes frequently) |
| `.last_model_name` | ∞ (monitored) | Model name for change detection; ignored if stale settings.json avoids it |
| `.data_freshness.json` | — | Fetch timestamps for staleness indicators |
| `.statusline.hash` | ∞ | Output deduplication (prevents duplicate redraws) |
| `.statusline.last_print_time` | — | Rate limiting (100ms minimum between prints) |

**Note:** Transcript data has implicit 1-hour TTL (not a file—validation at runtime)

### Safety
- No background processes (100% synchronous)
- Timeouts: ccusage (20s), jq (2s), git (implicit)
- Atomic writes: temp file → rename
- Error suppression with sensible fallbacks

---

## Troubleshooting

### Statusline is blank
Check dependencies: `jq --version`, `ccusage --version`, `git --version`

### Old costs displayed
Cache not invalidating:
```bash
rm ~/.claude/.ccusage_cache.json
rm ~/.claude/.data_freshness.json
```

### Red dot (🔴) appears
Data >1 hour stale:
```bash
ccusage blocks --json          # Check ccusage works
~/.claude/statusline.sh --debug # Enable debug logs
```

### 20 second freeze on startup
First ccusage fetch (happens once daily at UTC midnight). Expected behavior.

### Model switching slow or not updating
The statusline now intelligently prioritizes model data sources:
1. **JSON input** (if Claude Code provides it - most current)
2. **settings.json** (stable global config - default fallback)
3. **Transcript** (only if file modified <1 hour ago)
4. **Default** ("Claude" as last resort)

If you see stale model data, trigger a force refresh:
```bash
STATUSLINE_FORCE_REFRESH=1 claude ask "hello"
```

Or temporarily in settings.json:
```json
{
  "statusLine": {
    "type": "command",
    "command": "STATUSLINE_FORCE_REFRESH=1 /Users/vmks/_dev_tools/ai-agile-claude-code-statusline/scripts/statusline.sh",
    "padding": 0
  }
}
```

**Auto-Healing:** Transcript data automatically expires after 1 hour. Stale cache won't persist indefinitely.

### Rapid blinking/flickering
Rate-limited to 100ms minimum between updates. If still blinking:
- Enable debug: `~/.claude/statusline.sh --debug`
- Check: Which field is changing rapidly?
- Verify: `~/.claude/.statusline.hash` exists and updates

---

## Performance

**Normal (cache hit):** ~10-15ms
**First fetch (cache miss):** ~17-20s (expected at UTC midnight)
**Resource usage:** <5 MB memory, <1% CPU (I/O bound)

---

## Development

### Test syntax
```bash
bash -n ~/.claude/statusline.sh
```

### Debug output
```bash
~/.claude/statusline.sh --debug
tail ~/.claude/statusline.log
```

### Requirements for changes
- All changes pass: `bash -n statusline.sh`
- No background processes
- All external commands have timeouts
- All file writes must be atomic
- Add tests to `examples/test.sh`

---

## Links

- **Source:** `scripts/statusline.sh`
- **Examples:** `examples/sample-input.json`
- **Tests:** `examples/test.sh`
- **License:** Respects licenses of dependencies (ccusage: MIT, jq: CC0, Bash: GPL v3)

---

**Version:** 1.0.0 | **Author:** Vladimir K.S. | **Status:** Production Ready ✅
