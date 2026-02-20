# Deep Review - Model Display Fix Session

**Date**: 2026-02-18
**Scope**: Model version extraction, source priority, timeout handling
**Changes**: Dynamic version from model.id, prefer id over display_name, timeout 0.5→1.5s

## Project Context

Statusline V2: Real-time cost tracking and session monitoring for Claude Code.
- Display layer (`display-only.ts`): <10ms read-only, zero network
- Data daemon (`data-daemon.ts`): Background async data gathering
- Formatter: Adaptive output for tmux/terminal constraints

## Recent Changes
1. **Model version extraction** - Now extracts version from model.id ("claude-opus-4-6" → "Opus4.6")
2. **Source priority** - Prefer model.id over display_name to capture version info
3. **Timeout protection** - Bulletproof shell timeout 0.5s → 1.5s (bun cold start support)
4. **Fallback behavior** - Changed from `⚠:timeout` to empty string (cleaner)

## Critical Conventions
- **display-only.ts** MUST stay <10ms, zero imports except std lib, no network/subprocess
- **Atomic writes** - All JSON writes use temp file + renameSync
- **No cross-session contamination** - Model from stdin wins over cache (per-session isolation)
- **ModelResolver.formatModelName()** MUST handle both dash-separated ("claude-opus-4-6") and already-formatted ("Opus4.5") inputs

## Review Focus
- ✓ Model display accuracy across sessions (no "changed in one session, shows everywhere")
- ✓ Version extraction regex correctness (handles 4-5, 4-6, future versions)
- ✓ stdin priority vs cache (per-session model isolation)
- ✓ Timeout behavior and fallbacks
- ✓ Test coverage for new code paths
- ✓ Memory/performance impact (formatModelId inline, no new imports)
- ✓ Transcript model extraction still works as fallback

## Ignore
- Hardcoded 4.5 (now fixed, tests updated)
- Version mismatch between display_name ("Opus") and model.id ("claude-opus-4-6") — this is correct behavior
- Test fixtures using display_name without id — these are intentional to test fallback path
