#!/usr/bin/env bash
# check-refresh-health.sh - Monitor quota refresh system health
#
# Checks:
# 1. launchd agent loaded and running
# 2. Heartbeat file age < 10 min
# 3. Merged quota cache age < 15 min
# 4. Keychain integrity for all slots
# 5. No recent error log growth
#
# Outputs JSON report to stdout and ~/.claude/session-health/refresh-health.json
# Exit 0 = healthy, Exit 1 = degraded
#
# Usage: ./check-refresh-health.sh [--quiet]

set -euo pipefail

QUIET=false
[[ "${1:-}" == "--quiet" ]] && QUIET=true

HEALTH_DIR="$HOME/.claude/session-health"
HEARTBEAT="$HEALTH_DIR/quota-heartbeat.json"
CACHE="$HEALTH_DIR/merged-quota-cache.json"
ERROR_LOG="$HEALTH_DIR/quota-refresh-error.log"
PLIST_LABEL="com.claude.quota-refresh"

now=$(date +%s)
issues=()
checks=()

# Check 1: launchd agent
agent_loaded=false
if launchctl list 2>/dev/null | grep -q "$PLIST_LABEL"; then
  agent_loaded=true
  checks+=("{\"check\":\"launchd_agent\",\"status\":\"ok\",\"detail\":\"loaded\"}")
else
  issues+=("launchd agent not loaded")
  checks+=("{\"check\":\"launchd_agent\",\"status\":\"fail\",\"detail\":\"not loaded\"}")
fi

# Check 2: heartbeat freshness
if [[ -f "$HEARTBEAT" ]]; then
  hb_ts=$(python3 -c "import json; print(json.load(open('$HEARTBEAT')).get('ts',0))" 2>/dev/null || echo 0)
  hb_age=$((now - hb_ts))
  hb_rc=$(python3 -c "import json; print(json.load(open('$HEARTBEAT')).get('fetch_rc',99))" 2>/dev/null || echo 99)
  if [[ $hb_age -lt 600 ]]; then
    checks+=("{\"check\":\"heartbeat\",\"status\":\"ok\",\"age_sec\":$hb_age,\"fetch_rc\":$hb_rc}")
  else
    issues+=("heartbeat stale (${hb_age}s, max 600s)")
    checks+=("{\"check\":\"heartbeat\",\"status\":\"warn\",\"age_sec\":$hb_age,\"fetch_rc\":$hb_rc}")
  fi
else
  issues+=("no heartbeat file")
  checks+=("{\"check\":\"heartbeat\",\"status\":\"fail\",\"detail\":\"missing\"}")
fi

# Check 3: merged cache freshness
if [[ -f "$CACHE" ]]; then
  cache_ts=$(python3 -c "import json; print(json.load(open('$CACHE')).get('ts',0))" 2>/dev/null || echo 0)
  cache_age=$((now - cache_ts))
  if [[ $cache_age -lt 900 ]]; then
    checks+=("{\"check\":\"quota_cache\",\"status\":\"ok\",\"age_sec\":$cache_age}")
  else
    issues+=("quota cache stale (${cache_age}s, max 900s)")
    checks+=("{\"check\":\"quota_cache\",\"status\":\"warn\",\"age_sec\":$cache_age}")
  fi
else
  issues+=("no quota cache")
  checks+=("{\"check\":\"quota_cache\",\"status\":\"fail\",\"detail\":\"missing\"}")
fi

# Check 4: keychain integrity (use validate-keychains.sh if available)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -x "$SCRIPT_DIR/validate-keychains.sh" ]]; then
  if "$SCRIPT_DIR/validate-keychains.sh" --quiet 2>/dev/null; then
    checks+=("{\"check\":\"keychains\",\"status\":\"ok\"}")
  else
    issues+=("keychain integrity check failed")
    checks+=("{\"check\":\"keychains\",\"status\":\"fail\",\"detail\":\"integrity check failed\"}")
  fi
else
  checks+=("{\"check\":\"keychains\",\"status\":\"skip\",\"detail\":\"validator not found\"}")
fi

# Check 5: error log
if [[ -f "$ERROR_LOG" ]]; then
  error_lines=$(wc -l < "$ERROR_LOG" 2>/dev/null | tr -d ' ')
  # Check if errors grew in last hour
  recent_errors=$(python3 -c "
import os, time
cutoff = time.time() - 3600
count = 0
try:
    if os.path.getmtime('$ERROR_LOG') > cutoff:
        with open('$ERROR_LOG') as f:
            count = sum(1 for line in f if 'ERROR' in line or 'error' in line.lower())
except: pass
print(count)
" 2>/dev/null || echo 0)
  if [[ "$recent_errors" -gt 10 ]]; then
    issues+=("$recent_errors errors in last hour")
    checks+=("{\"check\":\"error_log\",\"status\":\"warn\",\"recent_errors\":$recent_errors,\"total_lines\":$error_lines}")
  else
    checks+=("{\"check\":\"error_log\",\"status\":\"ok\",\"recent_errors\":$recent_errors,\"total_lines\":$error_lines}")
  fi
else
  checks+=("{\"check\":\"error_log\",\"status\":\"ok\",\"detail\":\"no error log\"}")
fi

# Build report
healthy=true
[[ ${#issues[@]} -gt 0 ]] && healthy=false

checks_json=$(printf '%s,' "${checks[@]}")
checks_json="[${checks_json%,}]"

issues_json="[]"
if [[ ${#issues[@]} -gt 0 ]]; then
  issues_json=$(printf '"%s",' "${issues[@]}")
  issues_json="[${issues_json%,}]"
fi

report=$(python3 -c "
import json
report = {
    'healthy': $($healthy && echo 'True' || echo 'False'),
    'timestamp': $now,
    'checks': json.loads('$checks_json'),
    'issues': json.loads('$issues_json'),
}
print(json.dumps(report, indent=2))
" 2>/dev/null)

# Write to health file
echo "$report" > "$HEALTH_DIR/refresh-health.json"

if ! $QUIET; then
  echo "$report"
fi

$healthy && exit 0 || exit 1
