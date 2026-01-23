#!/bin/bash
# Modernized Claude Code statusline
# Updated: 2025-12-27 | Features: core, cache, git+, conversation, AIGILE, MCP, anti-flicker, resilient

set +e  # Don't exit on errors - we have fallbacks
trap '' EXIT  # Ignore errors at exit

# Read input first (CRITICAL: must be before any other operations)
input=$(cat 2>/dev/null) || input=""

# Detect if JSON input was actually provided (not empty stdin)
# DEFENSIVE: Check jq exists before attempting JSON validation
json_input_provided=0
if command -v jq >/dev/null 2>&1; then
    if [ -n "$input" ] && echo "$input" | jq -e . >/dev/null 2>&1; then
        json_input_provided=1
    fi
fi

# ANTI-FLICKER: Build all output in variable, print once at end
OUTPUT=""

# ---- Configuration ----
# Set your weekly budget (default $456)
# You can override: export WEEKLY_BUDGET=YOUR_BUDGET
WEEKLY_BUDGET="${WEEKLY_BUDGET:-456}"

# Timeout for all external commands (prevent hangs)
CMD_TIMEOUT=2

# Force refresh mode (bypasses all caches for debugging/manual updates)
FORCE_REFRESH="${STATUSLINE_FORCE_REFRESH:-0}"

# Debug mode setup
DEBUG=0
if [ "$1" = "--debug" ]; then
    DEBUG=1
    LOG_FILE="${HOME}/.claude/statusline.log"
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    {
        echo "[$TIMESTAMP] Status line triggered with input:"
        (echo "$input" | jq . 2>/dev/null) || echo "$input"
        echo "---"
    } >>"$LOG_FILE" 2>/dev/null
fi

# ---- color helpers ----
use_color=1
[ -n "$NO_COLOR" ] && use_color=0

C() { if [ "$use_color" -eq 1 ]; then printf '\033[%sm' "$1"; fi; }
RST() { if [ "$use_color" -eq 1 ]; then printf '\033[0m'; fi; }
rst() { RST; }

# ---- modern color palette ----
dir_color() { C '38;5;117'; }        # sky blue
git_color() { C '38;5;150'; }        # soft green
model_color() { C '38;5;147'; }      # light purple
version_color() { C '38;5;180'; }    # soft yellow
cc_version_color() { C '38;5;249'; } # light gray
style_color() { C '38;5;245'; }      # gray
usage_color() { C '38;5;189'; }      # lavender
cost_color() { C '38;5;222'; }       # light gold
burn_color() { C '38;5;220'; }       # bright gold
cache_color() { C '38;5;156'; }      # light green
aigile_color() { C '38;5;213'; }     # pink
mcp_color() { C '38;5;81'; }         # cyan

# Context colors based on remaining percentage
context_color_good() { C '38;5;158'; } # mint green
context_color_warn() { C '38;5;215'; } # peach
context_color_crit() { C '38;5;203'; } # coral red

# ---- caching system ----
GIT_CACHE_FILE="${HOME}/.claude/.git_status_cache"
GIT_CACHE_TTL=10 # Cache git operations for 10 seconds

read_cache() {
    local cache_file="$1"
    local ttl="$2"

    if [ -f "$cache_file" ]; then
        local cache_age=$(($(date +%s) - $(stat -f %m "$cache_file" 2>/dev/null || stat -c %Y "$cache_file" 2>/dev/null || echo 0)))
        if [ "$cache_age" -lt "$ttl" ]; then
            cat "$cache_file" 2>/dev/null
            return 0
        fi
    fi
    return 1
}

write_cache() {
    local cache_file="$1"
    local content="$2"

    # Atomic write using temp file
    local temp_file="${cache_file}.tmp.$$"
    echo "$content" >"$temp_file" 2>/dev/null && mv "$temp_file" "$cache_file" 2>/dev/null
}

