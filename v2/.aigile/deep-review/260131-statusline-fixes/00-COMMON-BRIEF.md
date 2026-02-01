# Project Context

## Architecture
Claude Code statusline v2 - Real-time cost tracking and session monitoring. Uses decoupled architecture: display-only.ts reads pre-formatted JSON, data-daemon.ts gathers data in background.

## Key Conventions
- Display-only NEVER makes network calls
- Data flows: stdin JSON → display-only → stdout
- Billing data shared across sessions via billing-shared.json
- Context % = percentage of 78% compaction threshold, not total window

## CRITICAL ISSUES TO FIX

1. **Context shows 0-free** - Context data from JSON input not reaching formatter
2. **Budget % shows 0%** - `budgetPercentUsed` calculation broken
3. **Weekly % stale (73% vs 83%)** - Subscription YAML not refreshing
4. **Cost priority wrong** - Shows burn rate only, should show total FIRST
5. **Component drop order wrong** - Usage (📊) should drop BEFORE cost

## Expected Component Drop Order (when space tight):
1. First drop: Usage (📊)
2. Then drop: Turns (💬)
3. Then drop: Burn rate (keep total cost)
4. Last resort: Drop total cost

## Ignore
- Style issues
- Safety tests (timing-sensitive)
