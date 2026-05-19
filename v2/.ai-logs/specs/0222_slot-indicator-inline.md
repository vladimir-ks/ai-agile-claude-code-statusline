# Spec: Inline Slot Indicator (👤S1)

## Problem
Slot identity only visible in notification lines (idle/intermittent). User needs persistent at-a-glance slot awareness.

## Solution
Add compact `👤S1` between 🧠(context) and 💬(turns) on Line 1/L2.

## Layout

```
📁:dir 🌿:branch 🤖:Model 🧠:ctx 👤S1 💬:2t 📦:484KB
```

When overflowed to L2:
```
🤖:Model 🧠:ctx 👤S1 💬:2t 📦:484KB v2.1.50
```

## Behavior
- Source: `SessionLockManager.read(sessionId)` → `lock.slotId` → extract digit
- Fallback: omit if no lock file (pre-first-message, no session lock yet)
- Color: slot-specific (S1=critical/red, S2=usage/cyan, S3=weeklyBudget/lavender, S4=cost/gold)
- Width: ~4 visible chars (`👤S1`) — participates in shrink cascade
- Shrink priority: drop `👤S1` BEFORE dropping context (slot is less critical than context usage)

## Shrink Cascade (updated)
1. Full model + full context + slot + turns
2. Full model + medium context + slot + turns
3. Full model + short context + slot + turns
4. Full model + minimal context + slot
5. Abbreviated model + short context + slot
6. Abbreviated model + minimal context + slot
7. Abbreviated model + slot (context→L2)
8. Abbreviated model only (slot→L2, context→L2)
9. Core only (dir + git)

Slot drops to L2 at same threshold as turns — it's a small, nice-to-have indicator.

## Files Changed
- `statusline-formatter.ts`: Add `fmtSlotIndicator()`, integrate into `buildLine1WithOverflow()`, `buildLine2WithOverflow()`, `formatSingleLine()`
- Tests: Add slot indicator tests

## No Changes
- `display-only.ts` — slot comes from session lock, not stdin
- Notification lines — unchanged, still show full `👤 S1|email|...`
