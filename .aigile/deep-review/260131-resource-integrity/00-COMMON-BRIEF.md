# Project Context: Claude Code Statusline V2

## Architecture
Real-time cost tracking for Claude Code CLI. Decoupled display (fast, read-only, <50ms) + daemon (background data gathering). Health files in `~/.claude/session-health/`.

## Key Conventions
- Display layer NEVER blocks, spawns processes, or makes network calls
- Atomic file writes (temp file + rename)
- Shared billing cache across sessions (`billing-shared.json`)
- Process lock for ccusage (`~/.claude/.ccusage.lock`)

## Review Focus
1. **Data accuracy** - model detection, context tokens, cost calculation
2. **Resource safety** - orphan processes, memory leaks, file descriptor leaks
3. **Multi-instance** - lock contention, race conditions, shared data corruption
4. **False positives** - secrets detection, stale indicators
5. **Cache efficiency** - update frequencies, TTLs, redundant operations

## Known Issues (User Reported)
- Model shows "Sonnet" when running "Haiku" (wrong source priority)
- Secrets detection triggered "Private Key" false positive (regex too broad)

## Ignore
- Style/formatting (linter handles)
- Test coverage (separate concern)
- Documentation
