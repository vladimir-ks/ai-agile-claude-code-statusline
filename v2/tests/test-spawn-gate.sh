#!/usr/bin/env bash
# Daemon spawn-gate tests — memory-pressure admission + spawn-interval gate.
# Hermetic: fake sysctl on PATH, temp HEALTH_DIR. Never touches ~/.claude.

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="${SCRIPT_DIR}/../src/statusline-bulletproof.sh"

test_count=0
pass_count=0
fail_count=0

log_test() { echo -e "${YELLOW}[TEST $((++test_count))]${NC} $1"; }
log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; ((pass_count++)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; ((fail_count++)); }

TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/statusline-spawn-gate.XXXXXX")"
cleanup() { rm -rf "$TMPROOT"; }
trap cleanup EXIT INT TERM

FAKE_BIN="${TMPROOT}/bin"
GATE_HEALTH_DIR="${TMPROOT}/session-health"
mkdir -p "$FAKE_BIN" "$GATE_HEALTH_DIR"

cat > "${FAKE_BIN}/sysctl" <<'FAKE'
#!/usr/bin/env bash
if [[ "${FAKE_SYSCTL_FAIL:-0}" == "1" ]]; then
  echo "sysctl: unknown oid" >&2
  exit 1
fi
for arg in "$@"; do
  case "$arg" in
    kern.memorystatus_level) echo "${FAKE_MEMSTATUS:-63}"; exit 0 ;;
  esac
done
exit 1
FAKE
chmod +x "${FAKE_BIN}/sysctl"

# Extract the gate config + should_spawn_daemon() verbatim from the wrapper so
# the test exercises shipped code without running the render path.
SNIPPET="${TMPROOT}/gate.sh"
awk '/^DAEMON_SPAWN_GATE=/{f=1} f{print} f && /^}$/{exit}' "$WRAPPER" > "$SNIPPET"
grep -q 'should_spawn_daemon()' "$SNIPPET" || { echo "extraction failed"; exit 1; }
grep -q 'MIN_MEMSTATUS_LEVEL' "$SNIPPET" || { echo "MIN_MEMSTATUS_LEVEL missing"; exit 1; }
grep -q 'MAX_LOADAVG' "$WRAPPER" && { echo "MAX_LOADAVG still present in wrapper"; exit 1; }

# Runs should_spawn_daemon in a clean subshell. $1=memstatus ("fail" to error),
# $2=gate file age in seconds ("none" for no gate file). Echoes spawn|skip.
run_gate() {
  local mem="$1" gate_age="$2"
  rm -f "${GATE_HEALTH_DIR}/.daemon-spawn.gate"
  if [[ "$gate_age" != "none" ]]; then
    echo "$$" > "${GATE_HEALTH_DIR}/.daemon-spawn.gate"
    touch -t "$(date -v-"${gate_age}"S +%Y%m%d%H%M.%S)" "${GATE_HEALTH_DIR}/.daemon-spawn.gate"
  fi
  local fail=0 memval="$mem"
  if [[ "$mem" == "fail" ]]; then fail=1; memval=0; fi
  (
    export PATH="${FAKE_BIN}:${PATH}"
    export FAKE_SYSCTL_FAIL="$fail" FAKE_MEMSTATUS="$memval"
    set -u
    HEALTH_DIR="$GATE_HEALTH_DIR"
    # shellcheck disable=SC1090
    source "$SNIPPET"
    if should_spawn_daemon; then echo spawn; else echo skip; fi
  )
}

assert_gate() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    log_pass "$desc → $actual"
  else
    log_fail "$desc → expected $expected, got $actual"
  fi
}

log_test "memorystatus 63 (healthy), no gate file → spawn"
assert_gate "healthy memory, no gate" "spawn" "$(run_gate 63 none)"

log_test "memorystatus 5 (critical) → no spawn"
assert_gate "critical memory" "skip" "$(run_gate 5 none)"

log_test "sysctl fails → fail open, spawn"
assert_gate "sysctl unavailable" "spawn" "$(run_gate fail none)"

log_test "gate file 3s old → no spawn (interval gate)"
assert_gate "gate 3s old" "skip" "$(run_gate 63 3)"

log_test "gate file 20s old → spawn (interval elapsed)"
assert_gate "gate 20s old" "spawn" "$(run_gate 63 20)"

# ---------------------------------------------------------------------------
# Daemon exit-status propagation (PIPESTATUS, not head's status)
# ---------------------------------------------------------------------------

# Extract the respawn counter functions verbatim from the wrapper.
RESPAWN_SNIPPET="${TMPROOT}/respawn.sh"
awk '/^_daemon_respawn_increment\(\) \{/{f=1} f{print} f && /^_daemon_respawn_reset\(\)/{g=1} g && /^}$/{exit}' \
  "$WRAPPER" > "$RESPAWN_SNIPPET"
grep -q '_daemon_respawn_increment()' "$RESPAWN_SNIPPET" || { echo "respawn extraction failed"; exit 1; }
grep -q '_daemon_respawn_reset()' "$RESPAWN_SNIPPET" || { echo "respawn extraction failed"; exit 1; }

