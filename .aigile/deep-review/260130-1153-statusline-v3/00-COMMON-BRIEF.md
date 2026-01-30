# Project Context: Statusline V3 Deep Review

## Architecture
Bulletproof statusline for Claude Code CLI that displays real-time session metrics.
Decoupled architecture: display-only (reads JSON files, <50ms) runs synchronously,
data-daemon (network/subprocess) runs in background AFTER display completes.

## Critical Review Focus
**DATA ACCURACY IS PARAMOUNT** - User sees this information constantly.
Any inaccuracy damages trust and utility.

### Key Data Sources to Validate:
1. **Context Window** - tokens left, percent used, compaction threshold
2. **Billing** - cost today, burn rate, budget remaining, reset time
3. **Git** - branch, ahead/behind, dirty count
4. **Model** - current model name detection
5. **Transcript** - sync status, staleness, data loss risk

### Validation Requirements:
- Cross-reference calculations against actual Claude Code JSON input
- Verify ccusage output parsing is accurate
- Check formula correctness (e.g., 78% compaction threshold)
- Ensure staleness detection thresholds are reasonable
- Verify time calculations (budget remaining, reset time)

## Key Conventions
- NO_COLOR env var disables ANSI colors
- Health files at ~/.claude/session-health/[session-id].json
- Daemon log at ~/.claude/session-health/daemon.log
- Process lock at ~/.claude/.ccusage.lock

## Review Checklist
- [ ] Data source accuracy
- [ ] Formula correctness
- [ ] Edge case handling (null, undefined, 0, negative)
- [ ] Error indicator accuracy
- [ ] Resource safety (timeouts, locks, cleanup)
- [ ] Memory leak potential
- [ ] Orphan process prevention

## Ignore
- Style/formatting issues
- Test file structure
- Documentation completeness
