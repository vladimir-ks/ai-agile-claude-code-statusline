# Data Pipeline Architecture

**Date**: 2026-02-01
**Status**: COMPLETE - All pipelines documented with staleness tracking
**Updated**: Added hot-swap-quota.json integration

---

## Data Sources Overview

| Data Point | Primary Source | Fallback | Staleness Threshold | Update Frequency |
|------------|---------------|----------|---------------------|------------------|
| Daily Cost | OAuth API | ccusage → billing-shared.json | 4 min | Background daemon |
| Budget % | **hot-swap-quota.json** | OAuth → ccusage → subscription.yaml | 2 min | Hot-swap system |
| Weekly Quota | **hot-swap-quota.json** | OAuth → subscription.yaml | 2 min | Hot-swap system |
| Context Window | stdin JSON | - | Real-time | Every invocation |
| Git Status | git commands | Cached | 30 sec | Background daemon |
| Model | stdin JSON | transcript → settings.json | Real-time | Every invocation |
| Transcript | File monitor | - | 5 min | Background daemon |

---

## Pipeline Details

### 1. Daily Billing Pipeline

```
                    ┌─────────────────────┐
                    │   OAuth API         │ ← Authoritative (requires valid token)
                    │   /api/oauth/usage  │
                    └─────────┬───────────┘
                              │
                              ▼ (401 = token expired)
                    ┌─────────────────────┐
                    │   ccusage CLI       │ ← Fallback (no auth needed)
                    │   blocks --json     │
                    └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │ billing-shared.json │ ← Cross-session cache
                    │ (2min freshness)    │
                    └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   Display Layer     │
                    │   ⌛:42m(29%)       │ ← Shows ⚠ if stale >4min
                    └─────────────────────┘
```

**Staleness Logic:**
- `isFresh: true` if data < 2 min old
- Shows ⚠ if data > 4 min old
- Shows ⚠⚠ if data so old that budget adjustment unreliable

### 2. Weekly Quota Pipeline (HOT-SWAP INTEGRATED)

```
                    ┌─────────────────────┐
                    │ hot-swap-quota.json │ ← PRIMARY (auto-refreshed tokens!)
                    │ session-health/     │
                    └─────────┬───────────┘
                              │
                              ▼ (No data / stale > 2min)
                    ┌─────────────────────┐
                    │   OAuth API         │ ← Fallback (needs valid token)
                    │   weekly_quota_*    │
                    └─────────┬───────────┘
                              │
                              ▼ (No data / token expired)
                    ┌─────────────────────┐
                    │ subscription.yaml   │ ← Manual fallback
                    │ ~/.claude/config/   │
                    └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   Display Layer     │
                    │ 📅:97h(98%)@Thu     │ ← Fresh from hot-swap!
                    └─────────────────────┘
```

**Hot-Swap Synergy:**
- Hot-swap system auto-refreshes OAuth tokens
- Writes fresh quota to `~/.claude/session-health/hot-swap-quota.json`
- Statusline reads from this shared cache
- **Result**: One fetch, both systems use fresh data

**Staleness Logic:**
- Hot-swap data: `isStale: true` if > 2 minutes old
- Subscription.yaml: `isStale: true` if file > 4 hours old
- Shows ⚠ indicator when stale

**hot-swap-quota.json structure:**
```json
{
  "slot-1": {
    "email": "vlad@vladks.com",
    "five_hour_util": 64,
    "seven_day_util": 98,
    "weekly_budget_remaining_hours": 97,
    "weekly_reset_day": "Thu",
    "last_fetched": 1769961225000,
    "is_fresh": true
  }
}
```

### 3. Context Window Pipeline

```
                    ┌─────────────────────┐
                    │   stdin JSON        │ ← Real-time from Claude Code
                    │   context_window    │
                    └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   Display Layer     │
                    │  🧠:154k-free[bar]  │ ← Always fresh (real-time)
                    └─────────────────────┘
```

**No staleness** - Context data is always real-time from Claude Code.

### 4. Git Status Pipeline

```
                    ┌─────────────────────┐
                    │   git commands      │ ← git status, git branch
                    │   (cached 30s)      │
                    └─────────┬───────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │   Display Layer     │
                    │   🌿:main+12*3      │ ← Shows dirty count
                    └─────────────────────┘
```

**Cached 30 seconds** to avoid excessive git operations.

---

## OAuth Token Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                    OAuth Token States                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  [VALID]                                                        │
│     │                                                           │
│     │ (1-2 hours active use)                                    │
│     ▼                                                           │
│  [EXPIRED]                                                      │
│     │                                                           │
│     ├──► [REFRESH SUCCESS] ──► [VALID]                         │
│     │    (if session active)                                    │
│     │                                                           │
│     └──► [REFRESH FAILED] ──► [INVALID]                        │
│          (session expired                                       │
│           after 12+ hours                                       │
│           inactivity)                                           │
│              │                                                  │
│              ▼                                                  │
│     User runs: claude /login                                    │
│              │                                                  │
│              ▼                                                  │
│          [VALID]                                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key Points:**
- Tokens expire after 1-2 hours
- Refresh tokens are single-use
- Server-side sessions expire after ~12 hours inactivity
- When sessions expire, user MUST run `claude /login` to re-authenticate

---

## Troubleshooting

### Weekly Quota Shows ⚠ (Stale)

**Cause:** subscription.yaml > 4 hours old OR OAuth token expired

**Fix:**
1. Try `claude /login` to refresh OAuth token
2. If that fails, manually update subscription.yaml:
   - Go to https://claude.ai/settings/usage
   - Update percentages in `~/.claude/config/subscription.yaml`

### Daily Budget Shows ⚠⚠ (Very Stale)

**Cause:** ccusage not running OR billing-shared.json > 10 min old

**Fix:**
1. Delete cache: `rm ~/.claude/session-health/billing-shared.json`
2. Check if ccusage is installed: `which ccusage`
3. Manually refresh: `ccusage blocks --json --active`

### Context Shows 🧠:0

**Cause:** Claude Code not sending context_window in JSON

**Fix:** This is a Claude Code issue, not statusline. Context should auto-recover on next message.

---

## Files

| File | Purpose | Freshness |
|------|---------|-----------|
| `~/.claude/session-health/billing-shared.json` | Shared billing cache | 2 min |
| `~/.claude/session-health/{session}.json` | Per-session health | Per invocation |
| `~/.claude/config/subscription.yaml` | User-managed quotas | 4 hours |
| `~/.claude/session-health/runtime-state.yaml` | Unified state | Per invocation |

---

## Staleness Indicators

| Indicator | Meaning | Action |
|-----------|---------|--------|
| ⚠ (single) | Data 4+ minutes old | Usually auto-recovers |
| ⚠⚠ (double) | Data extremely stale, unreliable | Check daemon/ccusage |
| 📅:Xh@Day⚠ | Weekly quota > 4 hours old | Update subscription.yaml |

