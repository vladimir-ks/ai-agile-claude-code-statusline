# Statusline V2 Specification

**Version:** 2.0.0
**Status:** Definitive Reference
**Last Updated:** 2025-01-30

---

## Output Format

### Single Line Layout
```
[ALERTS] 📁:path 🌿:git 🤖:model 🧠:context 💰:cost ⌛:budget 📝:sync 💬:lastmsg
```

### Example Outputs

**Full data (ideal):**
```
📁:~/../my-project/v2 🌿:main+12*3 🤖:Opus4.5 🧠:138k[----|-] 💰:$45|$12/h ⌛:2h30m@14:00 📝:<1m 💬:What is..(2m)
```

**Minimal (no health data):**
```
⚠:NoData 🤖:Claude
```

**No session:**
```
🤖:Claude
```

---

## Component Specifications

### 1. ALERTS (Position: First)
| Alert | Format | Condition | Color |
|-------|--------|-----------|-------|
| Stale data | `⚠Xm` | Health file >5 min old | Orange `38;5;208` |
| Secrets | `🔐SECRETS!(type)` | Secrets detected | Red `38;5;196` |
| Critical | `🔴SEC` or `🔴TXN` | Security/transcript issue | Coral `38;5;203` |

### 2. DIRECTORY (`📁:`)
**Format:** `📁:~/../project-name/subdir`
**Color:** Sky blue `38;5;117`
**Source:** stdin JSON `start_directory` → `workspace.current_dir` → `cwd`
**Hidden:** When no directory in stdin (never show wrong path)

**Path Shortening Rules:**
1. Replace `$HOME` with `~`
2. If ≤40 chars: show full path
3. If >40 chars: `~/../last-two/parts` or `~/../lastpart`
4. Always preserve `~` prefix for home paths

### 3. GIT STATUS (`🌿:`)
**Format:** `🌿:branch+ahead-behind*dirty`
**Color:** Soft green `38;5;150`
**Source:** Health file `git.*`
**Hidden:** When no branch (not a git repo)

**Examples:**
- `main` - clean
- `main+12` - 12 commits ahead
- `main-3` - 3 commits behind
- `main*5` - 5 dirty files
- `main+12-3*5` - all combined

### 4. MODEL (`🤖:`)
**Format:** `🤖:ModelName`
**Color:** Light purple `38;5;147`
**Source:** stdin `model.display_name` (primary) → health `model.value` → "Claude"
**Hidden:** Never

**Model Names:** Opus4.5, Sonnet4.5, Haiku4.5, Claude

### 5. CONTEXT (`🧠:`)
**Format:** `🧠:138k[----|-]`
**Colors:**
- Good (<80%): Mint green `38;5;158`
- Warn (80-95%): Peach `38;5;215`
- Critical (>95%): Coral `38;5;203`

**Source:** Health file `context.*`
**Hidden:** Never (shows `0[----|-]` if no data)

**Progress Bar:** `[====|-]` (6 chars)
- `|` marker at position 4 (represents 78% compaction threshold)
- `=` filled, `-` empty

**Token Display:**
- ≥1M: `1.2M`
- ≥1000: `138k`
- <1000: `500`

### 6. COST (`💰:`)
**Format:** `💰:$45|$12/h` or `💰:$45`
**Colors:** Cost `38;5;222`, Burn rate `38;5;220`
**Source:** Health file `billing.costToday`, `billing.burnRatePerHour`
**Hidden:** When `costToday` is 0 or null

**Money Format:**
- ≥$100: `$186` (no decimals)
- $10-99: `$45` or `$45.5`
- <$10: `$4.50` (2 decimals)

### 7. BUDGET (`⌛:`)
**Format:** `⌛:2h30m@14:00` or `⌛:2h30m🔴`
**Color:** Lavender `38;5;189`
**Source:** Health file `billing.budgetRemaining`, `billing.resetTime`, `billing.isFresh`
**Hidden:** When no budget data

**Staleness:** `🔴` appears when `isFresh: false`
**Reset Time:** Only shown when fresh

