# P3 Scope: Tests for Recent Changes

## Read First
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260222-display-config/00-COMMON-BRIEF.md

## Review These Files
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/tests/display-only.test.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/tests/statusline-formatter-integration.test.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/tests/spec-validation.test.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/tests/safety.test.ts

## Focus
- Test coverage gaps for new DisplayConfig (mode, marginPercent, maxLines)
- Test coverage for inline slot indicator across different widths
- Edge case tests missing (negative margin, invalid mode, maxLines=0)
- Tests for width fallback chain (no STATUSLINE_WIDTH, no COLUMNS)
- Tests for resumed session loading state
- Are model tests correctly updated with health files?
- Any assertions that became too weak after changes

## Write Output To
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260222-display-config/P3-review.md
