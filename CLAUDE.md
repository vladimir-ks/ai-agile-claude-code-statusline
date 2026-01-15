---
metadata:
  status: approved
  purpose: "AI-Agile Claude Code Status Line - Production-ready monitoring dashboard for Claude Code sessions"
  version: "1.0.0"
  author: "Vladimir K.S."
  last_updated: "2026-01-15"
  requires:
    - bash 4.0+
    - jq (JSON query tool)
    - ccusage (Claude usage tracker)
    - timeout (coreutils)
    - git (for status tracking)
  keywords:
    - statusline
    - claude-code
    - monitoring
    - session-tracking
    - budget-management
    - cache-management
---

# AI-Agile Claude Code Status Line

## Overview

A **production-ready, bulletproof status line system** for Claude Code that displays real-time session metrics, cost tracking, context window usage, and git status in a single, compact line. Designed for continuous integration with Claude Code hooks while maintaining strict process safety and resource efficiency.

**Current Display Example:**
```
📁:~/.claude 🌿:main+12/-0*1 🤖:Haiku4.5 📟:v1.0 🧠:154kleft [---------|--]
🕐:12:06 ⌛:1h53m(62%)14:00 💰:$40.3|$15.1/h 📊:83.4Mtok(521ktpm) 💾:16%
```

---

## Key Features

### ✅ Real-Time Monitoring
- **Event-driven updates**: Triggers on every Claude Code interaction (not polling)
- **Sub-100ms response**: Cached data makes most calls instant
- **Fresh data detection**: Automatically detects when session blocks end and forces refresh

### ✅ Multi-Level Caching
- **Git status**: 10-second cache (tight for rapid changes)
- **Financial data**: 15-minute cache with temporal validation
- **Context window**: Always fresh (from JSON input)
- **Conversation metrics**: Real-time calculation from transcript

### ✅ Staleness Tracking
- **🔴 Red dots**: Appear when data is >1 hour stale
- **Atomic writes**: Prevent cache corruption during concurrent updates
- **Safe fallbacks**: Returns sensible defaults on all errors

### ✅ Process Safety (CRITICAL)
- **No background processes**: Statusline is 100% synchronous
- **Timeouts on all commands**: ccusage (20s), jq (2s), git (implicit)
- **No `&` spawning**: Never creates orphaned processes
- **Error suppression**: All stderr redirected to `/dev/null`
- **Atomic file operations**: Temp file → rename, never direct writes

### ✅ Resilience
- **Silent error handling**: Graceful degradation on any failure
- **Defensive validation**: Null checks on all jq outputs
- **Fallback messaging**: Shows "[loading...]" instead of disappearing
- **Cross-platform support**: Works on macOS, Linux, BSD date variations

---

## Architecture

### Data Flow

```
Claude Code CLI (trigger)
    ↓
statusline.sh invoked (hook)
    ↓
1. Parse JSON input → workspace, model, context window
2. Git status → branch, ahead/behind, dirty count
3. ccusage blocks → cost, burn rate, tokens, session time
4. Context window → tokens used, remaining until compact
5. Transcript → conversation turns, velocity, efficiency
6. AIGILE metadata → project, sprint, task info
7. Last prompt → message time, text preview
    ↓
8. Build display string with all fields
9. Calculate MD5 hash of output
10. Compare vs last hash
11. If changed → print output, save hash
12. If identical → skip print (anti-flicker)
    ↓
Output to terminal
```

### Cache Files

| Cache File | TTL | Purpose | Validation |
|-----------|-----|---------|-----------|
| `.ccusage_cache.json` | 15 min | Billing blocks, cost, tokens, burn rate | Checks startTime matches today's date |
| `.weekly_quota_cache.json` | 30 min | Weekly cost aggregation (legacy) | Validates array structure exists |
| `.git_status_cache` | 10 sec | Branch, commits, dirty count | Auto-refresh on timeout |
| `.data_freshness.json` | N/A | Timestamps when data was last fetched | Used for 1h staleness indicator |
| `.statusline.hash` | N/A | MD5 of last output for deduplication | Prevents terminal flicker |

### Process Execution Model

**Safe Execution Pattern:**
```bash
# Always use timeout for external commands
blocks_output=$(timeout 20 "$CCUSAGE_CMD" blocks --json 2>/dev/null)

# Validate output before using
if [ -n "$blocks_output" ]; then
    # Process safely with defensive checks
fi

# Atomic cache writes
echo "$content" > "$file.tmp.$$" 2>/dev/null && \
mv "$file.tmp.$$" "$file" 2>/dev/null || true
```

---

## Installation & Usage

### Requirements

```bash
# Verify dependencies
bash --version          # Need 4.0+
jq --version           # JSON parsing
ccusage --version      # Usage tracking (npm: @anthropic-sdk/ccusage)
git --version          # Status tracking
which timeout          # Bash timeout builtin or coreutils
```

### Setup

