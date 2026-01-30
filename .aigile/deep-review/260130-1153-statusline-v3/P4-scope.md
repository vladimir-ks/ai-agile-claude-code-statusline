# P4 Scope: Git Status Accuracy

## Mission
Validate that git status information is ACCURATE.
Verify ahead/behind/dirty counts match actual git state.

## Read First
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/00-COMMON-BRIEF.md

## Review These Files
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/modules/git-module.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/display-only.ts (fmtGit)

## Validation Tasks
1. Run actual git commands and compare to module output
2. Verify dirty count calculation (does it count staged + unstaged?)
3. Verify ahead/behind counts against @{u} tracking
4. What happens when there's no upstream?
5. What happens in a non-git directory?
6. Is the 10s cache TTL appropriate?

## Commands to Run for Validation
```bash
git branch --show-current
git status --porcelain | wc -l
git rev-list --count @{u}..HEAD 2>/dev/null || echo "no upstream"
git rev-list --count HEAD..@{u} 2>/dev/null || echo "no upstream"
```

## Write Output To
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/P4-review.md
