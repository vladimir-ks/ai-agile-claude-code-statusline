---
metadata:
  status: approved
  title: "Troubleshooting Guide"
  version: "1.0.0"
  author: "Vladimir K.S."
---

# Troubleshooting Guide

## Quick Diagnostics

### Enable Debug Mode

```bash
# One-time debug run
~/.claude/statusline.sh --debug < /tmp/input.json

# Check detailed output
tail -100 ~/.claude/statusline.log

# Look for these lines:
# - "INIT: Starting statusline"
# - "INPUT: Parsed JSON successfully"
# - "CACHE: ccusage_blocks [HIT|MISS]"
# - "FETCH: Running ccusage blocks"
# - "OUTPUT: Generated statusline"
```

### Quick Health Check

```bash
# Run all verification steps
bash -n ~/.claude/statusline.sh && echo "✓ Script syntax OK"
command -v jq > /dev/null && echo "✓ jq installed"
command -v ccusage > /dev/null && echo "✓ ccusage installed"
ccusage blocks --json > /dev/null 2>&1 && echo "✓ ccusage working"
```

---

## Common Issues

### Issue 1: Statusline Blank / Not Displaying

**Symptoms:**
- No status line appears in terminal
- Status line shows empty space or minimal content

**Diagnosis:**

```bash
# Test direct execution
echo '{"cwd": "/tmp", "workspace": {"current_dir": "/tmp", "project_dir": "/tmp"}, "model": {"display_name": "Test", "id": "test"}, "session_id": "test", "transcript_path": "/tmp/t.jsonl", "version": "1.0", "context_window": {"context_window_size": 200000, "total_input_tokens": 0, "total_output_tokens": 0, "current_usage": {"input_tokens": 0, "output_tokens": 0, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}}}' | ~/.claude/statusline.sh

# If output is empty:
```

**Root Causes & Fixes:**

| Cause | Check | Fix |
|-------|-------|-----|
| jq not installed | `which jq` | `brew install jq` |
| Script not executable | `ls -la ~/.claude/statusline.sh` | `chmod +x ~/.claude/statusline.sh` |
| Bad input JSON | Enable debug mode | Verify input JSON format |
| Missing color support | `echo $TERM` | Ensure TERM=xterm-256color |

**Advanced Debugging:**

```bash
# Check if script is being called
strace -e trace=execve ~/.claude/statusline.sh 2>&1 | head -20

# Test with minimal JSON
cat > /tmp/minimal.json << 'EOF'
{
  "cwd": "/tmp",
  "workspace": {"current_dir": "/tmp", "project_dir": "/tmp"},
  "model": {"display_name": "Test", "id": "test"},
  "session_id": "test",
  "transcript_path": "/tmp/transcript.jsonl",
  "version": "1.0",
  "context_window": {
    "context_window_size": 200000,
    "total_input_tokens": 0,
    "total_output_tokens": 0,
    "current_usage": {
      "input_tokens": 0,
      "output_tokens": 0,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 0
    }
  }
}
EOF

cat /tmp/minimal.json | ~/.claude/statusline.sh
```

---

### Issue 2: Cost Data Shows Stale/Incorrect Values

**Symptoms:**
- 💰 cost stays same for hours
- Doesn't match ccusage blocks output
- Always shows "$35.10" or some frozen value

**Root Causes:**

1. **ccusage timeout too short** (17-20s needed)
   ```bash
   # Check if ccusage is timing out
   time timeout 1 ccusage blocks --json  # Too short!
   time timeout 20 ccusage blocks --json # Should work
   ```

2. **Cache not expiring** (15 minute TTL)
   ```bash
   # Check cache age
   ls -la ~/.claude/.ccusage_cache.json

   # Delete to force refresh
   rm ~/.claude/.ccusage_cache.json

   # Next statusline call will fetch fresh data
   ```

3. **ccusage command not available**
   ```bash
   ccusage blocks --json
   # If error: npm install -g @anthropic-sdk/ccusage
   ```

4. **Block hasn't ended** (system detected block is still active)
   ```bash
   # Check active block
   ccusage blocks --json | jq '.[] | select(.isActive == true)'

   # If block in past but isActive=true, it's a ccusage issue
   ```

**Fixes:**

```bash
# Fix 1: Force cache refresh
rm ~/.claude/.ccusage_cache.json
# Next statusline call will fetch fresh data (wait 20 sec)

# Fix 2: Check ccusage availability
ccusage blocks --json | jq '.[] | select(.isActive == true)' | head -20

# Fix 3: Verify network connectivity
curl -I https://api.anthropic.com

# Fix 4: Check token balance
echo "Visit: https://console.anthropic.com/account/usage"
```

---

### Issue 3: Last Message Line (💬) Disappears

**Symptoms:**
- 💬 line appears briefly, then disappears
- Shows "[loading...]" for extended time
- Flickers in and out

**Root Causes:**

