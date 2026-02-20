# P3: Tests & Behavioral Correctness

## Read First
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260218-model-fix/00-COMMON-BRIEF.md`
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/CLAUDE.md`

## Review These Files
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/tests/model-resolver.test.ts` (all 22 tests)
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/tests/display-only.test.ts` (focus: model handling tests, lines 449+)
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/tests/spec-validation.test.ts` (focus: model tests, lines 180+)
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/tests/safety.test.ts` (focus: timeout test, line 210)

## Write Output To
- `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260218-model-fix/P3-review.md`

## Specific Questions
1. Do all 1805 tests pass? Are there any flaky tests introduced?
2. Do model resolver tests cover edge cases: mixed case, dot versions, dash versions?
3. Is the "prefers stdin model" test behavior correct after changes?
4. Are there missing test cases for: version extraction, format preservation, fallback paths?
5. Does the timeout test correctly verify protection exists?
6. Any test fixtures that need updating for new version behavior?
