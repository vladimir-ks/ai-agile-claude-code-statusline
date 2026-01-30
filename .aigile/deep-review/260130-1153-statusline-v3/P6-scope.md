# P6 Scope: Resource Safety & Process Management

## Mission
Validate that the system cannot leak resources.
Verify orphan prevention, timeouts, and locks work correctly.

## Read First
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/00-COMMON-BRIEF.md

## Review These Files
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/statusline-bulletproof.sh
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/data-daemon.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/process-lock.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/tests/safety.test.ts

## Validation Tasks
1. Can background daemons become orphaned?
2. Is SIGKILL actually sent on timeout?
3. Is the process lock race-condition free?
4. What happens if lock file is corrupted?
5. Is log rotation working correctly?
6. Can memory grow unbounded in any path?

## Commands to Run for Validation
```bash
# Check for orphan daemon processes
pgrep -f "bun.*data-daemon" | wc -l

# Check lock file
cat ~/.claude/.ccusage.lock 2>/dev/null || echo "no lock"

# Check daemon log size
ls -la ~/.claude/session-health/daemon.log 2>/dev/null
```

## Write Output To
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/P6-review.md
