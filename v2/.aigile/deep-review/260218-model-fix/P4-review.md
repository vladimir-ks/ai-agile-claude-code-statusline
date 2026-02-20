# P4 Review: Integration

## Critical Issues

**None identified.**

All critical safety boundaries hold. Model extraction, timeout protection, and process locking are sound.

---

## Important Issues

### 1. formatModelId() Inlining vs ModelResolver.formatModelName() — Hidden Drift Risk
**File**: `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/display-only.ts:508-519` vs `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/model-resolver.ts:206-225`

**Issue**: Two identical implementations of version extraction regex exist:
- `display-only.ts` has inlined `formatModelId()` (no imports, architectural guarantee)
- `model-resolver.ts` has `ModelResolver.formatModelName()`

Both use same regex: `(\d+)-(\d+)(?:-\d|$)` for dash-sep, `(\d+\.\d+)` for dot-sep.

**Risk**: If either is updated for new model format (e.g., `claude-opus-5-0-20260301`), the other stays stale. Daemon shows `Opus5.0` but display shows `Opus5`.

**Example**:
```typescript
// display-only.ts line 514
const version = dashVersion ? `${dashVersion[1]}.${dashVersion[2]}` : (dotVersion ? dotVersion[1] : '');

// model-resolver.ts line 213
const version = dashVersion ? `${dashVersion[1]}.${dashVersion[2]}` : (dotVersion ? dotVersion[1] : '');
```

Both identical today, but maintenance burden. No way to enforce sync.

**Recommendation**: Extract shared constant or add comment referencing each location. Not critical (V5 models unlikely soon), but flag for future.

---

### 2. Timeout 0.5→1.5s Grace Period Asymmetry
**File**: `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/statusline-bulletproof.sh:91-94`

**Issue**: Display timeout uses `timeout -k 0.5 1.5 bun`:
- 1.5s total timeout
- 0.5s grace period before SIGKILL
- Means SIGTERM to process → waits 0.5s → force kills

**Current behavior**: Process gets 0.5s to clean up after SIGTERM. Safe.

**Concern**: If display-only.ts needs to flush buffered writes or clean temp files, 0.5s may be tight. Currently no-op (no writes), but architectural note: **display-only MUST remain write-free** to preserve this guarantee.

**Recommendation**: Document that grace period is intentionally short (kill is guaranteed by design), and display-only writer must NEVER add I/O.

---

### 3. Fallback Behavior Changed: Empty String vs ⚠️:timeout
**File**: `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/statusline-bulletproof.sh:94`

**Issue**: Changed from outputting warning indicator to empty string on timeout:
```bash
# Old (implicit): if timeout, would have shown error marker
# New: timeout → DISPLAY_OUTPUT="" → printf '%s' "" → nothing

DISPLAY_OUTPUT=$(echo "${JSON_INPUT}" | timeout -k 0.5 1.5 bun "$DISPLAY_SCRIPT" 2>/dev/null) || DISPLAY_OUTPUT=""
```

**Effect**:
- User sees blank statusline instead of ⚠️ indicator
- Silent failure (harder to debug)
- Assumes daemon will recover it next cycle

**Question from scope Q4**: "Is the empty fallback behavior handled correctly by Claude Code?"

**Assessment**:
- Claude Code (`statusline-bulletproof.sh` is wrapper called by Claude Code)
- Display returns empty → Claude Code gets empty statusline
- Claude Code likely shows default UI or partial statusline
- Next daemon cycle (5-60s later) restores data

**Risk**: User doesn't see "something's wrong" signal. Might notice display blanked.

**Recommendation**: Consider restoring a minimal fallback:
```bash
DISPLAY_OUTPUT=$(echo "${JSON_INPUT}" | timeout -k 0.5 1.5 bun "$DISPLAY_SCRIPT" 2>/dev/null) || DISPLAY_OUTPUT="🕐:$(date +%H:%M)"
```
Minimal clock keeps statusline visible, signals timeout + still fast. Not critical (daemon recovers), but UX improvement.

---

## Architectural Concerns

### 1. Model State Persistence Across Sessions — Correct but Implicit
**File**: `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/unified-data-broker.ts:115-127` and `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/sources/model-source.ts:29-37`

**Pattern**:
1. Display layer (`display-only.ts:542`) reads model from stdin + falls back to health file
2. Daemon layer (model-source) reads from stdin → resolves via transcript/settings → writes to health file
3. Next invocation: display reads updated health file

**Correctness**: ✓ Sound. stdin always wins (per-session), health file is fallback cache.

**Question from scope Q7**: "Does model state survive daemon cycle?"

**Answer**: Yes. Sequence:
1. T0: Display reads stdin model → shows it
2. T0: Daemon starts, reads stdin model → resolves it → writes to health file
3. T1: New display invocation reads health file (stdin model if provided, else cached)

**Implicit assumption**: Health file model is only read when stdin has NO model. Verified in display-only.ts:579-610.

**Concern**: If daemon crashes after acquiring lock but before writing health file, model stays in old health file. Acceptable because display reads stdin first.

**Recommendation**: All sound. Architecture guarantees per-session isolation (stdin always wins).

---

### 2. Race Condition: Daemon Lock → Model Written
**File**: `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/data-daemon.ts:93-100` (lock acquire) vs `132-136` (gather delegates to broker)

**Pattern**:
```typescript
const lockResult = await daemonLock.acquire();
if (!lockResult.acquired) {
  process.exit(0);  // Expected, another daemon has lock
}
// ... then gather() writes health file
```

