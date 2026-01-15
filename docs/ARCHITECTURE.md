---
metadata:
  status: approved
  title: "System Architecture & Technical Design"
  version: "1.0.0"
  author: "Vladimir K.S."
---

# Statusline Architecture

## System Overview

The Claude Code Status Line is a **synchronous event-driven hook** that collects real-time metrics from multiple sources and displays them in a compact, information-dense format.

```
┌─ Claude Code CLI ────────────────────┐
│  On user input / tool execution      │
│  ↓                                   │
│  Invoke statusline.sh hook           │
│  (receive JSON context)              │
└──────────────────────────────────────┘
     ↓
┌─ Statusline.sh ───────────────────────────────────────┐
│ 1. Parse input JSON                                   │
│ 2. Check cache validity                               │
│ 3. If stale: Fetch fresh data (blocking)              │
│ 4. Calculate display strings                          │
│ 5. Build single output line                           │
│ 6. Hash deduplicate (prevent flicker)                 │
│ 7. Output to terminal                                 │
└───────────────────────────────────────────────────────┘
     ↓
┌─ Data Sources (Cached) ───────────────┐
│ • ccusage blocks (15 min)              │
│ • Git status (10 sec)                  │
│ • Weekly quota (30 min, legacy)        │
│ • Context window (fresh per call)      │
│ • Session transcript (calculated)      │
└────────────────────────────────────────┘
```

## Data Flow Pipeline

### Phase 1: Input Parsing

**JSON Input** (from Claude Code hook):
```json
{
  "cwd": "/path/to/project",
  "workspace": {"current_dir": "...", "project_dir": "..."},
  "model": {"display_name": "Haiku4.5", "id": "claude-haiku-4-5-20251001"},
  "session_id": "session-uuid",
  "transcript_path": "/path/to/transcript.jsonl",
  "version": "1.0",
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

**Extraction** (~1ms):
- Current directory → 📁 component
- Workspace info → Path validation
- Model name → 🤖 component
- Context window → 🧠 and progress bar
- Session ID → Cache key
- Transcript → Last message extraction

### Phase 2: Cache Validation & Refresh

**Multi-Source Caching Strategy:**

| Source | TTL | Validation | Refresh Trigger |
|--------|-----|-----------|-----------------|
| **ccusage blocks** | 15 min | startTime matches today | Cache expired OR block ended >5min ago |
| **Git status** | 10 sec | File modification time | If last fetch >10s ago |
| **Weekly quota** | 30 min | Array structure valid | Cache file missing/corrupted |
| **Context data** | Fresh | Input JSON timestamp | Always use current input |
| **Transcript** | Fresh | File exists, >0 bytes | Always read latest |

**Cache Validation Logic:**
```
If cache file missing or corrupted:
  → Force fresh fetch

If cache expired (TTL):
  → Force fresh fetch

If ccusage block validation:
  IF block.startTime not today:
    → Force fresh fetch (block from yesterday)
  IF block.actualEndTime < (now - 5 minutes):
    → Force fresh fetch (block ended, new one started)
  ELSE:
    → Use cached data

If no validation errors:
  → Use cached data (most common)