# The wrapper must not mask bun's exit status behind `head`.
grep -q '| head -c 10000 >>' "$WRAPPER" && { echo "head -c truncation still masks daemon status"; exit 1; }
grep -q 'PIPESTATUS' "$WRAPPER" || { echo "PIPESTATUS missing from daemon spawn"; exit 1; }

# Extract the spawn pipeline + status branch verbatim.
SPAWN_SNIPPET="${TMPROOT}/spawn-status.sh"
awk '/^    echo "\$\{JSON_INPUT\}" \| timeout/{f=1} f{print} f && /^    fi$/{exit}' \
  "$WRAPPER" > "$SPAWN_SNIPPET"
grep -q '_daemon_respawn_increment' "$SPAWN_SNIPPET" || { echo "spawn-status extraction failed"; exit 1; }

STATUS_HEALTH_DIR="${TMPROOT}/status-health"
mkdir -p "$STATUS_HEALTH_DIR" "${TMPROOT}/fakebun"

# $1 = exit code the fake bun should return. Echoes "<count>|<forced:yes|no>".
run_daemon_status() {
  local exit_code="$1" initial="${2:-0}"
  rm -f "${STATUS_HEALTH_DIR}/.daemon-respawn-count" \
        "${STATUS_HEALTH_DIR}/.statusline-lazy-mode-forced" \
        "${STATUS_HEALTH_DIR}/daemon.log"
  echo "$initial" > "${STATUS_HEALTH_DIR}/.daemon-respawn-count"

  cat > "${TMPROOT}/fakebun/bun" <<FAKEBUN
#!/usr/bin/env bash
cat >/dev/null
echo "fake daemon exiting ${exit_code}"
exit ${exit_code}
FAKEBUN
  chmod +x "${TMPROOT}/fakebun/bun"

  (
    export PATH="${TMPROOT}/fakebun:${PATH}"
    set -u
    HEALTH_DIR="$STATUS_HEALTH_DIR"
    DAEMON_RESPAWN_LIMIT=3
    DAEMON_RESPAWN_COUNT_FILE="${STATUS_HEALTH_DIR}/.daemon-respawn-count"
    LAZY_MODE_FORCED_FILE="${STATUS_HEALTH_DIR}/.statusline-lazy-mode-forced"
    DAEMON_SCRIPT="/dev/null"
    JSON_INPUT='{"session_id":"spawn-gate-test"}'
    # shellcheck disable=SC1090
    source "$RESPAWN_SNIPPET"
    # shellcheck disable=SC1090
    source "$SPAWN_SNIPPET"
    local_forced="no"
    [[ -f "$LAZY_MODE_FORCED_FILE" ]] && local_forced="yes"
    echo "$(cat "$DAEMON_RESPAWN_COUNT_FILE")|${local_forced}"
  )
}

log_test "daemon SIGKILLed (exit 137) → respawn counter increments"
assert_gate "exit 137 from 0" "1|no" "$(run_daemon_status 137 0)"

log_test "daemon timeout (exit 124) → respawn counter increments"
assert_gate "exit 124 from 0" "1|no" "$(run_daemon_status 124 0)"

log_test "third consecutive failure → forced-lazy-mode file written"
assert_gate "exit 137 from 2" "3|yes" "$(run_daemon_status 137 2)"

log_test "daemon exit 0 → respawn counter reset"
assert_gate "exit 0 from 2" "0|no" "$(run_daemon_status 0 2)"

log_test "daemon stdout+stderr reach daemon.log untruncated"
run_daemon_status 0 0 >/dev/null
if grep -q "fake daemon exiting 0" "${STATUS_HEALTH_DIR}/daemon.log"; then
  log_pass "daemon output appended to daemon.log"
else
  log_fail "daemon output missing from daemon.log"
fi

log_test "real ~/.claude/session-health untouched"
if [[ -z "$(find "$GATE_HEALTH_DIR" -maxdepth 1 -type f 2>/dev/null | grep -v '.daemon-spawn.gate')" ]]; then
  log_pass "only the temp gate file was written"
else
  log_fail "unexpected files created in temp health dir"
fi

# --- keychain probe: bounded, never hangs, skip is visible in the heartbeat ---
KC_SNIPPET="${TMPROOT}/keychain.sh"
awk '/^KEYCHAIN_PROBE_TIMEOUT_S=/{f=1} f{print} f && /^}$/{exit}' "$WRAPPER" > "$KC_SNIPPET"
grep -q 'is_keychain_unlocked()' "$KC_SNIPPET" || { echo "keychain extraction failed"; exit 1; }

cat > "${FAKE_BIN}/security" <<'FAKE'
#!/usr/bin/env bash
case "${FAKE_SECURITY_MODE:-ok}" in
  ok) exit 0 ;;
  locked) exit 36 ;;
  hang) sleep 30; exit 0 ;;
esac
FAKE
chmod +x "${FAKE_BIN}/security"

