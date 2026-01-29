# Statusline V2 - Product Requirements Document

**Version**: 2.0 Research & Validation Phase
**Date**: 2026-01-29
**Status**: Research & Investigation

---

## Mission

Build a **reliable, validated statusline** that pulls data from multiple sources, compares them, detects anomalies, and displays the most accurate information. Prioritize **data accuracy and stability** over speed.

---

## Core Principles

1. **Multi-source validation** - Never trust a single source
2. **Consensus-based truth** - Compare sources to find most accurate
3. **Instability detection** - Log when sources disagree
4. **Smart caching** - Each module decides its own TTL based on change frequency
5. **Observable behavior** - Log everything to understand patterns

---

## Data Points - Deep Dive

### 1. Directory (📁)

**What it represents**: Current working directory

**Sources**:
- `process.cwd()` - Where statusline script runs
- JSON input `start_directory` - Where Claude Code started
- `$PWD` environment variable

**When it changes**:
- User runs `cd` command
- Claude Code switches project context
- Rarely changes mid-session

**Requirements**:
- Should reflect WHERE Claude Code is actually working
- If `start_directory` ≠ `cwd`, which is correct?
- Consider showing both if different: `📁:start→current`

**Validation**:
- Compare all 3 sources
- Log when they disagree
- Determine which represents "where work is happening"

**Proposed Cache**: None (fast to compute)

**Open Questions**:
- Do we care about start directory vs current?
- Is showing current directory more useful?
- Should we warn if they differ?

---

### 2. Git Branch & Status (🌿)

**What it represents**: Current branch, ahead/behind commits, dirty files

**Sources**:
- `git status --porcelain --branch` - Current state
- `git symbolic-ref --short HEAD` - Current branch name
- `.git/HEAD` file - Raw branch reference
- Git cache file (10s TTL in V1)

**When it changes**:
- User commits (dirty count changes)
- User switches branch
- User pushes/pulls (ahead/behind changes)
- User stages/unstages files

**Known Issues** (reported):
- "Sometimes pulls info from other branches" - BUG to investigate
- Cache might be showing stale branch after switch

**Requirements**:
- Must reflect CURRENT branch (not cached old branch)
- Must update within 10s of branch switch
- Dirty files count must be accurate

**Validation**:
- Compare `git status` vs `.git/HEAD` vs cache
- Log when branch from cache ≠ branch from git status
- Detect branch switches and invalidate cache

**Proposed Cache**: 10s TTL, invalidate on branch change detection

**Open Questions**:
- How to detect branch switch reliably?
- Should we check `.git/HEAD` mtime to detect changes?
- Is 10s TTL too long after branch switch?

---

### 3. Model (🤖)

**What it represents**: Currently active Claude model

**Sources (in priority order)**:
1. **Transcript last message** `.message.model` - Actual model from last API response
2. **JSON input** `model.display_name` - Current session config
3. **settings.json** `.model` - Global default (NOT current session)

**When it changes**:
- User switches model mid-session
- New session starts with different model

**Known Issues** (reported):
- "Only switches after first message comes in" - shows old model until new message
- Doesn't update immediately on model switch

**Requirements**:
- Should show CURRENT model user is talking to
- Should update immediately on switch (ideal) OR after first message (acceptable)
- Should NOT show stale model from previous session

**Validation**:
- Compare transcript vs JSON input vs settings
- Log when they disagree
- Understand when each source updates

**Proposed Cache**:
- Transcript data: 1 hour TTL OR until new message
- JSON input: Real-time (no cache)
- Prefer transcript if <1hr old, else JSON input

**Open Questions**:
- Can we detect model switch before first message?
- Is there a Claude Code API endpoint to get current model?
- Should we show "switching to X..." during transition?

---

### 4. Version (📟)

**What it represents**: Claude Code CLI version

