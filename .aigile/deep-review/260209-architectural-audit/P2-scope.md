# P2 Scope: UnifiedDataBroker Architecture

## Read First
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/.aigile/deep-review/260209-architectural-audit/00-COMMON-BRIEF.md
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/docs/UNIFIED_DATA_BROKER_COMPLETE.md

## Review These Files
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/unified-data-broker.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/sources/registry.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/sources/types.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/data-cache-manager.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/single-flight-coordinator.ts

## Focus Questions
1. **Necessity**: Does this solve a real problem or add complexity?
2. **Usage**: Is UnifiedDataBroker actually used by display-only.ts or just data-daemon.ts?
3. **Duplication**: Does DataGatherer still duplicate logic after "migration"?
4. **Over-abstraction**: 12 typed source descriptors for 12 data sources = 1:1. Why not just functions?
5. **Global cache**: Does data-cache.json actually improve performance or cause staleness?

## Write Output To
/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/.aigile/deep-review/260209-architectural-audit/P2-review.md