**Lock guarantees**:
- Exactly 1 daemon holds lock at any time
- Lock has 35s stale timeout (> 30s shell timeout)
- Release on exit (all paths)

**Timing**:
1. Daemon A acquires lock at T0
2. Daemon B tries lock → fails → exits
3. Daemon A gathers data (up to 20s deadline)
4. Daemon A writes health file
5. Daemon A releases lock

**Race**: What if Daemon A dies after write but before release?
- Lock file stale after 35s
- Next Daemon C acquires lock (expected, safety correct)

**Assessment**: Safe. Lock prevents concurrent writes to same health file. Model data survives daemon cycle.

---

### 3. Model Extraction Priority — stdin > transcript > settings > default
**File**: `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/lib/model-resolver.ts:49-68`

**Priority chain**:
1. `jsonInput.model.id` (real-time, highest confidence, has version)
2. `jsonInput.model.display_name` (fallback if no id)
3. Fresh transcript (<5min) (if no JSON)
4. Settings.json (fallback, low confidence)
5. "Claude" (hardcoded default)

**Question from scope Q3**: "Are model and id fields both present in Claude Code stdin JSON?"

**Answer**: According to test fixtures, yes BUT:
- `model.id` is present ("claude-opus-4-6")
- `model.display_name` is present ("Opus" or "Claude Opus 4.5")
- Daemon prefers `id` over `display_name` (line 51)

**Edge case**: What if Claude Code sends ONLY `display_name` (no `id`)?
- Falls back to `display_name` → `formatModelName()` handles it
- If `display_name = "Claude Opus 4.5"`, version extracted via dot-version regex
- If `display_name = "Opus"`, no version → shows as "Opus"

**Test coverage**:
- ✓ Test "handles id field (preferred — has version)" — `id` present, `display_name` present
- ✓ Test "falls back to display_name when no id" — `id` missing, `display_name` present
- ✓ Test "handles mixed case model names" — OPUS → Opus (no version)

**Assessment**: Correct. Priority is sound, fallbacks are tested.

---

### 4. Timeout Increase from 0.5s to 1.5s — Bun Cold Start Impact
**File**: `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/statusline-bulletproof.sh:91`

**Scope Q1**: "Does the timeout increase 0.5→1.5s create new issues (e.g., blocking behavior)?"

**Context**: Bun cold start can take 300-800ms under load (project comment, line 91).

**Analysis**:
- 0.5s timeout: Would kill bun startup mid-JIT (guarantees timeout)
- 1.5s timeout: Allows bun startup + display-only to complete (<10ms per design)

**Latency impact**:
- Worst case: display-only takes 1.5s → user sees blank statusline for 1.5s
- Typical case: bun startup 300ms + display-only 5ms = 305ms
- No observable blocking (tmux statusline update is async)

**Process group handling**:
```bash
echo "${JSON_INPUT}" | timeout -k 0.5 1.5 bun "$DISPLAY_SCRIPT"
```
Timeout applies to `bun` process only (stdin pipe). Parent shell (`bulletproof.sh`) continues immediately after output.

**Assessment**: Safe. Timeout is generous but necessary for bun startup. No blocking risk (timeout is on subprocess, not parent).

---

### 5. DisplayOutput Empty String — Cleaner UX or Silent Failure?
**File**: `/Users/vmks/_IT_Projects/_aigile-os/ingestion/ai-agile-claude-code-statusline/v2/src/statusline-bulletproof.sh:94`

**Question from scope Q2**: "Is the empty fallback behavior handled correctly by Claude Code?"

**Original intent** (per COMMON-BRIEF): "Changed from `⚠:timeout` to empty string (cleaner)"

**Current behavior**:
```bash
DISPLAY_OUTPUT=$(echo "${JSON_INPUT}" | timeout -k 0.5 1.5 bun "$DISPLAY_SCRIPT" 2>/dev/null) || DISPLAY_OUTPUT=""
printf '%s' "$DISPLAY_OUTPUT"
```

If timeout → `DISPLAY_OUTPUT=""` → prints nothing → Claude Code sees empty statusline.

**Next cycle** (5s later via daemon rate gate):
- Daemon updates health file with data
- Display reads health file → shows cached data
- User sees statusline restored

**Recovery**: Fast (5s max), but user sees flicker.

**Alternative approaches**:
1. Show minimal clock (current time) — always responsive
2. Show last-known cached model + time
3. Show `⚠️:timeout` indicator — signals problem

**Assessment**: Current approach (empty) is acceptable but suboptimal UX. Display will recover via daemon. No data loss.

**Recommendation**: Consider minimal fallback for next iteration (not critical for this session).

---

## Summary

**Integration integrity**: ✓ Solid.

**Model extraction**: Correct priority chain, tested fallbacks, no race conditions.

**Timeout safety**: 1.5s increase is justified (bun cold start). No blocking risk.

**Process locking**: Daemon singleton guarantee holds. Lock prevents concurrent health file writes.

**Data flow**: stdin → display (immediate) → daemon (background) → health file → next cycle. Clean decoupling.

**Test coverage**: 1805 pass (model-resolver, display-only, tier2-sources all covered).

**Minor concern**: formatModelId() duplication across display-only and model-resolver. Drift risk if new model format emerges. Cosmetic (both identical today).

**Recommended actions**:
1. Document that `formatModelId()` regex must stay in sync (add comment linking both locations)
2. Consider minimal fallback on timeout (clock instead of empty string) — UX improvement, non-critical
3. Verify Claude Code handles empty statusline gracefully (assumption: it does, shows default UI)

**Risk**: Low. Architecture is sound, tests pass, no data loss paths.