# ---- utility functions ----
num_or_zero() {
    v="$1"
    [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0
}

to_epoch() {
    ts="$1"
    local result=""

    # Try gdate first (GNU date on macOS with coreutils)
    if command -v gdate >/dev/null 2>&1; then
        result=$(gdate -d "$ts" +%s 2>/dev/null)
        if [ -n "$result" ] && [[ "$result" =~ ^[0-9]+$ ]]; then
            echo "$result"
            return 0
        fi
    fi

    # Try BSD date (macOS)
    result=$(date -u -j -f "%Y-%m-%dT%H:%M:%S%z" "${ts/Z/+0000}" +%s 2>/dev/null)
    if [ -n "$result" ] && [[ "$result" =~ ^[0-9]+$ ]]; then
        echo "$result"
        return 0
    fi

    # Try Python fallback
    result=$(python3 - "$ts" <<'PY' 2>/dev/null
import sys, datetime
try:
    s=sys.argv[1].replace('Z','+00:00')
    print(int(datetime.datetime.fromisoformat(s).timestamp()))
except:
    pass
PY
)
    if [ -n "$result" ] && [[ "$result" =~ ^[0-9]+$ ]]; then
        echo "$result"
        return 0
    fi

    # All methods failed - return 0 (safe default, won't break calculations)
    echo 0
}

fmt_time_hm() {
    epoch="$1"
    if date -r 0 +%s >/dev/null 2>&1; then date -r "$epoch" +"%H:%M"; else date -d "@$epoch" +"%H:%M"; fi
}

progress_bar() {
    pct="${1:-0}"
    width="${2:-10}"
    [[ "$pct" =~ ^[0-9]+$ ]] || pct=0
    ((pct < 0)) && pct=0
    ((pct > 100)) && pct=100
    filled=$((pct * width / 100))
    empty=$((width - filled))
    printf '%*s' "$filled" '' | tr ' ' '='
    printf '%*s' "$empty" '' | tr ' ' '-'
}

# Progress bar with threshold marker (|) showing where compact triggers
# Args: $1=used%, $2=threshold% (where | appears), $3=width
progress_bar_with_marker() {
    used_pct="${1:-0}"
    threshold_pct="${2:-78}"
    width="${3:-12}"
    [[ "$used_pct" =~ ^[0-9]+$ ]] || used_pct=0
    ((used_pct < 0)) && used_pct=0
    ((used_pct > 100)) && used_pct=100

    # Calculate positions
    filled_pos=$((used_pct * width / 100))
    marker_pos=$((threshold_pct * width / 100))

    # Build the bar character by character
    bar=""
    for ((i = 0; i < width; i++)); do
        if [ $i -eq $marker_pos ]; then
            bar="${bar}|"
        elif [ $i -lt $filled_pos ]; then
            bar="${bar}="
        else
            bar="${bar}-"
        fi
    done
    printf '%s' "$bar"
}

# ========================================
# PHASE 1: Parse JSON input (modernized)
# ========================================
if command -v jq >/dev/null 2>&1; then
    current_dir=$(echo "$input" | jq -r '.workspace.current_dir // .cwd // "unknown"' 2>/dev/null | sed "s|^$HOME|~|g")
    project_dir=$(echo "$input" | jq -r '.workspace.project_dir // ""' 2>/dev/null | sed "s|^$HOME|~|g")
    model_name=$(echo "$input" | jq -r '.model.display_name // "Claude"' 2>/dev/null)
    model_id=$(echo "$input" | jq -r '.model.id // ""' 2>/dev/null)
    session_id=$(echo "$input" | jq -r '.session_id // ""' 2>/dev/null)
    transcript_path=$(echo "$input" | jq -r '.transcript_path // ""' 2>/dev/null)
    cc_version=$(echo "$input" | jq -r '.version // ""' 2>/dev/null)
    output_style=$(echo "$input" | jq -r '.output_style.name // ""' 2>/dev/null)

    # Context window data (MODERNIZED - use direct JSON input)
    context_window_size=$(echo "$input" | jq -r '.context_window.context_window_size // 200000' 2>/dev/null)
    total_input_tokens=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0' 2>/dev/null)
    total_output_tokens=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0' 2>/dev/null)

    # Current usage (MODERNIZED - direct from JSON)
    current_input=$(echo "$input" | jq -r '.context_window.current_usage.input_tokens // 0' 2>/dev/null)
    current_output=$(echo "$input" | jq -r '.context_window.current_usage.output_tokens // 0' 2>/dev/null)
    cache_creation=$(echo "$input" | jq -r '.context_window.current_usage.cache_creation_input_tokens // 0' 2>/dev/null)
    cache_read=$(echo "$input" | jq -r '.context_window.current_usage.cache_read_input_tokens // 0' 2>/dev/null)
else
    current_dir=$(pwd | sed "s|^$HOME|~|g")
    project_dir=""
    model_name="Claude"
    model_id=""
    session_id=""
    transcript_path=""
    cc_version=""
    output_style=""
    context_window_size=200000
    total_input_tokens=0
    total_output_tokens=0
    current_input=0
    current_output=0
    cache_creation=0
    cache_read=0
fi

# ========================================
# PHASE 2: Cache Analytics
# ========================================
cache_hit_ratio=""
cache_badge=""
cache_efficiency=""

# Calculate cache metrics
current_input=$(num_or_zero "$current_input")
cache_read=$(num_or_zero "$cache_read")
cache_creation=$(num_or_zero "$cache_creation")
total_input_tokens=$(num_or_zero "$total_input_tokens")

if [ "$current_input" -gt 0 ] || [ "$cache_read" -gt 0 ]; then
    total_cache_eligible=$((current_input + cache_read))
    if [ "$total_cache_eligible" -gt 0 ]; then
        cache_hit_pct=$((cache_read * 100 / total_cache_eligible))
        cache_hit_ratio="${cache_hit_pct}%"

        # Badge based on cache efficiency
        if [ "$cache_hit_pct" -ge 80 ]; then
            cache_badge="🔋" # excellent
            cache_efficiency="excellent"
        elif [ "$cache_hit_pct" -ge 50 ]; then
            cache_badge="⚡" # good
            cache_efficiency="good"
        elif [ "$cache_hit_pct" -ge 20 ]; then
            cache_badge="💫" # fair
            cache_efficiency="fair"
        else
            cache_badge="❄️" # cold
            cache_efficiency="cold"
        fi
    fi
fi

# ========================================
# PHASE 3: Enhanced Git Integration (CACHED)
# ========================================
git_branch=""
git_ahead=0
git_behind=0
git_dirty=0

# Try cache first
cached_git=$(read_cache "$GIT_CACHE_FILE" "$GIT_CACHE_TTL")
if [ -n "$cached_git" ]; then
    # Parse cached values
    git_branch=$(echo "$cached_git" | sed -n '1p')
    git_ahead=$(echo "$cached_git" | sed -n '2p')
    git_behind=$(echo "$cached_git" | sed -n '3p')
    git_dirty=$(echo "$cached_git" | sed -n '4p')
else
    # Cache miss - fetch fresh data
    if git rev-parse --git-dir >/dev/null 2>&1; then
        git_branch=$(git branch --show-current 2>/dev/null || git rev-parse --short HEAD 2>/dev/null)
        git_ahead=$(git rev-list --count @{u}..HEAD 2>/dev/null || echo 0)
        git_behind=$(git rev-list --count HEAD..@{u} 2>/dev/null || echo 0)
        git_dirty=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')

        # Cache results
        write_cache "$GIT_CACHE_FILE" "$(printf '%s\n%s\n%s\n%s' "$git_branch" "$git_ahead" "$git_behind" "$git_dirty")"
    fi
fi

# Format git status: branch +ahead/-behind *dirty
git_status=""
if [ -n "$git_branch" ]; then
    git_status="$git_branch"

    if [ "$git_ahead" -gt 0 ] || [ "$git_behind" -gt 0 ]; then
        git_status="${git_status}+${git_ahead}/-${git_behind}"
    fi

    if [ "$git_dirty" -gt 0 ]; then
        git_status="${git_status}*${git_dirty}"
    fi
fi

# ========================================
# PHASE 4: Conversation Analytics
# ========================================
transcript_turns=0
session_velocity=""
response_efficiency=""

# Count turns from transcript if available
if [ -n "$transcript_path" ] && [ -f "$transcript_path" ] && command -v jq >/dev/null 2>&1; then
    transcript_turns=$(jq -s 'length' "$transcript_path" 2>/dev/null || echo 0)
    transcript_turns=$(num_or_zero "$transcript_turns")

    # Calculate session velocity (tokens per turn)
    if [ "$transcript_turns" -gt 0 ] && [ "$total_input_tokens" -gt 0 ]; then
        velocity=$(((total_input_tokens + total_output_tokens) / transcript_turns))
        session_velocity="${velocity}tok/turn"
    fi

    # Response efficiency (output/input ratio)
    total_output_tokens=$(num_or_zero "$total_output_tokens")
    if [ "$total_input_tokens" -gt 0 ]; then
        eff_pct=$((total_output_tokens * 100 / total_input_tokens))
        response_efficiency="${eff_pct}%out/in"
    fi
fi

# ========================================
# PHASE 2.5: Session Model Detection (CORRECT PRIORITY)
# ========================================
# CORRECT PRIORITY ORDER (per DATA_SOURCES.md):
# Layer 1: JSON input (real-time) - what user is using NOW
# Layer 2: Transcript (with TTL) - last model in session (fallback only)
# Layer 3: Default "Claude" (safety)
#
# NOTE: settings.json is GLOBAL DEFAULT, not CURRENT model
# Do NOT use settings.json for model detection.

# Model change detection file (SESSION-SPECIFIC to avoid cross-chat contamination)
# Each session has its own model cache based on session_id from JSON input
if [ -n "$session_id" ] && [ "$session_id" != "null" ]; then
    # Session-specific cache (prevents model "bleeding" between chats)
    SAVED_MODEL_FILE="${HOME}/.claude/.model_cache_${session_id}"
else
    # Fallback to global cache only if no session_id available
    SAVED_MODEL_FILE="${HOME}/.claude/.last_model_name"
fi

last_model_name=""
if [ -f "$SAVED_MODEL_FILE" ]; then
    last_model_name=$(cat "$SAVED_MODEL_FILE" 2>/dev/null)
fi

# Force refresh invalidates all caches
if [ "$FORCE_REFRESH" = "1" ]; then
    rm -f "${HOME}/.claude/.last_model_name" 2>/dev/null
    rm -f "${HOME}/.claude/.model_cache_"* 2>/dev/null  # All session-specific caches
    rm -f "${HOME}/.claude/.git_status_cache" 2>/dev/null
    rm -f "${HOME}/.claude/.statusline.hash" 2>/dev/null
    rm -f "${HOME}/.claude/.statusline.last_print_time" 2>/dev/null
fi

# Periodic cleanup: Remove stale session model caches (older than 7 days)
# Run only occasionally (when cache file doesn't exist) to avoid overhead
if [ ! -f "$SAVED_MODEL_FILE" ]; then
    find "${HOME}/.claude" -name ".model_cache_*" -mtime +7 -delete 2>/dev/null || true
fi

# Layer 1: JSON input (PRIMARY - most accurate, real-time)
json_model_name="$model_name"  # From Phase 1 parsing
if [ "$json_input_provided" -eq 0 ] || [ "$json_model_name" = "Claude" ]; then
    # JSON not provided or empty - fall through to Layer 2
    json_model_name=""
fi

# Layer 2: Transcript fallback (ONLY if JSON missing, WITH TTL)
# Transcript is session-specific and may be more current than JSON input
transcript_model=""
if [ -z "$json_model_name" ] && [ -n "$transcript_path" ] && [ -f "$transcript_path" ] && command -v jq >/dev/null 2>&1; then
    # Check TTL: Only use transcript if file modified <1 hour ago
    transcript_age=$(($(date +%s) - $(stat -f %m "$transcript_path" 2>/dev/null || stat -c %Y "$transcript_path" 2>/dev/null || echo 0)))
    TRANSCRIPT_TTL=3600  # 1 hour

    if [ "$transcript_age" -lt "$TRANSCRIPT_TTL" ]; then
        transcript_model_id=""

        # Get model from last assistant message in transcript
        transcript_model_id=$(timeout 2 tail -1 "$transcript_path" 2>/dev/null | jq -r '.message.model // ""' 2>/dev/null)

        # If last line not assistant, search recent lines
        if [ -z "$transcript_model_id" ] || [ "$transcript_model_id" = "null" ]; then
            transcript_model_id=$(timeout 2 bash -c "tail -50 '$transcript_path' 2>/dev/null | grep '\"type\": \"assistant\"' | tail -1" 2>/dev/null | jq -r '.message.model // ""' 2>/dev/null)
        fi

        # Map model ID to display name
        if [ -n "$transcript_model_id" ] && [ "$transcript_model_id" != "null" ]; then
            case "$transcript_model_id" in
                *"opus-4-5"*) transcript_model="Opus4.5" ;;
                *"opus"*) transcript_model="Opus" ;;
                *"sonnet-4-5"*) transcript_model="Sonnet4.5" ;;
                *"sonnet"*) transcript_model="Sonnet" ;;
                *"haiku-4-5"*) transcript_model="Haiku4.5" ;;
                *"haiku"*) transcript_model="Haiku" ;;
                *) transcript_model="" ;;
            esac
        fi
    fi