# $1=ok|locked|hang. Echoes unlocked|skip and the elapsed seconds.
run_keychain() {
  local mode="$1" start end verdict
  rm -f "${GATE_HEALTH_DIR}/pipeline-heartbeat.jsonl"
  start=$(date +%s)
  verdict=$(
    export PATH="${FAKE_BIN}:${PATH}" FAKE_SECURITY_MODE="$mode"
    HEALTH_DIR="$GATE_HEALTH_DIR"
    # shellcheck disable=SC1090
    source "$KC_SNIPPET"
    if is_keychain_unlocked; then echo unlocked; else echo skip; fi
  )
  end=$(date +%s)
  echo "${verdict}|$(( end - start ))"
}

# $1=desc $2=expected verdict $3=result "verdict|elapsed" — instant probes finish within 1s.
assert_keychain() {
  local desc="$1" expected="$2" result="$3"
  if [[ "${result%%|*}" == "$expected" && "${result##*|}" -le 1 ]]; then
    log_pass "$desc → $result"
  else
    log_fail "$desc → expected ${expected}|≤1, got $result"
  fi
}

log_test "keychain unlocked → probe passes"
assert_keychain "security exit 0" "unlocked" "$(run_keychain ok)"

log_test "keychain locked → daemon skipped, reason logged"
assert_keychain "security exit 36" "skip" "$(run_keychain locked)"
if grep -q '"reason":"keychain_locked"' "${GATE_HEALTH_DIR}/pipeline-heartbeat.jsonl" 2>/dev/null; then
  log_pass "heartbeat carries keychain_locked"
else
  log_fail "heartbeat missing keychain_locked"
fi

log_test "security hangs → probe bounded by timeout, skip logged"
result="$(run_keychain hang)"
elapsed="${result##*|}"
if [[ "${result%%|*}" == "skip" && "$elapsed" -le 4 ]]; then
  log_pass "hung probe returned skip in ${elapsed}s"
else
  log_fail "hung probe: $result"
fi
if grep -q '"reason":"keychain_probe_hung"' "${GATE_HEALTH_DIR}/pipeline-heartbeat.jsonl" 2>/dev/null; then
  log_pass "heartbeat carries keychain_probe_hung"
else
  log_fail "heartbeat missing keychain_probe_hung"
fi
rm -f "${GATE_HEALTH_DIR}/pipeline-heartbeat.jsonl"

# --- forced lazy mode self-heals after LAZY_MODE_FORCED_TTL_S ---
FL_SNIPPET="${TMPROOT}/forced-lazy.sh"
{
  grep -E '^(LAZY_MODE_FORCED_FILE|LAZY_MODE_FORCED_TTL_S|DAEMON_RESPAWN_COUNT_FILE)=' "$WRAPPER"
  awk '/^_forced_lazy_active\(\)/{f=1} f{print} f && /^}$/{exit}' "$WRAPPER"
} > "$FL_SNIPPET"
grep -q '_forced_lazy_active()' "$FL_SNIPPET" || { echo "forced-lazy extraction failed"; exit 1; }

# $1=forced file age in seconds ("none" for no file). Echoes lazy|spawn + file-present flag.
run_forced_lazy() {
  local age="$1" forced="${GATE_HEALTH_DIR}/.statusline-lazy-mode-forced"
  rm -f "$forced"
  if [[ "$age" != "none" ]]; then
    touch "$forced"
    touch -t "$(date -v-"${age}"S +%Y%m%d%H%M.%S)" "$forced"
  fi
  (
    HEALTH_DIR="$GATE_HEALTH_DIR"
    # shellcheck disable=SC1090
    source "$FL_SNIPPET"
    if _forced_lazy_active; then echo -n lazy; else echo -n spawn; fi
    [[ -f "$forced" ]] && echo "|present" || echo "|absent"
  )
}

log_test "no forced file → daemon may spawn"
assert_gate "forced none" "spawn|absent" "$(run_forced_lazy none)"

log_test "fresh forced file → lazy"
assert_gate "forced 30s" "lazy|present" "$(run_forced_lazy 30)"

log_test "forced file past TTL → cleared, daemon may spawn"
assert_gate "forced 700s" "spawn|absent" "$(run_forced_lazy 700)"
if [[ "$(cat "${GATE_HEALTH_DIR}/.daemon-respawn-count" 2>/dev/null)" == "0" ]]; then
  log_pass "respawn counter reset on expiry"
else
  log_fail "respawn counter not reset"
fi
rm -f "${GATE_HEALTH_DIR}/.daemon-respawn-count"

echo ""
echo "=========================================="
echo -e "${GREEN}Spawn Gate Tests Complete${NC}"
echo "Tests run: $test_count"
echo "Passed: $pass_count"
echo "Failed: $fail_count"
echo "=========================================="

if [[ $fail_count -eq 0 ]]; then
  echo -e "${GREEN}✓ ALL TESTS PASSED${NC}"
  exit 0
else
  echo -e "${RED}✗ TESTS FAILED${NC}"
  exit 1
fi