1. **Copy script to your Claude Code directory:**
   ```bash
   cp scripts/statusline.sh ~/.claude/statusline.sh
   chmod +x ~/.claude/statusline.sh
   ```

2. **Configure as Claude Code hook in `settings.json`:**
   ```json
   {
     "statusLine": {
       "type": "command",
       "command": "~/.claude/statusline.sh",
       "padding": 0
     }
   }
   ```

3. **Optional: Set weekly budget (default $456):**
   ```bash
   export WEEKLY_BUDGET=500  # Your budget in dollars
   ```

4. **Optional: Enable debug mode:**
   ```bash
   ~/.claude/statusline.sh --debug
   # Outputs to ~/.claude/statusline.log
   ```

### Verification

```bash
# Test script syntax
bash -n ~/.claude/statusline.sh

# Test execution with sample input
echo '{
  "cwd": "/path/to/project",
  "workspace": {"current_dir": "/path/to/project", "project_dir": "/path/to/project"},
  "model": {"display_name": "Haiku4.5", "id": "claude-haiku-4-5-20251001"},
  "session_id": "test",
  "transcript_path": "/path/to/transcript.jsonl",
  "version": "1.0",
  "context_window": {
    "context_window_size": 200000,
    "total_input_tokens": 10000,
    "total_output_tokens": 5000,
    "current_usage": {
      "input_tokens": 1000,
      "output_tokens": 500,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 200
    }
  }
}' | ~/.claude/statusline.sh
```

---

## Display Breakdown

### Component 1: System Core
```
📁:~/.claude 🌿:main+12/-0*1 🤖:Haiku4.5 📟:v1.0
```
- **📁**: Current directory
- **🌿**: Git branch + commits ahead/behind + dirty file count
- **🤖**: Active model name
- **📟**: Claude Code version

### Component 2: Context & Time
```
🧠:154kleft [---------|--] 🕐:12:06
```
- **🧠**: Tokens remaining before compact threshold (78%)
- **[---------|--]**: Progress bar with | showing compact trigger point
- **🕐**: Current time (HH:MM format)

### Component 3: Session Info
```
⌛:1h53m(62%)14:00
```
- **⌛**: Hours remaining until usage window resets
- **62%**: Percentage of session elapsed
- **14:00**: Time when session resets (UTC)
- **🔴** (if appears): Data is >1 hour stale

### Component 4: Financial
```
💰:$40.3|$15.1/h
```
- **💰**: Daily session cost | Hourly burn rate
- **🔴** (if appears): Cost data >1 hour stale

### Component 5: Usage Metrics
```
📊:83.4Mtok(521ktpm)
```
- **📊**: Total tokens in session (521ktpm = tokens per minute)

### Component 6: Health
```
💾:16%
```
- **💾**: Cache hit ratio (% of tokens from cache vs fresh)

### Component 7: Last Message (Optional)
```
💬:14:30(2h43m) What is...
```
- **💬**: Time last user message was sent (HH:MM) + elapsed time
- **What is...**: Truncated message preview (first 60 chars)

---

## Maintenance & Troubleshooting

### Cache Management

**View cache status:**
```bash
ls -lah ~/.claude/.ccusage_cache.json
ls -lah ~/.claude/.data_freshness.json
cat ~/.claude/.data_freshness.json | jq .
```

**Force fresh data fetch:**
```bash
# Delete cache to force immediate refresh on next statusline call
rm ~/.claude/.ccusage_cache.json
rm ~/.claude/.data_freshness.json

# Next statusline call will fetch fresh data (may take 20 seconds)
```

**Check data staleness:**
```bash
# If you see 🔴 red dot, it means data is >1 hour old
# Causes:
# - ccusage command is slow or unavailable
# - Network issues preventing fresh fetch
# - Cache TTL expired and refresh failed

# Remedies:
# 1. Check ccusage availability: ccusage blocks --json
# 2. Check network: curl -I https://api.anthropic.com
# 3. Check logs: cat ~/.claude/statusline.log (if --debug enabled)
```

### Debug Mode

**Enable detailed logging:**
```bash
# One-time debug run
~/.claude/statusline.sh --debug

# Check output
tail -50 ~/.claude/statusline.log
```

**Log includes:**
- Input JSON parsing results
- Git status extraction
- Cache hits/misses
- Data freshness timestamps
- Model detection (4-layer fallback info)

### Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| **Statusline blank** | jq not installed | `brew install jq` |
| **Old cost displayed** | Cache not invalidating | Delete `.ccusage_cache.json` and restart |
| **💬 line disappears** | Session file missing | Normal during first 10s of session, will reappear |
| **Red dots (🔴) appear** | Data >1h stale | Check ccusage availability, may need `ccusage blocks --json` |
| **20s freeze on startup** | First ccusage fetch | Expected, only happens when cache is stale (once/day at UTC midnight) |

### Process Safety Checks

**Verify no zombie processes:**
```bash
# Should return no results (no statusline processes running)
ps aux | grep statusline | grep -v grep

# Should show only current process (if running)
ps aux | grep ccusage | grep -v grep
```

