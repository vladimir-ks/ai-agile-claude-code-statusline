# P2 Scope: Statusline Formatter

## Read First
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260222-display-config/00-COMMON-BRIEF.md

## Review These Files
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/statusline-formatter.ts

## Focus
- `formatAllVariants(health, marginPercent?)` — parameter threading
- `formatForWidth(health, width, marginPercent?)` — margin calculation with all marginPercent values
- `fmtSlotIndicator(sessionId)` — correctness, edge cases (no lock, malformed slotId)
- Slot indicator integration in `buildLine1WithOverflow` — ordering in turnsSizeParts
- Slot indicator in `formatSingleLine` — ordering in combinations array
- Shrink cascade correctness — does slot participate correctly at each level?
- Edge: marginPercent=0 → margin=0 → effectiveWidth=width (full width)
- Edge: marginPercent=100 → margin=width → effectiveWidth=0 (catastrophic)
- Edge: marginPercent negative
- `buildAccountContextLine` still has its own slot extraction — duplication with fmtSlotIndicator?

## Write Output To
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260222-display-config/P2-review.md
