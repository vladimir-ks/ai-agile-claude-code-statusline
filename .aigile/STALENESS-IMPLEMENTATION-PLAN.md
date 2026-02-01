# Staleness Detection & Auto-Refresh Implementation Plan

**Date**: 2026-01-31
**Priority**: CRITICAL
**Status**: Planning

---

## Executive Summary

Implement comprehensive data freshness system with:
1. **Subtle staleness indicators** - Age in parentheses, not big dots
2. **Relocated storage** - Move to `~/.claude/config/` (cleaner)
3. **Restructured YAML** - AuthProfiles → Sessions → FormattedOutputs
4. **Auto-refresh** - Fetch billing every 5 minutes (authoritative data)
5. **Client-side freshness** - Calculate `isFresh` based on age

---

## Part 1: Staleness Indicator Design

### Current Problem
```
⌛:1h30m(46%)🔴    # Big red dot - too attention-grabbing
```

### Proposed Solution: Age Display
```
# Fresh (< 5 min) - no indicator
⌛:1h30m(46%)

# Slightly stale (5-15 min) - show age
⌛:1h30m(46%)(8m)

# Moderately stale (15-60 min) - show age with color
⌛:1h30m(46%)(42m)   # Orange text

# Critically stale (> 60 min) - show age with warning color
⌛:1h30m(46%)(2h)    # Red text
```

### Benefits
- **Informative**: User sees exactly how old the data is
- **Subtle**: Small parentheses, not big symbols
- **Actionable**: User knows data is 2 hours old → can refresh manually
- **Consistent**: Same format as other time displays

### Alternative Options
If age display too verbose:
- Superscript: `⌛:1h30m(46%)ˢ` (s = stale)
- Small triangle: `⌛:1h30m(46%)▴`
- Thin bar: `⌛:1h30m(46%)│` (colored)

**Recommendation**: Age display `(2h)` - most informative

---

## Part 2: Storage Relocation

### Current Structure (Crowded)
```
~/.claude/session-health/
├── a8e855a4-1b42-4793-a1b8-0a533aba93f8.json  # Session 1
├── 06baa616-10bb-48e2-8d63-67aa970d086c.json  # Session 2
├── [... 16 more session files ...]
├── billing-shared.json                         # Shared billing
└── runtime-state.yaml                          # 105KB YAML state
```

**Problem**: Shared state mixed with per-session files → hard to navigate

### New Structure (Clean)
```
~/.claude/
├── config/
│   ├── runtime-state.yaml          # Authoritative state (AuthProfiles + Sessions)
│   └── settings.json               # User settings (already exists)
└── session-health/
    ├── a8e855a4-....json          # Session 1 health
    ├── 06baa616-....json          # Session 2 health
    └── [... only session files ...]
```

**Benefits**:
- Config files in dedicated directory
- session-health/ only has session files
- Easier to find and read runtime-state.yaml
- Matches convention (`~/.claude/config/` for configuration)

### Migration Strategy
```typescript
// On first run with new version
if (existsSync('~/.claude/session-health/runtime-state.yaml')) {
  // Move to new location
  renameSync(
    '~/.claude/session-health/runtime-state.yaml',
    '~/.claude/config/runtime-state.yaml'
  );
}

// Delete billing-shared.json (now integrated in runtime-state.yaml)
if (existsSync('~/.claude/session-health/billing-shared.json')) {
  unlinkSync('~/.claude/session-health/billing-shared.json');
}
```

---

## Part 3: YAML Restructure

### Current Structure (Unreadable)
```yaml
sessions:
  - sessionId: abc123
    formattedStrings:        # 🔴 HUGE BLOCK
      width120: |
        [50 lines of formatted output]
      width200: |
        [50 lines of formatted output]
    health:                  # 🔴 CAN'T SEE THIS!
      status: healthy
```

**Problem**: Formatted strings are 90% of file size, block reading session data

### New Structure (Readable)
```yaml
# AuthProfiles FIRST (authoritative data)
authProfiles:
  default:
    billing: {...}
    weeklyQuota: {...}
    dataSource: oauth
    lastFetched: 123456
    isFresh: false           # Client-side calculation
    staleness: critical      # fresh | slight | moderate | critical

# Sessions SECOND (without huge strings)
sessions:
  - sessionId: abc123
    authProfile: default     # Link to authProfile
    health: {...}
    # NO formattedStrings here!

# FormattedOutputs LAST (indexed by session ID)
formattedOutputs:
  abc123:                    # Efficient lookup by ID
    width120: |
      [formatted output]
```

**Benefits**:
1. **AuthProfiles at top** - See authoritative billing data first
2. **Sessions readable** - No huge string blocks
3. **FormattedOutputs separate** - Indexed by ID for efficient lookup
4. **Clearer data flow** - AuthProfile → Session → Display

