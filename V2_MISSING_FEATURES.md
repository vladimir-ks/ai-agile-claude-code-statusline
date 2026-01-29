# V2 Missing Features vs V1

## Current State

**V1 Output (Full):**
```
📁:~/.claude 🌿:main+12/-0*1 🤖:Haiku4.5 📟:v1.0 🧠:154kleft [---------|--]
🕐:12:06 ⌛:1h53m(62%)14:00 💰:$40.3|$15.1/h 📊:83.4Mtok(521ktpm) 💾:16%
```

**V2 Output (Current):**
```
🌿:main*7 🤖:Sonnet 4.5 🧠:141kleft[=-----------] 🕐:14:03 ⏱:0m
```

---

## V2 Implemented (5 modules)
✅ Git status (branch + dirty count)
✅ Model detection
✅ Context window (tokens left)
✅ Time (current)
✅ Duration (session length)

## Missing from V2 (7+ features)

### 1. 📁 Directory Module
**V1 showed:** `📁:~/.claude`
**V2 shows:** Nothing
**Status:** Not implemented

### 2. Git Ahead/Behind Counts
**V1 showed:** `+12/-0` (commits ahead/behind)
**V2 shows:** Just `*7` (dirty files)
**Status:** Module exists but not parsing ahead/behind

### 3. 📟 Version Display
**V1 showed:** `📟:v1.0`
**V2 shows:** Nothing
**Status:** Not implemented

### 4. ⌛ Budget Tracking
**V1 showed:** `⌛:1h53m(62%)14:00`
- Hours left in billing period
- Percentage of weekly budget used
- Reset time (UTC)
**V2 shows:** Nothing
**Status:** Not implemented (needs weekly usage tracking)

### 5. 💰 Cost Display
**V1 showed:** `💰:$40.3|$15.1/h`
**V2 shows:** Nothing
**Status:** Module exists but not displaying (ccusage takes 20-30s, module times out silently)

### 6. 📊 Total Tokens + TPM
**V1 showed:** `📊:83.4Mtok(521ktpm)`
- Total tokens used in session
- Tokens per minute burn rate
**V2 shows:** Nothing
**Status:** Not implemented (V2 only shows tokens LEFT, not total)

### 7. 💾 Cache Hit Ratio
**V1 showed:** `💾:16%`
**V2 shows:** Nothing
**Status:** Not implemented

### 8. 💬 Last Message (optional)
**V1 showed:** `💬:14:30(2h43m) What is...`
**V2 shows:** Nothing
**Status:** Not implemented

---

## Why Cost Module Exists But Doesn't Show

Cost module (`v2/src/modules/cost-module.ts`) is implemented but:
1. ccusage takes 20-30 seconds to fetch
2. Quick test didn't wait long enough
3. Module may be timing out silently

---

## Options

### Option 1: Roll Back to V1 (Immediate)
```bash
cp ~/.claude/settings.json.backup ~/.claude/settings.json
```
- Restores all features
- No missing data
- V1 issues remain (race conditions, etc.)

### Option 2: Add Missing Modules to V2 (3-4 hours)
Need to create:
- `directory-module.ts` (10 min)
- Update `git-module.ts` for ahead/behind (20 min)
- `version-module.ts` (5 min)
- `budget-module.ts` (needs weekly usage logic, 1 hour)
- Fix cost module timeout (30 min)
- `tokens-module.ts` (total + TPM, 45 min)
- `cache-ratio-module.ts` (30 min)
- `last-message-module.ts` (30 min)

Total: ~4 hours for feature parity

### Option 3: Hybrid - Add Critical Features Only (1 hour)
Priority:
1. Fix cost display (30 min)
2. Add git ahead/behind (20 min)
3. Add directory (10 min)

Leave for later:
- Budget tracking (complex)
- Total tokens/TPM (nice-to-have)
- Cache ratio (nice-to-have)
- Last message (optional)

---

## Recommendation

**Immediate:** Use V1 until V2 has feature parity
**Next Session:** Complete missing V2 modules

V2 architecture is solid (session isolation, no race conditions, comprehensive tests) but incomplete vs V1 feature set.
