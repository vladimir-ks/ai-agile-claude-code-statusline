# Statusline V2 Enhancement Plan

**Date**: 2026-01-31
**Priority**: CRITICAL (fixes broken time calculations)

---

## Critical Issues Identified

### Issue 1: Billing Cache Too Old (CRITICAL)
**Problem**: Budget shows 3h31m remaining when reset is in 19 minutes
- Last fetched: 09:28 UTC (3 hours ago)
- Shows: `budgetRemaining: 211` minutes (stale data from 3 hours ago)
- Should show: ~19 minutes (current time 12:41, reset at 13:00)

**Root cause**: Billing cache TTL is 2 minutes, but data isn't being refreshed

**Fix**:
1. Reduce billing cache to 1 minute (from 2min)
2. Add client-side time adjustment: `budgetRemaining - (now - lastFetched)`
3. Force refresh if data is >5min old

**Files**:
- `v2/src/display-only.ts` - Add time adjustment on line 311
- `v2/src/modules/ccusage-shared-module.ts` - Reduce TTL to 60s

---

### Issue 2: Duplicate Secrets Display
**Problem**: Shows `🔴SEC` at beginning AND `🔐` at end

**Fix**: Remove end display, keep only beginning with clearer format
- Change `🔴SEC` to `⚠️ Secrets!` or `⚠️ API Key`
- Remove secrets from end of statusline (line 519)

**Files**:
- `v2/src/display-only.ts` - Lines 391-392 (health status), line 519 (remove)

---

### Issue 3: Spacing Inefficiency
**Problem**: Time and budget wrap to separate lines

**Fix**: Remove extra spaces, ensure they stay together
- Combine time + budget + weekly into one section
- Format: `🕐:12:41 ⌛:3h31m(73%)@14:00|📅:28h(41%)@Mon`

**Files**:
- `v2/src/display-only.ts` - Lines 499-502 (build order)

---

## New Requirements

### Requirement 1: Enhanced Budget Display

**Format**:
```
⌛:3h31m(73%)@14:00 | 📅:28h(41%)@Mon
```

**Components**:
- Daily budget: `3h31m` (hours remaining in 5h window)
- Daily %: `73%` (percentage of 5h window used)
- Daily reset: `@14:00` (when 5h window resets)
- Separator: ` | `
- Weekly budget: `28h` (full hours until weekly reset)
- Weekly %: `41%` (percentage of weekly quota used)
- Weekly reset: `@Mon` (day of week when resets)

**Data sources**:
- Daily: From existing `billing.budgetRemaining`, `billing.budgetPercentUsed`, `billing.resetTime`
- Weekly: NEW - needs OAuth API integration

---

### Requirement 2: Smart Component Visibility

**Configuration per component**:

```typescript
interface ComponentVisibility {
  // Threshold rules
  showOnlyIf?: {
    min?: number;      // Show only if value >= min
    max?: number;      // Show only if value <= max
  };

  // Rotation timing (show/hide cycle)
  rotation?: {
    showDuration: number;   // ms to show
    hideDuration: number;   // ms to hide
    lastShown?: number;     // timestamp of last display
  };

  // Conditional display
  showOnChange?: boolean;   // Show briefly when value changes
  changeDuration?: number;  // ms to show after change
}
```

**Examples**:

```typescript
// Turns: Only show if > 1000
turns: {
  showOnlyIf: { min: 1000 }
}

// Cache: Only show if < 95%
cache: {
  showOnlyIf: { max: 95 }
}

// Tokens: Show every 5min, hide for 1hr
tokens: {
  rotation: {
    showDuration: 5 * 60 * 1000,      // 5 minutes
    hideDuration: 60 * 60 * 1000      // 1 hour
  }
}

// Secrets: Show only when detected (always)
secrets: {
  showOnlyIf: { min: 1 }  // secretTypes.length >= 1
}
```

---

### Requirement 3: Session Start Time

**Purpose**: Show when current coding session started (not just turn count)

**Display**: `💬:42 (started 2h15m ago)` or `💬:42@14:26` (absolute time)

**Data source**: `firstSeen` timestamp (already tracked)

**Calculation**: `Date.now() - health.firstSeen`

---

## Implementation Plan

### Phase 1: Critical Fixes (IMMEDIATE)

