# Statusline Line 2 — Field Reference

Line 2 of the statusline shows the active slot, current time, and live quota metrics. All quota-derived fields include a staleness decorator when the merged-quota-cache is not fresh.

---

## Field Inventory

| Field | Example | Source | Notes |
|-------|---------|--------|-------|
| `⛔` | `⛔S1\|vlad@...` | rate-limit state file | Slot banned — backoff active. Entire badge dimmed. |
| `S1\|vlad@vladks.com` | `👤S1\|vlad@vladks.com` | session lock + YAML | Active slot number + email. |
| `🕐:HH:MM` | `🕐:14:32` | system clock | Local time at render time. Never stale. |
| `⌛:reset(X%)` | `⌛:2h30m(45%)` | merged-quota-cache | Time until next 5h-session reset + % of 5h budget consumed. |
| `📅:Nh X%→Y%` | `📅:120h 65%→114%` | merged-quota-cache | Weekly quota: hours remaining, current 7-day util, projected end-of-week util. |
| `🔥:A-B%/h\|C%/d` | `🔥:5-12%/h\|10%/d` | merged-quota-cache | Burn rate: hourly min-max range (5h window) + daily average (7d baseline). |
| `💰:$X.Y\|$Z.ZZ/h` | `💰:$1.2\|$0.80/h` | ccusage + transcript | Cost: session total + current hourly rate. Independent of quota cache. |

---

## Weekly Quota Field Decoded: `📅:120h 65%→114%`

- `120h` — `weekly_budget_remaining_hours`: hours of quota left this week
- `65%` — `seven_day_util`: current 7-day rolling usage as % of weekly budget
- `→114%` — `weekly_projected_util`: projection if current burn rate continues to week-end; >100% means overrun predicted

When projection data is absent (< 3 burn samples), the arrow is omitted: `📅:120h 65%`.

---

## Burn Rate Field Decoded: `🔥:5-12%/h|10%/d`

- `5-12%/h` — min-max hourly rate over the last 5h window (shown when ≥ 3 samples with distinct values)
- `10%/d` — 7-day average daily rate

Low-confidence prefix `~` appears when sample count < 3. Color reflects pacing status (green=on-track, orange=slow, red=losing, blue=fast).

---

## Staleness Decorators

Quota-derived fields (⌛, 📅, 🔥) reflect data from `merged-quota-cache.json`. When that cache is stale the fields are decorated:

| Cache age | Decoration | Behaviour |
|-----------|-----------|-----------|
| < 30 min | none | Numbers shown as-is |
| 30 – 120 min | ` ⚠` appended | Numbers still present; warn glyph at end |
| ≥ 120 min | field replaced with `⚠` | Label only; e.g. `🔥:⚠`, `📅:⚠`, `⌛:⚠` |

The `💰` cost block is sourced from local ccusage data — it is NOT subject to quota-cache staleness and never shows `⚠`.

The old trailing `⚠⚠ STALE Nm` banner has been removed. Staleness is now per-field only.

---

## Staleness Thresholds (source: `statusline-formatter.ts`)

- `STALE_WARN_MIN = 30` — minutes before warn tier activates
- `STALE_SEVERE_MIN = 120` — minutes before severe (label-only) tier activates

These are module-level constants. Do not promote to env vars unless a concrete need arises (YAGNI).

---

## Slot Ban Indicator

`⛔` prefix on the slot badge means the slot is in rate-limit backoff (`backoff_until_epoch` is in the future in `.fetch-rate-limit-state.{slotId}`). The entire badge is dimmed to `neutralLight` (245). Recovery is automatic when the backoff epoch passes.