fi

# Determine final model using correct priority
model_name=""
model_id=""

# Priority 1: JSON input (if provided and real model data)
if [ -n "$json_model_name" ] && [ "$json_model_name" != "Claude" ]; then
    model_name="$json_model_name"
    model_id=$(echo "$input" | jq -r '.model.id // ""' 2>/dev/null)
# Priority 2: Transcript fallback (if fresh)
elif [ -n "$transcript_model" ]; then
    model_name="$transcript_model"
    model_id=""
# Priority 3: Default
else
    model_name="Claude"
    model_id=""
fi

# Detect model changes for cache invalidation
MODEL_CHANGED=0
if [ -n "$last_model_name" ] && [ "$last_model_name" != "$model_name" ]; then
    MODEL_CHANGED=1
    rm -f "$GIT_CACHE_FILE" 2>/dev/null || true
fi

# Save current model for next invocation
echo "$model_name" >"$SAVED_MODEL_FILE" 2>/dev/null || true

# ========================================
# PHASE 5: AIGILE Integration
# ========================================
aigile_project=""
aigile_sprint=""
aigile_task=""

# Check for .aigile directory
project_path=$(echo "$project_dir" | sed "s|~|$HOME|g")
[ -z "$project_path" ] && project_path=$(echo "$current_dir" | sed "s|~|$HOME|g")

if [ -d "$project_path/.aigile" ]; then
    aigile_project="📋" # Project indicator

    # Try to parse metadata.json for more info
    if [ -f "$project_path/.aigile/metadata.json" ] && command -v jq >/dev/null 2>&1; then
        proj_name=$(jq -r '.name // ""' "$project_path/.aigile/metadata.json" 2>/dev/null)
        [ -n "$proj_name" ] && aigile_project="📋 ${proj_name}"
    fi

    # Check for active sprint
    if [ -f "$project_path/.aigile/current-sprint.json" ] && command -v jq >/dev/null 2>&1; then
        sprint_id=$(jq -r '.id // ""' "$project_path/.aigile/current-sprint.json" 2>/dev/null)
        [ -n "$sprint_id" ] && aigile_sprint="🏃 ${sprint_id}"
    fi

    # Check for active task
    if [ -f "$project_path/.aigile/current-task.json" ] && command -v jq >/dev/null 2>&1; then
        task_id=$(jq -r '.id // ""' "$project_path/.aigile/current-task.json" 2>/dev/null)
        [ -n "$task_id" ] && aigile_task="📌 ${task_id}"
    fi
fi

# ========================================
# PHASE 6: MCP Server Status
# ========================================
mcp_count=0

if [ -f "$HOME/.claude/settings.json" ] && command -v jq >/dev/null 2>&1; then
    mcp_count=$(jq -r '.mcpServers | length // 0' "$HOME/.claude/settings.json" 2>/dev/null || echo 0)
    mcp_count=$(num_or_zero "$mcp_count")
fi

# ========================================
# Context Window Calculation (Modernized)
# ========================================
# Autocompact buffer is 22.5% of context window (45k of 200k)
AUTOCOMPACT_BUFFER_PCT=22
COMPACT_THRESHOLD_PCT=$((100 - AUTOCOMPACT_BUFFER_PCT)) # 78% = where compact triggers

context_used_pct=0
context_remaining_pct=100
tokens_until_compact=0
compact_distance_pct=100
context_color_fn="context_color_good"

