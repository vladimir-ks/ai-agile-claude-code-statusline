# Statusline Data Points Specification

**Version**: 1.0
**Status**: SPECIFICATION
**Date**: 2026-01-31

---

## Display Format Reference

```
LINE 1: 📁:DIRECTORY 🌿:BRANCH 🤖:MODEL 🧠:CONTEXT[PROGRESSBAR]
LINE 2: 🕐:TIME|⌛:DAILY(%)RESET|📅:WEEKLY(%)@DAY 💰:COST|RATE 📊:TOKENS 💬:TURNS
LINE 3: 💬:(ELAPSED) PREVIEW
```

---

## Data Points Catalog

### 1. 📁 DIRECTORY

| Attribute | Value |
|-----------|-------|
| **Source** | stdin JSON `start_directory` OR `process.cwd()` |
| **Update Frequency** | Every display (real-time) |
| **Freshness Guarantee** | Always fresh (stdin is authoritative) |
| **Truncation Rule** | NEVER truncate |
| **Display Width** | Full path, use `~` for home |
| **Fallback** | `process.cwd()` if stdin missing |

**Current Problem**: Truncating long folders to `…`
**Required Fix**: Remove truncation, always show full path

**Pipeline**:
```
stdin → display-only.ts → output
```

---

### 2. 🌿 BRANCH (Git)

| Attribute | Value |
|-----------|-------|
| **Source** | `git branch --show-current` |
| **Update Frequency** | 30-second cooldown per repository |
| **Freshness Guarantee** | ≤30 seconds stale |
| **Truncation Rule** | NEVER truncate branch name |
| **Display Format** | `branch+ahead*dirty` |
| **Fallback** | Empty string if not git repo |

**Current Problem**: None (fixed - per-repo cooldown works)

**Pipeline**:
```
git commands → GitModule → cooldown file (with result) → data-gatherer → health file
display-only reads health file → output
```

**Cooldown File**: `~/.claude/session-health/cooldowns/git-status-{repoHash}.cooldown`

---

### 3. 🤖 MODEL

| Attribute | Value |
|-----------|-------|
| **Source** | 1) stdin JSON 2) transcript 3) settings.json |
| **Update Frequency** | Every display |
| **Freshness Guarantee** | Always fresh |
| **Truncation Rule** | Width-based shortening only |
| **Display Variants** | Full: `Opus4.5` → Short: `Op4` |

**Width Adaptation**:
| Width | Format |
|-------|--------|
| ≥120 | `Opus4.5` |
| 100-119 | `Op4.5` |
| 80-99 | `Op4` |
| <80 | Move to Line 2 |

**Pipeline**:
```
stdin/transcript → ModelResolver → health.model → display
```

---

### 4. 🧠 CONTEXT (Tokens)

| Attribute | Value |
|-----------|-------|
| **Source** | stdin JSON `tokens_used`, `tokens_left` |
| **Update Frequency** | Every display (real-time) |
| **Freshness Guarantee** | Always fresh |
| **Truncation Rule** | Width-based shortening |
| **Display Format** | `Xk-free[PROGRESSBAR]` |

**Width Adaptation**:
| Width | Format |
|-------|--------|
| ≥120 | `154k-free[---------|--]` |
| 100-119 | `154k[---|]` |
| 80-99 | `154k` |
| <80 | Move to Line 2 |

**Progress Bar**:
- 10 segments + threshold marker at 78%
- `|` marker shows compaction threshold
- Example: `[=======|---]` = 70% used

**Pipeline**:
```
stdin JSON → calculateContext() → health.context → display
```

---

### 5. 🕐 TIME

| Attribute | Value |
|-----------|-------|
| **Source** | `Date.now()` |
| **Update Frequency** | Every display (real-time) |
| **Freshness Guarantee** | Always fresh |
| **Truncation Rule** | None |
| **Display Format** | `HH:MM` (local time) |

**Condition**: Only show when ALL other data is fresh
- If any data is stale, show staleness indicator instead

**Pipeline**:
```
Date.now() → formatTime() → output
```

---

### 6. ⌛ DAILY BUDGET

| Attribute | Value |
|-----------|-------|
| **Source** | ccusage OR OAuth API |
| **Update Frequency** | 5-minute cooldown |
| **Freshness Guarantee** | ≤5 minutes stale (with client-side adjustment) |
| **Truncation Rule** | None |
| **Display Format** | `XhXm(%)@RESET` or `Xm(%)@RESET` |

**Data Fields**:
| Field | Source | Meaning |
|-------|--------|---------|
| `budgetRemaining` | ccusage projection.remainingMinutes | Minutes until 5h window ends |
| `budgetPercentUsed` | Calculated from elapsed/total | % of 5h window consumed |
| `resetTime` | ccusage block.endTime | When window resets (HH:MM UTC) |