**Task 1.1: Fix Budget Time Calculation**
```typescript
// File: v2/src/display-only.ts, line 311
function fmtBudget(h: SessionHealth): string {
  if (!h.billing?.budgetRemaining && h.billing?.budgetRemaining !== 0) return '';

  // Adjust for staleness (client-side time correction)
  let mins = h.billing.budgetRemaining || 0;
  if (h.billing.lastFetched) {
    const ageMinutes = Math.floor((Date.now() - h.billing.lastFetched) / 60000);
    mins = Math.max(0, mins - ageMinutes);  // Subtract elapsed time
  }

  const hours = Math.floor(mins / 60);
  const m = mins % 60;
  const pct = h.billing.budgetPercentUsed || 0;

  // New format: XhXm(XX%)@HH:MM
  const reset = h.billing.resetTime && h.billing.isFresh
    ? `${c('resetTime')}@${h.billing.resetTime}${rst()}`
    : '';
  const stale = !h.billing.isFresh ? `${c('critical')}🔴${rst()}` : '';

  return `⌛:${c('budget')}${hours}h${m}m(${pct}%)${reset}${rst()}${stale}`;
}
```

**Task 1.2: Remove Duplicate Secrets Display**
```typescript
// File: v2/src/display-only.ts, lines 391-392
function fmtHealthStatus(h: SessionHealth): string {
  if (!h.transcript?.exists && h.transcriptPath) return '🔴TXN';

  // Enhanced secrets display (replace 🔴SEC)
  if (h.alerts?.secretsDetected) {
    const types = h.alerts.secretTypes || [];
    if (types.length === 1) {
      const name = types[0].split('/').pop() || 'Secret';  // Remove path
      return `⚠️ ${name}`;
    }
    return `⚠️ ${types.length} secrets`;
  }

  return '';
}

// Line 519: REMOVE this line
// if (cfg.secrets) { const s = fmtSecrets(health); if (s) parts.push(s); }
```

**Task 1.3: Fix Spacing - Keep Time + Budget Together**
```typescript
// File: v2/src/display-only.ts, lines 499-502
// Change build order to combine time + budget
const timeBudgetSection = [
  cfg.time ? fmtTime() : '',
  cfg.budget ? fmtBudget(health) : '',
  cfg.weeklyBudget ? fmtWeeklyBudget(health) : ''  // NEW
].filter(Boolean).join(' ');

if (timeBudgetSection) parts.push(timeBudgetSection);
```

---

### Phase 2: Weekly Quota Integration (HIGH PRIORITY)

**Task 2.1: Add Weekly Quota to BillingInfo**
```typescript
// File: v2/src/types/session-health.ts, lines 46-54
export interface BillingInfo {
  // Existing daily fields
  costToday: number;
  burnRatePerHour: number;
  budgetRemaining: number;
  budgetPercentUsed: number;
  resetTime: string;
  totalTokens?: number;
  tokensPerMinute?: number | null;
  isFresh: boolean;
  lastFetched: number;

  // NEW: Weekly quota fields
  weeklyBudgetRemaining?: number;      // Hours until weekly reset
  weeklyBudgetPercentUsed?: number;    // Percentage of weekly quota used
  weeklyResetDay?: string;             // "Monday", "Tuesday", etc.
  weeklyLimitUSD?: number;             // Weekly quota limit in USD
}
```

**Task 2.2: Fetch Weekly Quota from OAuth API**
```typescript
// File: v2/src/modules/anthropic-oauth-api.ts
// Enhance convertToBillingInfo() to include weekly data
private static convertToBillingInfo(data: AnthropicOAuthUsageResponse): BillingInfo {
  // ... existing daily calculations ...

  // Calculate weekly budget
  const weeklyLimitUSD = data.weekly_quota_limit_usd || 500;  // Default $500/week
  const weeklyRemainingUSD = data.weekly_quota_remaining_usd || weeklyLimitUSD;
  const weeklyPercentUsed = Math.round((1 - weeklyRemainingUSD / weeklyLimitUSD) * 100);

  // Calculate hours until weekly reset
  const weeklyBudgetRemaining = burnRatePerHour > 0
    ? Math.floor(weeklyRemainingUSD / burnRatePerHour)
    : 999;

  // Determine reset day
  const weeklyResetDay = this.calculateWeeklyResetDay(data.weekly_reset_time);

  return {
    // ... existing fields ...
    weeklyBudgetRemaining,
    weeklyBudgetPercentUsed: weeklyPercentUsed,
    weeklyResetDay,
    weeklyLimitUSD
  };
}
```

