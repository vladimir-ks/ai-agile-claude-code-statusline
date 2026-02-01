# Project Context

## Architecture
Real-time cost tracking statusline for Claude Code. Uses decoupled architecture:
- **display-only.ts**: Fast (<50ms), read-only, reads pre-formatted JSON health files
- **data-daemon.ts**: Background process updates health files after display
- **statusline-formatter.ts**: Pre-computes formatted output for multiple terminal widths

## Key Conventions
- Display layer NEVER makes network calls or spawns processes
- Billing data fetched via ccusage CLI tool (external dependency)
- Pre-formatted output stored in session health JSON files
- 75% terminal width used to avoid tmux corner text overlap

## Review Focus
**PRIMARY**: Data staleness issue - billing/budget data shows ⚠⚠ (very stale)
- Why isn't data-daemon refreshing billing data properly?
- Why does ccusage fetch appear to fail or not run?
- Is there a cooldown/lock issue preventing refreshes?
- Is the daemon even being triggered?

**SECONDARY**:
- Resource leaks (file handles, processes)
- Lock contention issues
- Error handling gaps in data fetching
- Race conditions in shared billing cache

## Ignore
- Display formatting issues (already fixed)
- Style/lint issues
- Test files (separate partition)
