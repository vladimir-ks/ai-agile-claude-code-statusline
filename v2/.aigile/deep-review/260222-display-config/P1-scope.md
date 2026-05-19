# P1 Scope: Display-Only Layer

## Read First
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260222-display-config/00-COMMON-BRIEF.md

## Review These Files
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/display-only.ts

## Focus
- DisplayConfig interface and DEFAULT_DISPLAY correctness
- Config reading (display section merge with defaults)
- Width detection: STATUSLINE_WIDTH → COLUMNS → 120 fallback
- `useSingleLine` logic with all 3 modes
- `paneWidth` now defaults to 120 — impact on Guard 2 (hard truncation) and Guard 3
- Edge cases: marginPercent negative or >100, mode invalid string, maxLines=0
- The `!health` → `⏳` minimal loading path
- Dead code or stale comments referencing `noTmux`

## Write Output To
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260222-display-config/P1-review.md