**Check cache file integrity:**
```bash
# All cache files should be valid JSON
jq . ~/.claude/.ccusage_cache.json > /dev/null && echo "✓ Valid"
jq . ~/.claude/.data_freshness.json > /dev/null && echo "✓ Valid"
```

**Monitor resource usage:**
```bash
# Statusline should complete in <100ms (cache hit) or ~20s (fresh fetch)
time ~/.claude/statusline.sh

# Should show minimal memory/CPU impact
```

---

## Performance Characteristics

### Execution Timeline

**Cache Hit (Normal Case):**
```
statusline.sh invoked
  ├─ Parse JSON input: ~1ms
  ├─ Read git cache: ~1ms
  ├─ Read ccusage cache: ~2ms
  ├─ Calculate context usage: ~0ms
  ├─ Build output string: ~3ms
  ├─ Calculate MD5 hash: ~1ms
  ├─ Compare vs last hash: ~0ms
  └─ Print output: ~1ms

Total: ~9-15ms (sub-100ms guaranteed)
```

**Cache Miss (First Run or Stale):**
```
statusline.sh invoked
  ├─ Parse JSON input: ~1ms
  ├─ Check ccusage cache age: ~2ms
  ├─ Cache invalid (stale/missing)
  ├─ Run ccusage blocks: ~17-20 seconds (timeout 20)
  ├─ Parse result: ~2ms
  ├─ Write cache atomically: ~5ms
  ├─ Record fetch time: ~3ms
  ├─ Build output: ~3ms
  └─ Print output: ~1ms

Total: ~17-20 seconds (cache invalidation only)
```

### Resource Usage

| Metric | Value | Notes |
|--------|-------|-------|
| **Memory** | <5 MB | Bash process + subshells |
| **CPU** | <1% average | Mostly I/O bound |
| **Disk I/O** | ~50 KB read/write | Cache files + temp writes |
| **Network** | 0 (offline cache) | ccusage uses local data |

---

## Deployment & Distribution

### Repository Structure

```
ai-agile-claude-code-statusline/
├── CLAUDE.md                    # This file
├── README.md                    # Quick start guide
├── scripts/
│   └── statusline.sh            # Main executable
├── docs/
│   ├── ARCHITECTURE.md          # Detailed technical design
│   ├── CACHE-MANAGEMENT.md      # Cache strategy & cleanup
│   ├── PROCESS-SAFETY.md        # Security & safety guarantees
│   └── TROUBLESHOOTING.md       # Common issues & solutions
├── cache-config/
│   └── cache-defaults.json      # Recommended cache settings
├── examples/
│   ├── sample-input.json        # Example Claude Code hook input
│   ├── setup.sh                 # Installation script
│   └── test.sh                  # Integration test
└── CHANGELOG.md                 # Version history & fixes
```

### Making It Public

1. **Prepare for publication:**
   ```bash
   # Add LICENSE
   cp LICENSE ai-agile-claude-code-statusline/

   # Add .gitignore
   echo ".DS_Store" > ai-agile-claude-code-statusline/.gitignore
   echo "*.tmp" >> ai-agile-claude-code-statusline/.gitignore
   echo ".cache/" >> ai-agile-claude-code-statusline/.gitignore
   ```

2. **Create GitHub repo:**
   ```bash
   cd ai-agile-claude-code-statusline
   git init
   git add .
   git commit -m "Initial commit: Production-ready Claude Code statusline"
   git remote add origin https://github.com/your-org/ai-agile-claude-code-statusline
   git branch -M main
   git push -u origin main
   ```

3. **Document for users:**
   - Comprehensive README with screenshots
   - Installation instructions
   - Troubleshooting guide
   - Contributing guidelines

---

## Version History

**v1.0.0 (2026-01-15)** - Production Release
- ✅ Fixed frozen spending data detection
- ✅ Improved last message reliability
- ✅ Added staleness tracking with red dot indicators
- ✅ Full process safety verification
- ✅ Comprehensive caching strategy
- ✅ Cross-platform compatibility

---

## Support & Contributing

**Issues or suggestions?**
- Check `docs/TROUBLESHOOTING.md`
- Enable `--debug` mode for detailed logs
- Review `docs/CACHE-MANAGEMENT.md` for cache issues
- Verify process safety with checks in `docs/PROCESS-SAFETY.md`

**Contributing:**
- All changes must pass syntax check: `bash -n statusline.sh`
- No background processes allowed
- All external commands must have timeouts
- All file writes must be atomic
- Add tests in `examples/test.sh`

---

## License

This statusline system is designed for use with Claude Code and ccusage.

**Dependencies:**
- ccusage: MIT License
- jq: Licensed under CC0 1.0 Universal
- Bash: GPL v3

---

**Author:** Vladimir K.S.
**Last Updated:** 2026-01-15
**Status:** Production Ready ✅