**Task 2.3: Create Weekly Budget Formatter**
```typescript
// File: v2/src/display-only.ts
function fmtWeeklyBudget(h: SessionHealth): string {
  if (!h.billing?.weeklyBudgetRemaining) return '';

  const hours = h.billing.weeklyBudgetRemaining;
  const pct = h.billing.weeklyBudgetPercentUsed || 0;
  const resetDay = h.billing.weeklyResetDay || 'Mon';

  return `| 📅:${c('weeklyBudget')}${hours}h(${pct}%)@${resetDay}${rst()}`;
}
```

---

### Phase 3: Smart Visibility System (MEDIUM PRIORITY)

**Task 3.1: Add Visibility Config to ComponentsConfig**
```typescript
// File: v2/src/types/session-health.ts
export interface ComponentVisibilityRules {
  showOnlyIf?: {
    min?: number;
    max?: number;
  };
  rotation?: {
    showDuration: number;
    hideDuration: number;
  };
  showOnChange?: boolean;
  changeDuration?: number;
}

export interface ComponentsConfig {
  directory: boolean;
  git: boolean;
  model: boolean;
  context: boolean;
  time: boolean;
  budget: boolean;
  weeklyBudget: boolean;  // NEW
  cost: boolean;
  usage: boolean;
  cache: boolean;
  lastMessage: boolean;
  transcriptSync: boolean;
  secrets: boolean;

  // NEW: Visibility rules per component
  visibilityRules?: {
    turns?: ComponentVisibilityRules;
    cache?: ComponentVisibilityRules;
    usage?: ComponentVisibilityRules;
    cost?: ComponentVisibilityRules;
  };
}
```

**Task 3.2: Implement Smart Visibility Logic**
```typescript
// File: v2/src/display-only.ts
class VisibilityManager {
  private lastValues = new Map<string, any>();
  private lastShown = new Map<string, number>();

  shouldShow(
    componentName: string,
    value: number,
    rules?: ComponentVisibilityRules
  ): boolean {
    if (!rules) return true;

    // Threshold check
    if (rules.showOnlyIf) {
      if (rules.showOnlyIf.min !== undefined && value < rules.showOnlyIf.min) {
        return false;
      }
      if (rules.showOnlyIf.max !== undefined && value > rules.showOnlyIf.max) {
        return false;
      }
    }

    // Rotation check
    if (rules.rotation) {
      const now = Date.now();
      const lastShownTime = this.lastShown.get(componentName) || 0;
      const elapsed = now - lastShownTime;

      const { showDuration, hideDuration } = rules.rotation;
      const cycleTime = showDuration + hideDuration;
      const position = elapsed % cycleTime;

      const shouldShow = position < showDuration;

      if (shouldShow && !this.lastShown.has(componentName)) {
        this.lastShown.set(componentName, now);
      }

      return shouldShow;
    }

    // Change detection
    if (rules.showOnChange) {
      const lastValue = this.lastValues.get(componentName);
      if (lastValue !== value) {
        this.lastValues.set(componentName, value);
        this.lastShown.set(componentName, Date.now());
        return true;
      }

      const timeSinceChange = Date.now() - (this.lastShown.get(componentName) || 0);
      return timeSinceChange < (rules.changeDuration || 5000);
    }

    return true;
  }
}
```

**Task 3.3: Apply Visibility Rules in Display**
```typescript
// File: v2/src/display-only.ts
const visibilityManager = new VisibilityManager();

// Example: Cache only shows if < 95%
if (cfg.cache) {
  const cacheHitRatio = calculateCacheHitRatio(health);
  const rules = cfg.visibilityRules?.cache;
  if (visibilityManager.shouldShow('cache', cacheHitRatio, rules)) {
    parts.push(fmtCache(health));
  }
}

// Example: Tokens rotate (5min show, 1hr hide)
if (cfg.usage) {
  const tokens = health.billing.totalTokens || 0;
  const rules = cfg.visibilityRules?.usage;
  if (visibilityManager.shouldShow('usage', tokens, rules)) {
    parts.push(fmtUsage(health));
  }
}
```

---

### Phase 4: Session Start Time (LOW PRIORITY)

**Task 4.1: Add Session Start Display**
```typescript
// File: v2/src/display-only.ts
function fmtSessionInfo(h: SessionHealth): string {
  const turnCount = h.transcript?.messageCount || 0;
  const sessionAge = h.firstSeen ? Date.now() - h.firstSeen : 0;

  if (sessionAge > 0) {
    const duration = formatDuration(Math.floor(sessionAge / 60000));
    return `💬:${c('turns')}${turnCount}${rst()} (${c('sessionDuration')}${duration}${rst()})`;
  }

  return `💬:${c('turns')}${turnCount}${rst()}`;
}
```

