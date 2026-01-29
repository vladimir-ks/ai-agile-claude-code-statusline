# Context Window Display Diagnostic Guide

## Issue
The 🧠 field shows inaccurate "tokens left" calculations. It appears to be "lying" - showing incorrect values or stale numbers.

## Root Cause Analysis

The context display depends on three critical data sources from Claude Code:

```
tokens_until_compact = (context_window_size × 78%) - (current_input + cache_read)
```

If **any** of these values are wrong, the display will be inaccurate:
1. **context_window_size** - Total context available (default: 200k)
2. **current_input** - Input tokens in current context (resets after /compact)
3. **cache_read** - Cache tokens being used (resets after /compact)

## Diagnostic Process

### Step 1: Enable Debug Mode

Update `~/.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "/Users/vmks/_dev_tools/ai-agile-claude-code-statusline/scripts/statusline.sh --debug",
    "padding": 0
  }
}
```

### Step 2: Run One Statusline Update

Type something in Claude Code to trigger the statusline, then immediately check the log:

```bash
tail -30 ~/.claude/statusline.log
```

Look for output like:
```
[2025-01-21 12:34:56] Status line triggered with input:
{
  "context_window": {
    "context_window_size": 200000,
    "current_usage": {
      "input_tokens": 45000,
      "cache_read_input_tokens": 10000
    }
  },
  ...
}
---
[DEBUG] Context window calculation:
  json_input_provided: 1
  context_window_size: 200000
  current_input: 45000
  cache_read: 10000
  total_input_tokens: 95000 (not used)
  current_context_tokens: 55000
  context_used_pct: 27%
  usable_tokens (78%): 156000
  tokens_until_compact: 101000
  smoothed_tokens: 101000 (before: 101000)
  tokens_display: 101kleft
  context_bar: [===|--------]
```

### Step 3: Interpret the Debug Output

**If json_input_provided is 1:**
- Claude Code IS passing JSON with model and context data ✓
- Problem is likely in the values themselves or the calculation

**If json_input_provided is 0:**
- Claude Code is NOT sending JSON (empty stdin)
- Script uses defaults:
  - context_window_size: 200000 (from default)
  - current_input: 0
  - cache_read: 0
  - Result: Always shows "156kleft" (200k × 78% - 0)
- **This would cause "lying" - showing constant value even as context changes**

### Step 4: Verify the Math

Check if the calculation is correct:
```
tokens_until_compact = usable_tokens - current_context_tokens
                    = (200000 × 78%) - (45000 + 10000)
                    = 156000 - 55000
                    = 101000
```

If this matches what you see in the log, the calculation is correct.

### Step 5: Check for Anomalies

**Problem 1: Constant Value**
```
Symptom: Always shows "156kleft" or same value
Cause: json_input_provided = 0 (Claude Code not passing JSON)
  OR: current_input and cache_read always 0
Solution: Claude Code issue - may not be sending context data
```

**Problem 2: Smoothing Hiding Changes**
```
Symptom: Changes slowly or in jumps (100-token increments)
Cause: smooth_tokens() rounds to nearest 100 tokens
Effect: Masks rapid changes during processing
This is INTENTIONAL - reduces statusline flicker
Not a bug - it's by design
```

**Problem 3: Rapid Changes**
```
Symptom: Displays large jumps between runs
Cause: current_input or cache_read changes significantly
This is NORMAL - happens during active processing
Check if smoothing helps: Enable the smooth_tokens function
```

**Problem 4: Different Value Than Ccusage Reports**
```
Symptom: Statusline shows "50kleft" but ccusage shows different context usage
Cause: Timing difference - statusline shows instantaneous, ccusage may be cached
Solution: These are independent data sources with different refresh rates
           Ccusage cache: 15 minutes
           Statusline context: Real-time from JSON input
Both are correct for their purposes
```

## Quick Test Cases

### Test 1: No Input (Debug Mode)
```bash
echo "" | /Users/vmks/_dev_tools/ai-agile-claude-code-statusline/scripts/statusline.sh --debug
tail ~/.claude/statusline.log | grep "json_input_provided"
# Should show: json_input_provided: 0
# Display should be: 156kleft (default)
```

### Test 2: With Minimal JSON
```bash
cat > /tmp/test.json << 'EOF'
{
  "cwd": "/tmp",
  "context_window": {
    "context_window_size": 200000,
    "current_usage": {
      "input_tokens": 0,
      "cache_read_input_tokens": 0
    }
  }
}
EOF

cat /tmp/test.json | /Users/vmks/_dev_tools/ai-agile-claude-code-statusline/scripts/statusline.sh --debug
tail ~/.claude/statusline.log | grep -A5 "Context window calculation"
# Should show: tokens_until_compact: 156000
# Display should be: 156kleft
```

### Test 3: With Real Usage
```bash
cat > /tmp/test.json << 'EOF'
{
  "cwd": "/tmp",
  "context_window": {
    "context_window_size": 200000,
    "current_usage": {
      "input_tokens": 100000,
      "cache_read_input_tokens": 20000
    }
  }
}
EOF

cat /tmp/test.json | /Users/vmks/_dev_tools/ai-agile-claude-code-statusline/scripts/statusline.sh --debug
tail ~/.claude/statusline.log | grep -A5 "Context window calculation"
# Should show: tokens_until_compact: 36000 (156k - 120k)
# Display should be: 36kleft
```

## Next Steps

1. **Enable debug mode** and run for 5-10 statusline updates
2. **Check the logs** for json_input_provided value
3. **Report findings**:
   - Is json_input_provided always 1 or always 0?
   - What are the context_window_size, current_input, cache_read values?
   - Are they changing as expected?
   - Does the display match the calculation?

## Hypothesis Testing

| Hypothesis | Evidence | Expected Debug Output |
|-----------|----------|---|
| JSON not passed | Always shows "156kleft" | `json_input_provided: 0` |
| JSON incomplete | Shows contextual data but no context_window fields | `context_window_size: 200000` (default) |
| Bad calculation | Display doesn't match math | Log calculation vs displayed value mismatch |
| Smoothing issue | Changes in 100-token jumps | `smoothed_tokens` different from raw value |
| Timing/caching | Shows stale value | Multiple runs show same value when it should change |

