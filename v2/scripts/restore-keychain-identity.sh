#!/usr/bin/env bash
# restore-keychain-identity.sh
#
# One-time recovery script: restores oauthAccount section in keychain entries.
#
# The TS refreshOAuthToken() bug replaced entire keychain blobs with only
# claudeAiOauth, destroying the oauthAccount identity data. This script
# restores it from each slot's .claude.json file.
#
# Usage: ./restore-keychain-identity.sh [--dry-run]

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

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

echo -e "${GREEN}Using: $SESSIONS_YAML${NC}"
echo ""

# Helper: extract oauthAccount from a .claude.json file (uses temp file for safety)
extract_oauth_account() {
  local json_file="$1"
  local tmp_in
  tmp_in=$(mktemp)
  cp "$json_file" "$tmp_in"
  python3 -c "
import json, sys
with open('$tmp_in') as f:
    d = json.load(f)
oa = d.get('oauthAccount')
if oa:
    print(json.dumps(oa))
else:
    sys.exit(1)
" 2>/dev/null
  local rc=$?
  rm -f "$tmp_in"
  return $rc
}

# Helper: check if a JSON blob has oauthAccount (reads from stdin)
has_oauth_account() {
  local tmp_in
  tmp_in=$(mktemp)
  cat > "$tmp_in"
  python3 -c "
import json
with open('$tmp_in') as f:
    d = json.load(f)
print('yes' if d.get('oauthAccount') else 'no')
" 2>/dev/null
  rm -f "$tmp_in"
}

# Helper: get emailAddress from oauthAccount in a JSON blob (reads from stdin)
get_oauth_email() {
  local tmp_in
  tmp_in=$(mktemp)
  cat > "$tmp_in"
  python3 -c "
import json
with open('$tmp_in') as f:
    d = json.load(f)
print(d.get('oauthAccount',{}).get('emailAddress','unknown'))
" 2>/dev/null
  rm -f "$tmp_in"
}

# Helper: merge oauthAccount into a keychain blob
merge_oauth_account() {
  local blob_json="$1"
  local oa_json="$2"
  local tmp_blob tmp_oa
  tmp_blob=$(mktemp)
  tmp_oa=$(mktemp)
  echo "$blob_json" > "$tmp_blob"
  echo "$oa_json" > "$tmp_oa"
  python3 -c "
import json
with open('$tmp_blob') as f: blob = json.load(f)
with open('$tmp_oa') as f: oa = json.load(f)
blob['oauthAccount'] = oa
print(json.dumps(blob))
" 2>/dev/null
  rm -f "$tmp_blob" "$tmp_oa"
}

# Get slot list
SLOTS=$(yq '.accounts | keys | .[]' "$SESSIONS_YAML" 2>/dev/null)

restored=0
skipped=0
failed=0

for slot in $SLOTS; do
  config_dir=$(yq ".accounts.$slot.config_dir" "$SESSIONS_YAML" 2>/dev/null)
  email=$(yq ".accounts.$slot.email" "$SESSIONS_YAML" 2>/dev/null)

  if [[ -z "$config_dir" || "$config_dir" == "null" ]]; then
    echo -e "${YELLOW}  ⏭ $slot: No config_dir in sessions.yaml${NC}"
    skipped=$((skipped + 1))
    continue
  fi

  claude_json="$config_dir/.claude.json"
  if [[ ! -f "$claude_json" ]]; then
    echo -e "${YELLOW}  ⏭ $slot ($email): No .claude.json at $config_dir${NC}"
    skipped=$((skipped + 1))
    continue
  fi

  # Extract oauthAccount from .claude.json
  oauth_account=$(extract_oauth_account "$claude_json" || echo "")

  if [[ -z "$oauth_account" ]]; then
    echo -e "${YELLOW}  ⏭ $slot ($email): No oauthAccount in .claude.json${NC}"
    skipped=$((skipped + 1))
    continue
  fi

  # Compute keychain service name
  config_dir_abs=$(cd "$config_dir" 2>/dev/null && pwd || echo "$config_dir")
  default_dir=$(cd "$HOME/.claude" 2>/dev/null && pwd)

  if [[ "$config_dir_abs" == "$default_dir" ]]; then
    keychain_service="Claude Code-credentials"
  else
    hash=$(echo -n "$config_dir_abs" | shasum -a 256 | cut -c1-8)
    keychain_service="Claude Code-credentials-$hash"
  fi

  # Read current keychain blob
  current_blob=$(security find-generic-password -s "$keychain_service" -w 2>/dev/null || echo "")
  if [[ -z "$current_blob" ]]; then
    echo -e "${YELLOW}  ⏭ $slot ($email): No keychain entry for $keychain_service${NC}"
    skipped=$((skipped + 1))
    continue
  fi

  # Check if oauthAccount already exists
  has_oa=$(echo "$current_blob" | has_oauth_account)

  if [[ "$has_oa" == "yes" ]]; then
    existing_email=$(echo "$current_blob" | get_oauth_email)
    echo -e "${GREEN}  ✓ $slot ($email): Already has oauthAccount ($existing_email)${NC}"
    skipped=$((skipped + 1))
    continue
  fi

  # Merge oauthAccount into blob
  merged=$(merge_oauth_account "$current_blob" "$oauth_account")

  if [[ -z "$merged" ]]; then
    echo -e "${RED}  ✗ $slot ($email): Failed to merge oauthAccount${NC}"
    failed=$((failed + 1))
    continue
  fi

  if $DRY_RUN; then
    echo -e "${YELLOW}  [DRY-RUN] $slot ($email): Would restore oauthAccount in $keychain_service${NC}"
    restored=$((restored + 1))
    continue
  fi

  # Write back to keychain
  security delete-generic-password -s "$keychain_service" 2>/dev/null || true
  tmp_write=$(mktemp)
  printf '%s' "$merged" > "$tmp_write"
  security add-generic-password -s "$keychain_service" -a "vmks" -U -w "$(cat "$tmp_write")" 2>/dev/null
  write_rc=$?
  rm -f "$tmp_write"

  if [[ $write_rc -eq 0 ]]; then
    echo -e "${GREEN}  ✓ $slot ($email): Restored oauthAccount in $keychain_service${NC}"
    restored=$((restored + 1))
  else
    echo -e "${RED}  ✗ $slot ($email): Failed to write keychain${NC}"
    failed=$((failed + 1))
  fi
