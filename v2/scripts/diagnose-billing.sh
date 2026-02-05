#!/bin/bash
# Billing Data Diagnostic Script
# Run this to diagnose billing data issues in the statusline

set -e

HEALTH_DIR="$HOME/.claude/session-health"
COOLDOWN_DIR="$HEALTH_DIR/cooldowns"
SHARED_CACHE="$HEALTH_DIR/billing-shared.json"

echo "=================================================="
echo "  STATUSLINE V2 - BILLING DIAGNOSTIC"
echo "=================================================="
echo ""

# 1. Check shared billing cache
echo "=== SHARED BILLING CACHE ==="
if [[ -f "$SHARED_CACHE" ]]; then
  COST=$(jq -r '.costToday // "N/A"' "$SHARED_CACHE")
  LAST_FETCHED=$(jq -r '.lastFetched // 0' "$SHARED_CACHE")
  IS_FRESH=$(jq -r '.isFresh // false' "$SHARED_CACHE")

  NOW=$(date +%s)
  NOW_MS=$((NOW * 1000))
  AGE_MS=$((NOW_MS - LAST_FETCHED))
  AGE_MINUTES=$((AGE_MS / 60000))

  FETCH_DATE=$(date -r $((LAST_FETCHED / 1000)) 2>/dev/null || echo "Invalid timestamp")

  echo "Cost today: \$$COST"
  echo "Last fetched: $FETCH_DATE"
  echo "Age: ${AGE_MINUTES} minutes"
  echo "Stored isFresh: $IS_FRESH"

  if [[ $AGE_MINUTES -lt 2 ]]; then
    echo "Status: FRESH"
  elif [[ $AGE_MINUTES -lt 10 ]]; then
    echo "Status: STALE (should show warning)"
  else
    echo "Status: CRITICAL (should show red triangle)"
  fi
else
  echo "No shared cache found at: $SHARED_CACHE"
fi
echo ""

# 2. Check cooldown status
echo "=== COOLDOWN STATUS ==="
if [[ -d "$COOLDOWN_DIR" ]]; then
  for cat in billing_oauth billing_ccusage; do
    COOLDOWN_FILE="$COOLDOWN_DIR/fm-$cat.cooldown"
    if [[ -f "$COOLDOWN_FILE" ]]; then
      MTIME=$(stat -f %m "$COOLDOWN_FILE" 2>/dev/null || stat -c %Y "$COOLDOWN_FILE" 2>/dev/null)
      NOW=$(date +%s)
      AGE=$((NOW - MTIME))

      if [[ "$cat" == "billing_ccusage" ]]; then
        COOLDOWN=120  # 2 minutes
      else
        COOLDOWN=300  # 5 minutes
      fi

      REMAINING=$((COOLDOWN - AGE))
      if [[ $REMAINING -gt 0 ]]; then
        echo "$cat: IN COOLDOWN (${REMAINING}s remaining)"
      else
        echo "$cat: Cooldown expired"
      fi
    else
      echo "$cat: No cooldown (ready to fetch)"
    fi
  done
else
  echo "No cooldown directory found"
fi
echo ""

# 3. Check OAuth tokens
echo "=== OAUTH TOKEN STATUS ==="
OAUTH_ENTRIES=$(security dump-keychain 2>/dev/null | grep -o '"Claude Code-credentials-[^"]*"' | sort -u | wc -l)
echo "Found $OAUTH_ENTRIES keychain credential entries"

if [[ $OAUTH_ENTRIES -gt 0 ]]; then
  echo ""
  echo "Checking token validity..."
  security dump-keychain 2>/dev/null | grep -o '"Claude Code-credentials-[^"]*"' | sort -u | while read entry; do
    SERVICE=$(echo "$entry" | tr -d '"')
    # Try to get credential JSON
    CRED=$(security find-generic-password -s "$SERVICE" -w 2>/dev/null || echo "")
    if [[ -n "$CRED" ]]; then
      EXPIRES_AT=$(echo "$CRED" | jq -r '.claudeAiOauth.expiresAt // 0' 2>/dev/null || echo "0")
      NOW_MS=$(($(date +%s) * 1000))
      if [[ "$EXPIRES_AT" != "0" && "$EXPIRES_AT" != "null" ]]; then
        if [[ $EXPIRES_AT -gt $NOW_MS ]]; then
          echo "  $SERVICE: VALID (expires in $((($EXPIRES_AT - $NOW_MS) / 60000)) minutes)"
        else
          echo "  $SERVICE: EXPIRED (need to run: claude /login)"
        fi
      else
        echo "  $SERVICE: No expiry set (legacy token)"
      fi
    fi
  done
fi
echo ""

# 4. Check ccusage
echo "=== CCUSAGE STATUS ==="
if command -v ccusage &>/dev/null; then
  CCUSAGE_VERSION=$(timeout 3 ccusage --version 2>/dev/null || echo "timeout")
  echo "ccusage version: $CCUSAGE_VERSION"

  # Check for hung processes
  HUNG=$(ps aux | grep -c "ccusage blocks" | grep -v grep || echo "0")
  if [[ "$HUNG" -gt 0 ]]; then
    echo "WARNING: Found $HUNG hung ccusage processes!"
    echo "Run: pkill -f 'ccusage blocks' to kill them"
  else
    echo "No hung processes"
  fi
else
  echo "ccusage not installed"
fi
echo ""

# 5. Recommendations
echo "=== RECOMMENDATIONS ==="
if [[ $AGE_MINUTES -gt 10 ]]; then
  echo "1. Your billing data is critically stale (${AGE_MINUTES} minutes old)"
  echo ""
  echo "   ROOT CAUSE: ccusage hangs due to 4,691 transcript files (4.3GB)."
  echo "   The OAuth API endpoint doesn't support usage queries."
  echo ""
  echo "   FIX APPLIED: Local cost calculator now parses ONLY the current"
  echo "   session's transcript file, bypassing ccusage entirely."
  echo ""
  echo "   To trigger fresh calculation, clear cooldowns:"
  echo "   $ rm -f ~/.claude/session-health/cooldowns/fm-*.cooldown"
  echo "   $ rm -f ~/.claude/session-health/cooldowns/oauth-*.cooldown"
  echo ""
  echo "   Or delete the stale shared cache:"
  echo "   $ rm -f ~/.claude/session-health/billing-shared.json"
fi
echo ""
echo "=================================================="
