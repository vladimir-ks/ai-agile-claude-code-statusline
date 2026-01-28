# Data Sources for Statusline

Claude Code invokes statusline via a hook with real-time session data. This document catalogs all available data sources and their reliability.

## Primary: JSON Input (Real-time)

Claude Code pipes JSON to stdin on every invocation. This is the authoritative source.

**Model information:**
```json
{
  "model": {
    "display_name": "Haiku4.5",
    "id": "claude-haiku-4-5-20251001"
  }
}
```

- **Freshness:** Real-time
- **Reliability:** 100% (direct from active session)
- **Availability:** On every invocation
- **Accuracy:** Shows actual model in use NOW

**Context information:**
```json
{
  "context_window": {
    "context_window_size": 200000,
    "total_input_tokens": 50000,
    "total_output_tokens": 10000,
    "current_usage": {
      "input_tokens": 5000,
      "output_tokens": 1000,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 500
    }
  }
}
```

**Session information:**
```json
{
  "cwd": "/Users/vmks/.claude",
  "workspace": {
    "current_dir": "/Users/vmks/.claude",
    "project_dir": "/Users/vmks/.claude"
  },
  "session_id": "uuid-string",
  "transcript_path": "/path/to/transcript.jsonl",
  "version": "1.0"
}
```

---

## Secondary: Git Status (10-second cache)

Local git repository metadata.

**Available:**
- Branch name
- Commits ahead/behind
- Modified files count

**Freshness:** 10 seconds (cached)
**Reliability:** Very high (local filesystem)
**Availability:** In git repositories only
**Cost:** <100ms per fetch

---

## Tertiary: Transcript (Real-time, with TTL)

Session transcript file (JSONL format) at path provided in JSON input.

**Available:**
- Last user message timestamp
- Last user message content (preview)
- Assistant response model ID

**Freshness:** Real-time (file is updated as session progresses)
**Reliability:** Medium (may lag, can show old models)
**TTL:** 1 hour (ignore if file not modified in 1 hour)
**Availability:** When session_id provided
**Use case:** Fallback for model detection only if JSON input missing

---

## Quaternary: Settings.json (Static)

Global Claude Code configuration file.

**Available:**
- Default model: `.model` field
- MCP server count: `.mcpServers | length`

**Freshness:** Static (doesn't change during session)
**Reliability:** Very high (user-configured)
**Availability:** Always (on every invocation)
**Caveat:** Contains GLOBAL DEFAULT, not CURRENT model
- Do NOT use for determining active model mid-session
- Shows what user configured, not what user selected NOW

---

## Quaternary: ccusage Blocks (15-minute cache)

Anthropic billing API accessed via ccusage CLI.

**Available:**
- Daily cost (USD)
- Hourly burn rate
- Tokens per minute
- Session start/end times
- Active block status

**Freshness:** 15 minutes (cached)
**Reliability:** High (from billing system)
**Availability:** When `ccusage` installed
**Cost:** 17-20 seconds on cache miss (happens once daily at UTC midnight)
**Staleness indicator:** 🔴 red dot if >1 hour old

---

## Optional: AIGILE Project Metadata

Project-specific configuration if `.aigile/` directory exists.

**Available:**
- Project name
- Sprint ID
- Task ID

**Freshness:** Session (per-session)
**Reliability:** Medium (file-based)
**Availability:** In AIGILE projects only

---

## Environment Variables (User-settable)

**Optional:**
- `WEEKLY_BUDGET` - Cost alerting threshold (default $456)
- `STATUSLINE_FORCE_REFRESH=1` - Clear all caches on this invocation
- `NO_COLOR=1` - Disable ANSI colors

---

## Cached Artifacts (Derived Data)

Not input sources, but reuse processed results:

- `.ccusage_cache.json` - Billing data (15-min TTL)
- `.git_status_cache` - Git status (10-sec TTL)
- `.statusline.hash` - Output dedup hash
- `.statusline.last_print_time` - Rate limiting
- `.last_model_name` - Model change detection
- `.data_freshness.json` - Staleness timestamps

---

## Model Detection: Correct Priority Order

**CORRECTED: Actual implementation priority (transcript-first):**

1. **Transcript `.message.model`** ← PRIMARY (most accurate)
   - Shows actual model from API responses
   - Session-specific, reflects what model responded last
   - TTL: 1 hour (prevents indefinite stale data)
   - **Why first**: Reflects actual conversation history

2. **JSON `model.display_name`** ← FALLBACK
   - Only if transcript missing/stale (>1hr old)
   - Shows model configured for current request
   - Provided on every invocation by Claude Code

3. **Settings.json `.model`** ← DO NOT USE for current model
   - Contains GLOBAL DEFAULT only
   - Does NOT change when user switches models
   - Misleads about actual model in use

4. **Default "Claude"** ← LAST RESORT
   - Safe fallback if all sources fail

---

## Reliability Matrix

| Source | Freshness | Reliability | Staleness Risk | Best For |
|--------|-----------|-------------|-----------------|----------|
| JSON input | Real-time | 100% | None | Model, context, tokens |
| Git status | 10 sec cache | Very high | Minimal | Branch, dirty count |
| Transcript | Real-time | Medium | High if stale | Message preview, history |
| settings.json | Static | Very high | N/A | Global defaults |
| ccusage | 15-min cache | High | Can show old | Costs, burn rate |
| AIGILE | Session | Medium | Per-session | Project context |

---

## Key Insights

1. **JSON input is comprehensive.** Don't over-rely on fallbacks.
2. **Settings.json is configuration, not state.** It doesn't reflect current model.
3. **Transcript has implicit 1-hour TTL.** Old transcript data will be ignored.
4. **ccusage requires SDK.** Falls back gracefully if unavailable.
5. **All data is local.** No network calls except ccusage's Anthropic API.

---

**See:** CLAUDE.md for implementation details | DEPLOYMENT_GUIDE.md for setup
