# Data Freshness & Quality Control Audit

**Date**: 2026-01-31 17:17
**Status**: 🔴 **CRITICAL ISSUES FOUND**

---

## Storage Locations

### Primary Files
```
~/.claude/session-health/billing-shared.json       # Shared billing cache (all sessions)
~/.claude/session-health/runtime-state.yaml        # Unified state (105KB)
~/.claude/session-health/{session-id}.json         # Per-session health + formattedOutput
```

### Quick Access Links
```bash
# Billing cache
cat ~/.claude/session-health/billing-shared.json | jq .

# Current session
cat ~/.claude/session-health/a8e855a4-1b42-4793-a1b8-0a533aba93f8.json | jq .billing

# Runtime state (YAML)
cat ~/.claude/session-health/runtime-state.yaml
```

---

## Update Mechanism - HOW IT WORKS

### Data Flow Diagram
```
┌─────────────────┐
│ Claude Code     │ Sends stdin JSON every statusline render
│ (every prompt)  │ Contains: session_id, start_directory, model
└────────┬────────┘
         │ stdin
         ↓
┌─────────────────┐
│ display-only.ts │ FAST READ-ONLY (<2ms)
│                 │ 1. Read {session-id}.json
│                 │ 2. Use pre-formatted output
│                 │ 3. Apply stdin overrides if needed
│                 │ 4. Output to terminal
│                 │ 5. Spawn daemon in background
└────────┬────────┘
         │ spawn background process
         ↓
┌─────────────────┐
│ data-daemon.ts  │ BACKGROUND UPDATE (no time limit)
│                 │ 1. Gather all data
│                 │ 2. Call OAuth API / ccusage
│                 │ 3. Update billing-shared.json
│                 │ 4. Generate formattedOutput
│                 │ 5. Write {session-id}.json
│                 │ 6. Update runtime-state.yaml
└─────────────────┘
```

---

## Update Frequency - BY DATA SOURCE

### Billing Data (OAuth API / ccusage)

**Source Priority**:
1. OAuth API (authoritative - includes weekly quota)
2. ccusage (fallback - daily quota only)

**Update Trigger**: Every daemon run (background after each display)

**Lock Contention Protection**:
- Uses ProcessLock to prevent concurrent ccusage calls
- Max retries: 3
- Lock timeout: 30 seconds
- If locked: Uses cached data from billing-shared.json

**Current Status**: 🔴 **STALE**
```json
{
  "lastFetched": 1769869087305,  // 2026-01-31T14:18:07Z
  "age": "118 minutes ago",       // 🔴 NEARLY 2 HOURS OLD!
  "isFresh": true                 // 🔴 FALSE POSITIVE!
}
```

**Problem**: `isFresh` flag is set to true but data is 118 minutes old!

---

### Weekly Quota Fields

