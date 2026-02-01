# Statusline Format Enhancement Proposal

**Date**: 2026-01-31
**Status**: Draft for Review

---

## Current Issues

### Issue 1: False Positive - GitLeaks Path Detection
**Problem**: GitLeaks temp file path being detected as secret
```json
"secretTypes": ["/var/folders/k_/jtdmydws2590pd_p6x5gm_m80000gn/T/gitleaks"]
```

**Cause**: Secrets scanner includes file paths in secret types (should only include secret category names)

**Fix**: Filter out file paths, only keep secret type names (API Key, Private Key, etc.)

**Impact**:
- `🔴SEC` alert at beginning (false alarm)
- Confusing display at end showing path instead of type

---

### Issue 2: Unclear Secrets Display
**Current**: `🔐API` or `🔐3types` at end of statusline
**Problem**: Not immediately clear what this means

**Proposed**: More explicit format
- Single secret: `🔐 Secrets: API Key`
- Multiple: `🔐 Secrets: 3 types`
- Or even shorter: `⚠️ Secrets!` (critical alert style)

---

### Issue 3: Only Daily Quota Shown
**Current**: `⌛:5h30m(73%)14:00` - Shows only 5-hour daily budget
**Problem**: Weekly quota is more relevant for planning work

**Enhancement**: Add weekly quota display alongside daily

---

## Proposed Format Changes

### Option 1: Enhanced with Weekly Quota (Recommended)

```
Line 1:
📁:~/project 🌿:main 🤖:Opus4.5 👤:work 🧠:154k[---------|--] 🕐:12:06

Line 2:
⌛:5h30m(73%)→14:00 📅:28h15m(41%)→Mon 💰:$40|$15/h 📊:83M(521k/m) 💬:42t(<5m)
```

**New Components**:
- `👤:work` - Auth profile being used (from `launch.authProfile`)
- `📅:28h15m(41%)→Mon` - Weekly budget remaining (41% of 168h week used)
- `(<5m)` - Time since last message (integrated with turn count)

**Removed**:
- Cache hit ratio (low value, rarely changes)
- Separate transcript sync indicator (integrated into last message timing)

---

### Option 2: Compact with Project Context

```
Line 1:
📁:ai-agile 🐍 🌿:main 🤖:Opus@work 🧠:154k[---------|--] ⏱:2h15m 🕐:12:06

Line 2:
⌛:5h30m(73%) 📅:28h(41%/wk) 💰:$40|$15/h 📊:83M 💬:42(<5m) Recent: What does...
```

**New Components**:
- `🐍` - Project language indicator (Python, TypeScript, Rust, Go, etc.)
- `@work` - Auth profile suffix on model (shows which account)
- `⏱:2h15m` - Session duration
- `/wk` - Clarifies weekly vs daily
- `Recent:` - Label for last message preview

---

### Option 3: Minimal with Smart Alerts

```
Line 1:
📁:project 🌿:main 🤖:Opus4.5@work 🧠:154k[--|] ⌛:5h(73%) 📅:28h/wk 💰:$40 💬:42

Line 2 (only if alerts):
⚠️ Secrets detected: API Key, Private Key  |  📝 Transcript not saved (5m)
```

**Benefits**:
- Cleaner line 1 (most important info)
- Alerts only appear when needed
- More explicit alert messages
- Easy to scan at a glance

---

## Recommended Changes

### High Priority

1. **Fix GitLeaks false positive**
   - Filter out file paths from `secretTypes`
   - Only show actual secret category names

2. **Add weekly quota display**
   - Format: `📅:28h15m(41%)→Mon` or `📅:28h(41%/wk)`
   - Source: OAuth API `quota_limit_usd` → convert to time equivalent

3. **Clarify secrets alert**
   - Change from `🔐3types` to `⚠️ Secrets: 3 types`
   - Or use line 2 for full alert: `⚠️ Secrets detected: API Key, Private Key`

4. **Show auth profile**
   - Add `👤:work` or suffix on model `🤖:Opus@work`
   - Helps track which account is being billed

### Medium Priority

5. **Integrate last message timing**
   - Change `💬:42t` and `💬:(<5m) msg` to `💬:42(<5m)`
   - Saves space, still shows both metrics

6. **Add session duration**
   - Format: `⏱:2h15m` or `📅:2h15m`
   - Useful for tracking how long you've been working

7. **Project language indicator**
   - Add emoji or text: `🐍`, `📦:TS`, `🦀:Rust`
   - Quick visual context for what you're working on

### Low Priority

8. **Remove low-value components** (optional)
   - Cache hit ratio `💾:16%` - rarely actionable
   - Separate transcript sync `📝:2m` - integrated into last message timing

9. **Add performance debug mode** (for debugging)
   - `⚡:12ms` - data gather duration
   - Only shown when debugging enabled

---

## Weekly Quota Calculation

### Data Source: Anthropic OAuth API

```typescript
interface WeeklyQuota {
  weeklyLimitUSD: number;      // $500 per week
  weeklyRemainingUSD: number;  // $300 remaining
  weeklyPercentUsed: number;   // 40% used
  resetDay: string;            // "Monday" (when week resets)
}
```

### Conversion to Time

```typescript
// Calculate time remaining at current burn rate
const burnRatePerHour = billing.burnRatePerHour;
const weeklyBudgetHours = weeklyRemainingUSD / burnRatePerHour;
const weeklyBudgetMinutes = weeklyBudgetHours * 60;

// Format: 28h15m(41%)→Mon
const formatted = `📅:${formatDuration(weeklyBudgetMinutes)}(${weeklyPercentUsed}%)→${resetDay}`;
```

### Alternative: Show Both Daily and Weekly

