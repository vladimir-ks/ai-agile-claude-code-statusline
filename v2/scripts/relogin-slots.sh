#!/usr/bin/env bash
# relogin-slots.sh - Diagnose slot keychains and guide re-login for broken ones
#
# Checks each slot's keychain for integrity:
# - Entry exists and is valid JSON (>100 bytes)
# - Has claudeAiOauth.accessToken
# - Has oauthAccount.emailAddress
# - Token not expired
#
# For broken slots: prints the exact CLAUDE_CONFIG_DIR command to re-login.
#
# Usage: ./relogin-slots.sh [--fix]
#   --fix  Attempt auto-recovery from .claude.json before prompting re-login

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

AUTO_FIX=false
[[ "${1:-}" == "--fix" ]] && AUTO_FIX=true

SESSIONS_YAML=""
for p in "$HOME/_claude-configs/hot-swap/claude-sessions.yaml" \
         "$HOME/cloud_configs/hot-swap/claude-sessions.yaml"; do
  if [[ -f "$p" ]]; then
    SESSIONS_YAML="$p"
    break
  fi
done

if [[ -z "$SESSIONS_YAML" ]]; then
  echo -e "${RED}Error: claude-sessions.yaml not found${NC}" >&2
  exit 1
fi

echo -e "${CYAN}=== Slot Keychain Health Check ===${NC}"
echo ""

SLOTS=$(yq '.accounts | keys | .[]' "$SESSIONS_YAML" 2>/dev/null)

ok_count=0
broken_count=0
need_login=()

# Helper: compute keychain service name
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

# Helper: check a keychain entry, returns JSON status
check_keychain() {
  local service="$1"
  local blob
  blob=$(security find-generic-password -s "$service" -w 2>/dev/null || echo "")

  if [[ -z "$blob" ]]; then
    echo '{"status":"missing","reason":"No keychain entry"}'
    return
  fi

  local len=${#blob}
  if [[ $len -lt 100 ]]; then
    echo "{\"status\":\"corrupted\",\"reason\":\"Entry too small (${len} bytes, expected >100)\",\"content\":\"${blob}\"}"
    return
  fi

  # Parse with python3 for robust JSON handling
  local tmp_blob
  tmp_blob=$(mktemp)
  printf '%s' "$blob" > "$tmp_blob"

  python3 -c "
import json, sys, time
try:
    with open('$tmp_blob') as f:
        d = json.load(f)
except:
    print(json.dumps({'status':'corrupted','reason':'Invalid JSON'}))
    sys.exit(0)

cai = d.get('claudeAiOauth', {})
oa = d.get('oauthAccount', {})

has_token = bool(cai.get('accessToken'))
has_refresh = bool(cai.get('refreshToken'))
has_email = bool(oa.get('emailAddress'))
has_uuid = bool(oa.get('accountUuid'))

expires_at = cai.get('expiresAt', 0)
now_ms = time.time() * 1000
expired = expires_at > 0 and expires_at < now_ms
expires_min = round((expires_at - now_ms) / 60000) if expires_at > 0 else -1

issues = []
if not has_token: issues.append('no accessToken')
if not has_refresh: issues.append('no refreshToken')
if not has_email: issues.append('no oauthAccount.emailAddress')
if expired: issues.append(f'token expired {abs(expires_min)}min ago')

status = 'ok' if not issues else 'broken'
result = {
    'status': status,
    'has_token': has_token,
    'has_refresh': has_refresh,
    'has_email': has_email,
    'email': oa.get('emailAddress', ''),
    'expired': expired,
    'expires_min': expires_min,
    'issues': issues,
    'subscription': cai.get('subscriptionType', 'unknown'),
}
print(json.dumps(result))
" 2>/dev/null

  rm -f "$tmp_blob"
}

for slot in $SLOTS; do
  config_dir=$(yq ".accounts.$slot.config_dir" "$SESSIONS_YAML" 2>/dev/null)
  expected_email=$(yq ".accounts.$slot.email" "$SESSIONS_YAML" 2>/dev/null)
  slot_status=$(yq ".accounts.$slot.status" "$SESSIONS_YAML" 2>/dev/null)

  if [[ -z "$config_dir" || "$config_dir" == "null" ]]; then
    echo -e "${YELLOW}  ⏭ $slot: No config_dir${NC}"
    continue
  fi

  keychain_service=$(get_keychain_service "$config_dir")
  result=$(check_keychain "$keychain_service")

  status=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
  email=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('email',''))" 2>/dev/null)
  expires_min=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('expires_min',-1))" 2>/dev/null)
  issues=$(echo "$result" | python3 -c "import json,sys; print(', '.join(json.load(sys.stdin).get('issues',[])))" 2>/dev/null)
  sub=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('subscription','?'))" 2>/dev/null)

  reason=$(echo "$result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('reason',''))" 2>/dev/null)
  if [[ -n "$reason" && -z "$issues" ]]; then
    issues="$reason"
  fi

  if [[ "$status" == "ok" ]]; then
    # Check email mismatch
    if [[ -n "$expected_email" && -n "$email" && "$expected_email" != "$email" ]]; then
      echo -e "${YELLOW}  ⚠ $slot ($expected_email): OK but email mismatch (keychain=$email)${NC}"
    elif [[ -n "$expires_min" && "$expires_min" -gt 0 && "$expires_min" -lt 60 ]]; then
      echo -e "${YELLOW}  ⚠ $slot ($email): OK but token expires in ${expires_min}min ($sub)${NC}"
    else
      echo -e "${GREEN}  ✓ $slot ($email): OK ($sub, expires in ${expires_min}min)${NC}"
    fi
    ok_count=$((ok_count + 1))
  else
    echo -e "${RED}  ✗ $slot ($expected_email): $status — $issues${NC}"
    need_login+=("$slot|$config_dir|$expected_email")
    broken_count=$((broken_count + 1))
  fi
done

# Also check default keychain
echo ""
echo -e "${CYAN}=== Default Keychain ===${NC}"
default_result=$(check_keychain "Claude Code-credentials")
default_status=$(echo "$default_result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('status','?'))" 2>/dev/null)
default_email=$(echo "$default_result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('email',''))" 2>/dev/null)
default_expires=$(echo "$default_result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('expires_min',-1))" 2>/dev/null)
default_sub=$(echo "$default_result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('subscription','?'))" 2>/dev/null)

if [[ "$default_status" == "ok" ]]; then
  echo -e "${GREEN}  ✓ Default ($default_email): OK ($default_sub, expires in ${default_expires}min)${NC}"
else
  default_issues=$(echo "$default_result" | python3 -c "import json,sys; print(', '.join(json.load(sys.stdin).get('issues',[])))" 2>/dev/null)
  echo -e "${RED}  ✗ Default: $default_status — $default_issues${NC}"
fi

# Summary
echo ""
echo -e "${CYAN}=== Summary ===${NC}"
echo "  OK: $ok_count  Broken: $broken_count"

if [[ $broken_count -gt 0 ]]; then
  echo ""
  echo -e "${YELLOW}The following slots need re-login:${NC}"
  echo ""
  for entry in "${need_login[@]}"; do
    IFS='|' read -r slot config_dir email <<< "$entry"
    echo -e "  ${RED}$slot${NC} ($email):"
    echo -e "    ${CYAN}CLAUDE_CONFIG_DIR=$config_dir claude /login${NC}"
    echo ""
  done

  echo -e "${YELLOW}After re-login, run this script again to verify.${NC}"
  exit 1
fi

echo -e "${GREEN}All keychains healthy.${NC}"
exit 0
