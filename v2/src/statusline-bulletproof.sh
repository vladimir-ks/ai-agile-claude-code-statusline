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
# LAZY MODE CONFIG
# ============================================================================
# STATUSLINE_LAZY_MODE=1 → always skip daemon, render inline from quota cache.
# Auto-trigger: session file age >30s OR .statusline-lazy-mode-forced present.
#
# NOTE: HEALTH_DIR stays ~/.claude/session-health because the statusline daemon
# OWNS that directory (session files, daemon logs, lockfiles, watchdog state).
# Hot-swap-produced files (merged-quota-cache.json, .fetch-rate-limit-state.*)
# live under HS_HEALTH_DIR per the CLAUDE_HS_HOME contract.
HEALTH_DIR="${HOME}/.claude/session-health"

# Hot-swap add-on state dir (per CLAUDE_HS_HOME contract, Apr 2026).
# Precedence: $CLAUDE_HS_HOME env var → ~/.claude-hs/ (current default) →
# ~/.claude/ (legacy fallback for pre-split installs).
if [[ -n "${CLAUDE_HS_HOME:-}" ]]; then
    HS_HEALTH_DIR="${CLAUDE_HS_HOME%/}/session-health"
elif [[ -d "${HOME}/.claude-hs/session-health" ]]; then
    HS_HEALTH_DIR="${HOME}/.claude-hs/session-health"
else
    HS_HEALTH_DIR="${HEALTH_DIR}"
fi
LAZY_MODE_FORCED_FILE="${HEALTH_DIR}/.statusline-lazy-mode-forced"
SESSION_FILE_STALE_TTL=30   # seconds — if session file older than this, fallback
DAEMON_RESPAWN_LIMIT=3      # consecutive failures before writing forced-file
DAEMON_RESPAWN_COUNT_FILE="${HEALTH_DIR}/.daemon-respawn-count"

# ============================================================================
# LAYER 1: DAEMON SPAWN RATE GATE
# ============================================================================
# Prevents spawning daemon more than once per MIN_DAEMON_INTERVAL seconds.
# With tmux status-interval=1s, this reduces daemon spawns from 60/min to 12/min.
# Layer 2 (ProcessLock in data-daemon.ts) provides the hard singleton guarantee.

DAEMON_SPAWN_GATE="${HEALTH_DIR}/.daemon-spawn.gate"
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

# ============================================================================
# LAZY MODE DETECTION
# ============================================================================

# Returns 0 (true) when daemon is EXPLICITLY disabled. Explicit-only because
# a stale/missing session file is a RECOVERY path, not a reason to skip
# daemon spawn — otherwise we deadlock (file missing → lazy → no spawn →
# file stays missing forever).
_lazy_mode_active() {
  # Explicit env override
  [[ "${STATUSLINE_LAZY_MODE:-0}" == "1" ]] && return 0
  # Watchdog forced file (set after N consecutive daemon respawn failures)
  [[ -f "$LAZY_MODE_FORCED_FILE" ]] && return 0
  return 1
}

# True when session file is missing or past its staleness TTL. Used only as
# a safety-net signal to pick _fallback_render when display-only produced
# nothing — does NOT gate daemon spawn.
_session_file_stale() {
  local sid
  sid=$(printf '%s' "${JSON_INPUT:-}" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('session_id',''))" 2>/dev/null || true)
  [[ -z "$sid" ]] && return 0
  local sf="${HEALTH_DIR}/${sid}.json"
  [[ ! -f "$sf" ]] && return 0
  local now sf_mtime sf_age
  now=$(date +%s)
  sf_mtime=$(stat -f %m "$sf" 2>/dev/null || echo 0)
  sf_age=$((now - sf_mtime))
  [[ "$sf_age" -gt "$SESSION_FILE_STALE_TTL" ]]
}

# ============================================================================
# FALLBACK RENDER (inline, no daemon, <50ms)
# ============================================================================
# Reads merged-quota-cache.json + live-burn-estimate.json.
# Emits DEGRADED badge with core segments only (no 6-band colors).
# Absorbs all errors — returns empty string on any failure.