1. **Session file missing or empty** (first 10 seconds)
   ```bash
   # Check session file
   ls -la ~/.claude/.claude_sessions/*/

   # Expected: File with .jsonl extension
   # If missing: Wait 10 seconds (session initializes slowly)
   ```

2. **Session file path wrong** (directory structure changed)
   ```bash
   # Enable debug mode
   ~/.claude/statusline.sh --debug
   grep "SESSION_FILE:" ~/.claude/statusline.log

   # Verify path exists
   # If wrong: Check workspace.current_dir in input JSON
   ```

3. **Malformed JSONL in session file**
   ```bash
   # Check last line of session file
   tail -5 ~/.claude/.claude_sessions/*/session.jsonl | jq .

   # If error: File is corrupted or incomplete
   # Fix: Delete file (will be recreated)
   rm ~/.claude/.claude_sessions/*/session.jsonl
   ```

4. **jq timeout on large session file**
   ```bash
   # Check file size
   wc -l ~/.claude/.claude_sessions/*/session.jsonl

   # If >10k lines: jq might timeout
   # Fix: Wait for session to rotate (happens periodically)
   ```

**Fixes:**

```bash
# Fix 1: Check if session file exists
find ~/.claude -name "*.jsonl" -type f -mmin -5

# Fix 2: Enable debug and check logs
~/.claude/statusline.sh --debug
tail -20 ~/.claude/statusline.log | grep "last_prompt\|SESSION"

# Fix 3: Manual check of last message
tail -50 ~/.claude/.claude_sessions/*/session.jsonl | jq -r '.message.content' | tail -3

# Fix 4: Give session time to initialize
sleep 10 && ~/.claude/statusline.sh
```

---

### Issue 4: Red Dots (🔴) Appear, Data Looks Stale

**Symptoms:**
- 💰:$40.3🔴 (red dot after cost)
- ⌛:1h53m🔴 (red dot after session time)
- Dots don't disappear after several minutes

**Root Causes:**

1. **ccusage fetch failed or slow** (>1 hour old)
   ```bash
   # Check last fetch time
   cat ~/.claude/.data_freshness.json | jq '.ccusage_blocks'

   # Calculate age
   now_epoch=$(date +%s)
   fetch_epoch=$(date -d "$(cat ~/.claude/.data_freshness.json | jq -r '.ccusage_blocks')" +%s)
   age=$((now_epoch - fetch_epoch))
   echo "Data age: $age seconds"

   if [ $age -gt 3600 ]; then
       echo "Data is >1 hour stale!"
   fi
   ```

2. **ccusage API unavailable**
   ```bash
   # Test ccusage
   ccusage blocks --json

   # If error, check:
   curl -I https://api.anthropic.com
   ```

3. **Network connectivity issue**
   ```bash
   # Test network
   ping -c 1 api.anthropic.com
   curl -w "%{http_code}" -o /dev/null https://api.anthropic.com
   ```

**Fixes:**

```bash
# Fix 1: Force immediate refresh
rm ~/.claude/.ccusage_cache.json
rm ~/.claude/.data_freshness.json

# Next statusline call will fetch fresh data
# Wait up to 20 seconds

# Fix 2: Check if ccusage needs auth
ccusage blocks --json 2>&1 | head

# Fix 3: Verify token hasn't expired
# Visit: https://console.anthropic.com/account/keys
```

---

### Issue 5: Statusline Freezes for 20 Seconds

**Symptoms:**
- Terminal hangs briefly (17-20 seconds)
- Happens first thing in morning or after reboot
- Only happens once per day

**Root Cause:**
- First ccusage fetch after cache expires (UTC midnight)
- Expected behavior, not a bug

**Explanation:**

```
When ccusage cache expires (15 min old):
1. statusline.sh detects cache is stale
2. Calls: timeout 20 ccusage blocks --json
3. ccusage fetches from Anthropic API (17-20 sec)
4. Result cached locally
5. Subsequent calls use cache (<100ms)

This 20-second freeze happens:
- Once per day at UTC midnight (when 15-min cache expires)
- Or when you manually delete cache
- Or on first statusline call after installation
```

**Is This Normal?**
✅ **YES - This is expected behavior.**

**How to Minimize:**
1. **Use official `ccusage statusline` command** (faster, <100ms)
   - Only if you migrate to newer approach
   - Current statusline.sh intentionally uses blocks API

2. **Accept the freeze** (design tradeoff)
   - 20-second freeze once per day
   - vs. updating cost data every 15 minutes
   - Most users prefer occasional freeze over stale data

3. **Background refresh** (advanced)
   - Run `ccusage blocks` in cron job every 5 minutes
   - statusline.sh will use fresh cache
   - Requires additional system configuration

**Verification:**

```bash
# Confirm it's ccusage timing out
time timeout 20 ccusage blocks --json > /dev/null

# Should take 17-20 seconds
# This is normal
```

---

### Issue 6: Git Status Shows Wrong Info

