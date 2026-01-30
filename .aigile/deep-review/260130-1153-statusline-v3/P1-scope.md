# P1 Scope: Context Window & Token Calculations

## Mission
Validate that context window calculations are ACCURATE.
Cross-reference against Claude Code's actual JSON input structure.
Verify the 78% compaction threshold is correct.

## Read First
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/00-COMMON-BRIEF.md
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/CLAUDE.md

## Review These Files
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/data-gatherer.ts (calculateContext method)
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/display-only.ts (formatTokens, generateProgressBar)
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/modules/context-module.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/types/session-health.ts

## Validation Tasks
1. What fields does Claude Code actually provide in context_window JSON?
2. Is the formula: tokensUsed = input + cache_read + output correct?
3. Is 78% the actual compaction threshold Claude Code uses?
4. Is the progress bar calculation accurate?
5. Are edge cases handled (0 tokens, max tokens, negative)?

## Write Output To
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/P1-review.md
