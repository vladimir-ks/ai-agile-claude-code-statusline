# V2 Statusline - Data Reliability Matrix

## Executive Summary

V2 statusline uses a **two-layer architecture** for reliability:
1. **Display Layer** (`display-only.ts`): Ultra-thin, read-only, <10ms execution
2. **Data Layer** (daemon): Background async collection, writes to JSON cache

## Data Sources by Component

| Component | Primary Source | Fallback | Reliability | Notes |
|-----------|---------------|----------|-------------|-------|
| **Directory** | stdin `start_directory` | stdin `workspace.current_dir` → `cwd` | 100% | Real-time from Claude Code |
| **Model** | stdin `model.display_name` | cached health `model.value` → "Claude" | 100% | Prefers real-time |
| **Git** | cached health `git.*` | empty | 95% | Daemon refreshes every 10s |
| **Context** | cached health `context.*` | 0 tokens | 90% | Daemon calculates from transcript |
| **Cost** | cached health `billing.costToday` | hidden | 85% | ccusage dependency |
| **Budget** | cached health `billing.budgetRemaining` | hidden | 85% | ccusage dependency |
| **Transcript** | cached health `transcript.*` | ⚠ warning | 95% | Daemon monitors file |
| **Secrets** | cached health `alerts.secretsDetected` | hidden | 90% | Daemon scans transcript |

## Reliability Guarantees

### Display Layer (display-only.ts)
```
GUARANTEE: Will NEVER:
- Take more than ~10ms
- Spawn subprocesses
- Make network calls
- Throw uncaught exceptions
- Output malformed data

WORST CASE OUTPUT:
- No stdin: "🤖:Claude"
- No health file: "⚠:NoData 🤖:Claude"
- Any error: "⚠:ERR"
```

### Data Flow

```
Claude Code (invokes statusline)
    │
    ├── stdin JSON ──────────────────┐
    │   - session_id                 │
    │   - start_directory  ←─────────┼── REAL-TIME (100% reliable)
    │   - model.display_name         │
    │                                │
    v                                v
┌───────────────────┐        ┌───────────────────┐
│ display-only.ts   │        │ Data Daemon       │
│ (10ms, sync)      │◄───────│ (async, 5-30s)    │
│                   │        │                   │
│ Reads:            │        │ Collects:         │
│ - stdin JSON      │        │ - Git status      │
│ - health/*.json   │        │ - Billing (ccusage)│
│ - config.json     │        │ - Transcript scan │
│                   │        │ - Context calc    │
│ Outputs:          │        │                   │
│ - Single line     │        │ Writes:           │
│ - No newline      │        │ - health/*.json   │
└───────────────────┘        └───────────────────┘
```

## Component Details

### 1. Directory (`📁:`)
**Source**: stdin JSON from Claude Code (NOT daemon cache)
```typescript
stdinDirectory = parsed?.start_directory || parsed?.workspace?.current_dir || parsed?.cwd || null;
```
**Why**: Daemon's `process.cwd()` was unreliable (CWD of daemon ≠ project dir)
**Format**: `../project-name/subdir` (smart truncation shows project name)
**Hidden when**: No stdin directory available (prevents showing wrong path)

### 2. Model (`🤖:`)
**Source**: stdin JSON (primary) → cached health (fallback)
```typescript
const model = stdinModel || h.model?.value || 'Claude';
```
**Why**: Real-time stdin is always current; cache may be stale
**Format**: Display name as-is (e.g., "Opus4.5", "Sonnet4.5")

### 3. Git (`🌿:`)
**Source**: Cached health file (daemon collects via git commands)
**Format**: `branch+ahead-behind*dirty`
**Refresh**: Every 10 seconds
**Hidden when**: Not a git repo or no branch info

### 4. Context (`🧠:`)
**Source**: Cached health file (daemon calculates from context_window)
**Format**: `{tokens}k[====|-]` (compact progress bar)
**Colors**: Green (<80%), Peach (80-95%), Red (>95%)
**Calculation**: 78% compaction threshold

### 5. Cost (`💰:`)
**Source**: Cached health file (daemon fetches from ccusage)
**Format**: `${cost}|${rate}/h`
**Hidden when**: No cost data available
**Staleness**: 🔴 indicator via budget component

### 6. Budget (`⌛:`)
**Source**: Cached health file (ccusage)
**Format**: `{hours}h{mins}m@{reset}` or `{time}🔴` if stale
**Staleness indicator**: 🔴 when ccusage data >1 hour old

### 7. Transcript (`📝:`)
**Source**: Cached health file (daemon monitors file mtime)
**Format**: `{ago}` or `{ago}⚠` if stale or `{ago}🔴` if data loss risk
**Indicators**:
  - Normal: Just time ago
  - ⚠ Warning: Transcript stale
  - 🔴 Critical: Data loss risk

## Width Management

**MAX_WIDTH**: 85 visible columns (conservative)
**Emoji handling**: Each emoji counts as 2 columns
**Truncation**: Last message preview fills remaining space

## Testing Coverage

23 automated tests covering:
- Performance (<100ms execution)
- Fallback behavior (missing/corrupt data)
- Path extraction from all stdin fields
- Model override precedence
- Config respect
- Edge cases (null values, missing fields)

## Known Limitations

1. **Git data**: Up to 10s stale (daemon refresh interval)
2. **Billing data**: Can be minutes stale (ccusage cache)
3. **Context**: Depends on daemon running
4. **Directory**: Requires Claude Code to provide `start_directory`

## Troubleshooting

### No directory shown
- Check if Claude Code sends `start_directory` in stdin
- Run: `echo '{}' | bun src/display-only.ts` (should show no 📁:)

### Stale data indicator (🔴)
- ccusage data >1 hour old
- Daemon may not be running
- Check: `tail ~/.claude/session-health/daemon.log`

### Missing components
- Check `~/.claude/session-health/config.json`
- Verify daemon is writing health files
