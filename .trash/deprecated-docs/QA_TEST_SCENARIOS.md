# QA Test Scenarios - Stale Cache Fix (v1.1.0)

## Overview
This document outlines manual QA test scenarios for the stale cache model detection fix. These tests validate the new priority-based model detection system and auto-healing mechanisms.

---

## Prerequisites
- Claude Code installed with the updated statusline
- Access to `~/.claude/settings.json` and `scripts/statusline.sh`
- Ability to switch between models (Haiku, Sonnet, Opus) in Claude Code
- Terminal access for running test scripts

---

## Test Scenario 1: Model Detection Priority (Empty Input)

**Objective:** Verify that empty JSON input falls back to settings.json correctly

**Steps:**
1. Navigate to the statusline script directory
2. Run: `echo "" | ~/.claude/statusline.sh`
3. Verify output shows model from settings.json (configured as "haiku")

**Expected Result:** Shows "Haiku" in the 🤖 field

**Pass Criteria:** ✓ Output contains "Haiku" (or titlecased version of settings.json model)

---

## Test Scenario 2: Model Detection Priority (JSON Input)

**Objective:** Verify JSON input takes priority over settings.json

**Steps:**
1. Create a test JSON file with Sonnet4.5:
```bash
cat > /tmp/test_sonnet.json << 'EOF'
{
  "cwd": "/tmp",
  "workspace": {"current_dir": "/tmp"},
  "model": {"display_name": "Sonnet4.5", "id": "claude-sonnet-4-5-20250929"},
  "context_window": {"context_window_size": 200000, "total_input_tokens": 0, "total_output_tokens": 0, "current_usage": {"input_tokens": 0, "output_tokens": 0}}
}
EOF
```

2. Run: `cat /tmp/test_sonnet.json | ~/.claude/statusline.sh`
3. Verify output shows "Sonnet4.5"

**Expected Result:** Shows "Sonnet4.5" in the 🤖 field (JSON takes priority)

**Pass Criteria:** ✓ Output contains "Sonnet4.5"

---

## Test Scenario 3: Model Switching (Active Session)

**Objective:** Verify model detection updates correctly when switching between models mid-session

**Steps:**
1. Start a Claude Code session with Haiku 4.5
2. Observe statusline shows "Haiku4.5"
3. Switch to Sonnet 4.5 model mid-session
4. Observe statusline for model update

**Expected Result:**
- Initially shows "Haiku4.5"
- After switch, shows "Sonnet4.5" (may take up to 5 seconds due to caching)

**Pass Criteria:** ✓ Statusline correctly reflects current model after switch

---

## Test Scenario 4: Stale Transcript Data NOT Used

**Objective:** Verify that stale transcript data (>1 hour old) doesn't override settings.json

**Steps:**
1. Look at the transcript file age: `stat ~/.claude/projects/*/*.jsonl | grep Modify`
2. If transcript is older than 1 hour, it should be ignored
3. Run: `echo "" | ~/.claude/statusline.sh`
4. Verify it shows model from settings.json, NOT from stale transcript

**Expected Result:** Shows "Haiku" (from settings.json), not "Sonnet" (from old transcript)

**Pass Criteria:** ✓ Settings.json model is used, not stale transcript

---

## Test Scenario 5: Force Refresh Mechanism

**Objective:** Verify STATUSLINE_FORCE_REFRESH=1 clears all caches

**Steps:**
1. Run statusline once: `echo "" | ~/.claude/statusline.sh`
2. Verify cache files exist: `ls -la ~/.claude/.{statusline.hash,git_status_cache,last_model_name} 2>/dev/null | wc -l`
3. Force refresh with: `STATUSLINE_FORCE_REFRESH=1 bash -c 'echo "" | ~/.claude/statusline.sh'`
4. Verify caches were cleared: `ls -la ~/.claude/.{statusline.hash,git_status_cache,last_model_name} 2>/dev/null | wc -l`
5. Run statusline again: `echo "" | ~/.claude/statusline.sh`
6. Verify new caches are created

**Expected Result:**
- Before force refresh: 2-3 cache files exist
- After force refresh: cache files cleared
- After normal run: new caches recreated

**Pass Criteria:** ✓ Force refresh clears specified cache files

---

## Test Scenario 6: TTL Validation (Transcript Age)

**Objective:** Verify transcript data TTL prevents stale data from being used

**Steps:**
1. Check transcript file modification time: `stat -f %Sm ~/.claude/projects/*/*.jsonl 2>/dev/null | head -1`
2. If file is older than 1 hour, it should be ignored by fallback logic
3. Run: `echo "" | ~/.claude/statusline.sh`
4. Verify it uses settings.json (Haiku), not transcript model

**Expected Result:** Shows model from settings.json, not transcript

