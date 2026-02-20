#!/usr/bin/env bash
# validate-keychains.sh - Machine-readable keychain integrity check
#
# Outputs JSON report for all slot keychains.
# Exit 0 = all healthy, Exit 1 = at least one broken.
#
# Usage: ./validate-keychains.sh [--json] [--quiet]
#   --json   Output raw JSON only (for monitoring/scripts)
#   --quiet  Suppress output, just set exit code

set -euo pipefail

JSON_MODE=false
QUIET_MODE=false
for arg in "$@"; do
  case "$arg" in
    --json)  JSON_MODE=true ;;
    --quiet) QUIET_MODE=true ;;
  esac
done

SESSIONS_YAML=""
for p in "$HOME/_claude-configs/hot-swap/claude-sessions.yaml" \
         "$HOME/cloud_configs/hot-swap/claude-sessions.yaml"; do
  if [[ -f "$p" ]]; then
    SESSIONS_YAML="$p"
    break
  fi
done

if [[ -z "$SESSIONS_YAML" ]]; then
  if $JSON_MODE; then
    echo '{"error":"sessions.yaml not found","healthy":false}'
  fi
  exit 1
fi

SLOTS=$(yq '.accounts | keys | .[]' "$SESSIONS_YAML" 2>/dev/null)

# Collect results
results="[]"
all_ok=true

get_keychain_service() {
  local dir="$1"
  local abs_path
  if [[ -d "$dir" ]]; then
    abs_path=$(cd "$dir" && pwd)
  else
    abs_path="$dir"
  fi
  local default_dir
  default_dir=$(cd "$HOME/.claude" 2>/dev/null && pwd)
  if [[ "$abs_path" == "$default_dir" ]]; then
    echo "Claude Code-credentials"
  else
    echo "Claude Code-credentials-$(echo -n "$abs_path" | shasum -a 256 | cut -c1-8)"
  fi
}

check_one() {
  local service="$1"
  local expected_email="$2"
  local blob
  blob=$(security find-generic-password -s "$service" -w 2>/dev/null || echo "")

  if [[ -z "$blob" ]]; then
    echo '{"ok":false,"error":"missing"}'
    return
  fi

  if [[ ${#blob} -lt 100 ]]; then
    echo "{\"ok\":false,\"error\":\"corrupted\",\"size\":${#blob}}"
    return
  fi

  local tmp
  tmp=$(mktemp)
  printf '%s' "$blob" > "$tmp"
  python3 -c "
import json, sys, time
with open('$tmp') as f:
    d = json.load(f)
cai = d.get('claudeAiOauth', {})
oa = d.get('oauthAccount', {})
now = time.time() * 1000
exp = cai.get('expiresAt', 0)
r = {
    'ok': True,
    'has_token': bool(cai.get('accessToken')),
    'has_refresh': bool(cai.get('refreshToken')),
    'has_identity': bool(oa.get('emailAddress')),
    'email': oa.get('emailAddress', ''),
    'email_match': oa.get('emailAddress','').lower() == '$expected_email'.lower() if '$expected_email' else True,
    'expired': exp > 0 and exp < now,
    'expires_min': round((exp - now) / 60000) if exp > 0 else -1,
    'subscription': cai.get('subscriptionType', ''),
}
if not r['has_token'] or not r['has_identity'] or r['expired']:
    r['ok'] = False
    errs = []
    if not r['has_token']: errs.append('no_token')
    if not r['has_identity']: errs.append('no_identity')
    if r['expired']: errs.append('expired')
    r['error'] = ','.join(errs)
print(json.dumps(r))
" 2>/dev/null
  rm -f "$tmp"
}

for slot in $SLOTS; do
  config_dir=$(yq ".accounts.$slot.config_dir" "$SESSIONS_YAML" 2>/dev/null)
  expected_email=$(yq ".accounts.$slot.email" "$SESSIONS_YAML" 2>/dev/null)

  if [[ -z "$config_dir" || "$config_dir" == "null" ]]; then
    continue
  fi

  ks=$(get_keychain_service "$config_dir")
  result=$(check_one "$ks" "$expected_email")

  ok=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null)
  if [[ "$ok" != "True" ]]; then
    all_ok=false
  fi

  # Append to results array
  results=$(echo "$results" | python3 -c "
import json, sys
arr = json.load(sys.stdin)
entry = json.loads('$result')
entry['slot'] = '$slot'
entry['service'] = '$ks'
entry['expected_email'] = '$expected_email'
arr.append(entry)
print(json.dumps(arr))
" 2>/dev/null)
done

# Check default keychain
default_result=$(check_one "Claude Code-credentials" "")
default_ok=$(echo "$default_result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null)
if [[ "$default_ok" != "True" ]]; then
  all_ok=false
fi

# Build final report
report=$(python3 -c "
import json
slots = json.loads('''$results''')
default = json.loads('''$default_result''')
default['slot'] = 'default'
default['service'] = 'Claude Code-credentials'
report = {
    'healthy': $( $all_ok && echo 'True' || echo 'False' ),
    'timestamp': $(date +%s),
    'slots': slots,
    'default': default,
}
print(json.dumps(report, indent=2))
" 2>/dev/null)

if $JSON_MODE; then
  echo "$report"
elif ! $QUIET_MODE; then
  echo "$report"
fi

# Write to health file
echo "$report" > "$HOME/.claude/session-health/keychain-health.json"

$all_ok && exit 0 || exit 1
