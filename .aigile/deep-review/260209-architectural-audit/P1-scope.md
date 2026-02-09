# P1 Scope: Quota Data Flow & Readers

## Read First
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/.aigile/deep-review/260209-architectural-audit/00-COMMON-BRIEF.md
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/CLAUDE.md
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/docs/OAUTH_TOKEN_ARCHITECTURE.md

## Review These Files
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/quota-broker-client.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/hot-swap-quota-reader.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/subscription-reader.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/sources/quota-source.ts

## Focus Questions
1. **Cascade logic**: Does quota-source properly try broker → hot-swap → subscription?
2. **Path resolution**: Are cloud-configs paths hardcoded or configurable?
3. **Duplicate reads**: Do multiple readers compete or conflict?
4. **Data freshness**: Who triggers refresh? QuotaBrokerClient.spawnBroker() or someone else?
5. **Integration**: Does statusline correctly detect slot from keychain service name?

## Write Output To
/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/.aigile/deep-review/260209-architectural-audit/P1-review.md