**Symptoms:**
- 🌿 shows wrong branch name
- Ahead/behind count incorrect
- Dirty file count stuck

**Root Causes:**

1. **Git cache expired** (10 second TTL)
   ```bash
   # Check cache age
   stat -f %m ~/.claude/.git_status_cache  # macOS
   stat -c %Y ~/.claude/.git_status_cache   # Linux
   ```

2. **Repository not in expected location**
   ```bash
   # Verify repo path
   git -C $(pwd) rev-parse --show-toplevel
   ```

3. **Git command hanging**
   ```bash
   # Test git status directly
   timeout 5 git -C $(pwd) status --porcelain
   ```

**Fixes:**

```bash
# Fix 1: Delete cache and refresh
rm ~/.claude/.git_status_cache

# Next statusline call (within 1 second) will fetch fresh

# Fix 2: Manually check git status
git -C $(pwd) rev-parse --abbrev-ref HEAD
git rev-list --left-right --count main...HEAD
git status --porcelain

# Fix 3: Verify working directory
pwd
git -C $(pwd) status
```

---

### Issue 7: Token Counts Look Wrong

**Symptoms:**
- 📊 shows 0 tokens (should be higher)
- Token burn rate calculation off
- Cache hit ratio always 0%

**Root Causes:**

1. **Input JSON context_window not populated**
   ```bash
   # Check input JSON
   echo "$INPUT_JSON" | jq '.context_window'

   # Should have non-zero values for:
   # - total_input_tokens
   # - total_output_tokens
   # - current_usage.input_tokens
   # - current_usage.cache_read_input_tokens
   ```

2. **Cache hit ratio calculation**
   ```bash
   # Formula: cache_read / (cache_read + fresh_input)
   # If both are 0: Ratio is 0%
   # This is normal for first few messages
   ```

**Fixes:**

```bash
# Fix 1: Verify Claude Code is passing full context
echo "$INPUT_JSON" | jq '.context_window | keys'

# Should show:
# - context_window_size
# - total_input_tokens
# - total_output_tokens
# - current_usage (nested object)

# Fix 2: Give session time to accumulate tokens
# Token counts are cumulative - will increase with more messages
```

---

## Advanced Debugging

### Enable Verbose Logging

```bash
# Add this to statusline.sh temporarily for debugging
set -x  # Echo all commands

~/.claude/statusline.sh < input.json

set +x  # Disable tracing
```

### Trace Cache Behavior

```bash
# Monitor cache file changes
watch -n 0.1 'ls -la ~/.claude/.*.json | tail -5'

# In another terminal, run statusline
~/.claude/statusline.sh < input.json

# Watch for files being created/modified
```

### Test Individual Components

```bash
# Test ccusage command
timeout 20 ccusage blocks --json | jq '.[] | .cost'

# Test git command
git -C ~/.claude status --porcelain

# Test jq parsing
echo '{"test": "value"}' | jq '.test'

# Test epoch conversion
gdate -d "2026-01-15T12:00:00Z" +%s  # macOS
date -d "2026-01-15T12:00:00Z" +%s   # Linux
```

### Check System Configuration

```bash
# Verify all dependencies
bash --version      # Need 4.0+
jq --version        # Need installed
ccusage --version   # Need installed
git --version       # Need installed
which timeout       # Need available

# Check environment
echo $SHELL
echo $TERM
echo $HOME
```

---

## Performance Issues

### Statusline Takes >1 Second (Cache Hit)

**Expected:** 9-15ms on cache hits

**If taking longer:**

1. **Check system load**
   ```bash
   uptime
   # If load >4: System is busy
   ```

2. **Check disk I/O**
   ```bash
   iostat -x 1 1
   # If I/O >50%: Disk is slow
   ```

3. **Check if cache file corrupted**
   ```bash
   jq . ~/.claude/.ccusage_cache.json > /dev/null
   # Should be instant
   ```

**Fixes:**

```bash
# Fix 1: Delete cache
rm ~/.claude/.*.json

# Fix 2: Reduce other background processes
killall node npm  # Example

# Fix 3: Check disk space
df -h
# Need at least 100MB free
```

---

## Getting Help

### Information to Gather

Before reporting issues, collect:

```bash
# System info
uname -a
bash --version
jq --version
ccusage --version

# Statusline info
ls -la ~/.claude/statusline.sh
bash -n ~/.claude/statusline.sh  # Syntax check

# Recent logs
~/.claude/statusline.sh --debug
tail -50 ~/.claude/statusline.log

# Cache state
ls -la ~/.claude/.*.json
jq . ~/.claude/.ccusage_cache.json 2>&1

# Git status
git -C ~/.claude status
git -C ~/.claude log --oneline -5
```

### Debug Output

```bash
# Capture full execution trace
~/.claude/statusline.sh --debug 2>&1 | tee /tmp/debug.log

# Share relevant portions
tail -100 /tmp/debug.log
```

---

**Last Updated:** 2026-01-15
**Version:** 1.0.0
