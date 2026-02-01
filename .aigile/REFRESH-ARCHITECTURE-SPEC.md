# Refresh Architecture Specification

**Date**: 2026-01-31
**Status**: SPECIFICATION
**Priority**: CRITICAL

---

## Core Requirements

1. **Automatic selective refresh** - Only fetch stale data categories
2. **Ultra-fast** - <5ms if nothing stale
3. **Memory-safe** - No leaks even with 30 concurrent agents
4. **No orphans** - All processes must terminate cleanly
5. **In-memory cache** - Minimize file reads
6. **Manual subscription data** - Allow user to input subscription info

---

## Data Categories & Staleness

| Category | TTL | Source | Refresh Method |
|----------|-----|--------|----------------|
| Directory | 0 | stdin | Real-time |
| Git | 30s | git commands | Per-repo cooldown |
| Model | 0 | stdin | Real-time |
| Context | 0 | stdin | Real-time |
| Billing (daily) | 5min | ccusage | Shared cache |
| Billing (weekly) | 5min | Config file | User-managed |
| Transcript | 0 | File stat | Real-time |

---

## Subscription Configuration

### User-Provided Data

File: `~/.claude/config/subscription.yaml`

```yaml
# User subscription configuration
# Edit this file to update subscription data

account: rimidalvk@gmail.com

# Weekly quota settings
weeklyQuota:
  limitUSD: 500           # Weekly spending limit
  currentUsage: 72        # Percent used (manually update)
  resetDay: Saturday      # Day of week when resets
  resetTime: "00:00"      # UTC time of reset

# Daily window settings
dailyWindow:
  durationHours: 5        # 5-hour usage window
  # Note: Daily data comes from ccusage automatically

# Last manual update
lastUpdated: 2026-01-31T18:50:00Z
```

### Display Calculation

```
Weekly remaining hours = (100 - currentUsage)% × hoursUntilReset
Example: (100 - 72)% × 24h = 28% × 24h = ~7h of quota remaining
```

---

## Refresh Architecture

### Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                     STATUSLINE TRIGGER                       │
│              (Claude Code invokes hook)                      │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          v
┌─────────────────────────────────────────────────────────────┐
│                    MEMORY CACHE CHECK                        │
│         (In-process cache, TTL per category)                │
│                                                             │
│  if (allFresh(cache)) {                                     │
│    return cachedOutput;  // <1ms                            │
│  }                                                          │
└─────────────────────────┬───────────────────────────────────┘
                          │ Some category stale
                          v
┌─────────────────────────────────────────────────────────────┐
│                   FILE CACHE CHECK                           │
│       (billing-shared.json, subscription.yaml)              │
│                                                             │
│  Check lastFetched timestamps                               │
│  Identify which categories need refresh                     │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          v
┌─────────────────────────────────────────────────────────────┐
│              SELECTIVE REFRESH (Parallel)                    │
│                                                             │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐      │
│  │ Git Status  │  │ Billing/Cost │  │ Subscription  │      │
│  │ (if stale)  │  │ (if stale)   │  │ (if stale)    │      │
│  └──────┬──────┘  └──────┬───────┘  └───────┬───────┘      │
│         │                │                   │              │
│         v                v                   v              │
│    git commands     ccusage           Read YAML file       │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          v
┌─────────────────────────────────────────────────────────────┐
│                    UPDATE CACHES                             │
│                                                             │
│  1. Update in-memory cache                                  │
│  2. Write billing-shared.json (atomic)                      │
│  3. Update health file                                      │
│  4. Generate formatted output                               │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          v
┌─────────────────────────────────────────────────────────────┐
│                    OUTPUT STATUSLINE                         │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation: Smart Refresh Manager

### File: `src/lib/smart-refresh-manager.ts`

```typescript
interface CategoryState {
  lastFetched: number;
  ttlMs: number;
  data: any;
}

interface RefreshCategory {
  name: string;
  ttlMs: number;
  fetch: () => Promise<any>;
  isFresh: (state: CategoryState) => boolean;
}

class SmartRefreshManager {
  // In-memory cache (shared across all invocations in same process)
  private static cache = new Map<string, CategoryState>();

  // Minimum time between file reads (prevents 30 agents all reading)
  private static lastFileRead = 0;
  private static FILE_READ_COOLDOWN = 2000; // 2 seconds

  // Categories with their refresh logic
  private categories: RefreshCategory[] = [
    {
      name: 'billing',
      ttlMs: 300000, // 5 minutes
      fetch: () => this.fetchBilling(),
      isFresh: (s) => Date.now() - s.lastFetched < 300000
    },
    {
      name: 'git',
      ttlMs: 30000, // 30 seconds
      fetch: () => this.fetchGit(),
      isFresh: (s) => Date.now() - s.lastFetched < 30000
    },
    {
      name: 'subscription',
      ttlMs: 60000, // 1 minute (file-based)
      fetch: () => this.readSubscription(),
      isFresh: (s) => Date.now() - s.lastFetched < 60000
    }
  ];

  async getHealth(sessionId: string): Promise<SessionHealth> {
    // Step 1: Check in-memory cache first (fastest path)
    if (this.allCategoriesFresh()) {
      return this.buildHealthFromCache();
    }

    // Step 2: Throttle file reads (prevent 30 agents all reading)
    const now = Date.now();
    if (now - SmartRefreshManager.lastFileRead < SmartRefreshManager.FILE_READ_COOLDOWN) {
      // Too soon, use stale cache
      return this.buildHealthFromCache();
    }
    SmartRefreshManager.lastFileRead = now;

    // Step 3: Identify stale categories
    const staleCategories = this.getStaleCategories();

    // Step 4: Refresh only stale categories (in parallel)
    await Promise.all(
      staleCategories.map(cat => this.refreshCategory(cat))
    );

    // Step 5: Build health from updated cache
    return this.buildHealthFromCache();
  }

  private allCategoriesFresh(): boolean {
    return this.categories.every(cat => {
      const state = SmartRefreshManager.cache.get(cat.name);
      return state && cat.isFresh(state);
    });
  }

  private getStaleCategories(): RefreshCategory[] {
    return this.categories.filter(cat => {
      const state = SmartRefreshManager.cache.get(cat.name);
      return !state || !cat.isFresh(state);
    });
  }

  private async refreshCategory(cat: RefreshCategory): Promise<void> {
    try {
      const data = await Promise.race([
        cat.fetch(),
        this.timeout(cat.name === 'billing' ? 30000 : 5000)
      ]);

      SmartRefreshManager.cache.set(cat.name, {
        lastFetched: Date.now(),
        ttlMs: cat.ttlMs,
        data
      });
    } catch (error) {
      // Keep stale data on error
      console.error(`[SmartRefresh] ${cat.name} failed:`, error);
    }
  }

  private timeout(ms: number): Promise<never> {
    return new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), ms)
    );
  }
}
```

