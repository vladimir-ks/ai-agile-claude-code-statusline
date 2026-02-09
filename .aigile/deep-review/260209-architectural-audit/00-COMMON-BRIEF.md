# Project Context — Statusline V2 Deep Review

## Architecture

Real-time cost tracking and session monitoring for Claude Code CLI. Decoupled architecture: fast read-only display layer (<10ms) + background data daemon that writes health files. Uses UnifiedDataBroker with 12 typed data sources across 3 tiers (instant/session/global).

## User's Core Concern

**"I don't think this is a problem that requires my re-login. There must be something wrong in the way that you are routing and using the data."**

User suspects:
1. Data routing issues or duplicate entries
2. Over-engineering (thousands of tests, yet basic functionality broken)
3. Architectural mix-ups preventing proper function
4. System should be simple but spending days debugging

**Critical Question**: Why does a "simple" statusline require 1645 tests and 90K lines yet quota data doesn't refresh?

## Review Focus

### PRIMARY (User's Suspicions)
1. **Data routing**: Trace quota data flow from cloud-configs → keychain → statusline
2. **Duplicate functionality**: Multiple readers for same data? Conflicting caches?
3. **Architectural complexity**: Is UnifiedDataBroker necessary? Over-abstracted?
4. **Dead code**: Features built but not used? Test inflation?
5. **Integration gaps**: Does statusline properly read from cloud-configs hot-swap system?

### SECONDARY (Standard Review)
- Security vulnerabilities
- Resource leaks
- Logic errors
- Missing error handling

## Key Facts from Investigation

1. **Cloud-configs hot-swap** (~/_claude-configs/hot-swap/):
   - Stores OAuth tokens in macOS Keychain (per-slot, hashed service names)
   - quota-broker.sh merges slot data → merged-quota-cache.json
   - refresh-token.sh (cron hourly) auto-refreshes expired tokens
   - fetch-quotas.sh calls Anthropic API for fresh quota data

2. **Statusline V2** (ingestion/ai-agile-claude-code-statusline/v2/):
   - display-only.ts: reads health files (<10ms, no network)
   - data-daemon.ts: background updates via UnifiedDataBroker
   - QuotaBrokerClient: reads merged-quota-cache.json
   - HotSwapQuotaReader: fallback to slot files
   - SubscriptionReader: fallback to subscription.yaml

3. **Current Symptom**: Quota data 11+ hours stale despite "working" auto-refresh

## Ignore

- Style/linting (handled by tooling)
- TypeScript type safety (compiler catches)
- Test patterns (focus on WHAT is tested, not HOW)
- Generated files (bun.lockb, etc.)

## Critical Questions to Answer

1. **Is cloud-configs data even being read?** Or is statusline using wrong paths?
2. **Are there multiple quota readers competing?** QuotaBroker vs HotSwap vs Subscription
3. **Is the UnifiedDataBroker architecture solving a real problem?** Or adding complexity?
4. **Why 1645 tests?** Are we testing mocks? Over-testing internals?
5. **Is data-gatherer.ts truly thin after migration?** Or still duplicating logic?

## Output Format

For each partition:

```markdown
# Review: [Partition Name]

## Critical Issues
[file:line - Spartan description of actual problem]

## Architectural Concerns
[Fundamental design issues, not just bugs]

## Dead Code / Over-Engineering
[Unused features, unnecessary abstractions]

## Integration Gaps
[Where statusline fails to use cloud-configs properly]

## Test Inflation
[Tests that don't validate real behavior]

## Summary
[3-5 sentences: core problem, impact, recommended fix]

## Fixes Immediately Applied
[If straightforward, fix and document here]
```

## Tone

**Spartan. Brutal honesty.** If something is over-engineered, say so. If tests are meaningless, say so. User wants lean, clear, functional code.
