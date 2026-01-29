# Deployment Checklist - V2 Statusline

**Version**: 2.0.1
**Date**: 2026-01-29

---

## Pre-Deployment Tests

### 1. UI Safety Tests (REQUIRED)

```bash
bash v2/tests/test-ui-safety.sh
```

**Expected Result**: All 10 tests pass ✅

**Tests**:
- [x] No trailing newline
- [x] No embedded newlines
- [x] No stderr output
- [x] Output length <500 chars
- [x] Contains expected emojis
- [x] No ANSI escape codes
- [x] Fast execution (<1s)
- [x] Wrapper has no trailing newline
- [x] Exit code 0
- [x] Graceful degradation

---

### 2. Stress Test (REQUIRED)

```bash
bash /tmp/stress-test-v2.sh
```

**Expected Result**: Only 1 ccusage process spawned (not 10) ✅

---

### 3. Output Format Verification (REQUIRED)

```bash
echo '{"model":{"name":"sonnet"},"context_window":{"context_window_size":200000}}' | \
  bun v2/src/index.ts 2>/dev/null | od -c | tail -1
```

**Expected Result**: Output should NOT end with `\n`

**Example**:
```
0000200    :   2   3   :   1   6                        # ✅ NO \n
```

---

### 4. Manual Test (REQUIRED)

```bash
echo '{"model":{"name":"sonnet"},"context_window":{"context_window_size":200000}}' | \
  ~/.claude/statusline-v2.sh
```

**Expected Output**:
```
📁:<path> 🌿:<branch> 🤖:<model> 🧠:<tokens>left[---------|--] 🕐:<time>
```

**Verify**:
- [x] No errors
- [x] Output appears correctly formatted
- [x] No UI corruption

---

## Deployment Steps

### Step 1: Backup Current Configuration

```bash
cp ~/.claude/settings.json ~/.claude/settings.json.backup
```

---

### Step 2: Enable V2 Statusline

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

---

### Step 3: Redeploy Wrapper (if needed)

```bash
cp ~/.claude/statusline-v2.sh ~/.claude/statusline-v2.sh.backup
bun v2/scripts/deploy.ts
```

---

### Step 4: Verify Deployment

```bash
# Test with Claude CLI
claude ask "hello"

# Check for UI corruption
# Statusline should appear correctly at bottom
```

**Verify**:
- [x] Statusline renders correctly
- [x] No UI corruption
- [x] No garbled text
- [x] Updates smoothly

---

## Post-Deployment Monitoring

### First Hour (Critical)

**Monitor every 5 minutes**:

1. **ccusage process count**:
   ```bash
   ps aux | grep ccusage | grep -v grep | wc -l
   ```
   **Expected**: 0 or 1 (NEVER >1)

2. **Lock file age**:
   ```bash
   ls -lh ~/.claude/.ccusage.lock
   ```
   **Expected**: <35 seconds old (or doesn't exist)

3. **UI health**:
   - Run `claude ask "test"`
   - Verify statusline renders correctly
   - No corruption or garbled text

---

### First 24 Hours (Important)

**Monitor every hour**:

1. **Resource usage**:
   ```bash
   top | grep -E "(ccusage|bun)"
   ```
   **Expected**: <200% CPU total

2. **Cache health**:
   ```bash
   ls -lh ~/.claude/.ccusage_cache.json
   cat ~/.claude/.data_freshness.json | jq .
   ```
   **Expected**: Recent modification times

3. **Lock failures** (check logs):
   ```bash
   tail -100 ~/.claude/statusline.log | grep -i "lock"
   ```
   **Expected**: No repeated lock failures

---

## Rollback Procedure

### If Issues Detected

**Immediate Actions**:

1. **Disable statusline**:
   ```bash
   # Remove statusLine section from settings.json
   jq 'del(.statusLine)' ~/.claude/settings.json > /tmp/settings.json
   mv /tmp/settings.json ~/.claude/settings.json
   ```

2. **Kill processes**:
   ```bash
   pkill -9 ccusage
   pkill -9 bun
   ```

3. **Clear locks**:
   ```bash
   rm ~/.claude/.ccusage.lock
   ```

4. **Restore backup**:
   ```bash
   cp ~/.claude/settings.json.backup ~/.claude/settings.json
   ```

---

## Success Criteria

### Required for Production

- [x] All 10 UI safety tests pass
- [x] Stress test passes (only 1 ccusage)
- [x] No trailing newline in output
- [x] Manual test shows correct output
- [x] ProcessLock prevents concurrent spawns
- [x] Fast execution (<1s cached)
- [x] Graceful error handling

### Verification After 1 Hour

- [ ] No UI corruption reported
- [ ] ccusage count never exceeded 1
- [ ] Lock file never stale (>35s)
- [ ] No resource exhaustion
- [ ] Statusline updates correctly

### Verification After 24 Hours

- [ ] No crashes or errors
- [ ] Cache working correctly
- [ ] Performance stable
- [ ] User satisfaction confirmed

---

## Known Issues

### Issue 1: First Fetch Slow (~20s)

**Symptoms**: First ccusage call after UTC midnight takes 20+ seconds

**Expected Behavior**: This is normal - ccusage scans full billing data once per day

**Mitigation**: Cache TTL is "until UTC midnight" for same-day blocks

---

### Issue 2: Red Dot (🔴) Shows Stale Data

**Symptoms**: Staleness indicator appears when ccusage data >1 hour old

**Expected Behavior**: This is correct - warns user data may be outdated

**Mitigation**: Run `STATUSLINE_FORCE_REFRESH=1 claude ask "test"` to force refresh

---

## Emergency Contacts

**Issues to Report Immediately**:
1. UI corruption or garbled text
2. >2 ccusage processes for >5 seconds
3. Lock file age >35 seconds
4. CPU usage >300% sustained
5. Kernel panic or system freeze

**Reporting**:
- GitHub Issues: https://github.com/anthropics/claude-code/issues
- Include: system info, logs, steps to reproduce

---

## Deployment History

| Date | Version | Status | Notes |
|------|---------|--------|-------|
| 2026-01-29 | 2.0.1 | ✅ READY | Fixed trailing newline, all tests pass |
| 2026-01-29 | 2.0.0 | ❌ BROKE UI | Trailing newline broke Claude CLI |
| 2026-01-29 | 2.0.0 | ❌ KERNEL PANIC | Race condition fixed with ProcessLock |
| 2026-01-29 | 1.0.0 | ✅ STABLE | V1 bash script (production baseline) |

---

## Sign-Off

**Developer**: Claude + Vladimir K.S.
**Tested**: 2026-01-29 23:18 UTC
**Status**: ✅ READY FOR PRODUCTION

**Signatures**:
- [x] All pre-deployment tests pass
- [x] Documentation complete
- [x] Rollback plan ready
- [x] Monitoring plan in place

---

**Last Updated**: 2026-01-29 23:18 UTC