**Client-Side Adjustment** (CRITICAL):
```typescript
const ageMinutes = (Date.now() - billing.lastFetched) / 60000;
const adjustedRemaining = Math.max(0, budgetRemaining - ageMinutes);
```

**Pipeline**:
```
ccusage/OAuth → CCUsageSharedModule → billing-shared.json → data-gatherer → health
display-only reads → adjusts client-side → output
```

**Current Problem**: ccusage sometimes returns wrong data
**Root Cause**: Process lock contention, dead process locks

---

### 7. 📅 WEEKLY BUDGET

| Attribute | Value |
|-----------|-------|
| **Source** | OAuth API ONLY (ccusage doesn't provide) |
| **Update Frequency** | 5-minute cooldown (same as daily) |
| **Freshness Guarantee** | ≤5 minutes stale |
| **Truncation Rule** | None |
| **Display Format** | `Xh(%)@DAY` |

**Data Fields**:
| Field | Source | Meaning |
|-------|--------|---------|
| `weeklyBudgetRemaining` | OAuth `weekly_quota_remaining_usd` / burn rate | Hours until weekly quota exhausted |
| `weeklyBudgetPercentUsed` | OAuth `weekly_quota_percentage_used` | % of weekly quota used |
| `weeklyResetDay` | OAuth `weekly_reset_time` | Day name (Mon, Tue, etc.) |

**Current Problem**: NOT DISPLAYING - OAuth API returns 401
**Root Cause**: Using wrong API endpoint

**Pipeline**:
```
OAuth API → AnthropicOAuthAPI → billing-shared.json → health → display
```

---

### 8. 💰 COST

| Attribute | Value |
|-----------|-------|
| **Source** | ccusage OR OAuth API |
| **Update Frequency** | 5-minute cooldown |
| **Freshness Guarantee** | ≤5 minutes stale |
| **Truncation Rule** | Decimal places based on value |
| **Display Format** | `$X|$Y/h` |

**Data Fields**:
| Field | Source | Meaning |
|-------|--------|---------|
| `costToday` | ccusage block.costUSD | Daily spend in USD |
| `burnRatePerHour` | ccusage block.burnRate.costPerHour | Extrapolated hourly rate |

**Format Rules**:
| Cost | Format |
|------|--------|
| <$1 | `$0.95` |
| $1-$10 | `$5.2` |
| $10-$100 | `$42` |
| ≥$100 | `$172` |

**Pipeline**:
```
ccusage → CCUsageSharedModule → billing-shared.json → health → display
```

---

### 9. 📊 TOKENS

| Attribute | Value |
|-----------|-------|
| **Source** | ccusage block.totalTokens |
| **Update Frequency** | 5-minute cooldown |
| **Freshness Guarantee** | ≤5 minutes stale |
| **Truncation Rule** | Scientific notation for large values |
| **Display Format** | `X.XMtok(Xktpm)` |

**Data Fields**:
| Field | Meaning |
|-------|---------|
| `totalTokens` | Total tokens processed in session |
| `tokensPerMinute` | Token throughput rate |

**Format Rules**:
| Tokens | Format |
|--------|--------|
| <1K | `500tok` |
| 1K-1M | `150ktok` |
| ≥1M | `83.4Mtok` |

---

### 10. 💬 TURNS

| Attribute | Value |
|-----------|-------|
| **Source** | Transcript file line count |
| **Update Frequency** | Incremental on each display |
| **Freshness Guarantee** | Always fresh |
| **Display Format** | `Xt` |

**Pipeline**:
```
transcript file → IncrementalTranscriptScanner → health.transcript.messageCount → display
```

---

### 11. 💬 LAST MESSAGE

| Attribute | Value |
|-----------|-------|
| **Source** | Transcript file last line |
| **Update Frequency** | Incremental on each display |
| **Freshness Guarantee** | Always fresh |
| **Truncation Rule** | Fit remaining width |
| **Display Format** | `(ELAPSED) PREVIEW...` |

**Data Fields**:
| Field | Meaning |
|-------|---------|
| `lastModifiedAgo` | Time since transcript update |
| `lastMessagePreview` | First 100 chars of last message |

---

## Width Adaptation Rules

### Line 1 Components (Priority Order)

Components move to Line 2 when width < threshold:

| Priority | Component | Threshold | Action |
|----------|-----------|-----------|--------|
| 1 | Directory | NEVER | Never truncate or move |
| 2 | Git | NEVER | Never truncate or move |
| 3 | Model | 100 chars | Shorten, then move to L2 at <80 |
| 4 | Context | 100 chars | Shorten, then move to L2 at <80 |

### Line 2 Components

All stay on Line 2, compress format at narrow widths:

| Width | Format |
|-------|--------|
| ≥120 | Full format with all metrics |
| 100-119 | Shorter format, fewer decimal places |
| 80-99 | Minimal format, essential data only |
| <80 | Critical data only (time, budget) |

---

## Data Pipeline Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      DATA SOURCES                                │
├─────────────────────────────────────────────────────────────────┤
│  stdin JSON        git commands      ccusage        transcript  │
│  (real-time)       (30s cooldown)    (5min cooldown) (real-time)│
└──────┬──────────────────┬───────────────┬────────────────┬──────┘
       │                  │               │                │
       v                  v               v                v
┌─────────────────────────────────────────────────────────────────┐
│                      DATA GATHERER                               │
│  Orchestrates all data collection, writes to health files       │
└──────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────┐
│                      HEALTH FILES                                │
│  ~/.claude/session-health/{session-id}.json                     │
│  ~/.claude/session-health/billing-shared.json                   │
└──────────────────────────────────────────────────────────────────┘
                              │
                              v
┌─────────────────────────────────────────────────────────────────┐
│                      DISPLAY-ONLY                                │
│  Fast read (<2ms), client-side adjustments, outputs statusline  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Freshness Guarantees

| Data Point | Max Staleness | Refresh Mechanism |
|------------|---------------|-------------------|
| Directory | 0 | Real-time stdin |
| Git | 30 seconds | Per-repo cooldown |
| Model | 0 | Real-time stdin |
| Context | 0 | Real-time stdin |
| Time | 0 | Real-time |
| Daily Budget | 5 minutes | Cooldown + client-side adjust |
| Weekly Budget | 5 minutes | Cooldown + OAuth API |
| Cost | 5 minutes | Cooldown |
| Tokens | 5 minutes | Cooldown |
| Turns | 0 | Real-time transcript scan |
| Last Message | 0 | Real-time transcript scan |

---

## Fixed Issues (Session 2026-01-31)

### FIXED ✅

1. **Directory Truncation** - FIXED
   - Was: Truncating long folders to `…`
   - Now: Full path always shown, only `~` substitution for home
   - File: `statusline-formatter.ts:truncateLongFolders()`

2. **Weekly Budget Missing** - FIXED
   - Was: Not displayed (OAuth API not working)
   - Now: Shows `📅:30h(81%)@Mon` - hours until Monday reset, week progress
   - File: `force-billing-refresh.ts` + `data-gatherer.ts`

3. **Billing Data Inconsistent** - FIXED
   - Was: Random values from lock contention
   - Now: Process lock properly releases dead locks, ccusage runs reliably
   - Files: `process-lock.ts`, `ccusage-shared-module.ts`

4. **Git Cooldown Cross-Repo Blocking** - FIXED
   - Was: System-wide cooldown blocked all repos
   - Now: Per-repository cooldown with hash in filename
   - Files: `cooldown-manager.ts`, `git-module.ts`

### PENDING

5. **Model/Context Width Adaptation**
   - Current: Fixed format regardless of width
   - Required: Adaptive shortening/moving per spec
   - File: `statusline-formatter.ts`

6. **Staleness Indicators**
   - Current: No visual indicator of data age
   - Required: Show `(Xm)` for stale data
   - File: `statusline-formatter.ts`

7. **OAuth API Integration**
   - Current: 401 Unauthorized from Anthropic API
   - Required: Get authoritative weekly quota from API
   - File: `anthropic-oauth-api.ts`

---

## Files Reference

| File | Purpose |
|------|---------|
| `display-only.ts` | Fast display layer (<2ms) |
| `data-gatherer.ts` | Orchestrates all data collection |
| `statusline-formatter.ts` | Pre-formats output for all widths |
| `ccusage-shared-module.ts` | Fetches billing from ccusage |
| `anthropic-oauth-api.ts` | Fetches billing from OAuth API |
| `git-module.ts` | Fetches git status |
| `cooldown-manager.ts` | Manages operation cooldowns |
| `process-lock.ts` | Prevents concurrent ccusage |

---

## Testing Checklist

- [ ] Directory shows full path, never truncated
- [ ] Git branch shows full name, never truncated
- [ ] Model adapts to width (full → short → L2)
- [ ] Context adapts to width (full → short → L2)
- [ ] Daily budget accurate within 1 minute
- [ ] Weekly budget displays correctly
- [ ] Cost matches ccusage output
- [ ] Staleness indicator shows for data >5min old
- [ ] Width 80, 100, 120, 200 all display correctly

---

**Document Version**: 1.0
**Last Updated**: 2026-01-31T18:14:00Z
