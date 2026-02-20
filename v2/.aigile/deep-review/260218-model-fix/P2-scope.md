# P2: Model Resolver & Data Sources

## Read First
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260218-model-fix/00-COMMON-BRIEF.md`
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/CLAUDE.md`

## Review These Files
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/model-resolver.ts` (focus: version extraction lines 206-223)
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/sources/model-source.ts` (priority logic)
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/types/session-health.ts` (ClaudeCodeInput interface)

## Write Output To
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260218-model-fix/P2-review.md`

## Specific Questions
1. Does version regex `/(\d+)-(\d+)(?:-\d|$)/` correctly match all Claude model IDs?
2. Does the dot-version fallback `/(\d+\.\d+)/` preserve already-formatted names?
3. Are all 3 source priorities (jsonInput > transcript > settings) respected?
4. Is settings.json model ("haiku") correctly formatted to "Haiku" (no version)?
5. Any issues with model disagreement detection?
