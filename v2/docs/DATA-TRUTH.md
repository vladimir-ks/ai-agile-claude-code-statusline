# Datapoint Truth Table

Source of truth, scope, and staleness behavior for every rendered field.
Render paths: `display-only.ts` (per render, stdin-first) · daemon → `unified-data-broker` → health file (background).

| Field | Source of truth | Scope | Staleness after external change |
|---|---|---|---|
| 📁 dir | stdin `cwd`/`workspace.current_dir` | per-session | never (fresh each render) |
| 🌿 git | daemon git-source → health file | per-repo | next daemon pass (seconds); external commit/branch switch lags one pass |
| 🤖 model | stdin `model.id` | per-session | never (fresh each render) |
| 📟 version | stdin `version` = RUNNING process; lock fallback (pinned from stdin). Mismatch vs `installed-version.json` (daemon, 5-min gate) → highlighted `📟:vRUN→vINST!` | per-session | CLI upgrade in another pane → marker within ≤5 min; running version never rewritten (contract: session-lock-manager.test.ts) |
| 🧠 context | stdin `context_window` — native `used_percentage` authoritative; tokensLeft = window − used (incl. cache_creation); shared `calculateContext()` both paths | per-session | never (fresh each render); stdin absent → daemon health value (same calc) |
| 👤 slot\|email | session lock; env `CLAUDE_CONFIG_DIR` overrides on mismatch (relaunch-into-different-slot) | per-session | correct immediately via env override; lock rebinds on next daemon pass |
| 🕐 time | local clock at render | machine | never |
| ⌛ 5h quota (active slot) | stdin `rate_limits.five_hour` (native) | per-account | never (fresh each render) |
| ⌛/📅 (cross-slot rows, or stdin absent) | `merged-quota-cache.json` (quota broker, ~5-min cadence) | per-account | stale-tier decorators: ⚠ at 30 min, replace at 120 min; grey + `⏳stale <age>` in degraded render |
| 📅 weekly | stdin `rate_limits.seven_day` (native) else broker cache | per-account | as ⌛ |
| 🔥 burn/pacing | live-burn sampler (5 s) + broker weekly fields | per-account | LKG fallback flagged via heartbeat |
| 💰 session cost | stdin `cost.total_cost_usd` (native) else transcript-derived | per-session | never (fresh) / transcript path lags one daemon pass |
| 💰 daily \| burn | `billing-shared.json` (ccusage, machine-global cache) | **machine — sums ALL accounts/slots** | 🔴 marker when stale; not per-account (known limitation) |
| 📊 tokens / 💾 cache ratio | stdin `context_window.current_usage` (ratio) · ccusage (totals) | session / machine | ratio fresh; totals as 💰 daily |
| 💬 turns + last-msg + 🔥Nk cache counter | transcript JSONL tail read (TranscriptMonitor; parity across all 3 render paths) | per-session | fresh read each pass; >1 MB files: messageCount is size-estimated |
| 🆔 session id | stdin `session_id` | per-session | never |
| 📝 transcript-stale warn | transcript mtime vs threshold | per-session | is itself the staleness detector |

## Known non-truths (accepted / tracked)
- 💰 daily + 📊 totals are machine-global (ccusage): multiple accounts on one machine are summed — not a per-account spend view.
- Legacy paths `src/index.ts`/`context-module.ts`/`version-module.ts`/`statusline-thin.ts` are OFF the live path (`statusline-bulletproof.sh` runs display-only + data-daemon only) and still carry old context/version semantics.
- Perf-threshold tests (`statusline-p99-latency`, `<100ms` display asserts) are machine-load-sensitive — flaky under parallel load, green quiet.

Debug: capture live stdin via `touch ~/.claude/session-health/.capture-stdin` → `stdin-capture.json` (see repo CLAUDE.md).
