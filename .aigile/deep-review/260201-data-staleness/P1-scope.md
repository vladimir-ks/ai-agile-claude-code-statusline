# P1 Scope: Data Daemon & Orchestration

## Read First
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260201-data-staleness/00-COMMON-BRIEF.md
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/CLAUDE.md

## Review These Files
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/data-daemon.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/data-gatherer.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/statusline-bulletproof.sh

## Focus Questions
1. Is the daemon actually being triggered on each statusline invocation?
2. Are there early exits preventing billing refresh?
3. Is the daemon completing or timing out?
4. Are errors being swallowed silently?

## Write Output To
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260201-data-staleness/P1-review.md
