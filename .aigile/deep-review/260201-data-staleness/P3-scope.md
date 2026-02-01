# P3 Scope: Cooldown & Lock Management

## Read First
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260201-data-staleness/00-COMMON-BRIEF.md
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/CLAUDE.md

## Review These Files
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/cooldown-manager.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/process-lock.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/broker/data-broker.ts

## Focus Questions
1. Is cooldown too aggressive, preventing refreshes entirely?
2. Are stale locks blocking new fetches?
3. Is lock cleanup working properly?
4. Is there a deadlock scenario?
5. What are the cooldown durations and are they reasonable?

## Write Output To
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260201-data-staleness/P3-review.md