_fallback_render() {
  local t0
  t0=$(date +%s%3N 2>/dev/null || echo 0)
  local out=""
  local slot email pct reset_in burn seven_day_hrs seven_day_pct badge

  # ── Read merged-quota-cache.json (hot-swap-owned, HS_HEALTH_DIR) ─────────
  local cache_file="${HS_HEALTH_DIR}/merged-quota-cache.json"
  if [[ ! -f "$cache_file" ]]; then
    # Absolute minimum: just show time
    local hhmm
    hhmm=$(date +%H:%M 2>/dev/null || echo "??:??")
    printf '⚠DEGRADED 🕐:%s' "$hhmm"
    _fallback_heartbeat "$t0" "no_cache_file"
    return 0
  fi

  # Extract active slot data via python3 (available macOS, no jq dependency required)
  local cache_data
  cache_data=$(python3 -c "
import json,sys,datetime,math
try:
    d=json.load(open('${cache_file}'))
    active=d.get('active_slot','slot-1')
    slots=d.get('slots',{})
    s=slots.get(active,{})
    if not s:
        # pick first active
        for k,v in slots.items():
            if v.get('status')=='active':
                s=v; active=k; break
    if not s and slots:
        k=list(slots.keys())[0]; s=slots[k]; active=k
    email=s.get('email','?')
    pct=int(s.get('five_hour_util',0) or 0)
    reset_iso=s.get('five_hour_resets_at','')
    reset_in='?'
    try:
        if reset_iso:
            from datetime import timezone
            # strip fractional seconds + handle offset
            ts=reset_iso.replace('Z','+00:00')
            if '.' in ts:
                base,rest=ts.split('.',1)
                # keep offset if present
                off_idx=max(rest.find('+'),rest.find('-'))
                if off_idx>=0:
                    ts=base+rest[off_idx:]
                else:
                    ts=base+'+00:00'
            try:
                dt=datetime.datetime.fromisoformat(ts)
            except Exception:
                dt=None
            if dt:
                now=datetime.datetime.now(timezone.utc)
                diff=int((dt-now).total_seconds())
                if diff<0: reset_in='RESET'
                else:
                    h=diff//3600; m=(diff%3600)//60
                    if h>0: reset_in=f'{h}h{m:02d}m'
                    else: reset_in=f'{m}m'
    except Exception: pass
    seven_pct=int(s.get('seven_day_util',0) or 0)
    seven_hrs=int(s.get('weekly_budget_remaining_hours',0) or 0)
    # burn rate
    burn=s.get('burn_rate_1h_avg_5h')
    if burn is None: burn=s.get('five_hour_burn_rate')
    burn_str=f'{int(burn)}' if burn is not None else '?'
    sub=s.get('subscription_type','?')
    slot_num=active.replace('slot-','')
    print(f'{slot_num}|{email}|{pct}|{reset_in}|{seven_pct}|{seven_hrs}|{burn_str}|{sub}')
except Exception as e:
    print(f'?|?|0|?|0|0|?|?')
" 2>/dev/null || echo "?|?|0|?|0|0|?|?")

  IFS='|' read -r slot email pct reset_in seven_day_pct seven_day_hrs burn sub <<< "$cache_data"

  # ── Optionally blend live-burn-estimate ───────────────────────────────────
  local burn_file="${HEALTH_DIR}/live-burn-estimate.json"
  if [[ -f "$burn_file" ]]; then
    local live_burn
    live_burn=$(python3 -c "
import json,time
try:
    d=json.load(open('${burn_file}'))
    age=int(time.time())-int(d.get('ts',0) or 0)
    if age<120:
        tph=d.get('tokens_per_hour',0) or 0
        # rough: 1M tokens ~ 1% (will be refined in Phase 3)
        if tph>0: print(str(round(tph/1000000,1)))
        else: print('')
    else: print('')
except: print('')
" 2>/dev/null || true)
    [[ -n "$live_burn" ]] && burn="$live_burn"
  fi

  # ── Format time ───────────────────────────────────────────────────────────
  local hhmm
  hhmm=$(date +%H:%M 2>/dev/null || echo "??:??")

  # ── ANSI colors (basic only — no 6-band palette) ─────────────────────────
  local RED='\x1b[31m' GRN='\x1b[32m' GRY='\x1b[38;5;245m' YEL='\x1b[33m' RST='\x1b[0m'
  # Pick color by pct
  local pct_color="$GRN"
  if (( pct >= 80 )); then pct_color="$RED"
  elif (( pct >= 50 )); then pct_color="$YEL"
  fi

  # ── Compose output ────────────────────────────────────────────────────────
  # Template: ⚠[S{slot}]|{email} 🕐:{HH:MM} ⌛:{reset_in}({pct}%) 📅:{7d_hrs}h({7d_pct}%) 🔥:{burn}%/h
  out="$(printf '%b⚠[S%s]%b|%b%s%b 🕐:%b%s%b ⌛:%b%s(%s%%)%b 📅:%b%sh(%s%%)%b 🔥:%b%s%%/h%b' \
    "$YEL" "$slot" "$RST" \
    "$GRY" "$email" "$RST" \
    "$GRY" "$hhmm" "$RST" \
    "$pct_color" "$reset_in" "$pct" "$RST" \
    "$GRY" "$seven_day_hrs" "$seven_day_pct" "$RST" \
    "$YEL" "$burn" "$RST")"

  printf '%s' "$out"

  # ── Heartbeat ─────────────────────────────────────────────────────────────
  _fallback_heartbeat "$t0" "ok"
}

_fallback_heartbeat() {
  local t0="$1"
  local reason="${2:-ok}"
  local t1
  t1=$(date +%s%3N 2>/dev/null || echo 0)
  local latency=0
  if [[ "$t0" =~ ^[0-9]+$ ]] && [[ "$t1" =~ ^[0-9]+$ ]]; then
    latency=$((t1 - t0))
  fi
  local hb_file="${HEALTH_DIR}/pipeline-heartbeat.jsonl"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "1970-01-01T00:00:00Z")
  local status="warn"
  [[ "$reason" == "ok" ]] && status="warn"  # always warn: we are in fallback path
  printf '{"ts":"%s","component":"statusline-hook","event":"fallback_render","latency_ms":%d,"status":"%s","extra":{"reason":"daemon_stale","trigger":"%s"}}\n' \
    "$ts" "$latency" "$status" "$reason" \
    >> "$hb_file" 2>/dev/null || true
}

# ============================================================================
# RESPAWN COUNTER (used by daemon watchdog)
# ============================================================================
# After DAEMON_RESPAWN_LIMIT consecutive failures, write forced-lazy-mode file.

_daemon_respawn_increment() {
  local count=0
  if [[ -f "$DAEMON_RESPAWN_COUNT_FILE" ]]; then
    count=$(cat "$DAEMON_RESPAWN_COUNT_FILE" 2>/dev/null || echo 0)
    [[ "$count" =~ ^[0-9]+$ ]] || count=0
  fi
  count=$((count + 1))
  echo "$count" > "$DAEMON_RESPAWN_COUNT_FILE" 2>/dev/null || true
  if [[ "$count" -ge "$DAEMON_RESPAWN_LIMIT" ]]; then
    touch "$LAZY_MODE_FORCED_FILE" 2>/dev/null || true
  fi
}

_daemon_respawn_reset() {
  echo "0" > "$DAEMON_RESPAWN_COUNT_FILE" 2>/dev/null || true
  rm -f "$LAZY_MODE_FORCED_FILE" 2>/dev/null || true
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
# LAZY MODE FAST PATH (explicit disable only)
# ============================================================================
# Fast-exit ONLY when daemon is EXPLICITLY disabled (env or watchdog forced).
# Stale/missing session file is NOT a reason to skip daemon spawn — that's
# a recovery path. _session_file_stale() below triggers fallback_render as
# safety net but allows daemon to spawn so next tick is back to normal.

if _lazy_mode_active; then
  _fallback_render
  exit 0
fi

# ============================================================================
# LAYER 1: DISPLAY (synchronous, fast, guaranteed to complete)
# ============================================================================

# Run display with timeout (3.0s max — bun cold start 300-800ms + W23 broker
# freshness check + KeychainResolver hash compute push real total to ~1.6s.
# Prior 1.5s budget was too tight; raised post-W23 to absorb the new latency
# until 3B-2 broker rewrite consolidates the freshness path.)
# If it fails for ANY reason, output safe fallback.
# Note: timeout -k sends SIGKILL after grace period.
DISPLAY_OUTPUT=$(echo "${JSON_INPUT}" | timeout -k 0.5 3.0 bun "$DISPLAY_SCRIPT" 2>/dev/null) || DISPLAY_OUTPUT=""

# If display-only produced nothing AND we have no session file, try fallback as safety net
if [[ -z "$DISPLAY_OUTPUT" ]]; then
  DISPLAY_OUTPUT=$(_fallback_render 2>/dev/null) || DISPLAY_OUTPUT="⚠"
fi

# Output to stdout (NO newline - critical for CLI UI)
printf '%s' "$DISPLAY_OUTPUT"

# ============================================================================
# KEYCHAIN LOCK GUARD
# ============================================================================
# When login keychain is locked (sleep/screensaver), `security find-generic-password`
# triggers interactive SecurityAgent dialogs. The daemon calls security commands in a
# loop across sessions — locked keychain = dialog flood that freezes all tmux panes.
# Check once here (non-interactive, instant) and skip daemon spawn if locked.

is_keychain_unlocked() {
  security show-keychain-info login.keychain-db 2>/dev/null ||
  security show-keychain-info login.keychain 2>/dev/null
}

# ============================================================================
# LAYER 2: DATA UPDATE (background, fire-and-forget, rate-gated)
# ============================================================================

# Only spawn daemon if rate gate allows (Layer 1) + keychain unlocked + daemon has singleton lock (Layer 2 in TS)
# Also skip if lazy mode is forced (daemon intentionally disabled)
if should_spawn_daemon && is_keychain_unlocked && [[ "${STATUSLINE_LAZY_MODE:-0}" != "1" ]] && [[ ! -f "$LAZY_MODE_FORCED_FILE" ]]; then
  mark_daemon_spawn

  # ── Litter retention (r49) ─────────────────────────────────────────────
  # The daemon's per-session artifacts ({uuid}.debug.json, {uuid}.lock,
  # *.tmp.* from interrupted atomic writes) had NO retention — 1,681 files
  # accumulated by Jun 2026. Prune on this infrequent daemon-spawn path
  # (never the per-render hot path). Backgrounded + nice'd; ~ms over a few
  # thousand files. Age gates keep anything plausibly-live untouched.
  (
    find "$HEALTH_DIR" -maxdepth 1 -name '*.debug.json' -mtime +14 -delete 2>/dev/null
    find "$HEALTH_DIR" -maxdepth 1 -name '*.lock' -mtime +14 -delete 2>/dev/null
    find "$HEALTH_DIR" -maxdepth 1 -name '*.tmp.*' -mtime +2 -delete 2>/dev/null
  ) &

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
    if echo "${JSON_INPUT}" | timeout -k 1 30 bun --no-cache "$DAEMON_SCRIPT" 2>&1 | head -c 10000 >> "${HEALTH_DIR}/daemon.log" 2>/dev/null; then
      _daemon_respawn_reset 2>/dev/null || true
    else
      _daemon_respawn_increment 2>/dev/null || true
    fi
  ) &

  # Disown the background process so it doesn't become a zombie
  disown 2>/dev/null || true
fi

# Immediately exit (don't wait for background process)
exit 0
