# P6 Scope: Billing Data Sources

## Read First
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/.aigile/deep-review/260209-architectural-audit/00-COMMON-BRIEF.md

## Review These Files
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/sources/billing-source.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/ccusage-client.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/local-cost-tracker.ts

## Focus Questions
1. **Cascade logic**: Does billing-source properly handle OAuth → ccusage → local cost?
2. **Duplicate billing**: Are there multiple billing readers? Shared cache vs per-session?
3. **ccusage-client**: Does it properly detect ccusage CLI or always fail?
4. **Lock contention**: billing-shared.json - do multiple daemons fight over this?
5. **Dead code**: Any billing readers not used by quota or billing sources?

## Write Output To
/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/.aigile/deep-review/260209-architectural-audit/P6-review.md
