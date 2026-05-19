# P4 Scope: Shell Wrapper & Config Integration

## Read First
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260222-display-config/00-COMMON-BRIEF.md

## Review These Files
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/statusline-bulletproof.sh
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/config/statusline.config.json

## Focus
- Shell wrapper sets STATUSLINE_WIDTH=$COLUMNS when not in tmux — does this align with new display-only.ts fallback chain?
- Is there redundancy now? (shell sets COLUMNS fallback, display-only.ts also falls back to COLUMNS)
- Config file format — does it include display section or need updating?
- Any shell-level configuration that could conflict with the new TypeScript-level DisplayConfig
- Race conditions between shell width detection and display-only.ts width detection

## Write Output To
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/.aigile/deep-review/260222-display-config/P4-review.md