```

### Phase 3: Data Fetching (Only if cache invalid)

**Blocking Operations** (17-20 seconds for first daily refresh):

1. **ccusage blocks command** (timeout: 20s)
   ```
   timeout 20 ccusage blocks --json
   ```
   - Fetches billing blocks from Anthropic API
   - Returns: cost, tokens, burn rate, reset times
   - Atomically cached with timestamp

2. **Git status** (implicit timeout from CLI):
   ```
   git -C <dir> status --porcelain
   git -C <dir> rev-parse --abbrev-ref HEAD
   git -C <dir> rev-list --left-right --count main...HEAD
   ```
   - Fetches branch, ahead/behind, dirty files
   - Atomically cached

3. **Transcript parsing** (always fresh):
   - Read last 50 lines of session file
   - Extract most recent user message
   - Parse timestamp and content

### Phase 4: Metric Calculation

**Context Window Usage:**
```
total_tokens_used = total_input + total_output + cache_creation
current_session_tokens = current_input + current_output + cache_read
tokens_available = context_window_size - total_tokens_used
percentage_used = (total_tokens_used / context_window_size) * 100
compact_threshold = 78% of context_window_size
```

**Financial Metrics:**
```
daily_cost = sum of all blocks started today
hourly_burn_rate = daily_cost / session_duration_hours
session_duration = now - earliest_block_start_time
```

**Session Timing:**
```
session_elapsed = (now - session_start_epoch)
session_until_reset = reset_time_from_block - now
session_percentage = (elapsed / total_window_duration) * 100
reset_hour = reset_time.hour:reset_time.minute (UTC)
```

**Token Metrics:**
```
total_session_tokens = sum of all input + output across blocks
tokens_per_minute = (total_session_tokens / session_elapsed_minutes)
cache_hit_ratio = (cache_read_tokens / (cache_read_tokens + fresh_input_tokens)) * 100
```

### Phase 5: Staleness Tracking

**Data Freshness File:**
```json
{
  "ccusage_blocks": "2026-01-15T11:30:00Z",
  "git_status": "2026-01-15T11:39:00Z",
  "weekly_quota": "2026-01-15T11:00:00Z"
}
```

**Staleness Calculation:**
```
For each data field:
  fetch_time = read from .data_freshness.json
  age_seconds = now_epoch - to_epoch(fetch_time)

  IF age_seconds > 3600 (1 hour):
    indicator = 🔴 (red dot - stale)
  ELSE IF currently_fetching:
    indicator = 🟠 (orange dot - loading)
  ELSE:
    indicator = "" (no indicator - fresh)
```

### Phase 6: Display Formatting

**Output Construction:**
```
SYSTEM_CORE := "📁:$(pwd_short) 🌿:$(git_info) 🤖:$(model_name) 📟:$(version)"
CONTEXT_STATE := "🧠:$(tokens_left) [$(progress_bar)] 🕐:$(current_time)"
SESSION_INFO := "⌛:$(session_time)$(staleness_ccusage)"
FINANCIAL := "💰:$(daily_cost)|$(hourly_rate)$(staleness_ccusage)"
USAGE_METRICS := "📊:$(total_tokens)($(tpm))"
CACHE_HEALTH := "💾:$(cache_hit_ratio)%"
LAST_MESSAGE := "💬:$(message_time)($(elapsed_since)) $(message_preview)"

OUTPUT := SYSTEM_CORE + CONTEXT_STATE + SESSION_INFO + FINANCIAL + USAGE_METRICS + CACHE_HEALTH
```

**Emoji Spacing Rules:**
- Separators between components (controlled by SEP variable)
- Staleness indicators appear AFTER data values: `💰:$40.3🔴`
- Color codes embedded: `$(color_code)text$(reset_code)`

### Phase 7: Deduplication & Output

**Hash Comparison:**
```
output_string = complete formatted line
output_hash = md5(output_string)

IF output_hash == last_hash:
  → Skip print (prevents flicker on unchanged data)
  → Update timestamp only
ELSE:
  → Print output to terminal
  → Save new hash to .statusline.hash
```

**Benefits:**
- Prevents terminal flicker when data unchanged
- Reduces visual noise on rapid interactions
- Maintains scrollback clarity

## Cache File Organization

**Location:** `~/.claude/` (alongside statusline.sh)

| File | Size | TTL | Purpose | Format |
|------|------|-----|---------|--------|
| `.ccusage_cache.json` | ~2 KB | 15 min | Billing blocks, cost, tokens | JSON object |
| `.weekly_quota_cache.json` | ~500 B | 30 min | Weekly cost aggregation (legacy) | JSON array |
| `.git_status_cache` | ~1 KB | 10 sec | Branch, commits, dirty count | Text lines |
| `.data_freshness.json` | ~300 B | N/A | Fetch timestamps per source | JSON object |
| `.statusline.hash` | ~33 B | N/A | MD5 of last output | Text (hex) |
| `.statusline.log` | ~100 KB | N/A | Debug output (if --debug) | Text lines |

**Atomic Write Pattern:**
```bash
# Never append directly, use temp file + atomic move
content="new cache data"
cache_file="$HOME/.claude/.ccusage_cache.json"

