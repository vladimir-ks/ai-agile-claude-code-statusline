# P4: Integration & Process Leak Prevention

## Read First
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260218-model-fix/00-COMMON-BRIEF.md`
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/CLAUDE.md`

## Review These Files
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/statusline-bulletproof.sh` (focus: timeout, lines 87-97)
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/data-daemon.ts` (model extraction from stdin, lines 113-135)
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/data-gatherer.ts` (model passed to resolver, lines 100-120)

## Write Output To
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260218-model-fix/P4-review.md`

## Specific Questions
1. Does the timeout increase 0.5→1.5s create new issues (e.g., blocking behavior)?
2. Is the empty fallback behavior handled correctly by Claude Code?
3. Are model and id fields both present in Claude Code stdin JSON? Any missing field handling?
4. Does data-daemon correctly pass jsonInput.model to the resolver?
5. Any race conditions between daemon and display-only model extraction?
6. Is formatModelId() inlining preventing any import-related issues?
7. Process lock behavior — does model state survive daemon cycle?