```
⌛:5h(73%)→14:00  Daily budget
📅:28h(41%)→Mon   Weekly budget
```

Or combined:
```
💰:5h/28h(73%/41%)  Both in one (daily/weekly)
```

---

## Display Width Optimization

Current width budget: **80% of terminal width** (96 chars for 120-char terminal)

### Character Count Analysis

**Current Line 1** (~85 chars):
```
📁:~/long/path 🌿:feature-branch+12*3 🤖:Opus4.5 🧠:154kleft[---------|--] 🕐:12:06
```

**Proposed Line 1** (~90 chars):
```
📁:~/path 🌿:main 🤖:Opus@work 🧠:154k[---|] ⏱:2h15m 🕐:12:06
```

**Savings opportunities**:
- Shorten progress bar: `[---------|--]` → `[---|]` (saves ~6 chars)
- Truncate path more aggressively: `~/long/path/to/project` → `~/...project` (saves ~10 chars)
- Remove redundant "left" text: `154kleft` → `154k` (saves 4 chars)

---

## Secrets Display - Detailed Proposal

### Current Behavior
```typescript
// Line 368-384 in display-only.ts
if (!h.alerts?.secretsDetected) return '';  // Hidden if no secrets

// Single secret
return `🔐${shortName}`;  // e.g., 🔐API

// Multiple secrets
return `🔐${count}types`;  // e.g., 🔐3types
```

### Proposed Changes

**Option A: More Explicit (Recommended)**
```typescript
// Single secret
return `⚠️ Secret: ${fullName}`;  // e.g., ⚠️ Secret: API Key

// Multiple secrets
return `⚠️ Secrets: ${count} types`;  // e.g., ⚠️ Secrets: 3 types
```

**Option B: Critical Alert Style**
```typescript
// Single secret
return `🔴 SECRET EXPOSED`;  // Generic critical alert

// Multiple secrets
return `🔴 ${count} SECRETS EXPOSED`;  // e.g., 🔴 3 SECRETS EXPOSED
```

**Option C: Inline with Types**
```typescript
// Single secret
return `🔐 ${fullName}`;  // e.g., 🔐 API Key

// Multiple secrets (list first 2)
return `🔐 ${types.slice(0,2).join(', ')}${count > 2 ? '...' : ''}`;
// e.g., 🔐 API Key, Private Key...
```

---

## Configuration Options

Add to `ComponentsConfig`:

```typescript
interface ComponentsConfig {
  // Existing
  directory: boolean;
  git: boolean;
  model: boolean;
  context: boolean;
  time: boolean;
  budget: boolean;
  cost: boolean;
  usage: boolean;
  cache: boolean;
  lastMessage: boolean;
  transcriptSync: boolean;
  secrets: boolean;

  // New
  weeklyBudget: boolean;        // Show weekly quota
  authProfile: boolean;         // Show which auth account
  projectLanguage: boolean;     // Show project language
  sessionDuration: boolean;     // Show how long session active
  performanceDebug: boolean;    // Show gather timing (debug)
}
```

---

## Implementation Plan

### Phase 1: Critical Fixes (Immediate)

1. Fix GitLeaks false positive
   - File: `v2/src/modules/secrets-detector-module.ts`
   - Filter out paths from `secretTypes`

2. Improve secrets display clarity
   - File: `v2/src/display-only.ts`
   - Change format to `⚠️ Secret: API Key`

### Phase 2: Weekly Quota (High Value)

3. Add OAuth API weekly quota fetch
   - File: `v2/src/modules/anthropic-oauth-api.ts`
   - Parse weekly limit and remaining from API

4. Add weekly budget formatter
   - File: `v2/src/display-only.ts`
   - New function: `fmtWeeklyBudget()`

5. Update display order
   - Add `📅:` component after daily budget

### Phase 3: Enhanced Context (Nice to Have)

6. Add auth profile display
   - Show `👤:work` or `@work` suffix

7. Add project language
   - Show `🐍`, `📦`, `🦀` emoji

8. Add session duration
   - Show `⏱:2h15m`

### Phase 4: Optimization (Polish)

9. Reduce character count
   - Shorten progress bar
   - Truncate paths more aggressively

10. Add configuration options
    - Allow users to hide/show new components

---

## User Questions

Before implementing, please confirm:

1. **Weekly quota format** - Which do you prefer?
   - `📅:28h15m(41%)→Mon` (verbose, clear)
   - `📅:28h(41%/wk)` (compact)
   - `💰:5h/28h(73%/41%)` (combined daily/weekly)

2. **Secrets display** - Which is clearest?
   - `⚠️ Secret: API Key` (explicit, friendly)
   - `🔴 SECRET EXPOSED` (alarming, generic)
   - `🔐 API Key, Private Key...` (inline list)

3. **Auth profile** - Where to show?
   - `👤:work` (separate component)
   - `🤖:Opus@work` (suffix on model)
   - Both?

4. **Session duration** - Useful?
   - `⏱:2h15m` (show how long you've been working)
   - Or skip to save space?

5. **Project language** - Useful?
   - `🐍`, `📦:TS`, `🦀` (quick visual context)
   - Or skip to save space?

---

## Summary

**Immediate fixes needed**:
1. ✅ GitLeaks false positive (filter paths)
2. ✅ Clearer secrets display format
3. ✅ Add weekly quota support

**High-value additions**:
- Weekly budget display (`📅:`)
- Auth profile indicator (`👤:` or `@work`)
- Session duration (`⏱:`)

**Low priority**:
- Project language emoji
- Performance debug timing
- Remove cache hit ratio

**Your feedback requested on**:
- Preferred format for each component
- Which new components to prioritize
