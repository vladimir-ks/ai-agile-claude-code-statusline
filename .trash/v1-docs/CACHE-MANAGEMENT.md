---
metadata:
  status: approved
  title: "Cache Management Strategy"
  version: "1.0.0"
  author: "Vladimir K.S."
---

# Cache Management

## Cache Hierarchy

The statusline uses a multi-layer caching strategy optimized for different data freshness requirements:

```
Data Source
   ↓
┌──────────────────────────────────────┐
│ Freshness Requirement                │
└──────────────────────────────────────┘
   ├─ Always Fresh (0 sec)
   │  └─ Context window, Transcript
   │
   ├─ Very Fresh (10 sec)
   │  └─ Git status
   │
   ├─ Fresh (15 min)
   │  └─ Financial data (ccusage blocks)
   │
   └─ Legacy (30 min)
      └─ Weekly quota (deprecated)
```

## Cache Files

### 1. `.ccusage_cache.json` (15 minute TTL)

**Purpose:** Billing blocks, cost, tokens, burn rate, session times

**Format:**
```json
{
  "blocks": [
    {
      "id": "block-uuid",
      "startTime": "2026-01-15T00:00:00Z",
      "actualEndTime": null,
      "cost": 12.50,
      "tokens": 234567,
      "inputTokens": 150000,
      "outputTokens": 84567,
      "cacheCreationInputTokens": 0,
      "cacheReadInputTokens": 5000,
      "isActive": true
    },
    // ... more blocks
  ],
  "metadata": {
    "fetchTime": "2026-01-15T11:30:45Z",
    "dailyUsage": { "cost": 45.23, "tokens": 1234567 },
    "hourlyRate": 15.10
  }
}
```

**Validation Rules:**
- ✅ File must be valid JSON
- ✅ Blocks array must exist
- ✅ Earliest block's startTime must be today
- ✅ If any block has actualEndTime < (now - 5min), reject entire cache
- ✅ If cache older than 15 minutes, refresh

**Refresh Trigger:**
```bash
# Check if block has ended
if [ -n "$block_end_time" ] && [ "$block_end_time" != "null" ]; then
    block_end_epoch=$(to_epoch "$block_end_time")
    now_epoch=$(date +%s)
    age_seconds=$((now_epoch - block_end_epoch))

    if [ $age_seconds -gt 300 ]; then  # 5 minutes
        # Force refresh - active session changed
        rm "$cache_file"
    fi
fi
```

**File Location:** `~/.claude/.ccusage_cache.json`
**Size:** ~2 KB (typical, varies with number of blocks)
**Refresh Cost:** 17-20 seconds (network call to Anthropic API)

### 2. `.git_status_cache` (10 second TTL)

**Purpose:** Git branch, ahead/behind commits, dirty file count

**Format:**
```
main
+12
-0
*1
```
- Line 1: Current branch name
- Line 2: Commits ahead of main
- Line 3: Commits behind main
- Line 4: Dirty (modified) file count

**Validation Rules:**
- ✅ File must exist
- ✅ File must have exactly 4 lines
- ✅ Lines 2-4 must be numeric
- ✅ If modified time >10 seconds ago, refresh

**Refresh Trigger:**
```bash
cache_mtime=$(stat -f %m "$git_cache" 2>/dev/null || stat -c %Y "$git_cache" 2>/dev/null)
now_epoch=$(date +%s)
cache_age=$((now_epoch - cache_mtime))

if [ $cache_age -gt 10 ]; then
    # Force refresh
    rm "$git_cache"
fi
```

**File Location:** `~/.claude/.git_status_cache`
**Size:** ~50 bytes
**Refresh Cost:** <100ms (local git commands)

### 3. `.data_freshness.json` (No TTL)

**Purpose:** Track when each data source was last fetched (for staleness indicators)

**Format:**
```json
{
  "ccusage_blocks": "2026-01-15T11:30:00Z",
  "git_status": "2026-01-15T11:39:00Z",
  "weekly_quota": "2026-01-15T11:00:00Z"
}
```