**Sources**:
- `claude --version` command
- Package.json if accessible
- Cached value (version doesn't change often)

**When it changes**:
- User updates Claude Code (rare)

**Requirements**:
- Should be accurate
- Can cache for long time (hours or days)

**Validation**:
- Run `claude --version` once per day
- Cache result

**Proposed Cache**: 24 hours

**Open Questions**: None - straightforward

---

### 5. Context Window (🧠)

**What it represents**: Tokens until compaction (78% threshold)

**Sources**:
- JSON input: `context_window.context_window_size`, `current_input_tokens`, `cache_read_tokens`, `current_output_tokens`
- Transcript: Count messages and estimate tokens
- Model defaults: Known context sizes per model

**When it changes**:
- Every message (token count increases)
- Compaction happens (tokens reset)
- Model switches (window size changes)

**Known Issues** (reported):
- "Unstable - sometimes corresponds well, then switches to something else"
- V1 calculation might be wrong

**Requirements**:
- Must show accurate tokens until 78% threshold
- Must detect compaction and update immediately
- Must account for cache_read_tokens (not just input)

**Validation**:
- Log all token counts from JSON
- Compare calculated value vs actual compaction events
- Detect when calculation is off by >10%

**Proposed Cache**: Real-time (from JSON input, no cache needed)

**Open Questions**:
- What causes instability? Wrong formula or wrong source data?
- Should we log JSON token values to debug?
- Is 78% threshold always correct?

**Investigation Plan**:
```bash
# Log all context data for debugging
echo "Context Debug:" >> ~/.claude/context-debug.log
echo "Window: $window, Input: $input, Cache: $cache, Output: $output" >> ~/.claude/context-debug.log
echo "Calculated: $tokens_left, Threshold: $threshold" >> ~/.claude/context-debug.log
```

---

### 6. Time (🕐)

**What it represents**: Current time (HH:MM)

**Sources**:
- `new Date()` - System time

**When it changes**: Every minute

**Requirements**: Show current time

**Validation**: None needed (system time is source of truth)

**Proposed Cache**: None (always real-time)

**Open Questions**: None - trivial

---

### 7. CCUsage (💰 Cost, ⌛ Budget, 📊 Usage)

**What it represents**:
- Cost: Total spent today + burn rate
- Budget: Hours/minutes left until weekly budget exhausted
- Usage: Total tokens + rate

**Sources**:
- `ccusage blocks --json --active` - Current billing block
- `ccusage weekly --json` - Weekly totals
- Cached data (~/.claude/.ccusage_cache.json)
- Transcript: Estimate from conversation tokens (rough)

**When it changes**:
- Every API call (cost increases)
- Every message (tokens increase)
- UTC midnight (new billing block starts)
- Weekly reset (budget resets)

**Requirements**:
- Must be GLOBAL (same for all sessions)
- Can update slowly (every 1-2 minutes is fine)
- Must be accurate (±$0.10 acceptable)
- Must cache effectively (ccusage is slow ~20s)

**Validation**:
- Compare ccusage blocks vs weekly totals
- Verify cost calculation matches expected
- Detect if block has ended (stale data)

**Proposed Cache**:
- 2 minute TTL for active work
- 5 minute TTL for idle
- Invalidate at UTC midnight (new block starts)
- Invalidate if block ended >5 min ago

**Open Questions**:
- Is 2 min refresh too frequent? Too slow?
- Should we estimate cost from transcript between cache updates?
- How to detect "active work" vs "idle"?

---

### 8. Cache Hit Ratio (💾)

**What it represents**: Percentage of API calls using cached prompts

**Sources**:
- Transcript: Count messages with cache hits
- ccusage: Cache statistics if available
- Manual calculation from transcript data

**When it changes**:
- Every message (cache hit or miss)

**Known Issues** (reported):
- "Always 99-100%, only fluctuates when changing models"
- Might not be working correctly

**Requirements**:
- Should show real cache hit rate
- Should vary based on conversation pattern
- If always 99%, either broken or not useful

**Validation**:
- Manually verify: count messages with cache metadata
- Compare to ccusage cache stats
- Determine if metric is actually useful

**Proposed Cache**: Real-time calculation from recent messages

**Open Questions**:
- Is this metric useful if it's always high?
- Should we remove it if not providing value?
- How to calculate correctly from transcript?

**Investigation Plan**:
- Log cache hit/miss for each message
- Calculate over last 10 messages
- Compare to expected behavior

---

### 9. Last Message (💬)

**What it represents**: Time and preview of last message

**Sources**:
- Transcript: Last message in conversation history
- File mtime: When transcript was last modified

**When it changes**:
- Every message (both user and assistant)

**Known Issues** (reported):
- "Sometimes appears and disappears" - UNSTABLE
- Main reason for working on statusline

**Requirements**:
- Must be stable (not flicker)
- Must show most recent message consistently
- Must update on new messages

**Validation**:
- Check if transcript file exists
- Verify file is not empty
- Confirm parsing works correctly
- Detect when message is missing

**Proposed Cache**:
- 1 hour TTL OR until transcript mtime changes
- Invalidate if transcript modified
- Show cached value if file read fails (stability)

**Open Questions**:
- Why does it appear/disappear?
- Is transcript file sometimes empty?
- Is parsing failing silently?

**Investigation Plan**:
```bash
# Log last message parsing
echo "Last Message Debug:" >> ~/.claude/last-message-debug.log
echo "File exists: $exists, Size: $size bytes" >> ~/.claude/last-message-debug.log
echo "Parsed: $success, Content: $preview" >> ~/.claude/last-message-debug.log
```

---

### 10. Secrets Detection (NEW - 🔐)

**What it represents**: Warning if secrets detected in conversation

**Sources**:
- Transcript: Scan all messages for patterns
- Regex patterns: API keys, tokens, passwords, private keys

**When it changes**:
- When new message contains secrets
- Can check every 5 minutes

**Requirements**:
- Detect common secret patterns:
  - API keys: `sk-[a-zA-Z0-9]{32,}`
  - AWS keys: `AKIA[0-9A-Z]{16}`
  - Private keys: `-----BEGIN.*PRIVATE KEY-----`
  - Tokens: `ghp_[a-zA-Z0-9]{36}`, `xoxb-[a-zA-Z0-9-]+`
  - Passwords in code: `password.*=.*["'][^"']+["']`
- Show huge warning: `🔐 SECRETS EXPOSED!`
- Log what was detected (pattern, not actual secret)

**Validation**:
- Test with known secret patterns
- Ensure no false positives on normal text
- Verify warning is visible and urgent

**Proposed Cache**:
- Scan every 5 minutes
- Cache scan results
- Re-scan if transcript modified

**Patterns to Detect**:
```regex
# API Keys
sk-[a-zA-Z0-9]{20,}               # OpenAI/Anthropic
AKIA[0-9A-Z]{16}                  # AWS Access Key
[0-9]+-[a-zA-Z0-9]{32}\.apps\.    # Google OAuth

# Tokens
ghp_[a-zA-Z0-9]{36}               # GitHub Personal Access Token
xoxb-[a-zA-Z0-9-]+                # Slack Bot Token
glpat-[a-zA-Z0-9_-]{20,}          # GitLab Personal Access Token

# Private Keys
-----BEGIN.*PRIVATE KEY-----      # SSH/TLS Private Keys

# Connection Strings
postgres://.*:.*@                 # PostgreSQL
mongodb://.*:.*@                  # MongoDB
mysql://.*:.*@                    # MySQL

# Passwords in Code
password\s*=\s*["'][^"']{8,}["']  # password = "..."
api_key\s*=\s*["'][^"']{8,}["']   # api_key = "..."
```

---

## Multi-Source Validation Framework

### Goal

For each data point, compare all available sources and determine:
1. Which source is most accurate
2. When sources disagree
3. Patterns in disagreement
4. Source of truth selection logic

### Validation Logging

Create debug logs for each module:

```typescript
interface ValidationLog {
  timestamp: number;
  dataPoint: string;
  sources: {
    [sourceName: string]: {
      value: any;
      fetchTime: number;
      error?: string;
    };
  };
  consensus: {
    selected: string;      // Which source was used
    confidence: number;    // 0-100% confidence
    reason: string;        // Why this source was selected
  };
  disagreement?: {
    detected: boolean;
    details: string;
  };
}
```

**Log Location**: `~/.claude/statusline-validation.jsonl` (JSON lines)

### Validation Rules

Each module defines rules for source selection:

**Example - Model Module**:
```typescript
const sources = {
  transcript: getModelFromTranscript(),  // Last message model
  jsonInput: getModelFromJSON(),         // Session config
  settings: getModelFromSettings()       // Global default
};

// Validation logic
if (transcript && transcript.age < 3600) {
  // Transcript is fresh (<1 hour), highest confidence
  return { value: transcript.model, source: 'transcript', confidence: 95 };
} else if (jsonInput) {
  // JSON input is current session
  return { value: jsonInput.model, source: 'jsonInput', confidence: 80 };
} else if (settings) {
  // Settings is fallback
  return { value: settings.model, source: 'settings', confidence: 50 };
}

// Disagreement detection
if (transcript.model !== jsonInput.model) {
  logDisagreement('Model mismatch: transcript says X, JSON says Y');
}
```

---

## Investigation Plan

### Phase 1: Logging & Observation (Week 1)

**Goal**: Collect data to understand behavior

**Tasks**:
1. Implement validation logging for all modules
2. Run statusline normally for 1 week
3. Collect logs: `~/.claude/statusline-validation.jsonl`
4. Analyze patterns:
   - Which sources disagree most?
   - When do they disagree?
   - Which correlates best with user experience?

**Analysis**:
```bash
# Count disagreements per module
jq -r 'select(.disagreement.detected) | .dataPoint' \
  ~/.claude/statusline-validation.jsonl | sort | uniq -c

# Find model source switches
jq -r 'select(.dataPoint == "model") |
  "\(.timestamp) \(.consensus.selected) \(.sources.transcript.value) \(.sources.jsonInput.value)"' \
  ~/.claude/statusline-validation.jsonl
```

---

### Phase 2: Testing & Validation (Week 2)

**Goal**: Test specific scenarios to understand edge cases

**Test Scenarios**:

1. **Model Switch Test**:
   - Start conversation with Haiku
   - Switch to Sonnet mid-conversation
   - Observe: When does statusline update?
   - Expected: After first message with new model

2. **Branch Switch Test**:
   - Work on `main` branch
   - Switch to `feature` branch
   - Observe: Git cache update timing
   - Expected: Update within 10s

3. **Context Window Test**:
   - Start fresh conversation
   - Track tokens as conversation grows
   - Trigger compaction
   - Observe: Does calculation reset correctly?

4. **Last Message Test**:
   - Send message
   - Observe: Does last message show immediately?
   - Wait 1 hour
   - Check: Is message still showing?

5. **ccusage Stability Test**:
   - Compare ccusage output over 10 minutes
   - Check: Does cost increase as expected?
   - Verify: Block data doesn't become stale

---

### Phase 3: Refinement (Week 3)

**Goal**: Fix issues found, optimize source selection

**Tasks**:
1. Fix identified bugs (e.g., git branch cache issue)
2. Adjust source priority based on findings
3. Optimize cache TTLs
4. Add instability detection (warn if data jumping)

---

## Success Criteria

### Reliability
- [ ] No data point "appears and disappears"
- [ ] Model shows correct model (max 1 message delay on switch)
- [ ] Git always shows current branch (not stale)
- [ ] Context window stable (no wild jumps)

### Accuracy
- [ ] All sources logged and compared
- [ ] Disagreements detected and resolved
- [ ] Source selection logic validated
- [ ] Cost within ±$0.10 of actual

### Performance
- [ ] Total execution <1s (cached)
- [ ] Total execution <25s (cold start with ccusage)
- [ ] No resource leaks
- [ ] No concurrent ccusage spawns

### Observability
- [ ] All modules log validation data
- [ ] Easy to analyze logs
- [ ] Disagreements tracked
- [ ] Patterns identified

---

## Open Research Questions

1. **Model Detection**: Can we detect model switch before first message?
2. **Git Branch Bug**: Why does git sometimes show other branches?
3. **Context Instability**: What causes context window to jump?
4. **Cache Hit Ratio**: Is this metric useful? How to calculate correctly?
5. **Last Message Disappearing**: Why does it flicker? File access issue?
6. **ccusage Frequency**: What's the optimal refresh rate? 1 min? 2 min? 5 min?
7. **Secrets Detection**: What patterns are most important? False positive rate?

---

## Next Steps

1. **Create investigation framework** (logging, validation)
2. **Run for 1 week** to collect data
3. **Analyze logs** to understand patterns
4. **Fix identified bugs**
5. **Optimize source selection**
6. **Document findings** in final report

---

**Status**: PRD Complete - Ready for Investigation Phase
**Owner**: Claude + Vladimir K.S.
**Timeline**: 3 weeks investigation + refinement
