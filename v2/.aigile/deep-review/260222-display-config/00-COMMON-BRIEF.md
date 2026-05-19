# Project Context

## Architecture
Claude Code statusline V2 — decoupled display layer (`display-only.ts`, <10ms, read-only) + background data daemon (`data-daemon.ts`). Formatter (`statusline-formatter.ts`) generates width-adaptive multi-line output with shrink cascades. Session health stored in `~/.claude/session-health/`.

## Recent Changes (This Session)
1. **Minimal loading state**: `!health` → always show just `⏳` (no partial state)
2. **Inline slot indicator**: `👤S1` between 🧠 and 💬, with shrink cascade integration
3. **Configurable display**: `DisplayConfig` with mode (auto/multiline/singleline), marginPercent (null/0/5-25), maxLines

## Key Conventions
- Static-only classes (no instances) for managers
- Atomic writes (temp file + renameSync)
- Non-critical side-effects wrapped in try/catch
- File-based IPC between display and daemon
- COLORS dict — only use defined keys
- SessionLockManager validates sessionId with `/^[a-zA-Z0-9_-]+$/`

## Review Focus
- Logic correctness of new display config integration
- Edge cases in margin calculation (marginPercent=0, negative, >100)
- Slot indicator rendering correctness across all width variants
- Width detection fallback chain (STATUSLINE_WIDTH → COLUMNS → 120)
- Config validation (malformed display config)
- Test coverage for new features
- Dead code from old `noTmux` logic
- Anti-wrapping guards with new defaults (paneWidth now defaults to 120 instead of 0)

## Ignore
- Pre-existing 2 test failures (E2E env, TelemetryDashboard CLI)
- Style/formatting issues
- Code outside recent changes unless directly affected