**Usage:**
```bash
# After fetching ccusage data
record_fetch_time "ccusage_blocks"

# When displaying data
indicator=$(calculate_data_indicator "ccusage_blocks")
# Returns: 🔴 if >1h old, 🟠 if loading, empty otherwise
```

**File Location:** `~/.claude/.data_freshness.json`
**Size:** ~300 bytes
**Never Expires:** Updated on each fetch, always accurate

### 4. `.weekly_quota_cache.json` (30 minute TTL - LEGACY)

**Purpose:** Weekly cost aggregation (deprecated, kept for compatibility)

**Note:** No longer displayed in default output but kept for fallback compatibility. Modern implementations use per-session blocks instead.

**File Location:** `~/.claude/.weekly_quota_cache.json`
**Status:** Deprecated ⚠️

### 5. `.statusline.hash` (No TTL)

**Purpose:** MD5 hash of last output (prevents terminal flicker)

**Format:**
```
a3d4e5c8f1b2c9d7e8f9a0b1c2d3e4f5
```

**Usage:**
```bash
new_hash=$(echo "$output" | md5 -q)

if [ "$new_hash" = "$(cat ~/.claude/.statusline.hash 2>/dev/null)" ]; then
    exit 0  # Skip print, no change
fi

echo "$output"
echo "$new_hash" > ~/.claude/.statusline.hash
```

**File Location:** `~/.claude/.statusline.hash`
**Size:** 33 bytes

### 6. `.statusline.log` (No TTL - Debug Only)

**Purpose:** Detailed logging when `--debug` flag is used

**Generated When:**
```bash
~/.claude/statusline.sh --debug
```

**Contents:**
- Timestamp of execution
- Input JSON parsing results
- Cache hit/miss for each data source
- Fetch duration for remote calls
- Data validation results
- Metric calculations
- Output string generated

**File Location:** `~/.claude/statusline.log`
**Size:** Grows ~5-10 KB per debug run

---

## Cache Management Operations

### View Cache Status

```bash
# Check all cache files
ls -lah ~/.claude/.*.json ~/.claude/.statusline.hash

# View ccusage cache content
cat ~/.claude/.ccusage_cache.json | jq .

# View freshness timestamps
cat ~/.claude/.data_freshness.json | jq .

# Check git cache
cat ~/.claude/.git_status_cache
```

### Validate Cache Integrity

```bash
# Verify JSON files are valid
jq . ~/.claude/.ccusage_cache.json > /dev/null && echo "✓ ccusage cache valid"
jq . ~/.claude/.data_freshness.json > /dev/null && echo "✓ freshness cache valid"

# Check git cache format (4 lines)
[ $(wc -l < ~/.claude/.git_status_cache) -eq 4 ] && echo "✓ git cache valid"
```

### Force Fresh Data Fetch

```bash
# Option 1: Delete individual cache
rm ~/.claude/.ccusage_cache.json      # Forces ccusage refresh
rm ~/.claude/.git_status_cache         # Forces git refresh
rm ~/.claude/.data_freshness.json      # Resets staleness tracking

# Option 2: Clear all caches
rm ~/.claude/.*.json ~/.claude/.statusline.hash 2>/dev/null

# Option 3: After clearing, next statusline call will fetch fresh data
# Wait up to 20 seconds for ccusage fetch to complete
~/.claude/statusline.sh < /tmp/input.json
```

### Clear Specific Data Staleness

```bash
# Mark ccusage data as fresh (set to now)
current_time=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
jq --arg time "$current_time" '.ccusage_blocks=$time' \
  ~/.claude/.data_freshness.json > ~/.claude/.data_freshness.json.tmp && \
mv ~/.claude/.data_freshness.json.tmp ~/.claude/.data_freshness.json
```

### Emergency Cache Cleanup

