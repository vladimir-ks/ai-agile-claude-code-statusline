# Claude Code Statusline V2

Real-time cost tracking and session monitoring for Claude Code.

**Display Example:**
```
📁:~/project 🌿:main+12*3 🤖:Opus4.5 🧠:154kleft[---------|--] 🕐:12:06
⌛:1h53m(62%)14:00 💰:$40.3|$15.1/h 📊:83.4Mtok(521ktpm) 💾:16% 💬:42t
💬:(<5m) What does the main function do in this file?
```

---

## Git Boundary

This is **module 01 — Statusline**, an **independent git repo**, gitignored by the AIGILE-OS umbrella (`.gitignore`: `[0-9][0-9]_*/`). Its commits never appear in umbrella history.

- Commit + push module source HERE: `git push origin main` — `origin` = `git@gitea:vladimir-ks/aigile-statusline.git`.
- `github` remote = GitHub mirror `vladimir-ks/ai-agile-claude-code-statusline` (provenance — never deleted).
- Never run `git add` from the umbrella root expecting it to catch this dir.
- The umbrella tracks only docs/specs/handoffs/registry — never module source.
- Module root holds metadata (`README`, `CHANGELOG`, `LICENSE`, `package.json`); the V2 implementation lives in `v2/`.

> ⚠ **Deployment coupling.** Claude Code configs reference this dir by absolute path in `statusLine.command` — `~/_AIgile-OS/01_statusline/v2/src/statusline-bulletproof.sh`. Live consumers: `~/_claude-configs/specialists/general/settings.json` and `~/_claude-configs/settings-configs/{standard,full-trust,restricted}.json`. **If this dir is ever renamed/relocated, update those configs** or the statusline silently stops rendering.

---

## Architecture

V2 uses a **decoupled architecture** for reliability:

### Display Layer (`v2/src/display-only.ts`)
- **Fast** - <50ms, read-only
- Reads from JSON health files
- Never makes network calls or spawns processes (incl. the quota broker — only the daemon may spawn it)
- Active-slot ⌛/📅/💰 prefer Claude Code's native stdin (`rate_limits.{five_hour,seven_day}`, `cost.total_cost_usd`); the broker cache is the fallback and the source for cross-slot rows
- Always outputs something (graceful degradation)

### Data Daemon (`v2/src/data-daemon.ts`)
- Runs in background AFTER display
- Updates health files for next invocation
- Sole component that refreshes quota (spawns the broker)
- Handles: ccusage, git, transcript monitoring

### Shared Billing (`~/.claude/session-health/billing-shared.json`)
- Any successful ccusage fetch writes here
- All sessions read from shared cache
- Eliminates lock contention issues

---

## Components

| Symbol | Example | Meaning |
|--------|---------|---------|
| 📁 | ~/project | Current directory |
| 🌿 | main+12*3 | Git branch, ahead, dirty files |
| 🤖 | Opus4.5 | Active model (no spaces) |
| 🧠 | 154kleft | Tokens until auto-compact |
| [---\|--] | Progress bar | Context usage (\| at 78% threshold) |
| 🕐 | 12:06 | Current time |
| ⌛ | 1h53m(62%)14:00 | Budget remaining, %, reset time |
| 💰 | $40.3\|$15.1/h | Daily cost \| hourly burn rate |
| 📊 | 83.4Mtok(521ktpm) | Total tokens (tokens per minute) |
| 💾 | 16% | Cache hit ratio |
| 💬 | 42t | Turn count |
| 💬 | (<5m) msg | Last message elapsed + preview |

### Indicators

| Indicator | Meaning |
|-----------|---------|
| 🔴 | Billing data stale (after budget/cost) |
| ⏳ | Degraded render — per-session health file not yet written (fresh session, OR daemon blocked e.g. locked login keychain). Fresh stdin fields (dir/model/context/time/cache) render at full color; cached quota renders **dimmed grey** with a trailing `⏳stale <age>` marker. Never a lone glyph. Git/live-cost omitted (need the daemon). Upgrades to the full render once the daemon writes health. |
| dimmed grey + `⏳stale 12h` | Quota block is last-known-good from `merged-quota-cache.json`, not live; `<age>` = cache age |
| 📝:5m⚠ | Transcript not saved in 5+ minutes |

---

## Data Flow

```
Claude Code → stdin JSON → display-only.ts → stdout
                              ↓
                     health files (read)
                              ↑
             data-daemon.ts (background write)
                     ↑
            ccusage, git, transcript
```

### Health Files (`~/.claude/session-health/`)

| File | Purpose |
|------|---------|
| `{session-id}.json` | Per-session health data |
| `billing-shared.json` | Shared billing cache (cross-session) |
| `daemon.log` | Daemon activity log |

---

## Troubleshooting

### Check daemon log
```bash
tail ~/.claude/session-health/daemon.log
```

### Force refresh billing
```bash
rm ~/.claude/session-health/billing-shared.json
```

### View session health
```bash
cat ~/.claude/session-health/*.json | jq '.billing'
```

### Billing shows 🔴 (stale)
ccusage lock contention - another session is fetching. Data will appear when fetch completes.

### New session shows ⏳
Normal - health file being created. Full display on next interaction.

---

## Development

### Run tests
```bash
cd v2 && bun test
```

### Test display manually
```bash
echo '{"session_id":"test","start_directory":"~/project"}' | bun v2/src/display-only.ts
```

### Capture raw stdin (debug)
Confirm which native fields Claude Code sends (e.g. `rate_limits`, `cost`). Enable by EITHER:
```bash
export STATUSLINE_CAPTURE_STDIN=1                 # for manual `bun display-only.ts`
touch ~/.claude/session-health/.capture-stdin     # sentinel — live session, no restart
```
Next render writes the raw stdin JSON to `~/.claude/session-health/stdin-capture.json`. Remove the sentinel to stop. Capture is read-only and never alters render output.

### Key files
- `v2/src/display-only.ts` - Display layer
- `v2/src/data-daemon.ts` - Background data gathering
- `v2/src/statusline-bulletproof.sh` - Wrapper script
- `v2/src/lib/data-gatherer.ts` - Data orchestration

---

## Documentation

- `v2/docs/ARCHITECTURE.md` - Detailed architecture
- `v2/docs/VALIDATION.md` - Multi-source validation
- `v2/docs/MEMORY.md` - Memory optimization
- `DATA_SOURCES.md` - Data source priority

---

**Version:** 2.0.0 | **Status:** Production Ready
