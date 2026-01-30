# P3 Scope: Model Detection & Multi-Source Validation

## Mission
Validate that model detection is ACCURATE across all sources.
Verify the priority order: transcript > jsonInput > settings > default.
Check for edge cases and mismatches.

## Read First
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/00-COMMON-BRIEF.md
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/CLAUDE.md

## Review These Files
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/model-resolver.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/data-gatherer.ts (model section)
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/tests/unit/lib/model-resolver.test.ts

## Validation Tasks
1. What model names does Claude Code actually use in JSON input?
2. What model names appear in transcript files?
3. Is the model name normalization correct (e.g., "claude-sonnet-4-5" → "Sonnet4.5")?
4. What happens when sources disagree?
5. Is the 1-hour transcript freshness threshold reasonable?

## Commands to Run for Validation
```bash
# Check actual model in settings
cat ~/.claude/settings.json | grep -i model

# Check recent transcript for model info
ls -la ~/.claude/projects/ | head -5
```

## Write Output To
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/P3-review.md