### Data Access Pattern
```typescript
// Read runtime state
const state = readYAML('~/.claude/config/runtime-state.yaml');

// Get session
const session = state.sessions.find(s => s.sessionId === sessionId);

// Get auth profile (authoritative billing)
const authProfile = state.authProfiles[session.authProfile];

// Get formatted output
const formatted = state.formattedOutputs[sessionId];

// Use pre-formatted output
process.stdout.write(formatted.width120);
```

---

## Part 4: Auto-Refresh Mechanism

### Current Behavior (Reactive)
```
User types → Statusline displays → Daemon spawned → Fetch billing (maybe)
```

**Problems**:
- Only updates when user active
- If user inactive for 2 hours → data 2 hours stale
- OAuth API might fail, uses cached data forever
- No scheduled refresh

### New Behavior (Proactive)
```
Every 5 minutes:
  ├─ Daemon wakes up (cron-like timer)
  ├─ Fetch from OAuth API (authoritative)
  ├─ Update authProfiles in runtime-state.yaml
  ├─ Update all active sessions
  ├─ Log success/failure
  └─ Calculate staleness

User types → Statusline displays:
  ├─ Read runtime-state.yaml
  ├─ Check authProfile.isFresh (client-side calculation)
  ├─ Show staleness indicator if needed
  └─ Display pre-formatted output
```

**Benefits**:
- Data stays fresh even when user inactive
- Catches OAuth API failures quickly (5 min max)
- User always sees current data
- Staleness indicator shows when data is old

### Implementation: Daemon Scheduler

**File**: `v2/src/daemon-scheduler.ts` (NEW)

```typescript
class DaemonScheduler {
  private timer: NodeJS.Timeout | null = null;
  private interval = 5 * 60 * 1000; // 5 minutes

  start() {
    this.timer = setInterval(() => {
      this.refreshAllProfiles();
    }, this.interval);
  }

  async refreshAllProfiles() {
    const state = this.runtimeStateStore.loadState();

    for (const [profileId, profile] of Object.entries(state.authProfiles)) {
      try {
        // Fetch fresh data
        const billing = await AnthropicOAuthAPI.fetchUsage(profileId);

        if (billing) {
          // Update auth profile
          this.runtimeStateStore.updateAuthProfile(profileId, billing);
          console.log(`[Scheduler] Updated ${profileId}: Fresh data fetched`);
        }
      } catch (error) {
        console.error(`[Scheduler] Failed to update ${profileId}:`, error);
      }
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
```

**Integration**: Run as background service
```bash
# Start daemon scheduler (runs forever)
bun src/daemon-scheduler.ts &

# Or integrate into existing daemon
# Add scheduler.start() in data-daemon.ts
```

---

## Part 5: Client-Side Freshness Calculation

### Current (Server-Side, Wrong)
```typescript
// Set at fetch time, never expires
return { ...billing, isFresh: true, lastFetched: Date.now() };
```

**Problem**: Always `isFresh: true`, even 2 hours later!

### New (Client-Side, Correct)
```typescript
// Calculate freshness when reading data
function calculateFreshness(billing: BillingInfo) {
  const ageMinutes = (Date.now() - billing.lastFetched) / 60000;

  return {
    ageMinutes: Math.floor(ageMinutes),
    isFresh: ageMinutes < 5,
    staleness:
      ageMinutes < 5 ? 'fresh' :
      ageMinutes < 15 ? 'slight' :
      ageMinutes < 60 ? 'moderate' : 'critical'
  };
}

// In runtime-state-store, update authProfile on read
const authProfile = state.authProfiles[profileId];
const freshness = calculateFreshness(authProfile.billing);
authProfile.isFresh = freshness.isFresh;
authProfile.staleness = freshness.staleness;
authProfile.ageMinutes = freshness.ageMinutes;
```

### Staleness Levels
| Age | Level | Indicator | Color |
|-----|-------|-----------|-------|
| < 5 min | `fresh` | None | - |
| 5-15 min | `slight` | `(8m)` | Orange |
| 15-60 min | `moderate` | `(42m)` | Yellow |
| > 60 min | `critical` | `(2h)` | Red |

---

## Part 6: Enhanced Logging

### Current Logs (Minimal)
```
[AnthropicOAuthAPI] No OAuth token available
[2026-01-31T17:16:00.852Z] [INFO] Session updated in 293ms
```

**Missing**: Data age, staleness warnings, fetch status