echo "$content" > "$cache_file.tmp.$$" 2>/dev/null
mv "$cache_file.tmp.$$" "$cache_file" 2>/dev/null || true
```

This prevents corruption if process dies during write.

## Timing & Performance

### Execution Timeline (Cache Hit)

```
statusline.sh invoked ─┐
                      ├─ Parse JSON input: 1ms
                      ├─ Check cache validity: 2ms
                      ├─ Read ccusage cache: 2ms
                      ├─ Read git cache: 1ms
                      ├─ Calculate metrics: 3ms
                      ├─ Build output string: 3ms
                      ├─ Calculate MD5: 1ms
                      ├─ Compare hashes: 1ms
                      └─ Print/save: 1ms

Total: 9-15ms (sub-100ms guaranteed)
```

### Execution Timeline (Cache Miss)

```
statusline.sh invoked ─┐
                      ├─ Parse JSON input: 1ms
                      ├─ Detect cache invalid: 2ms
                      ├─ Run ccusage blocks: 17-20 seconds ⏱️
                      ├─ Parse ccusage result: 2ms
                      ├─ Write cache atomically: 5ms
                      ├─ Update freshness tracking: 3ms
                      ├─ Calculate metrics: 3ms
                      ├─ Build output: 3ms
                      └─ Print output: 1ms

Total: 17-20 seconds (only when TTL expires - once/day at UTC midnight)
```

## Resource Consumption

| Resource | Usage | Notes |
|----------|-------|-------|
| **Memory** | <5 MB | Bash process + subshells, no accumulation |
| **CPU** | <1% average | Mostly I/O bound, sub-second on cache hits |
| **Disk I/O** | ~50 KB/call | Read/write cache files, temp file cleanup |
| **Network** | 0 KB | ccusage uses local Anthropic SDK cache |

## Error Handling Strategy

**Silent Error Suppression:**
```bash
# All external commands suppress stderr to prevent terminal pollution
timeout 20 ccusage blocks --json 2>/dev/null

# jq parsing failures return empty string instead of error
jq '.field' 2>/dev/null || echo ""
```

**Fallback Chain for to_epoch():**
```
Input: ISO8601 timestamp string
  ↓
Try: gdate -d (GNU date on macOS)
  if result is numeric → return it
  else ↓
Try: BSD date -j (native macOS)
  if result is numeric → return it
  else ↓
Try: Python datetime
  if result is numeric → return it
  else ↓
Return: 0 (safe default)
```

**Last Message Extraction:**
```
Try: Read session file (must exist, >0 bytes)
  ↓
Try: Extract last user message from JSONL (timeout 2s)
  ↓
Try: Parse timestamp and content
  ↓
Try: Convert timestamp to epoch
  ↓
Fallback: Empty string (💬 line shows "[loading...]")
```

## Thread Safety & Concurrency

**No Concurrency Issues** (single-threaded design):
- Statusline is 100% synchronous hook
- Never spawns background processes
- Each invocation is independent
- Concurrent statusline calls don't race (CLI serializes hooks)

**Atomic File Operations:**
- All cache writes use temp → move pattern
- No partial writes possible
- Reading from stale files is safe (no corruption)

## Extension Points

**To add new data fields:**

1. **Add fetch function** (if needs external data):
   ```bash
   fetch_my_data() {
       local cache_file="$HOME/.claude/.mydata_cache.json"
       # Check cache validity
       # If invalid, fetch and cache
       # Return data
   }
   ```

2. **Track freshness:**
   ```bash
   record_fetch_time "my_data_source"
   ```

3. **Add to output:**
   ```bash
   MY_FIELD="💥:$(my_value)$(calculate_data_indicator "my_data_source")"
   OUTPUT="${OUTPUT}${SEP}${MY_FIELD}"
   ```

4. **Test thoroughly** (see TROUBLESHOOTING.md)

---

**Last Updated:** 2026-01-15
**Version:** 1.0.0