### 8. TRANSCRIPT SYNC (`📝:`)
**Format:** `📝:<1m` or `📝:5m⚠` or `📝:10m🔴`
**Colors:**
- Fresh: Light green `38;5;156`
- Stale: Peach `38;5;215`
- Risk: Coral `38;5;203`

**Source:** Health file `transcript.lastModifiedAgo`, `alerts.transcriptStale`, `alerts.dataLossRisk`
**Hidden:** Never (shows `📝:⚠` if transcript missing)

**Indicators:**
- No indicator: Fresh and synced
- `⚠`: Transcript stale
- `🔴`: Data loss risk

### 9. LAST MESSAGE (`💬:`)
**Format:** `💬:Message preview..(2m)`
**Color:** Light gray `38;5;252`
**Source:** Health file `transcript.lastMessagePreview`, `transcript.lastMessageAgo`
**Hidden:** When no preview OR not enough remaining width

**Truncation:** Fills remaining space (MAX_WIDTH - core components - 2)
**Minimum:** Only shown if ≥10 chars available

---

## Width Management

**MAX_WIDTH:** 85 visible columns (conservative for Claude Code UI)

**Width Calculation:**
- Each character = 1 column
- Each emoji = 2 columns (terminal rendering)
- ANSI color codes = 0 columns (invisible)

**Priority (if width exceeded):**
1. HIGH (always): Model, Context
2. MEDIUM: Git, Cost, Budget, Transcript
3. LOW: Directory
4. FILL: Last message (truncated to fit)

---

## Data Sources

| Component | Primary Source | Fallback | Reliability |
|-----------|---------------|----------|-------------|
| Directory | stdin JSON | None (hidden) | 100% |
| Model | stdin JSON | Health cache | 100% |
| Git | Health cache | Empty | 95% |
| Context | Health cache | Zeros | 90% |
| Cost | Health cache | Hidden | 85% |
| Budget | Health cache | Hidden | 85% |
| Transcript | Health cache | Warning | 95% |
| Last Msg | Health cache | Hidden | 90% |

---

## Color Palette

| Element | ANSI Code | Color Name |
|---------|-----------|------------|
| Directory | `38;5;117` | Sky blue |
| Git | `38;5;150` | Soft green |
| Model | `38;5;147` | Light purple |
| Context Good | `38;5;158` | Mint green |
| Context Warn | `38;5;215` | Peach |
| Context Crit | `38;5;203` | Coral red |
| Cost | `38;5;222` | Light gold |
| Burn Rate | `38;5;220` | Bright gold |
| Budget | `38;5;189` | Lavender |
| Transcript | `38;5;156` | Light green |
| Last Msg | `38;5;252` | Light gray |
| Warning | `38;5;215` | Peach |
| Critical | `38;5;203` | Coral |
| Secrets | `38;5;196` | Bright red |
| Stale | `38;5;208` | Orange |

---

## Error Handling

| Scenario | Output |
|----------|--------|
| No stdin | `🤖:Claude` |
| Invalid JSON | `🤖:Claude` |
| No session_id | `🤖:Claude` |
| No health file | `⚠:NoData 🤖:Claude` |
| Corrupt health | `⚠:NoData 🤖:Claude` |
| Any exception | `⚠:ERR` |

---

## Performance Requirements

| Metric | Target |
|--------|--------|
| Execution time | <10ms typical, <100ms max |
| Memory | <5MB |
| Subprocesses | 0 (display-only) |
| Network calls | 0 |
| File reads | 2 max (health + config) |

---

## Testing Requirements

1. **Path Tests:**
   - Home paths show `~`
   - Long paths truncate with `~/../`
   - Non-home paths work
   - Missing directory hides component

2. **Model Tests:**
   - stdin model preferred over cache
   - Cache fallback works
   - Default "Claude" works

3. **Width Tests:**
   - Output ≤85 visible columns
   - Emoji counted as 2 columns
   - Last message truncated to fit

4. **Fallback Tests:**
   - No stdin → minimal output
   - No health → warning output
   - Any error → safe output

---

## Changelog

### v2.0.0 (2025-01-30)
- Fixed path shortening to preserve `~` prefix
- Directory sourced from stdin (not daemon cache)
- Model prefers stdin over cache
- Emoji-aware width calculation
- Comprehensive test coverage