### New Logs (Comprehensive)
```
[2026-01-31T17:20:00.000Z] [INFO] Daemon scheduler started (5min interval)
[2026-01-31T17:20:00.100Z] [INFO] Fetching billing for profile 'default'
[2026-01-31T17:20:00.500Z] [SUCCESS] OAuth API: Fresh data fetched
[2026-01-31T17:20:00.501Z] [INFO] AuthProfile 'default' updated:
  - Cost today: $0.21 (+$0.02 since last fetch)
  - Budget remaining: 155m (-6m since last fetch)
  - Weekly remaining: 28.4h (-0.1h since last fetch)
  - Data age: 0 minutes (FRESH)
  - Source: oauth

[2026-01-31T17:25:00.000Z] [INFO] Scheduled refresh: Checking all profiles
[2026-01-31T17:25:00.100Z] [WARN] AuthProfile 'default' data is 5 minutes old (SLIGHT staleness)
[2026-01-31T17:25:00.500Z] [SUCCESS] OAuth API: Fresh data fetched
[2026-01-31T17:25:00.501Z] [INFO] AuthProfile 'default' updated: Cost $0.22, Budget 150m

[2026-01-31T18:20:00.000Z] [ERROR] OAuth API failed: Network timeout
[2026-01-31T18:20:00.001Z] [WARN] Using cached data (60 minutes old - CRITICAL staleness)
[2026-01-31T18:20:00.002Z] [INFO] Falling back to ccusage
[2026-01-31T18:20:01.000Z] [SUCCESS] ccusage: Fresh data fetched (no weekly quota)
```

**Benefits**:
- See exactly when data was fetched
- Know if OAuth API working
- Warning when data goes stale
- Track billing changes over time

---

## Implementation Checklist

### Phase 1: Staleness Indicators
- [ ] Implement age calculation helper
- [ ] Add staleness level logic (fresh/slight/moderate/critical)
- [ ] Update StatuslineFormatter to show age `(2h)`
- [ ] Add color coding for staleness levels
- [ ] Test at all boundaries (5min, 15min, 60min)

### Phase 2: Storage Migration
- [ ] Create `~/.claude/config/` directory
- [ ] Update RuntimeStateStore to use new path
- [ ] Add migration logic for existing installations
- [ ] Update all read/write paths
- [ ] Remove billing-shared.json (integrate into YAML)

### Phase 3: YAML Restructure
- [ ] Add AuthProfile type with billing + weeklyQuota
- [ ] Restructure RuntimeState type (AuthProfiles → Sessions → FormattedOutputs)
- [ ] Update generateYAML to new structure
- [ ] Update read logic to handle new structure
- [ ] Migrate existing runtime-state.yaml

### Phase 4: Auto-Refresh
- [ ] Create DaemonScheduler class
- [ ] Implement 5-minute timer
- [ ] Add OAuth API refresh logic
- [ ] Update authProfiles in YAML on refresh
- [ ] Add startup/shutdown hooks

### Phase 5: Client-Side Freshness
- [ ] Remove server-side `isFresh` assignment
- [ ] Implement calculateFreshness() helper
- [ ] Calculate on every read
- [ ] Update authProfile with freshness data

### Phase 6: Enhanced Logging
- [ ] Add detailed OAuth API logs
- [ ] Log staleness warnings
- [ ] Log billing changes
- [ ] Add timestamp to all logs

### Phase 7: Testing
- [ ] Test staleness calculation at all levels
- [ ] Test auto-refresh (mock 5-minute wait)
- [ ] Test OAuth API failure fallback
- [ ] Test migration from old structure
- [ ] Test age display in all terminal widths

---

## Expected Results

### Before
```
📁:~/v2 🤖:Sonnet4.5 🧠:11k-free[=========|=-]
🕐:17:20|⌛:2h41m(46%) 💰:$0.19|$19.8/h 💬:9049t
# Data is 2 hours old, user has NO IDEA!
```

### After
```
📁:~/v2 🤖:Sonnet4.5 🧠:11k-free[=========|=-]
🕐:17:20|⌛:43m(46%)(2h)|📅:26.5h(43%)@Mon 💰:$0.19|$19.8/h 💬:9049t
# User sees (2h) - knows data is old
# Budget already adjusted client-side: 161min - 118min = 43min
# Weekly also adjusted: 28.5h - 2h = 26.5h
```

**With Auto-Refresh** (every 5 minutes):
```
📁:~/v2 🤖:Sonnet4.5 🧠:11k-free[=========|=-]
🕐:17:20|⌛:43m(46%)|📅:26.5h(43%)@Mon 💰:$0.19|$19.8/h 💬:9049t
# No staleness indicator - data is fresh!
# Auto-refreshed 2 minutes ago
```

---

## Files to Create/Modify

### New Files
1. `v2/src/daemon-scheduler.ts` - Auto-refresh scheduler
2. `~/.claude/config/runtime-state.yaml` - New location

### Modified Files
1. `v2/src/lib/runtime-state-store.ts` - New YAML structure + path
2. `v2/src/lib/statusline-formatter.ts` - Age display logic
3. `v2/src/lib/data-gatherer.ts` - Remove server-side isFresh
4. `v2/src/types/runtime-state.ts` - New AuthProfile type
5. `v2/src/display-only.ts` - Read from new location

### Deprecated Files
1. `~/.claude/session-health/billing-shared.json` - Integrated into YAML
2. `~/.claude/session-health/runtime-state.yaml` - Moved to config/

---

**Status**: Ready for implementation
**Priority**: CRITICAL (user seeing 2-hour-old data)
**Estimated Impact**: Major UX improvement + data accuracy
