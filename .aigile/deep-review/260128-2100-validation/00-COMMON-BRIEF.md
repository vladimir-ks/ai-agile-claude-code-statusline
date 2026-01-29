# Project Context: aigile - Claude Code Status Line (VALIDATION REVIEW)

## Architecture
Production-ready bash script displaying real-time Claude Code session metrics, costs, context usage, and git status. Integrates with ccusage CLI for billing data, uses intelligent caching (same-day TTL for ccusage, 10-sec for git), follows strict data source priority: Transcript → JSON input → defaults.

## Recent Changes (Just Completed)
- Phase 1: Security hardening (command injection, race conditions, path traversal, cache corruption)
- Phase 2: Comprehensive test suite (34 tests covering security, concurrency, error recovery, performance)
- All fixes validated and committed

## HEIGHTENED SCRUTINY REQUIREMENTS

**Critical Focus Areas:**
1. **Memory Leaks**: Unclosed file descriptors, unbounded arrays, zombie processes, resource accumulation
2. **Security**: ANY remaining injection risks, privilege escalation, data exposure, authentication bypasses
3. **UX/Setup Flow**: Installation pain points, unclear documentation, missing prerequisites, confusing error messages
4. **Operational Gaps**: Maintenance burden, upgrade path, monitoring blind spots, failure recovery procedures
5. **Edge Cases**: Boundary conditions, race windows, timeout edge cases, cache invalidation correctness

**Question Everything:**
- Does the setup documentation ACTUALLY work for a new user?
- Are error messages helpful or cryptic?
- Can users diagnose problems themselves?
- Are there hidden dependencies?
- What breaks when ccusage/git/jq unavailable?
- How does user know if it's working correctly?
- What's the maintenance burden?

## Key Conventions (Respect These)
- **Compact bash style**: Intentional (not a bug)
- **Global variables**: Standard for bash scripts
- **Error suppression**: Silent fallbacks prevent statusline breakage (by design)
- **No background processes**: 100% synchronous execution (critical safety feature)
- **Atomic writes**: Temp file → rename pattern (concurrency safety)

## Review Focus

**Primary:**
- Memory leaks (file descriptors, processes, unbounded growth)
- Security vulnerabilities (injection, traversal, privilege issues)
- UX/setup flow gaps (installation, configuration, troubleshooting)
- Operational concerns (maintenance, monitoring, failure recovery)

**Secondary:**
- Logic errors in data source priority
- Cache invalidation correctness
- Test coverage blind spots
- Documentation accuracy

## Ignore
- Style/formatting (intentional compact bash)
- Use of global variables (bash script standard)
- Lack of unit tests (integration tests via examples/)
- Complex conditionals (necessary for multi-source priority)