context_window_size=$(num_or_zero "$context_window_size")

# Debug: Log what we're using
if [ "$DEBUG" -eq 1 ]; then
    {
        echo "[DEBUG] Context window calculation:"
        echo "  json_input_provided: $json_input_provided"
        echo "  context_window_size: $context_window_size"
        echo "  current_input: $current_input"
        echo "  cache_read: $cache_read"
        echo "  total_input_tokens: $total_input_tokens (not used)"
    } >>"$LOG_FILE" 2>/dev/null
fi

# Use current_usage fields (NOT total_input_tokens which is cumulative and never resets)
# current_input + cache_read = actual tokens in context window (resets after /compact)
current_context_tokens=$((current_input + cache_read))

if [ "$context_window_size" -gt 0 ]; then
    # Calculate used percentage based on CURRENT context (not cumulative session)
    if [ "$current_context_tokens" -gt 0 ]; then
        context_used_pct=$((current_context_tokens * 100 / context_window_size))
    fi
    context_remaining_pct=$((100 - context_used_pct))

    # Calculate tokens until compact (usable = 78% of window)
    usable_tokens=$((context_window_size * COMPACT_THRESHOLD_PCT / 100))
    tokens_until_compact=$((usable_tokens - current_context_tokens))
    ((tokens_until_compact < 0)) && tokens_until_compact=0

    # Debug: Log calculation
    if [ "$DEBUG" -eq 1 ]; then
        {
            echo "  current_context_tokens: $current_context_tokens"
            echo "  context_used_pct: $context_used_pct%"
            echo "  usable_tokens (78%): $usable_tokens"
            echo "  tokens_until_compact: $tokens_until_compact"
        } >>"$LOG_FILE" 2>/dev/null
    fi

    # Calculate distance to compact threshold as percentage
    if [ "$usable_tokens" -gt 0 ]; then
        compact_distance_pct=$((tokens_until_compact * 100 / usable_tokens))
    fi

    # Clamp values
    ((context_used_pct < 0)) && context_used_pct=0
    ((context_used_pct > 100)) && context_used_pct=100
    ((context_remaining_pct < 0)) && context_remaining_pct=0
    ((context_remaining_pct > 100)) && context_remaining_pct=100

    # Set color based on distance to COMPACT (not remaining)
    if [ "$compact_distance_pct" -le 5 ]; then
        context_color_fn="context_color_crit" # red - imminent
    elif [ "$compact_distance_pct" -le 20 ]; then
        context_color_fn="context_color_warn" # yellow - approaching
    fi
fi

# Format tokens for display (k notation)
format_tokens() {
    local tok="$1"
    if [ "$tok" -ge 1000 ]; then
        printf '%dk' $((tok / 1000))
    else
        printf '%d' "$tok"
    fi
}

# Smooth noisy metrics to reduce statusline flicker during active processing
# When Claude is working, tokens and cache ratios change rapidly
# This function rounds to reduce noise while keeping display responsive
smooth_tokens() {
    local tok="$1"
    # Round to nearest 100 tokens (ignores small fluctuations)
    printf '%d' $(( (tok + 50) / 100 * 100 ))
}

smooth_tpm() {
    local tpm="$1"
    # Round to nearest 10 TPM (ignores processing jitter)
    local int_tpm=${tpm%.*}  # Get integer part
    printf '%d' $(( (int_tpm + 5) / 10 * 10 ))
}

smooth_cache_ratio() {
    local pct="$1"
    # Round to nearest 5% (only show meaningful changes)
    printf '%d' $(( (pct + 2) / 5 * 5 ))
}

# Compact format for large numbers (with M, k, for display)
format_compact_number() {
    local num="$1"
    # Handle both integers and floats
    if (( $(echo "$num >= 1000000" | bc -l 2>/dev/null || echo 0) )); then
        printf '%.1fM' "$(echo "scale=1; $num / 1000000" | bc -l 2>/dev/null || echo $((${num%.*} / 1000000)))"
    elif (( $(echo "$num >= 1000" | bc -l 2>/dev/null || echo 0) )); then
        printf '%.0fk' "$(echo "scale=0; $num / 1000" | bc -l 2>/dev/null || echo $((${num%.*} / 1000)))"
    else
        printf '%.0f' "$num"
    fi
}

# ========================================
# Session file for last prompt tracking
# ========================================
session_file=""
if [ -n "$session_id" ] && [ -n "$current_dir" ]; then
    proj_path=$(echo "$current_dir" | sed "s|~|$HOME|g" | sed 's|/|-|g' | sed 's|\.|-|g' | sed 's|_|-|g' | sed 's|^-||')
    session_file="$HOME/.claude/projects/-${proj_path}/${session_id}.jsonl"
fi

# ========================================
# Last Prompt Tracking (OPTIMIZED)
# ========================================
last_prompt=""
last_prompt_time=""

