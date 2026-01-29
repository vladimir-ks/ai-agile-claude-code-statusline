# Project Context: aigile - Claude Code Status Line

## Architecture
Production-ready bash script that displays real-time Claude Code session metrics, costs, context usage, and git status. Integrates with ccusage CLI tool for billing data, uses intelligent caching (15-min TTL for ccusage, 10-sec for git), and follows strict data source priority: JSON input → transcript → ccusage cache → settings.json → defaults.

## Key Conventions
- **Cache Strategy**: 15-min TTL for ccusage (expensive operation), 10-sec for git status
- **Model Detection**: JSON input (primary) → transcript if <1hr old → settings.json (global default only)
- **Atomic Writes**: All file writes use temp file → rename pattern
- **No Background Processes**: 100% synchronous, no subshells persisting
- **Error Suppression**: Silent fallbacks to prevent statusline breakage

## Review Focus
- **Resource Leaks**: Background processes, unclosed file descriptors, zombie processes
- **Race Conditions**: Concurrent cache access, file write atomicity
- **Security**: Command injection, path traversal, temp file vulnerabilities
- **Logic Errors**: Cache invalidation bugs, stale data display
- **Performance**: Unnecessary external commands, inefficient loops
- **Error Handling**: Silent failures that should be logged

## Ignore
- Style/formatting (intentional compact bash style)
- Use of global variables (standard for bash scripts)
- Lack of unit tests (integration testing via examples/)
- Complex conditionals (necessary for multi-source data priority)