done

# Handle default keychain
echo ""
echo -e "${GREEN}=== Default Keychain (Claude Code-credentials) ===${NC}"

default_blob=$(security find-generic-password -s "Claude Code-credentials" -w 2>/dev/null || echo "")
if [[ -n "$default_blob" ]]; then
  has_default_oa=$(echo "$default_blob" | has_oauth_account)

  if [[ "$has_default_oa" == "yes" ]]; then
    default_email=$(echo "$default_blob" | get_oauth_email)
    echo -e "${GREEN}  ✓ Default: Already has oauthAccount ($default_email)${NC}"
  else
    # Need to identify which account the default token belongs to
    # Use the current session health if available
    session_email=""
    for health_file in "$HOME/.claude/session-health/"*.json; do
      [[ -f "$health_file" ]] || continue
      [[ "$health_file" == *"debug"* ]] && continue
      [[ "$health_file" == *"billing"* ]] && continue
      [[ "$health_file" == *"telemetry"* ]] && continue
      [[ "$health_file" == *"notifications"* ]] && continue
      [[ "$health_file" == *"data-cache"* ]] && continue
      [[ "$health_file" == *"publish"* ]] && continue
      [[ "$health_file" == *"merged"* ]] && continue
      [[ "$health_file" == *"hot-swap"* ]] && continue
      [[ "$health_file" == *"slot-recommendation"* ]] && continue

      tmp_hf=$(mktemp)
      cp "$health_file" "$tmp_hf"
      email=$(python3 -c "
import json
with open('$tmp_hf') as f:
    d = json.load(f)
auth = d.get('launch',{}).get('authProfile','')
if auth and auth != 'default' and '@' in auth:
    print(auth)
" 2>/dev/null || echo "")
      rm -f "$tmp_hf"

      if [[ -n "$email" ]]; then
        session_email="$email"
        break
      fi
    done

    if [[ -n "$session_email" ]]; then
      echo -e "${YELLOW}  Detected active account: $session_email (from session health)${NC}"

      # Find matching slot's oauthAccount
      for slot in $SLOTS; do
        slot_email=$(yq ".accounts.$slot.email" "$SESSIONS_YAML" 2>/dev/null)
        if [[ "$slot_email" == "$session_email" ]]; then
          slot_config=$(yq ".accounts.$slot.config_dir" "$SESSIONS_YAML" 2>/dev/null)
          slot_claude_json="$slot_config/.claude.json"

          if [[ -f "$slot_claude_json" ]]; then
            slot_oa=$(extract_oauth_account "$slot_claude_json" || echo "")

            if [[ -n "$slot_oa" ]]; then
              merged_default=$(merge_oauth_account "$default_blob" "$slot_oa")

              if $DRY_RUN; then
                echo -e "${YELLOW}  [DRY-RUN] Default: Would restore oauthAccount ($session_email)${NC}"
              elif [[ -n "$merged_default" ]]; then
                security delete-generic-password -s "Claude Code-credentials" 2>/dev/null || true
                tmp_dw=$(mktemp)
                printf '%s' "$merged_default" > "$tmp_dw"
                security add-generic-password -s "Claude Code-credentials" -a "vmks" -U -w "$(cat "$tmp_dw")" 2>/dev/null
                rm -f "$tmp_dw"
                echo -e "${GREEN}  ✓ Default: Restored oauthAccount ($session_email)${NC}"
                restored=$((restored + 1))
              fi
            fi
          fi
          break
        fi
      done
    else
      echo -e "${YELLOW}  ⚠ Default: Cannot identify account (no session health with email)${NC}"
      echo -e "${YELLOW}    Run a Claude Code session first, then re-run this script${NC}"
    fi
  fi
fi

echo ""
echo -e "${GREEN}Done: restored=$restored skipped=$skipped failed=$failed${NC}"