**Source**: OAuth API only (ccusage doesn't provide weekly data)

**Fields**:
- `weeklyBudgetRemaining`: Hours until weekly reset (28.5h)
- `weeklyBudgetPercentUsed`: Percentage used (41%)
- `weeklyResetDay`: Day of week reset ("Mon")
- `weeklyLimitUSD`: Weekly limit in USD (100)

**Update Frequency**: Same as billing data (every daemon run)

**Current Status**: 🔴 **STALE** (118 minutes old)

**Problem**: Weekly data is NOT updating because:
1. OAuth API requires token (may not be set)
2. Falls back to ccusage which doesn't have weekly data
3. Once set, data is cached but not refreshed

---

### Session Health Data

**Update Frequency**: Every daemon run

**Data Sources**:
- Transcript: File stat (real-time)
- Git: `git` command (real-time)
- Context: Stdin JSON (real-time)
- Model: Stdin JSON / transcript (real-time)
- Billing: OAuth/ccusage (🔴 STALE)

---

## Quality Control Mechanisms - CURRENT STATE

### 1. `isFresh` Flag

**Purpose**: Indicate if billing data is current

**Implementation**:
```typescript
// In OAuth API
return { ...billingData, isFresh: true, lastFetched: Date.now() };

// In ccusage
return { ...billingData, isFresh: true, lastFetched: Date.now() };
```

**Problem**:
- Flag is set at fetch time
- Never expires!
- 118-minute-old data still marked `isFresh: true`

**Fix Needed**: Client-side freshness check based on age

---

### 2. Client-Side Time Adjustment

**Purpose**: Decrease budget remaining based on data age

**Implementation** (in StatuslineFormatter):
```typescript
if (health.billing.lastFetched) {
  const ageMinutes = Math.floor((Date.now() - health.billing.lastFetched) / 60000);
  mins = Math.max(0, mins - ageMinutes);
}
```

**Status**: ✅ Working (budget countdown adjusts for staleness)

---

### 3. Stale Data Indicator

**Current**: None for billing data!

**Proposed**: Show 🟠 next to stale data

---

## CRITICAL ISSUES IDENTIFIED

### Issue 1: Weekly Quota Not Updating

**Symptom**: Weekly data shows 28.5h but hasn't updated in 118 minutes

**Root Cause**:
1. OAuth API may not be configured (no ANTHROPIC_API_KEY)
2. Falls back to ccusage which lacks weekly data
3. Once set manually, data is frozen

**Evidence**:
```bash
$ cat ~/.claude/session-health/billing-shared.json | jq .weeklyBudgetRemaining
28.5

$ node -e "console.log(new Date(1769869087305).toISOString())"
2026-01-31T14:18:07.305Z  # 118 minutes ago!
```

**Impact**: User sees stale weekly quota (28.5h) that should be 26.5h now

---

### Issue 2: `isFresh` Flag Misleading

**Problem**: Flag never expires

**Current Logic**:
```typescript
isFresh: true  // Set at fetch time, never updated
```

**Should Be**:
```typescript
isFresh: (Date.now() - lastFetched) < (5 * 60 * 1000)  // Fresh if <5 min old
```

**Impact**: No visual indicator that billing data is stale

---

### Issue 3: No Staleness Indicator in Display

**Current**: Budget shows `⌛:1h30m(46%)` with no indication data is 118 min old

**Should Show**: `⌛:1h30m(46%)🟠` when data >5 minutes old

**Current Implementation**:
```typescript
const stale = !health.billing.isFresh ? `${c('critical')}🔴${rst()}` : '';
parts.push(`⌛:${c('budget')}${timeStr}(${pct}%)${rst()}${stale}`);
```

**Problem**: `isFresh` is always true, so `🔴` never shows!

---

### Issue 4: OAuth API Not Running

**Evidence**: Daemon log shows:
```
[AnthropicOAuthAPI] No OAuth token available
```

**Impact**: System falls back to ccusage (no weekly data) or cached data

**Fix**: Set `ANTHROPIC_API_KEY` environment variable

---

## Proposed Freshness Levels

### Visual Indicators

| Age | Indicator | Meaning | Color |
|-----|-----------|---------|-------|
| <5 min | None | Fresh | - |
| 5-15 min | 🟠 | Slightly stale | Orange |
| 15-60 min | 🟡 | Moderately stale | Yellow |
| >60 min | 🔴 | Very stale | Red |

### Display Examples

```
# Fresh (< 5 min)
⌛:1h30m(46%)

# Slightly stale (5-15 min)
⌛:1h30m(46%)🟠

# Moderately stale (15-60 min)
⌛:1h30m(46%)🟡

# Very stale (> 60 min)
⌛:1h30m(46%)🔴
```

---

## Data Quality Tests Needed

### Test Suite to Create

1. **Billing Age Test**
   - Verify `isFresh` calculated correctly
   - Test staleness indicators appear
   - Verify budget countdown works

2. **Weekly Quota Update Test**
   - Mock OAuth API response
   - Verify weekly fields update
   - Test fallback to cached data

3. **Staleness Visual Test**
   - Create health with old `lastFetched`
   - Verify 🟠/🟡/🔴 appears
   - Test at 5min, 15min, 60min boundaries

4. **OAuth API Integration Test**
   - Test with valid token
   - Test with invalid token
   - Test with no token (fallback)

5. **Client-Side Adjustment Test**
   - Verify budget decreases over time
   - Test with 10-minute-old data
   - Verify never goes negative

---

## Current Data Snapshot

```json
{
  "costToday": 0.19,
  "budgetRemaining": 161,        // Minutes (2h41m)
  "budgetPercentUsed": 46,
  "weeklyBudgetRemaining": 28.5, // Hours
  "weeklyBudgetPercentUsed": 41,
  "lastFetched": 1769869087305,  // 2026-01-31 14:18:07 UTC
  "age": "118 minutes",           // 🔴 STALE!
  "isFresh": true                 // 🔴 WRONG!
}
```

**Actual Current Values** (if fresh):
- Budget remaining: 161 - 118 = 43 minutes (should show ~43m)
- Weekly remaining: 28.5 - 2.0 = 26.5 hours (should show ~26h)

---

## Logging & Observability - CURRENT STATE

### Daemon Log
```bash
tail -f ~/.claude/session-health/daemon.log
```

**Current Output**:
```
[AnthropicOAuthAPI] No OAuth token available
[ProcessLock] Failed to acquire lock: Max retries exceeded
[2026-01-31T17:16:00.852Z] [PID:94619] [INFO] Session updated in 293ms
```

**Missing**:
- ❌ No log of billing data age
- ❌ No warning when data >15 minutes old
- ❌ No OAuth API success/failure details
- ❌ No weekly quota fetch status

**Needed**:
```
[2026-01-31T17:16:00.852Z] [INFO] Session updated in 293ms
[2026-01-31T17:16:00.852Z] [WARN] Billing data is 118 minutes old (STALE)
[2026-01-31T17:16:00.852Z] [INFO] OAuth API: No token, using cached data
[2026-01-31T17:16:00.852Z] [INFO] Weekly quota: 28.5h (from cache, 118min old)
```

---

## Action Items

### Immediate (Critical)

1. **Fix `isFresh` calculation** - Make it client-side based on age
2. **Add staleness indicators** - Show 🟠/🟡/🔴 based on age
3. **Add logging** - Log data age warnings
4. **Test OAuth API** - Verify weekly quota updates

### High Priority

5. **Create freshness tests** - Test all staleness levels
6. **Add age display** - Show "2h ago" next to stale data
7. **Improve daemon logging** - Log billing fetch success/failure

### Medium Priority

8. **Monitor weekly quota** - Verify it updates every daemon run
9. **Add metrics** - Track how often data is stale
10. **Documentation** - Update CLAUDE.md with freshness info

---

**Status**: 🔴 **REQUIRES IMMEDIATE ATTENTION**
**Priority**: CRITICAL (user sees stale data without knowing)
