# Review: Git Status Accuracy

## Actual vs Reported Comparison

**Test Environment:** Repository at `/Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline`

### Actual Git State (via commands)
| Metric | Command | Result |
|--------|---------|--------|
| Branch | `git branch --show-current` | `main` |
| Ahead | `git rev-list --count @{u}..HEAD` | `37` |
| Behind | `git rev-list --count HEAD..@{u}` | `0` |
| Dirty (porcelain) | `git status --porcelain \| wc -l` | `1` |
| Dirty (uall) | `git status --porcelain -uall \| wc -l` | `7` |

### Module Expected Output
| Source | Format Code | Expected Output |
|--------|-------------|-----------------|
| git-module.ts format() | `+${ahead}/-${behind}` if either >0 | `main+37/-0*1` |
| display-only.ts fmtGit() | `+${ahead}` only if ahead>0, `/-${behind}` only if behind>0 | `main+37*1` |
| V1 statusline.sh | Same as git-module.ts | `main+37/-0*1` |

**FINDING: Format inconsistency between git-module.ts and display-only.ts**

## Dirty Count Accuracy

### Issue: Directory Collapsing

| Mode | Command | Count |
|------|---------|-------|
| Default porcelain | `git status --porcelain` | 1 (directory shown as single entry) |
| Full porcelain | `git status --porcelain -uall` | 7 (each file counted) |

**Module uses:** `git status --porcelain` (default)

**Implication:**
- Untracked directory with 7 files shows as `*1` not `*7`
- This is consistent with standard git behavior
- README claims "dirty files" but git shows "dirty entries"
- Technically accurate but semantically misleading

### Staged vs Unstaged
- Module counts ALL lines from `--porcelain`
- Includes: modified (M), added (A), deleted (D), renamed (R), copied (C), untracked (??)
- Does NOT differentiate staged from unstaged
- This is the correct behavior for "dirty count"

## Ahead/Behind Accuracy

### Correctness Verified
```bash
git rev-list --count @{u}..HEAD  # = 37 (commits ahead)
git rev-list --count HEAD..@{u}  # = 0 (commits behind)
```

Module uses identical commands. **Accuracy: CORRECT**

### Error Handling
- Both ahead/behind commands wrapped in try/catch
- On failure, defaults to `0` (silent failure)
- No indication to user that tracking info unavailable

## Edge Cases

### No Upstream Branch
**Test:** Created branch without remote tracking

| Scenario | Behavior | Assessment |
|----------|----------|------------|
| `git rev-list --count @{u}..HEAD` | Returns fatal error, exit 128 | Module catches, returns 0 |
| `git rev-list --count HEAD..@{u}` | Returns fatal error, exit 128 | Module catches, returns 0 |

**Result:** Silent degradation to `ahead=0, behind=0`. User cannot distinguish "synced" from "no tracking".

### Non-Git Directory
**Test:** Commands in `/tmp`

| Scenario | Behavior | Assessment |
|----------|----------|------------|
| `git branch --show-current` | Fatal error exit 128 | Module catches, returns `isRepo: false` |
| `git status --porcelain` | Fatal error exit 128 | Module catches |

**Result:** Correctly returns `{ isRepo: false }`. Display shows empty string for git component.

### Detached HEAD
Module and validator handle via regex check: `/^[0-9a-f]{7,40}$/i`

**Assessment:** Correct detection of SHA-like branch names.

## Critical Issues

### 1. Format Inconsistency [display-only.ts:187-188]
```typescript
// display-only.ts
if (h.git.ahead > 0) result += `+${h.git.ahead}`;
if (h.git.behind > 0) result += `/-${h.git.behind}`;
```
```typescript
// git-module.ts:85-86
if (data.ahead > 0 || data.behind > 0) {
  status += `+${data.ahead}/-${data.behind}`;
}
```

**Impact:** Different output from module vs display-only
- Module: `main+37/-0*1` (shows both when either non-zero)
- display-only: `main+37*1` (only shows non-zero values)
- V1: `main+37/-0*1` (matches module)

**Severity:** Medium - Visual inconsistency between V1 and V2 display-only

## Important Issues

### 2. Silent No-Upstream [git-module.ts:44-56]
```typescript
try {
  const { stdout: aheadStr } = await execAsync('git rev-list --count @{u}..HEAD', execOpts);
  ahead = parseInt(aheadStr.trim(), 10) || 0;
} catch {
  // No upstream or error, default to 0  <-- SILENT
}
```

**Impact:** User cannot distinguish:
- Branch fully synced with remote (ahead=0, behind=0)
- Branch has no upstream tracking (also shows ahead=0, behind=0)

**Severity:** Low - Most users have tracking branches

### 3. Dirty Count Semantics [git-module.ts:38]
```typescript
const dirty = status.trim().split('\n').filter(l => l.trim()).length;
```

**Impact:** Counts directory entries, not individual files for untracked directories.
- User sees `*1` when 7 untracked files exist in one directory
- Technically correct (git's behavior) but potentially confusing

**Severity:** Low - Matches git's default behavior

### 4. No Validation of Git Data in Display-Only [display-only.ts:184-191]
```typescript
function fmtGit(h: SessionHealth): string {
  if (!h.git?.branch) return '';  // Only checks branch exists
  // No validation of ahead/behind/dirty being valid numbers
```

**Impact:** If health file has corrupt data (e.g., `ahead: "NaN"`), display proceeds without validation.

**Severity:** Low - Defensive, but relies on daemon writing valid data

## Recommendations

### Must Fix
1. **Align format logic** between git-module.ts and display-only.ts
   - Decision: Use V1 format (show both when either >0) OR new format (only show non-zero)
   - Ensure consistency across all formatters

### Should Fix
2. **Add upstream indicator** - Show `~` or similar when no upstream tracking
   - `main~*3` = no upstream, 3 dirty files
   - `main+5/-0*3` = has upstream, 5 ahead, 3 dirty

3. **Consider -uall flag** for dirty count to show actual file count
   - Trade-off: More accurate count vs. potentially large numbers

### Nice to Have
4. **Add data validation** in fmtGit for numeric fields
5. **Cache upstream check** separately (rarely changes mid-session)

## Summary

**Overall Accuracy:** GOOD with caveats

| Aspect | Rating | Notes |
|--------|--------|-------|
| Branch detection | Excellent | Correct commands, proper error handling |
| Ahead/behind counts | Excellent | Accurate when upstream exists |
| Dirty count | Good | Matches git default (directory collapsing) |
| Non-git handling | Excellent | Clean degradation to isRepo=false |
| No-upstream handling | Adequate | Silent degradation, no indicator |
| Format consistency | Poor | V2 display-only differs from V1/module |

**Key Finding:** The git data collection is accurate, but there's a format inconsistency between `git-module.ts` (V1-compatible) and `display-only.ts` (V2 display) that should be resolved.

**10s Cache TTL:** Appropriate for git status which can change frequently during development.