---

## Default Visibility Rules

```typescript
// File: v2/src/types/session-health.ts
export function createDefaultConfig(): StatuslineConfig {
  return {
    components: {
      directory: true,
      git: true,
      model: true,
      context: true,
      time: true,
      budget: true,
      weeklyBudget: true,   // NEW
      cost: true,
      usage: true,
      cache: true,
      lastMessage: true,
      transcriptSync: false,  // Hide by default (integrated into last message)
      secrets: true
    },
    visibilityRules: {
      // Turns: Only show if > 1000
      turns: {
        showOnlyIf: { min: 1000 }
      },

      // Cache: Only show if < 95%
      cache: {
        showOnlyIf: { max: 95 }
      },

      // Tokens: Show 5min every hour
      usage: {
        rotation: {
          showDuration: 5 * 60 * 1000,      // 5 minutes
          hideDuration: 55 * 60 * 1000      // 55 minutes
        }
      },

      // Cost: Show briefly when changes
      cost: {
        showOnChange: true,
        changeDuration: 10 * 1000  // 10 seconds after change
      }
    },
    thresholds: {
      transcriptStaleMinutes: 5,
      contextWarningPercent: 70,
      budgetWarningPercent: 80
    },
    display: {
      maxWidth: 200,
      useEmoji: true,
      useColor: false
    }
  };
}
```

---

## Expected Output After Implementation

**Before** (current, broken):
```
📁:~/project 🌿:main 🤖:Opus4.5 🧠:154kleft[---------|--] 🕐:12:41
🔴SEC ⌛:3h31m(73%)13:00 💰:$40.3|$15.1/h 📊:83.4Mtok(521ktpm) 💾:16% 💬:42t 🔐API
```
Issues: Wrong time (3h31m vs 19m), duplicate secrets, inefficient spacing

**After** (fixed):
```
📁:~/project 🌿:main 🤖:Opus4.5 🧠:154k[---|] 🕐:12:41 ⌛:19m(73%)@14:00|📅:28h(41%)@Mon 💰:$40|$15/h
⚠️ API Key 💬:42t (2h15m)
```
Benefits: Correct time, weekly quota, cleaner layout, one secret alert

**After with smart visibility** (tokens hidden, cache hidden):
```
📁:~/project 🌿:main 🤖:Opus4.5 🧠:154k[---|] 🕐:12:41 ⌛:19m(73%)@14:00|📅:28h(41%)@Mon
```
Benefits: Minimal, essential info only (tokens/cache hidden because within thresholds)

---

## Testing Plan

### Test 1: Time Calculation
```bash
# Before fix
echo '{"session_id":"test"}' | bun v2/src/display-only.ts | grep "⌛"
# Expected (broken): ⌛:3h31m(73%)13:00

# After fix
echo '{"session_id":"test"}' | bun v2/src/display-only.ts | grep "⌛"
# Expected (fixed): ⌛:19m(73%)@14:00
```

### Test 2: Weekly Quota
```bash
# After OAuth integration
export ANTHROPIC_API_KEY="sk-ant-..."
echo '{"session_id":"test"}' | bun v2/src/display-only.ts | grep "📅"
# Expected: 📅:28h(41%)@Mon
```

### Test 3: Smart Visibility
```bash
# Set cache hit ratio to 97% (should hide)
# Expected: No 💾 in output

# Set cache hit ratio to 85% (should show)
# Expected: 💾:85%
```

---

## Summary

**Phase 1** (Immediate): Fix critical bugs
- ✅ Client-side time adjustment for stale billing
- ✅ Remove duplicate secrets display
- ✅ Improve spacing efficiency

**Phase 2** (High Priority): Weekly quota
- ✅ OAuth API integration
- ✅ Weekly budget display
- ✅ Combined daily/weekly format

**Phase 3** (Medium Priority): Smart visibility
- ✅ Threshold-based display rules
- ✅ Rotation timing (show/hide cycles)
- ✅ Change detection

**Phase 4** (Low Priority): Enhancements
- ✅ Session duration display
- ✅ Auth profile indicator

**Estimated time**: 4-6 hours total
**Priority order**: Phase 1 → Phase 2 → Phase 3 → Phase 4