**Pass Criteria:** ✓ TTL validation prevents stale transcript usage

---

## Test Scenario 7: Empty Settings.json Fallback

**Objective:** Verify that if settings.json has no model, transcript is used (if fresh)

**Steps:**
1. Temporarily remove model from settings.json
2. Run statusline
3. Verify it shows model from recent transcript (if available)
4. Restore settings.json model

**Expected Result:** Falls through to transcript fallback

**Pass Criteria:** ✓ Correct fallback chain: JSON → settings → transcript → default

---

## Test Scenario 8: Rapid Model Switching

**Objective:** Verify statusline responds immediately to model changes

**Steps:**
1. Switch models rapidly in Claude Code (Haiku → Sonnet → Opus)
2. Observe statusline updates quickly
3. Trigger multiple statusline updates by typing in Claude Code

**Expected Result:** Model field updates within 1-2 seconds of actual model change

**Pass Criteria:** ✓ No significant lag between model switch and display update

---

## Test Scenario 9: Debug Mode Verification

**Objective:** Verify debug mode logs model detection decisions

**Steps:**
1. Enable debug mode: `jq '.statusLine.command = "STATUSLINE_FORCE_REFRESH=1 ~/.claude/statusline.sh --debug"' ~/.claude/settings.json > /tmp/s.json && mv /tmp/s.json ~/.claude/settings.json`
2. Type a message in Claude Code to trigger statusline
3. Check debug log: `tail -20 ~/.claude/statusline.log`
4. Restore settings.json

**Expected Result:** Log shows model selection logic (which layer was used)

**Pass Criteria:** ✓ Debug output includes model detection decision

---

## Test Scenario 10: No Regressions (Existing Features)

**Objective:** Verify existing statusline features still work after changes

**Steps:**
1. Check git status updates: `cd ~/.claude && git status; echo "" | ~/.claude/statusline.sh` (should show dirty count)
2. Check context window display works
3. Check cost data displays correctly (if ccusage available)
4. Check cache hit ratio displays

**Expected Result:** All existing features work unchanged

**Pass Criteria:** ✓ Git, context, cost, and cache metrics all display

---

## Regression Test Suite

Run the automated tests:
```bash
bash examples/test.sh
```

Should show:
- ✓ Test 0a: JSON model priority
- ✓ Test 0b: Settings.json fallback
- ✓ Test 0c: Force refresh mechanism
- ✓ All original tests 1-10

---

## Known Limitations

1. **TTL is 1 hour:** Transcript data older than 1 hour is ignored. This is intentional to prevent stale data.

2. **Force refresh is manual:** Users must explicitly use `STATUSLINE_FORCE_REFRESH=1` for immediate cache clear. Auto-refresh happens every 1 hour for transcript data.

3. **Case sensitivity:** Model names must match configured values (e.g., "haiku" in settings.json becomes "Haiku" in display)

---

## Troubleshooting Guide

### Symptom: Statusline shows wrong model
**Solution:**
1. Check model in settings.json: `jq '.model' ~/.claude/settings.json`
2. Force refresh: `STATUSLINE_FORCE_REFRESH=1 bash -c 'echo "" | ~/.claude/statusline.sh'`
3. Check debug log: `~/.claude/statusline.sh --debug` and review log

### Symptom: Statusline shows blank
**Solution:**
1. Check jq is installed: `jq --version`
2. Check dependencies: `bash -n ~/.claude/statusline.sh`
3. Run with debug: `~/.claude/statusline.sh --debug`

### Symptom: Force refresh not working
**Solution:**
1. Verify variable is set: `echo $STATUSLINE_FORCE_REFRESH`
2. Try direct invocation: `STATUSLINE_FORCE_REFRESH=1 echo "" | ~/.claude/statusline.sh`
3. Check permissions on cache files: `ls -la ~/.claude/.{statusline.hash,git_status_cache}`

---

## Sign-Off Checklist

After QA testing, confirm:
- [ ] Test 1: Empty input fallback works (shows Haiku)
- [ ] Test 2: JSON input priority works (shows Sonnet4.5)
- [ ] Test 3: Model switching detected
- [ ] Test 4: No stale Sonnet shown when it shouldn't be
- [ ] Test 5: Force refresh clears caches
- [ ] Test 6: TTL prevents old transcript usage
- [ ] Test 7: Fallback chain works correctly
- [ ] Test 8: Rapid switching doesn't break display
- [ ] Test 9: Debug mode provides useful info
- [ ] Test 10: Existing features unaffected
- [ ] Regression tests pass: `bash examples/test.sh`

---

**Document Version:** 1.0
**Last Updated:** 2025-01-20
**Target Audience:** QA Engineers, Integration Testers
**Status:** Ready for Manual Testing