---

## Subscription File Format

### Location: `~/.claude/config/subscription.yaml`

```yaml
# Claude Code Subscription Configuration
# Last updated: 2026-01-31

account: rimidalvk@gmail.com

# Weekly Quota
weekly:
  limitUSD: 500
  usedPercent: 72          # Current usage percentage
  resetDay: Saturday       # When quota resets
  resetHour: 0             # Hour (UTC) when resets

# Notes (optional)
notes: |
  Pro subscription
  Renews monthly
```

### Command to Update

```bash
# Edit subscription config
claude config subscription edit

# Or directly edit
vi ~/.claude/config/subscription.yaml
```

---

## Display Rules Update

### Weekly Budget Display

**Current** (incorrect):
```
📅:30h(81%)@Mon    # Hours until Monday, week progress
```

**Correct**:
```
📅:7h(72%)@Sat     # Hours of quota remaining, percent used, reset day
```

**Calculation**:
```
hoursUntilReset = calculateHoursUntilDay(resetDay, resetHour)
quotaRemainingHours = hoursUntilReset × (100 - usedPercent) / 100
display = `📅:${quotaRemainingHours}h(${usedPercent}%)@${resetDay}`
```

---

## Context (🧠) Display Rules

| Condition | Display | Notes |
|-----------|---------|-------|
| Available ≥30 chars | `154k-free[---------|--]` | Full with bar |
| Available 25-29 | `154k-free[----|-]` | Short bar |
| Available 18-24 | `154k[----|-]` | No "-free" |
| Available 10-17 | `154k` | Just number |
| Available <10 | (move to L2) | Not enough space |

**Current Issue**: The full directory path takes up space, leaving less for context. The adaptive logic IS working, but the width calculation may be off.

---

## Memory Safety

### Concurrent Agent Protection

```typescript
// Global singleton - shared across all invocations
const globalCache = new Map<string, CacheEntry>();

// Prevent thundering herd
let fetchInProgress = false;
const fetchQueue: Array<() => void> = [];

async function fetchWithQueue(): Promise<void> {
  if (fetchInProgress) {
    // Wait for current fetch to complete
    return new Promise(resolve => fetchQueue.push(resolve));
  }

  fetchInProgress = true;
  try {
    await actualFetch();
  } finally {
    fetchInProgress = false;
    // Notify all waiters
    fetchQueue.forEach(resolve => resolve());
    fetchQueue.length = 0;
  }
}
```

### Process Cleanup

```typescript
// Register cleanup on exit
process.on('exit', () => {
  // Kill any child processes
  childProcesses.forEach(p => {
    try { p.kill('SIGTERM'); } catch {}
  });
});

// Timeout all exec calls
const result = await execAsync('ccusage ...', {
  timeout: 30000,
  maxBuffer: 1024 * 1024
});
```

---

## File Structure

```
~/.claude/
├── config/
│   ├── subscription.yaml    # User-managed subscription data
│   └── settings.json        # Existing settings
└── session-health/
    ├── billing-shared.json  # Auto-managed billing cache
    ├── {session-id}.json    # Per-session health
    └── cooldowns/           # Cooldown state files
```

---

## Implementation Checklist

### Phase 1: Subscription Config
- [ ] Create subscription.yaml schema
- [ ] Add reader for subscription data
- [ ] Integrate into display formatter
- [ ] Add CLI command to edit subscription

### Phase 2: Smart Refresh
- [ ] Implement SmartRefreshManager class
- [ ] Add in-memory cache with TTL
- [ ] Add file read throttling
- [ ] Add selective category refresh

### Phase 3: Safety
- [ ] Add process cleanup handlers
- [ ] Add timeout to all async operations
- [ ] Add memory limit checks
- [ ] Test with 30 concurrent agents

### Phase 4: Display Fixes
- [ ] Fix weekly display calculation
- [ ] Verify context adaptive rules
- [ ] Test at all terminal widths

---

## User Action Required

To configure your subscription:

1. Create the subscription config file:
```bash
mkdir -p ~/.claude/config
cat > ~/.claude/config/subscription.yaml << 'EOF'
account: rimidalvk@gmail.com

weekly:
  limitUSD: 500
  usedPercent: 72
  resetDay: Saturday
  resetHour: 0

notes: Pro subscription
EOF
```

2. Update `usedPercent` when it changes (or we can read from ccusage stats)

---

**Document Version**: 1.0
**Status**: Ready for implementation
