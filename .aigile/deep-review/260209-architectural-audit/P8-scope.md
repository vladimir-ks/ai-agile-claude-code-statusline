# P8 Scope: Cloud-Configs Integration

## Read First
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/.aigile/deep-review/260209-architectural-audit/00-COMMON-BRIEF.md
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/docs/OAUTH_TOKEN_ARCHITECTURE.md

## Review These Files
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/auth-profile-detector.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/keychain-resolver.ts
- /Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/session-lock-manager.ts

## Focus Questions
1. **Path detection**: Does statusline correctly find ~/_claude-configs/hot-swap/?
2. **Keychain service resolution**: Does getKeychainService() match cloud-configs hashing?
3. **Slot detection**: Can statusline determine which slot is active from keychain?
4. **Integration**: Does QuotaBrokerClient.getActiveQuota() properly use keychainService parameter?
5. **Fallback**: What happens if cloud-configs doesn't exist? Silent fail or error?

## Critical Test
Trace data flow: stdin session_id → KeychainResolver → get keychainService → QuotaBrokerClient → match slot

## Write Output To
/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/.aigile/deep-review/260209-architectural-audit/P8-review.md
