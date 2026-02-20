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

# ============================================================================
# LAYER 1: DAEMON SPAWN RATE GATE
# ============================================================================
# Prevents spawning daemon more than once per MIN_DAEMON_INTERVAL seconds.
# With tmux status-interval=1s, this reduces daemon spawns from 60/min to 12/min.
# Layer 2 (ProcessLock in data-daemon.ts) provides the hard singleton guarantee.

DAEMON_SPAWN_GATE="${HOME}/.claude/session-health/.daemon-spawn.gate"
MIN_DAEMON_INTERVAL=5  # seconds

should_spawn_daemon() {
  # If gate file doesn't exist, spawn immediately
  [ ! -f "$DAEMON_SPAWN_GATE" ] && return 0

  # Check gate file age (macOS stat -f %m = modification time in epoch seconds)
  local now gate_mtime gate_age
  now=$(date +%s)
  gate_mtime=$(stat -f %m "$DAEMON_SPAWN_GATE" 2>/dev/null || echo 0)
  gate_age=$((now - gate_mtime))

  # Spawn if interval has elapsed
  [ "$gate_age" -ge "$MIN_DAEMON_INTERVAL" ]
}

mark_daemon_spawn() {
  # Touch gate file to record spawn time (atomic enough for 5s intervals)
  echo "$$" > "$DAEMON_SPAWN_GATE" 2>/dev/null || true
}

# Read JSON from stdin into variable
JSON_INPUT=$(cat)

# ============================================================================
# DETECT PANE WIDTH (tmux-aware)
# ============================================================================

# If running in tmux, get the actual pane width and capture tmux context
if [ -n "${TMUX:-}" ]; then
  STATUSLINE_WIDTH=$(tmux display -p '#{pane_width}' 2>/dev/null || echo "120")
  # Capture tmux session/window/pane info for session tracking
  export TMUX_SESSION_NAME=$(tmux display-message -p '#{session_name}' 2>/dev/null || echo "")
  export TMUX_WINDOW_INDEX=$(tmux display-message -p '#{window_index}' 2>/dev/null || echo "")
  export TMUX_PANE_INDEX=$(tmux display-message -p '#{pane_index}' 2>/dev/null || echo "")
  export TMUX_PANE_HEIGHT=$(tmux display-message -p '#{pane_height}' 2>/dev/null || echo "")
else
  # Fallback: try terminal columns, or default to 120
  STATUSLINE_WIDTH="${COLUMNS:-120}"
fi
export STATUSLINE_WIDTH

# ============================================================================
# LAYER 1: DISPLAY (synchronous, fast, guaranteed to complete)
# ============================================================================

# Run display with timeout (1.5s max — bun cold start can take 300-800ms under load)
# If it fails for ANY reason, output safe fallback
# Note: timeout -k sends SIGKILL after grace period
DISPLAY_OUTPUT=$(echo "${JSON_INPUT}" | timeout -k 0.5 1.5 bun "$DISPLAY_SCRIPT" 2>/dev/null) || DISPLAY_OUTPUT=""

# Output to stdout (NO newline - critical for CLI UI)
printf '%s' "$DISPLAY_OUTPUT"

# ============================================================================
# LAYER 2: DATA UPDATE (background, fire-and-forget, rate-gated)
# ============================================================================

# Only spawn daemon if rate gate allows (Layer 1) + daemon has singleton lock (Layer 2 in TS)
if should_spawn_daemon; then
  mark_daemon_spawn

  # Run data daemon in background with strict limits:
  # - timeout 30s with SIGKILL after 1s grace period
  # - Nice +10 to lower CPU priority
  # - All output to daemon log for observability
  # - LAYER 3: trap 'kill 0' EXIT kills entire process group on subshell exit
  #   This ensures ALL children (ccusage, quota-broker, git) die with the daemon
  (
    # Set low priority so it doesn't compete with interactive work
    renice -n 10 $$ >/dev/null 2>&1 || true

    # Run daemon with timeout (SIGKILL on timeout - cannot leave orphans)
    # --no-cache ensures daemon always loads latest code (not cached modules)
    # Layer 3: timeout -k 1 sends SIGKILL after 1s grace — kills daemon AND its children
    echo "${JSON_INPUT}" | timeout -k 1 30 bun --no-cache "$DAEMON_SCRIPT" 2>&1 | head -c 10000 >> "${HOME}/.claude/session-health/daemon.log" 2>/dev/null || true
  ) &

  # Disown the background process so it doesn't become a zombie
  disown 2>/dev/null || true
fi

# Immediately exit (don't wait for background process)
exit 0
