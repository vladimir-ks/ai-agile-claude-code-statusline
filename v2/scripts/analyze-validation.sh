#!/usr/bin/env bash
# Analyze validation logs to understand data source behavior
#
# Usage: ./analyze-validation.sh [dataPoint]
# Example: ./analyze-validation.sh model
# Example: ./analyze-validation.sh  (all data points)

LOG_FILE="${HOME}/.claude/statusline-validation.jsonl"

if [[ ! -f "$LOG_FILE" ]]; then
  echo "No validation log found at $LOG_FILE"
  echo "Enable logging by running statusline with STATUSLINE_VALIDATION_LOG=1"
  exit 1
fi

echo "=== Statusline Validation Analysis ==="
echo "Log file: $LOG_FILE"
echo "Total entries: $(wc -l < "$LOG_FILE" | tr -d ' ')"
echo ""

# Summary by data point
echo "=== Entries per Data Point ==="
jq -r '.dataPoint' "$LOG_FILE" 2>/dev/null | sort | uniq -c | sort -rn
echo ""

# Disagreements
echo "=== Disagreements Detected ==="
DISAGREEMENTS=$(jq -r 'select(.disagreement != null) | "\(.time) [\(.dataPoint)] \(.disagreement)"' "$LOG_FILE" 2>/dev/null)
if [[ -z "$DISAGREEMENTS" ]]; then
  echo "  No disagreements found (sources agree)"
else
  echo "$DISAGREEMENTS" | head -20
  TOTAL=$(jq -r 'select(.disagreement != null)' "$LOG_FILE" 2>/dev/null | wc -l | tr -d ' ')
  echo "  ... ($TOTAL total disagreements)"
fi
echo ""

# Source selection frequency
echo "=== Source Selection Frequency ==="
jq -r '"\(.dataPoint): \(.selected.source)"' "$LOG_FILE" 2>/dev/null | sort | uniq -c | sort -rn
echo ""

# Confidence levels
echo "=== Average Confidence by Data Point ==="
jq -r '.dataPoint' "$LOG_FILE" 2>/dev/null | sort -u | while read dp; do
  AVG=$(jq -r "select(.dataPoint == \"$dp\") | .selected.confidence" "$LOG_FILE" 2>/dev/null | awk '{sum+=$1; count++} END {if(count>0) printf "%.1f", sum/count; else print "N/A"}')
  echo "  $dp: ${AVG}%"
done
echo ""

# Specific data point analysis (if provided)
if [[ -n "$1" ]]; then
  echo "=== Detailed Analysis: $1 ==="

  echo "Recent values:"
  jq -r "select(.dataPoint == \"$1\") | \"\(.time) [\(.selected.source)] = \(.selected.value)\"" "$LOG_FILE" 2>/dev/null | tail -10

  echo ""
  echo "Source value history:"
  jq -r "select(.dataPoint == \"$1\") | .sources | to_entries[] | \"\(.key): \(.value.value)\"" "$LOG_FILE" 2>/dev/null | sort | uniq -c | sort -rn | head -20
fi

echo ""
echo "=== Quick Commands ==="
echo "View model disagreements:"
echo "  jq 'select(.dataPoint==\"model\" and .disagreement!=null)' $LOG_FILE"
echo ""
echo "View git branch switches:"
echo "  jq 'select(.dataPoint==\"git\") | {time, branch: .selected.value}' $LOG_FILE"
echo ""
echo "View context window changes:"
echo "  jq 'select(.dataPoint==\"context\") | {time, value: .selected.value}' $LOG_FILE"
