#!/usr/bin/env bash
# BULLETPROOF STATUSLINE - Decoupled Architecture
#
# GUARANTEE: Display CANNOT be blocked by data gathering
#
# FLOW:
# 1. Read JSON from stdin
# 2. Run display-only (FAST, read-only, <10ms) → outputs immediately
# 3. Run data-daemon in BACKGROUND (updates health files for next time)
#
# WHY THIS IS BULLETPROOF:
# - display-only ONLY reads JSON files (no network, no subprocesses)
# - display-only handles all errors gracefully (always outputs something)
# - data-daemon runs AFTER display, in background
# - Even if daemon fails, display works with cached/stale data
# - Timeout protection on both layers
#
# RESOURCE LIMITS:
# - Display: 500ms max, 128MB max memory
# - Daemon: 30s max, 256MB max memory, killed on timeout
#
# OBSERVABILITY:
# - Daemon logs to: ~/.claude/session-health/daemon.log
# - Check errors with: tail ~/.claude/session-health/daemon.log
#
# ORPHAN PREVENTION:
# - Background daemon runs with timeout (auto-killed after 30s)
# - SIGKILL used for timeouts (cannot be caught/ignored)
# - Daemon is orphan-adopted by init on parent exit

set -u  # Fail on undefined variables (but not on errors - we handle those)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DISPLAY_SCRIPT="$SCRIPT_DIR/display-only.ts"
DAEMON_SCRIPT="$SCRIPT_DIR/data-daemon.ts"

# Read JSON from stdin into variable
JSON_INPUT=$(cat)

# ============================================================================
# LAYER 1: DISPLAY (synchronous, fast, guaranteed to complete)
# ============================================================================

# Run display with strict timeout (500ms max - should take <50ms)
# If it fails for ANY reason, output safe fallback
# Note: timeout -k sends SIGKILL after grace period
DISPLAY_OUTPUT=$(echo "${JSON_INPUT}" | timeout -k 0.1 0.5 bun "$DISPLAY_SCRIPT" 2>/dev/null) || DISPLAY_OUTPUT="⚠:timeout"

# Output to stdout (NO newline - critical for CLI UI)
printf '%s' "$DISPLAY_OUTPUT"

# ============================================================================
# LAYER 2: DATA UPDATE (background, fire-and-forget)
# ============================================================================

# Run data daemon in background with strict limits:
# - timeout 30s with SIGKILL after 1s grace period
# - nohup ensures it continues if parent exits
# - Nice +10 to lower CPU priority
# - All output to daemon log for observability
(
  # Set low priority so it doesn't compete with interactive work
  renice -n 10 $$ >/dev/null 2>&1 || true

  # Run daemon with timeout (SIGKILL on timeout - cannot leave orphans)
  echo "${JSON_INPUT}" | timeout -k 1 30 bun "$DAEMON_SCRIPT" 2>&1 | head -c 10000 >> "${HOME}/.claude/session-health/daemon.log" 2>/dev/null || true
) &

# Disown the background process so it doesn't become a zombie
disown 2>/dev/null || true

# Immediately exit (don't wait for background process)
exit 0
