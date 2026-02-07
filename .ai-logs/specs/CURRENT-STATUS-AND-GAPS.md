# Current Status & Feature Gaps Analysis

**Date**: 2026-02-07
**Version**: V2 (after Unified Data Broker migration)

---

## What You're NOT Seeing (Missing Features)

### 1. **Slot/Account Indicator** ❌ PARTIALLY WORKING

**Expected**: `|S1`, `|S2`, etc. after time/budget on Line 2
**Current Status**: Code exists in `fmtSlotIndicator()` but may not be displaying
**Location**: `v2/src/lib/statusline-formatter.ts:670-686`

**Implementation Status**:
- ✅ SessionLockManager reads lock file
- ✅ Extracts slot number from `slotId`
- ✅ Color-codes based on quota percentage
- ❓ **Needs verification**: Is lock file being created correctly?

**Testing Required**:
```bash
# Check if session lock exists
ls ~/.claude/session-health/*.lock

# View lock content
cat ~/.claude/session-health/<session-id>.lock | jq '.'
```

---

### 2. **Slot Switch Notifications** ❌ NOT DISPLAYING

**Expected**: Line 4-5 showing:
```
💡 Consider switching to slot-2 (95% → 35% quota)
```

**Current Status**: Infrastructure exists but likely not triggering

**Components**:
- ✅ `NotificationManager` - stores notifications
- ✅ `buildNotifications()` - formats notification lines
- ✅ `QuotaBrokerClient.getSwitchMessage()` - generates recommendation
- ❌ **Missing**: Notifications not showing in actual output

**Root Causes**:
1. Notifications may be registered but not active (dismissed or expired)
2. `NotificationManager.getActive()` may return empty array
3. Intermittent display pattern (show 30s, hide 5min) may be hiding them

**Debug Steps**:
```bash
# Check notification state
cat ~/.claude/session-health/notifications.json | jq '.'

# Check if slot switch is being triggered
grep "slot_switch" ~/.claude/session-health/daemon.log
```

---

### 3. **Session Bootstrap Info** ❌ MISSING

**Expected**: At session **START**, display current account + quota:
```
🚀 Session started on slot-2 (user@example.com)
   Current quota: 42h/50h remaining (16% used)
   Weekly reset: Monday 14:00
```

**Current Status**: NOT IMPLEMENTED

**What's Missing**:
- No special "first invocation" detection
- No bootstrap message in statusline output
- Session lock created by daemon, but user doesn't see confirmation

**Implementation Plan**:
1. Add `isFirstInvocation` flag to SessionHealth
2. Detect: lock file created in last 5 seconds
3. Generate bootstrap notification
4. Display for 10 seconds, then dismiss

---

## What IS Working ✅

### Line 1: Directory + Git + Model + Context
✅ Directory path
✅ Git branch + ahead/behind + dirty count
✅ Model name (with abbreviation for narrow terminals)
✅ Context tokens left + progress bar

### Line 2: Time + Budget + Cost + Usage
✅ Current time
✅ Daily budget remaining + percentage
✅ Weekly budget + reset day
✅ Daily cost + burn rate
✅ Total tokens + TPM
✅ Turn count

### Line 3: Last Message
✅ Elapsed time since last message
✅ Message preview (truncated)
✅ System message filtering

### Data Pipeline
✅ UnifiedDataBroker orchestrates all 12 data sources
✅ Billing cascade (OAuth → ccusage → local)
✅ Quota cascade (broker → hotswap → subscription)
✅ Cross-process coordination (single-flight locks)
✅ Atomic writes (all JSON files)
✅ 1289 tests passing

---

## Missing Features Summary

| Feature | Status | Priority | Effort |
|---------|--------|----------|--------|
| Slot indicator (|S1) | Partially implemented | **HIGH** | 1h (debug) |
| Slot switch notifications | Infrastructure exists | **HIGH** | 2h (debug + display logic) |
| Session bootstrap message | Not implemented | **MEDIUM** | 4h (detection + formatting) |
| Version update notification | Implemented but not tested | **LOW** | 1h (manual test) |
| Auto-restart mechanism | Planned, not implemented | **LOW** | 8h+ |

---

## Immediate Action Items

### 1. **Debug Slot Indicator** (1h)
**Why it might not show:**
- Lock file not being created
- Lock file created but `slotId` field missing
- Slot indicator logic broken
- Width calculation drops it from Line 2

**Fix**:
1. Add debug logging to `fmtSlotIndicator()`
2. Verify lock file exists and has correct structure
3. Ensure `SessionLockManager.getOrCreate()` is called in data-daemon

---

### 2. **Fix Slot Switch Notifications** (2h)
**Current Flow**:
```
DataGatherer.gather() (step 11g)
  → QuotaBrokerClient.getSwitchMessage()
  → NotificationManager.register('slot_switch', msg, priority=6)
  → StatuslineFormatter.buildNotifications()
  → getActive() filters by intermittent display pattern
```

**Why it might fail**:
- `getActive()` may filter out notifications
- Intermittent display logic may hide them
- Notification priority too low (sorted wrong)

**Fix**:
1. Check `NotificationManager.getActive()` logic
2. Verify display pattern (show 30s, hide 5min)
3. Test with manual notification registration

---

### 3. **Add Session Bootstrap Message** (4h)
**Implementation**:
1. Add `sessionBootstrap` field to SessionHealth
2. Detect first invocation:
   ```typescript
   const lock = SessionLockManager.read(sessionId);
   const isFirstInvocation = lock && (Date.now() - lock.createdAt) < 5000;
   ```
3. Generate bootstrap message in UnifiedDataBroker
4. Display in `buildNotifications()` with special formatting
5. Auto-dismiss after 10 seconds

---

## Testing Checklist

Before claiming "feature complete":

- [ ] Slot indicator shows on Line 2 for all sessions
- [ ] Slot switch notification appears when quota >95% and alternative <50%
- [ ] Session bootstrap shows account + quota on first statusline call
- [ ] Version update notification appears when new version available
- [ ] Notifications follow intermittent display pattern (show 30s, hide 5min)
- [ ] Manual dismissal works (`NotificationManager.dismiss()`)
- [ ] Multi-session scenario: each session shows its own slot
- [ ] Account switch mid-session: lock file immutable, slot doesn't change

---

## Code Locations Reference

| Feature | File | Function |
|---------|------|----------|
| Slot indicator | `statusline-formatter.ts` | `fmtSlotIndicator()` (line 670) |
| Notifications | `statusline-formatter.ts` | `buildNotifications()` (line 831) |
| Slot switch logic | `data-gatherer.ts` | `gather()` step 11g (line 207) |
| Session lock | `session-lock-manager.ts` | `getOrCreate()` |
| Notification manager | `notification-manager.ts` | `register()`, `getActive()` |
| Quota broker | `quota-broker-client.ts` | `getSwitchMessage()` |

---

## Next Steps

1. **Run diagnostic** to see why slot indicator isn't showing
2. **Test notification system** manually
3. **Implement session bootstrap** if time permits
4. **Document** expected behavior vs actual behavior
5. **Create test scenarios** for each missing feature
