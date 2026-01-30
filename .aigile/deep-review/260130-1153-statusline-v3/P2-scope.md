# P2 Scope: Billing & Cost Calculations

## Mission
Validate that billing/cost calculations are ACCURATE.
Verify ccusage output parsing and budget time calculations.
Ensure staleness detection is reasonable.

## Read First
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/00-COMMON-BRIEF.md
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/CLAUDE.md

## Review These Files
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/modules/ccusage-shared-module.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/data-gatherer.ts (billing section)
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/display-only.ts (fmtBudget, fmtCost)

## Validation Tasks
1. Run `ccusage blocks --json --active` and examine actual output structure
2. Verify costUSD, burnRate parsing is correct
3. Verify budget remaining calculation (hoursLeft, minutesLeft)
4. Verify resetTime extraction and formatting
5. Is the 2-minute billing cache TTL reasonable?
6. Is the staleness indicator (🔴) threshold correct?

## Commands to Run for Validation
```bash
ccusage blocks --json --active 2>/dev/null | head -100
```

## Write Output To
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/P2-review.md
