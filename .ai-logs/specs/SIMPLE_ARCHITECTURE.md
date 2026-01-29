# Statusline V2 - Simple Architecture

## Goal

Display accurate, stable data from the best available source.

---

## Data Flow (Simple)

```
┌─────────────────────────────────────────────────────────────┐
│                    DATA SOURCES                              │
├─────────────┬─────────────┬─────────────┬──────────────────┤
│ JSON Input  │ Transcript  │ Git Status  │ ccusage          │
│ (real-time) │ (file)      │ (command)   │ (command, slow)  │
└──────┬──────┴──────┬──────┴──────┬──────┴──────┬───────────┘
       │             │             │             │
       ▼             ▼             ▼             ▼
┌─────────────────────────────────────────────────────────────┐
│                   VALIDATION LAYER                           │
│  Compare sources → Select best → Log disagreements          │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     CACHE LAYER                              │
│  Per-module caching with appropriate TTL                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                     OUTPUT                                   │
│  📁:dir 🌿:branch 🤖:model 🧠:context 🕐:time 💰:cost       │
└─────────────────────────────────────────────────────────────┘
```

---

## Per-Module Strategy

### 1. Directory (📁)
- **Source**: `process.cwd()` or JSON `start_directory`
- **Cache**: None (instant)
- **Update**: Never changes mid-session

### 2. Git (🌿)
- **Source**: `git status --porcelain --branch`
- **Cache**: 10 seconds
- **Update**: On commit, branch switch, push/pull
- **Validation**: Compare command output vs `.git/HEAD`

### 3. Model (🤖)
- **Sources**: Transcript (last message) > JSON input > settings.json
- **Cache**: None (use best available)
- **Update**: After first message with new model
- **Validation**: Log when sources disagree

### 4. Context (🧠)
- **Source**: JSON input token counts
- **Cache**: None (real-time from JSON)
- **Update**: Every message
- **Formula**: `threshold * 0.78 - (input + cache_read + output)`

### 5. Time (🕐)
- **Source**: System clock
- **Cache**: None
- **Update**: Every call

### 6. ccusage (💰⌛📊)
- **Source**: `ccusage blocks --json --active`
- **Cache**: 2-5 minutes (GLOBAL - same for all sessions)
- **Update**: Every 2-5 minutes when active
- **File**: `~/.claude/.ccusage_cache.json`

### 7. Last Message (💬)
- **Source**: Transcript file
- **Cache**: Until transcript mtime changes
- **Update**: On new message (detect via mtime)

### 8. Secrets (🔐)
- **Source**: Transcript file (regex scan)
- **Cache**: 5 minutes
- **Update**: Periodically + on transcript change

---

## Caching Strategy

| Data Point | TTL | Scope | File |
|------------|-----|-------|------|
| Directory | ∞ | Session | None |
| Git | 10s | Per-repo | `.git_status_cache` |
| Model | 0 | Session | None (select best source) |
| Context | 0 | Session | None (from JSON) |
| Time | 0 | - | None |
| ccusage | 2-5 min | **GLOBAL** | `.ccusage_cache.json` |
| Last Message | Until mtime | Session | None |
| Secrets | 5 min | Session | None |

**Key Insight**: ccusage is GLOBAL (same data for all sessions). One cache file, one update cycle, all sessions read from it.

---

## Validation Logging

Each module optionally logs:
```json
{
  "ts": 1738234567890,
  "dataPoint": "model",
  "sources": {
    "transcript": { "value": "opus-4-5", "fetchTimeMs": 5 },
    "jsonInput": { "value": "sonnet", "fetchTimeMs": 0 },
    "settings": { "value": "haiku", "fetchTimeMs": 2 }
  },
  "selected": {
    "source": "transcript",
    "value": "opus-4-5",
    "confidence": 95,
    "reason": "Transcript is fresh (<1hr)"
  },
  "disagreement": "Sources disagree: transcript=opus-4-5, jsonInput=sonnet"
}
```

Analyze with:
```bash
./v2/scripts/analyze-validation.sh model
```

---

## Simple Rules

1. **One ccusage call** per cache period (not per module, not per session)
2. **File mtime** to detect changes (git, transcript)
3. **Log disagreements** to understand which source is best
4. **Fail gracefully** - show cached/default if source fails
5. **No complexity** where simple works

---

## What We Don't Need

- Complex distributed locks (simple file cache is enough)
- Real-time ccusage updates (2-5 min is fine)
- Perfect consistency (stability > precision)
- Over-engineered validation (simple comparison + logging)

---

## Testing Approach

### Manual Testing
1. Switch model → observe when statusline updates
2. Switch git branch → verify branch shows correctly
3. Send messages → watch context window change
4. Wait 5+ min → verify ccusage refreshes

### Log Analysis
```bash
# Enable validation logging
export STATUSLINE_VALIDATION_LOG=1

# Run for a while, then analyze
./v2/scripts/analyze-validation.sh

# Check specific data point
./v2/scripts/analyze-validation.sh model
```

---

## Implementation Status

- [x] Directory module
- [x] Git module
- [x] Model module
- [x] Context module
- [x] Time module
- [x] ccusage shared module (single call)
- [x] Cost/Budget/Usage wrapper modules
- [x] Last message module
- [x] Secrets detector module (NEW)
- [x] Validation logger
- [x] Analysis script
- [ ] Integration testing with logging
- [ ] 1-week observation period
- [ ] Refinement based on findings

---

## Next Steps

1. **Enable validation logging** in production
2. **Run for 1 week** to collect data
3. **Analyze disagreements** to find best sources
4. **Fix identified issues** (e.g., git branch bug)
5. **Remove unnecessary complexity** (e.g., ProcessLock if not needed)
6. **Document findings** in final report
