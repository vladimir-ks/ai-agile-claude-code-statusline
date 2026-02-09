# P4 Scope: DataGatherer & Legacy Code

## Read First
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/.aigile/deep-review/260209-architectural-audit/00-COMMON-BRIEF.md
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/docs/UNIFIED_DATA_BROKER_COMPLETE.md (claims 379 lines removed)

## Review These Files
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/data-gatherer.ts

## Focus Questions
1. **Size**: Is it truly 314 lines or still bloated?
2. **Dead code**: Any functions NOT called by anyone?
3. **Duplication**: Does it duplicate UnifiedDataBroker logic?
4. **Dependencies**: Does anything else import DataGatherer or is it only used by data-daemon?
5. **Justification**: After UnifiedDataBroker migration, why does DataGatherer exist at all?

## Write Output To
/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/.aigile/deep-review/260209-architectural-audit/P4-review.md