if [ -n "$session_file" ] && [ -f "$session_file" ] && [ -s "$session_file" ] && command -v jq >/dev/null 2>&1; then
    # OPTIMIZATION: Reduced from tail -200 to -50 (only need last user message)
    # SAFETY: Add 2s timeout to jq to prevent hanging on malformed JSONL
    last_msg=$(timeout 2 bash -c "tail -50 '$session_file' | jq -c 'select(.type == \"user\" and (.message.content | type) == \"string\") | {timestamp: .timestamp, text: .message.content}' 2>/dev/null | tail -1" 2>/dev/null)

    if [ -n "$last_msg" ]; then
        raw_text=$(echo "$last_msg" | jq -r '.text' 2>/dev/null)

        if echo "$raw_text" | grep -q "<local-command-stdout>"; then
            if echo "$raw_text" | grep -q "<command-name>"; then
                command_name=$(echo "$raw_text" | sed -n 's/.*<command-name>\(.*\)<\/command-name>.*/\1/p')
                last_prompt_text="[Local command: /${command_name}]"
            else
                last_prompt_text="[Local command executed]"
            fi
        else
            last_prompt_text=$(echo "$raw_text" | sed 's/<[^>]*>//g' | sed 's/^ *//;s/ *$//' | tr '\n' ' ')
            # Truncate to 60 chars with ellipsis if longer
            if [ ${#last_prompt_text} -gt 60 ]; then
                last_prompt_text="${last_prompt_text:0:60}..."
            fi
        fi

        last_prompt_ts=$(echo "$last_msg" | jq -r '.timestamp' 2>/dev/null)

        if [ -n "$last_prompt_ts" ] && [ "$last_prompt_ts" != "null" ]; then
            last_epoch=$(to_epoch "$last_prompt_ts")
            now_epoch=$(date +%s)

            if [ -n "$last_epoch" ] && [ "$last_epoch" -gt 0 ]; then
                elapsed=$((now_epoch - last_epoch))

                # Show ACTUAL TIMESTAMP + ELAPSED TIME
                # Format: 14:30(2h43m) = message sent at 14:30, and it's been 2h43m since
                # This shows: WHEN the message was sent AND HOW LONG AGO (for context on chat duration)
                actual_time=$(fmt_time_hm "$last_epoch")

                # Format elapsed time
                if [ "$elapsed" -lt 60 ]; then
                    elapsed_str="${elapsed}s"
                elif [ "$elapsed" -lt 3600 ]; then
                    elapsed_str="$((elapsed / 60))m"
                elif [ "$elapsed" -lt 86400 ]; then
                    hours=$((elapsed / 3600))
                    mins=$(((elapsed % 3600) / 60))
                    elapsed_str="${hours}h${mins}m"
                else
                    elapsed_str="$((elapsed / 86400))d"
                fi

                last_prompt_time="${actual_time}(${elapsed_str})"

                # Color based on recency (how long AGO the message was sent)
                if [ "$elapsed" -lt 300 ]; then
                    prompt_color_code='38;5;156' # light green (recent: <5min)
                elif [ "$elapsed" -lt 1800 ]; then
                    prompt_color_code='38;5;228' # light yellow (medium: <30min)
                else
                    prompt_color_code='38;5;245' # gray (old: >30min)
                fi

                if [ -n "$last_prompt_text" ]; then
                    # Color only the emoji & timestamp (won't wrap), leave text in default color
                    # This prevents color from being lost when text wraps to next line
                    # Follow standard format: emoji:data (no spaces)
                    # Display: 💬:HH:MM (actual time message was sent, not elapsed)
                    last_prompt="$(C $prompt_color_code)💬:${last_prompt_time}$(rst) ${last_prompt_text}"
                fi
            fi
        fi
    fi
fi

# ========================================
# ccusage Integration (KEPT from original)
# ========================================
session_txt=""
session_pct=0
session_bar=""
cost_usd=""
cost_per_hour=""
current_week_cost=""
tpm=""
tot_tokens=""

CCUSAGE_CMD=""
if [ -x "/opt/homebrew/bin/ccusage" ]; then
    CCUSAGE_CMD="/opt/homebrew/bin/ccusage"
elif [ -x "/Users/vmks/.nvm/versions/node/system/bin/ccusage" ]; then
    CCUSAGE_CMD="/Users/vmks/.nvm/versions/node/system/bin/ccusage"
elif command -v ccusage >/dev/null 2>&1; then
    CCUSAGE_CMD="ccusage"
fi

# ccusage caching (prevents delay on every statusline update)
CCUSAGE_CACHE_FILE="${HOME}/.claude/.ccusage_cache.json"
CCUSAGE_CACHE_TTL=900 # Cache for 15 minutes (was 3600s/1h - too stale for spending data)

# Data freshness tracking (new feature)
DATA_FRESHNESS_FILE="${HOME}/.claude/.data_freshness.json"

# Function to record when data was fetched
record_fetch_time() {
    local data_type="$1"  # e.g., "ccusage_blocks", "git_status", "last_prompt"
    local timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

    # Read existing freshness file or create empty object
    local current_json="{}"
    if [ -f "$DATA_FRESHNESS_FILE" ]; then
        current_json=$(cat "$DATA_FRESHNESS_FILE" 2>/dev/null)
        # Validate JSON
        if ! echo "$current_json" | jq . >/dev/null 2>&1; then
            current_json="{}"
        fi
    fi

    # Add/update timestamp for this data type
    updated_json=$(echo "$current_json" | jq --arg type "$data_type" --arg time "$timestamp" '.[$type]=$time' 2>/dev/null)

    # Atomic write
    if [ -n "$updated_json" ]; then
        echo "$updated_json" > "${DATA_FRESHNESS_FILE}.tmp.$$" 2>/dev/null && \
        mv "${DATA_FRESHNESS_FILE}.tmp.$$" "$DATA_FRESHNESS_FILE" 2>/dev/null || true
    fi
}

# Function to calculate staleness indicator
calculate_data_indicator() {
    local data_type="$1"  # e.g., "ccusage_blocks"

    if [ ! -f "$DATA_FRESHNESS_FILE" ]; then
        return 0  # No freshness data yet
    fi

    local last_fetch=$(jq -r ".\"$data_type\" // empty" "$DATA_FRESHNESS_FILE" 2>/dev/null)
    if [ -z "$last_fetch" ]; then
        return 0  # Never fetched
    fi

    local now_epoch=$(date +%s)
    local fetch_epoch=$(to_epoch "$last_fetch")

    if [ -z "$fetch_epoch" ] || [ "$fetch_epoch" -le 0 ]; then
        return 0  # Failed to parse
    fi

    local age_seconds=$((now_epoch - fetch_epoch))

    # Return exit code to indicate staleness (0=fresh, 1=orange/loading, 2=red/stale)
    if [ $age_seconds -gt 3600 ]; then
        return 2  # 🔴 Red - stale >1 hour
    fi
    return 0  # No indicator needed
}

if command -v jq >/dev/null 2>&1 && [ -n "$CCUSAGE_CMD" ]; then
    blocks_output=""

    # Check if cache exists and validate freshness
    use_cache=0
    if [ -f "$CCUSAGE_CACHE_FILE" ]; then
        # Validate cache is from today (not stale from yesterday) AND block hasn't ended
        cached_data=$(cat "$CCUSAGE_CACHE_FILE" 2>/dev/null)
        active_block_in_cache=$(echo "$cached_data" | jq -c '.blocks[] | select(.isActive == true)' 2>/dev/null | head -n1)

        if [ -n "$active_block_in_cache" ]; then
            # Extract startTime from cached block
            cached_start=$(echo "$active_block_in_cache" | jq -r '.startTime // ""' 2>/dev/null)
            today_date=$(date -u '+%Y-%m-%d')

            # Only use cache if:
            # 1. Block started today (not yesterday)
            # 2. Block hasn't actually ended yet (check actualEndTime)
            block_is_fresh=0
            if [[ "$cached_start" == *"$today_date"* ]]; then
                # Double-check: has the block actually ended?
                actual_end=$(echo "$active_block_in_cache" | jq -r '.actualEndTime // empty' 2>/dev/null)
                if [ -n "$actual_end" ] && [ "$actual_end" != "null" ]; then
                    actual_end_sec=$(to_epoch "$actual_end")
                    now_sec=$(date +%s)
                    # If block ended more than 5 minutes ago, don't use cache - need fresh data
                    if [ -n "$actual_end_sec" ] && [ "$actual_end_sec" -gt 0 ]; then
                        if [ "$now_sec" -le $((actual_end_sec + 300)) ]; then
                            block_is_fresh=1
                        fi
                    else
                        # No actualEndTime, assume fresh
                        block_is_fresh=1
                    fi
                else
                    # No actualEndTime means still active, use cache
                    block_is_fresh=1
                fi
            fi

            if [ "$block_is_fresh" -eq 1 ]; then
                blocks_output="$cached_data"
                use_cache=1
            fi
        fi
    fi

    # Fetch fresh data if cache missing, stale, or invalid
    # Use 20s timeout to allow ccusage to complete (it takes ~19-20s)
    # NOTE: This only triggers when cache is stale (from previous day)
    # Most of the time cache will be from today (fast path)
    if [ "$use_cache" -eq 0 ]; then
        blocks_output=$(timeout 20 "$CCUSAGE_CMD" blocks --json 2>/dev/null)
        if [ -n "$blocks_output" ]; then
            write_cache "$CCUSAGE_CACHE_FILE" "$blocks_output"
            record_fetch_time "ccusage_blocks"
        fi
    fi

    if [ -n "$blocks_output" ]; then
        active_block=$(echo "$blocks_output" | jq -c '.blocks[] | select(.isActive == true)' 2>/dev/null | head -n1)

        if [ -n "$active_block" ]; then
            # DEFENSIVE: Extract all fields with null validation
            cost_usd=$(echo "$active_block" | jq -r '.costUSD // empty' 2>/dev/null)
            [ "$cost_usd" = "null" ] && cost_usd=""

            # Validate burnRate exists before accessing nested fields
            burn_rate=$(echo "$active_block" | jq -r '.burnRate // empty' 2>/dev/null)
            if [ -n "$burn_rate" ] && [ "$burn_rate" != "null" ]; then
                cost_per_hour=$(echo "$active_block" | jq -r '.burnRate.costPerHour // empty' 2>/dev/null)
                [ "$cost_per_hour" = "null" ] && cost_per_hour=""
                tpm=$(echo "$active_block" | jq -r '.burnRate.tokensPerMinute // empty' 2>/dev/null)
                [ "$tpm" = "null" ] && tpm=""
            else
                cost_per_hour=""
                tpm=""
            fi

            tot_tokens=$(echo "$active_block" | jq -r '.totalTokens // empty' 2>/dev/null)
            [ "$tot_tokens" = "null" ] && tot_tokens=""

            reset_time_str=$(echo "$active_block" | jq -r '.usageLimitResetTime // .endTime // empty' 2>/dev/null)
            [ "$reset_time_str" = "null" ] && reset_time_str=""

            start_time_str=$(echo "$active_block" | jq -r '.startTime // empty' 2>/dev/null)
            [ "$start_time_str" = "null" ] && start_time_str=""

            if [ -n "$reset_time_str" ] && [ -n "$start_time_str" ]; then
                start_sec=$(to_epoch "$start_time_str")
                end_sec=$(to_epoch "$reset_time_str")
                now_sec=$(date +%s)
                total=$((end_sec - start_sec))
                ((total < 1)) && total=1
                elapsed=$((now_sec - start_sec))
                ((elapsed < 0)) && elapsed=0
                ((elapsed > total)) && elapsed=$total
                session_pct=$((elapsed * 100 / total))
                remaining=$((end_sec - now_sec))
                ((remaining < 0)) && remaining=0
                rh=$((remaining / 3600))
                rm=$(((remaining % 3600) / 60))
                end_hm=$(fmt_time_hm "$end_sec")

                # Base format: Xh Xm(XX%)HH:MM
                session_txt="$(printf '%dh%dm(%d%%)%s' "$rh" "$rm" "$session_pct" "$end_hm")"

                session_bar=$(progress_bar "$session_pct" 10)
            fi
        fi
    fi
fi

# ========================================
# WEEKLY QUOTA CACHE (Legacy - not used in display)
# ========================================
# Kept for potential future use, but weekly aggregation is stale/unreliable
# Weekly consumption is shown per-session in ccusage, not accumulated here
WEEKLY_QUOTA_CACHE="${HOME}/.claude/.weekly_quota_cache.json"
WEEKLY_QUOTA_TTL=1800  # 30 minutes (reduced from 2h for potential future use)
weekly_quota_pct=""

if [ -n "$CCUSAGE_CMD" ] && command -v jq >/dev/null 2>&1; then
    # Check if cache exists and validate it has current week data
    use_weekly_cache=0
    if [ -f "$WEEKLY_QUOTA_CACHE" ]; then
        cached_weekly=$(cat "$WEEKLY_QUOTA_CACHE" 2>/dev/null)

        # Validate cache has weekly data with recent entries
        if [ -n "$cached_weekly" ]; then
            latest_week=$(echo "$cached_weekly" | jq -r '.weekly[-1].week // ""' 2>/dev/null)
            # Simple check: if latest week in cache is within last 7 days, use it
            if [ -n "$latest_week" ]; then
                use_weekly_cache=1
            fi
        fi
    fi

    # Only fetch fresh data if cache missing or invalid
    # Use 20s timeout to allow ccusage to complete (it takes ~19-20s)
    if [ "$use_weekly_cache" -eq 0 ]; then
        cached_weekly=$(timeout 20 "$CCUSAGE_CMD" weekly --json 2>/dev/null)
        if [ -n "$cached_weekly" ]; then
            write_cache "$WEEKLY_QUOTA_CACHE" "$cached_weekly"
        fi
    fi

    # Parse current week's cost and calculate quota percentage
    if [ -n "$cached_weekly" ]; then
        # Extract most recent week's total cost (last entry in array)
        # DEFENSIVE: Validate array structure exists
        array_len=$(echo "$cached_weekly" | jq -r '.weekly | length // 0' 2>/dev/null)
        if [ "$array_len" -gt 0 ]; then
            current_week_cost=$(echo "$cached_weekly" | jq -r '.weekly[-1].totalCost // empty' 2>/dev/null)
            [ "$current_week_cost" = "null" ] && current_week_cost=""

            if [ -n "$current_week_cost" ] && [ "$current_week_cost" != "0" ] && [[ "$current_week_cost" =~ ^[0-9.]+$ ]]; then
                # Calculate percentage using WEEKLY_BUDGET set at top of script
                weekly_quota_pct=$(echo "scale=0; $current_week_cost * 100 / $WEEKLY_BUDGET" | bc 2>/dev/null || echo "0")
                # Cap display at 999% to avoid cluttering the statusline
                ((weekly_quota_pct > 999)) && weekly_quota_pct="999"
            fi
        fi
    fi
fi

# NOTE: Session display now shows only: Xh Xm(XX%)HH:MM
# Weekly/daily quota percentages don't belong here - they're shown in cost display

# Session color based on remaining time
session_color() {
    rem_pct=$((100 - session_pct))
    if ((rem_pct <= 10)); then
        SCLR='38;5;210'
    elif ((rem_pct <= 25)); then
        SCLR='38;5;228'
    else SCLR='38;5;194'; fi
    C "$SCLR"
}

# ========================================
# DEFENSIVE INITIALIZATION (RESILIENCE)
# ========================================
# Ensure all variables have sensible values even if data fetching failed
# This prevents datapoints from randomly disappearing
#

# Session info fallback
[ -z "$session_txt" ] && session_txt=""

# Financial data fallback
[ -z "$cost_usd" ] && cost_usd=""
[ -z "$cost_per_hour" ] && cost_per_hour=""
[ -z "$weekly_quota_pct" ] && weekly_quota_pct=""

# Usage metrics fallback
[ -z "$tot_tokens" ] && tot_tokens=""
[ -z "$tpm" ] && tpm=""

# Conversation metrics fallback
[ -z "$transcript_turns" ] && transcript_turns=0
[ -z "$session_velocity" ] && session_velocity=""
[ -z "$response_efficiency" ] && response_efficiency=""

# Cache metrics fallback
[ -z "$cache_hit_ratio" ] && cache_hit_ratio=""

# Last prompt fallback
[ -z "$last_prompt" ] && last_prompt=""

# ========================================
# Debug logging
# ========================================
if [ "$DEBUG" = "1" ]; then
    {
        echo "[$TIMESTAMP] Parsed: dir=${current_dir:-}, proj=${project_dir:-}, model=${model_name:-}, git=${git_status:-}"
        echo "[$TIMESTAMP] Context: size=${context_window_size:-}, used=${total_input_tokens:-}, remaining=${context_pct:-}"
        echo "[$TIMESTAMP] Cache: read=${cache_read:-}, creation=${cache_creation:-}, ratio=${cache_hit_ratio:-}"
        echo "[$TIMESTAMP] AIGILE: project=${aigile_project:-}, sprint=${aigile_sprint:-}, task=${aigile_task:-}"
        echo "[$TIMESTAMP] MCP: count=${mcp_count:-}"
    } >>"$LOG_FILE" 2>/dev/null
fi

# ========================================
# BUILD STATUSLINE (ANTI-FLICKER: Build all output, print once)
# ========================================

# === SINGLE LINE WITH COLONS ===
# Separator between data points (single space for compactness)
SEP=" "
COLON=":"

# START BUILDING OUTPUT IN NEW ORDER:
# 1. System Core (directory, git, model, version)
# 2. Context & Time (tokens left, current time)
# 3. Session info (reset time)
# 4. Financial (cost)
# 5. Usage (tokens, turns, velocity, efficiency)
# 6. Health (cache)
# 7. Last message

# Start with directory
OUTPUT="📁${COLON}$(dir_color)${current_dir}$(rst)"

# Project dir indicator if different
if [ -n "$project_dir" ] && [ "$project_dir" != "$current_dir" ]; then
    OUTPUT="${OUTPUT}${SEP}(proj${COLON}$(dir_color)$(basename "$project_dir")$(rst))"
fi

# Git status
if [ -n "$git_status" ]; then
    OUTPUT="${OUTPUT}${SEP}🌿${COLON}$(git_color)${git_status}$(rst)"
fi

# Model
OUTPUT="${OUTPUT}${SEP}🤖${COLON}$(model_color)${model_name}$(rst)"

# CC version
if [ -n "$cc_version" ] && [ "$cc_version" != "null" ]; then
    OUTPUT="${OUTPUT}${SEP}📟${COLON}$(cc_version_color)v${cc_version}$(rst)"
fi

# Output style (removed per user preference)
# AIGILE indicator (removed per user preference)

# === 2. CONTEXT & TIME ===
# Context with compact threshold marker
# Bar shows: [====|-----] where | is the compact threshold (78%)
if [ "$context_window_size" -gt 0 ]; then
    context_bar=$(progress_bar_with_marker "$context_used_pct" "$COMPACT_THRESHOLD_PCT" 12)
    # Smooth tokens to reduce flicker during active processing (Claude working)
    smoothed_tokens=$(smooth_tokens "$tokens_until_compact")
    tokens_display=$(format_tokens "$smoothed_tokens")

    # Debug: Log display values
    if [ "$DEBUG" -eq 1 ]; then
        {
            echo "  smoothed_tokens: $smoothed_tokens (before: $tokens_until_compact)"
            echo "  tokens_display: ${tokens_display}left"
            echo "  context_bar: [${context_bar}]"
        } >>"$LOG_FILE" 2>/dev/null
    fi

    # Show remaining tokens left (more useful than "used %")
    if [ "$tokens_until_compact" -gt 0 ]; then
        OUTPUT="${OUTPUT}${SEP}🧠${COLON}$($context_color_fn)${tokens_display}left$(rst) [${context_bar}]"
    else
        OUTPUT="${OUTPUT}${SEP}🧠${COLON}$(context_color_crit)COMPACT!$(rst) [${context_bar}]"
    fi
else
    OUTPUT="${OUTPUT}${SEP}🧠${COLON}$(context_color_good)Context:calculating...$(rst)"
fi

# Current statusline run time (shows when this statusline executed)
# Display: HH:MM (clean format without seconds)
# For hash: Only use HH:MM (prevents redraw every second even when output unchanged)
current_statusline_time_display=$(date '+%H:%M')
current_statusline_time_hash=$(date '+%H:%M')  # Use same as display (no seconds) to prevent constant redraws
OUTPUT="${OUTPUT}${SEP}🕐${COLON}${current_statusline_time_display}"

# === 3. SESSION INFO ===
# Session time remaining with reset time
if [ -n "$session_txt" ]; then
    # Add staleness indicator for ccusage data
    staleness_indicator=""
    calculate_data_indicator "ccusage_blocks"
    staleness_code=$?
    if [ $staleness_code -eq 2 ]; then
        staleness_indicator="🔴"  # Red - stale >1 hour
    fi
    OUTPUT="${OUTPUT}${SEP}⌛${COLON}$(session_color)${session_txt}${staleness_indicator}$(rst)"
fi

# === 4. FINANCIAL ===
# Consolidated cost display: daily | hourly
# Format: 💰:$7.2|$18.7/h (with 1 decimal precision)
# NOTE: Removed /w (weekly) - it shows stale aggregated data from previous weeks
if [ -n "$cost_usd" ] && [[ "$cost_usd" =~ ^[0-9.]+$ ]]; then
    cost_display="\$$(printf '%.1f' "$cost_usd")"

    if [ -n "$cost_per_hour" ] && [[ "$cost_per_hour" =~ ^[0-9.]+$ ]]; then
        cost_display="${cost_display}|\$$(printf '%.1f' "$cost_per_hour")/h"
    fi

    # Add staleness indicator for cost data
    cost_staleness_indicator=""
    calculate_data_indicator "ccusage_blocks"
    cost_staleness_code=$?
    if [ $cost_staleness_code -eq 2 ]; then
        cost_staleness_indicator="🔴"  # Red - stale >1 hour
    fi

    OUTPUT="${OUTPUT}${SEP}💰${COLON}$(cost_color)${cost_display}${cost_staleness_indicator}$(rst)"
fi

# === 5. USAGE METRICS ===
if [ -n "$tot_tokens" ] && [[ "$tot_tokens" =~ ^[0-9]+$ ]]; then
    tok_compact=$(format_compact_number "$tot_tokens")

    # Add staleness indicator for token data
    tok_staleness_indicator=""
    calculate_data_indicator "ccusage_blocks"
    tok_staleness_code=$?
    if [ $tok_staleness_code -eq 2 ]; then
        tok_staleness_indicator="🔴"  # Red - stale >1 hour
    fi

    tok_str="📊${COLON}$(usage_color)${tok_compact}tok${tok_staleness_indicator}$(rst)"
    if [ -n "$tpm" ] && [[ "$tpm" =~ ^[0-9.]+$ ]]; then
        # Smooth TPM to reduce flicker during active processing
        smoothed_tpm=$(smooth_tpm "$tpm")
        tpm_compact=$(format_compact_number "$smoothed_tpm")
        tok_str="📊${COLON}$(usage_color)${tok_compact}tok(${tpm_compact}tpm)${tok_staleness_indicator}$(rst)"
    fi
    OUTPUT="${OUTPUT}${SEP}$tok_str"
fi

# Conversation metrics (turns, velocity, efficiency)
if [ "$transcript_turns" -gt 0 ]; then
    OUTPUT="${OUTPUT}${SEP}$(C '38;5;189')💬${COLON}${transcript_turns}t$(rst)"

    if [ -n "$session_velocity" ]; then
        OUTPUT="${OUTPUT}${SEP}$(C '38;5;189')🚀${COLON}${session_velocity}$(rst)"
    fi

    if [ -n "$response_efficiency" ]; then
        OUTPUT="${OUTPUT}${SEP}$(C '38;5;189')📈${COLON}${response_efficiency}$(rst)"
    fi
fi

# === 6. HEALTH ===
# Cache metrics (before last message)
if [ -n "$cache_hit_ratio" ]; then
    # Smooth cache ratio to reduce flicker (extract percentage, smooth, reformat)
    cache_pct="${cache_hit_ratio%\%}"  # Remove % sign
    if [[ "$cache_pct" =~ ^[0-9]+$ ]]; then
        smoothed_cache=$(smooth_cache_ratio "$cache_pct")
        smoothed_cache_display="${smoothed_cache}%"
        OUTPUT="${OUTPUT}${SEP}💾${COLON}$(cache_color)${smoothed_cache_display}$(rst)"
    else
        OUTPUT="${OUTPUT}${SEP}💾${COLON}$(cache_color)${cache_hit_ratio}$(rst)"
    fi
fi

# === 7. LAST MESSAGE ===
# Last prompt (cache hit ratio before this)
if [ -n "$last_prompt" ]; then
    OUTPUT="${OUTPUT}${SEP}${last_prompt}"
fi

# ========================================
# === ATOMIC OUTPUT WITH DEDUPLICATION (ANTI-FLICKER FIX) ===
# Output is fully assembled above in order:
# 1. System core (dir, git, model, version)
# 2. Context & time (tokens left, current time)
# 3. Session (reset time)
# 4. Financial (cost)
# 5. Usage (tokens, turns, velocity, efficiency)
# 6. Health (cache)
# 7. Last message
#
# DEDUPLICATION: Only print if output has changed
# This prevents terminal redraws when statusline content is identical
# ========================================

LAST_OUTPUT_HASH_FILE="${HOME}/.claude/.statusline.hash"

# DEFENSIVE: Ensure OUTPUT is never completely empty
# If OUTPUT is empty, show minimal statusline with current time
if [ -z "$OUTPUT" ]; then
    OUTPUT="🕐:$(date '+%H:%M:%S') [statusline-error]"
fi

# Calculate hash of current output ONLY (no timestamp)
# CRITICAL: Do NOT include time in hash - time changes every minute
# This causes unnecessary redraws when only the display time updates
# Instead, only hash the actual DATA content
# Deduplication should only trigger when actual data changes, not when display updates
hash_input="${OUTPUT}"
current_hash=$(echo -n "$hash_input" | md5sum 2>/dev/null | awk '{print $1}' || \
              echo -n "$hash_input" | shasum 2>/dev/null | awk '{print $1}' || \
              echo -n "$hash_input" | wc -c)

# Read last hash and timestamp
last_hash=""
last_print_time=0
LAST_PRINT_TIME_FILE="${HOME}/.claude/.statusline.last_print_time"

if [ -f "$LAST_OUTPUT_HASH_FILE" ]; then
    last_hash=$(cat "$LAST_OUTPUT_HASH_FILE" 2>/dev/null)
fi

if [ -f "$LAST_PRINT_TIME_FILE" ]; then
    last_print_time=$(cat "$LAST_PRINT_TIME_FILE" 2>/dev/null || echo 0)
fi

# Cross-platform millisecond time calculation
# macOS (BSD) doesn't support %N (nanoseconds), so use perl or fallback to seconds
if [[ "$OSTYPE" == "darwin"* ]]; then
    # macOS: Use perl for millisecond precision (Time::HiRes is built-in)
    current_time_ms=$(perl -MTime::HiRes=time -e 'printf "%.0f", time * 1000' 2>/dev/null || echo $(($(date +%s) * 1000)))
else
    # Linux: GNU date supports %3N for milliseconds
    current_time_ms=$(date +%s%3N 2>/dev/null || echo $(($(date +%s) * 1000)))
fi

# Rate limiting only applies to IDENTICAL output (deduplication)
# Changed output should ALWAYS print immediately
time_since_last_print=$((current_time_ms - last_print_time))
RATE_LIMIT_MS=500  # Minimum 500ms between identical prints

# Print decision logic:
# - Model changed: ALWAYS print (immediate feedback)
# - First run (no hash): ALWAYS print
# - Output changed (hash differs): ALWAYS print immediately
# - Output identical (hash same): Skip (deduplication)
# - Hash calculation failed: Print as fallback
should_print=0
if [ "$MODEL_CHANGED" -eq 1 ]; then
    should_print=1  # Model change: immediate feedback
elif [ -z "$last_hash" ]; then
    should_print=1  # First run: always print
elif [ -n "$current_hash" ] && [ -n "$last_hash" ] && [ "$current_hash" != "$last_hash" ]; then
    should_print=1  # Output changed: ALWAYS print immediately (no rate limit)
# When hashes are identical, should_print stays 0 (correct deduplication)
elif [ -z "$current_hash" ]; then
    should_print=1  # Hash calculation failed: print as fallback
fi

# Print if should print
if [ "$should_print" -eq 1 ]; then
    printf '%b' "$OUTPUT"

    # Save current hash for next invocation (ignore errors)
    if [ -n "$current_hash" ]; then
        echo "$current_hash" >"$LAST_OUTPUT_HASH_FILE" 2>/dev/null || true
    fi

    # Save current time for rate limiting (ignore errors)
    echo "$current_time_ms" >"$LAST_PRINT_TIME_FILE" 2>/dev/null || true
fi