```bash
# Remove all statusline caches (safe, will be recreated)
rm -f ~/.claude/.ccusage_cache.json
rm -f ~/.claude/.weekly_quota_cache.json
rm -f ~/.claude/.git_status_cache
rm -f ~/.claude/.data_freshness.json
rm -f ~/.claude/.statusline.hash
rm -f ~/.claude/.statusline.log

# Verify cleanup
ls -lah ~/.claude/.*.json ~/.claude/.statusline.* 2>&1 | grep -v "cannot access"
```

---

## Freshness Indicators

### Red Dot (🔴) - Stale Data >1 Hour

**When it appears:**
- Data last fetched >1 hour ago
- Displayed after the value: `💰:$40.3🔴`

**Why it appears:**
- ccusage API slow or unavailable
- Network issues preventing refresh
- Cache TTL expired but fetch failed

**What to do:**
1. Check ccusage availability: `ccusage blocks --json`
2. Check network: `curl -I https://api.anthropic.com`
3. Force refresh: `rm ~/.claude/.ccusage_cache.json`
4. Wait for next statusline update (max 20 seconds)

### Orange Dot (🟠) - Data Currently Loading

**When it appears:**
- System is actively fetching fresh data
- Displayed after the value: `💰:$40.3🟠`
- Typically visible for 1-2 seconds during refresh

**Why it appears:**
- First fetch of the day (ccusage cache expires at UTC midnight)
- Manual cache clear triggered
- TTL expired for a data source

**Expected behavior:**
- Orange dot → Red dot (still loading)
- Red dot → Disappears (fresh data received)

---

## Cache Size Monitoring

### Estimated Sizes

| File | Min | Typical | Max |
|------|-----|---------|-----|
| `.ccusage_cache.json` | 500 B | 2 KB | 10 KB (many blocks) |
| `.git_status_cache` | 20 B | 50 B | 100 B |
| `.data_freshness.json` | 100 B | 300 B | 500 B |
| `.statusline.hash` | 33 B | 33 B | 33 B |
| `.statusline.log` | 0 B | 10 KB (debug) | 100 KB (long session) |

**Total typical footprint:** ~2.5 KB (plus .log if debug enabled)

### Monitor Disk Usage

```bash
# Check statusline cache directory usage
du -sh ~/.claude/.*.json ~/.claude/.statusline.* 2>/dev/null | tail -1

# Expected output
# 2.5K    ~/.claude/
```

---

## Cache Corruption Handling

### Symptoms of Corruption

- Statusline displays outdated data (>2 hours)
- `jq` parsing fails with "parse error"
- Git branch shows incorrect info
- Crash with "attempt to calculate timeout less than zero"

### Recovery Procedures

**Step 1: Identify corrupted file**
```bash
jq . ~/.claude/.ccusage_cache.json 2>&1 | head -5
jq . ~/.claude/.data_freshness.json 2>&1 | head -5
```

**Step 2: Delete corrupted cache**
```bash
# If ccusage cache is corrupted
rm ~/.claude/.ccusage_cache.json

# If freshness tracking is corrupted
rm ~/.claude/.data_freshness.json

# If all caches corrupted (safest option)
rm ~/.claude/.*.json
```

**Step 3: Verify recovery**
```bash
# Next statusline call will recreate caches
~/.claude/statusline.sh < /tmp/input.json

# Check that data appears fresh
cat ~/.claude/.data_freshness.json | jq .
```

---

## Best Practices

✅ **Do:**
- Let statusline manage caches automatically
- Delete `.ccusage_cache.json` if cost data looks stale
- Check staleness indicators (red dots) if concerned about freshness
- Enable `--debug` mode if troubleshooting

❌ **Don't:**
- Manually edit cache JSON (will corrupt tracking)
- Delete cache files while statusline is running
- Ignore repeated red dot indicators (indicates system issue)
- Assume cache data is stale without checking freshness timestamps

---

**Last Updated:** 2026-01-15
**Version:** 1.0.0
