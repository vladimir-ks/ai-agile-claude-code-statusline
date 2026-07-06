#!/usr/bin/env bash
# Fallback-render slot isolation — regression for _AIgile-OS wiring-everything
# task #7/#10: "statusline shows the wrong slot's account" / "slot switch not
# isolating account". Root cause: statusline-bulletproof.sh's _fallback_render
# (the bash "no daemon yet" degraded path — display-only.ts's daemon path was
# already fixed via CLAUDE_CONFIG_DIR-aware resolution, W23) picked the
# account to render from merged-quota-cache.json's top-level `active_slot` —
# a GLOBAL last-launched pointer shared across every concurrently-running
# session. Session A (slot-1) rendered session B's (slot-3) email/quota the
# moment B (re-)launched, even though A never switched slots.
#
# Fix: resolve "self" from the running session's OWN $CLAUDE_CONFIG_DIR
# (inherited from the launching `claude` process) matched against each
# slot's `config_dir` field in the cache — falling back to the old
# active_slot behavior only when no match is available (bare `claude`,
# legacy cache, or a slot not yet stamped with config_dir).

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BULLETPROOF="${SCRIPT_DIR}/../src/statusline-bulletproof.sh"

test_count=0
pass_count=0
fail_count=0

log_test() { echo -e "${YELLOW}[TEST $((++test_count))]${NC} $1"; }
log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; ((pass_count++)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1"; ((fail_count++)); }

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
CACHE_FILE="${TMP_DIR}/merged-quota-cache.json"

cat > "$CACHE_FILE" <<'JSON'
{
  "schema_version": 2,
  "active_slot": "slot-3",
  "slots": {
    "slot-1": {"email": "vlad@vladks.com", "status": "active", "config_dir": "/tmp/fake-slots/S1/general",
               "five_hour_util": 10, "five_hour_resets_at": "", "seven_day_util": 26,
               "weekly_budget_remaining_hours": 132, "subscription_type": "max"},
    "slot-3": {"email": "v@ainsys.com", "status": "active", "config_dir": "/tmp/fake-slots/S3/general",
               "five_hour_util": 8, "five_hour_resets_at": "", "seven_day_util": 88,
               "weekly_budget_remaining_hours": 73, "subscription_type": "max"}
  }
}
JSON

# Isolate one call to _fallback_render's python slot-resolution: source only
# that function body (avoids needing the rest of the wrapper's environment).
run_fallback() {
  local config_dir="$1"
  CLAUDE_CONFIG_DIR="$config_dir" HS_HEALTH_DIR="$TMP_DIR" HEALTH_DIR="$TMP_DIR" bash -c '
    source <(sed -n "/^_fallback_render()/,/^}/p" "'"$BULLETPROOF"'")
    _fallback_heartbeat() { :; }
    _fallback_render
  '
}

log_test "own CLAUDE_CONFIG_DIR (slot-1) renders slot-1's OWN account, not the global active_slot (slot-3)"
OUT1="$(run_fallback /tmp/fake-slots/S1/general)"
if [[ "$OUT1" == *"vlad@vladks.com"* && "$OUT1" == *"[S1]"* && "$OUT1" != *"v@ainsys.com"* ]]; then
  log_pass "slot-1 session rendered its own account (was: showed slot-3 before the fix)"
else
  log_fail "expected slot-1/vlad@vladks.com, got: $OUT1"
fi

log_test "own CLAUDE_CONFIG_DIR (slot-3) renders slot-3's OWN account"
OUT3="$(run_fallback /tmp/fake-slots/S3/general)"
if [[ "$OUT3" == *"v@ainsys.com"* && "$OUT3" == *"[S3]"* ]]; then
  log_pass "slot-3 session rendered its own account"
else
  log_fail "expected slot-3/v@ainsys.com, got: $OUT3"
fi

log_test "no CLAUDE_CONFIG_DIR (bare claude / legacy) falls back to the prior active_slot behavior"
OUT_NONE="$(run_fallback "")"
if [[ "$OUT_NONE" == *"v@ainsys.com"* && "$OUT_NONE" == *"[S3]"* ]]; then
  log_pass "no-env fallback still resolves via active_slot (backward compatible)"
else
  log_fail "expected active_slot fallback (slot-3), got: $OUT_NONE"
fi

log_test "unrecognized CLAUDE_CONFIG_DIR (no config_dir match) falls back to active_slot, doesn't error"
OUT_UNKNOWN="$(run_fallback /tmp/fake-slots/S99/nonexistent)"
if [[ "$OUT_UNKNOWN" == *"v@ainsys.com"* ]]; then
  log_pass "unmatched config_dir falls back gracefully"
else
  log_fail "expected graceful active_slot fallback, got: $OUT_UNKNOWN"
fi

echo ""
echo "Results: $pass_count/$test_count passed"
if [[ $fail_count -gt 0 ]]; then
  exit 1
fi
exit 0
