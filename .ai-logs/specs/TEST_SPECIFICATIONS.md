# Test Specifications - Session Health System

**Purpose**: Define all tests before implementation

---

## Test Categories

1. **Unit Tests** - Individual module logic
2. **Integration Tests** - Module interactions
3. **E2E Tests** - Full system flows
4. **Manual QA Scenarios** - Human verification

---

## Unit Tests

### UT-1: Health Store

```yaml
UT-1.1: Directory Creation
  Given: ~/.claude/session-health/ does not exist
  When: healthStore.ensureDirectory()
  Then: Directory is created with correct permissions (700)

UT-1.2: Write Session Health
  Given: Valid SessionHealth object
  When: healthStore.writeSessionHealth("abc-123", health)
  Then:
    - File exists at ~/.claude/session-health/abc-123.json
    - File contains valid JSON
    - JSON matches input health object

UT-1.3: Atomic Write Safety
  Given: Existing health file
  When: Write operation fails midway (simulate with error injection)
  Then:
    - Original file unchanged
    - No partial/corrupt file left
    - Temp file cleaned up

UT-1.4: Read Non-Existent Session
  Given: Session ID with no health file
  When: healthStore.readSessionHealth("non-existent")
  Then: Returns null (not error)

UT-1.5: Read Corrupt JSON
  Given: Health file with invalid JSON
  When: healthStore.readSessionHealth(sessionId)
  Then: Returns null, logs error

UT-1.6: Update Sessions Summary
  Given: 3 session health files exist
  When: healthStore.updateSessionsSummary()
  Then:
    - sessions.json created/updated
    - Contains all 3 sessions
    - Correct counts and metadata

UT-1.7: Default Config
  Given: No config.json exists
  When: healthStore.readConfig()
  Then: Returns default config with all critical components enabled

UT-1.8: Config Persistence
  Given: Custom config with git=false
  When: healthStore.writeConfig(config)
  Then:
    - config.json written
    - Subsequent readConfig() returns same config
```

### UT-2: Transcript Monitor

```yaml
UT-2.1: Missing Transcript
  Given: Path to non-existent file
  When: transcriptMonitor.checkHealth(path)
  Then:
    - exists = false
    - All other fields are defaults (0, empty, false)

UT-2.2: Empty Transcript
  Given: Transcript file exists but empty (0 bytes)
  When: transcriptMonitor.checkHealth(path)
  Then:
    - exists = true
    - sizeBytes = 0
    - messageCount = 0

UT-2.3: Fresh Transcript (<1 min)
  Given: Transcript modified 30 seconds ago
  When: transcriptMonitor.checkHealth(path)
  Then:
    - lastModifiedAgo = "<1m"
    - isSynced = true

UT-2.4: Stale Transcript (>5 min)
  Given: Transcript modified 6 minutes ago
  When: transcriptMonitor.checkHealth(path)
  Then:
    - lastModifiedAgo = "6m"
    - isSynced = false

UT-2.5: Very Stale Transcript (hours)
  Given: Transcript modified 3 hours ago
  When: transcriptMonitor.checkHealth(path)
  Then:
    - lastModifiedAgo = "3h"
    - isSynced = false

UT-2.6: Message Count (Small File)
  Given: Transcript with 50 lines (JSONL)
  When: transcriptMonitor.checkHealth(path)
  Then: messageCount = 50

UT-2.7: Message Count (Large File >1MB)
  Given: Transcript with 1.5MB size
  When: transcriptMonitor.checkHealth(path)
  Then:
    - messageCount is estimated (not exact)
    - No performance degradation (should be <100ms)

UT-2.8: Last Message Time
  Given: Transcript with last entry timestamp "2026-01-30T10:15:00Z"
  When: transcriptMonitor.checkHealth(path)
  Then: lastMessageTime matches parsed timestamp
```

### UT-3: Model Resolver

```yaml
UT-3.1: Fresh Transcript Wins
  Given:
    - Transcript: model="Opus4.5", age=1 minute
    - JSON input: model="Sonnet4.5"
    - Settings: model="Haiku4.5"
  When: modelResolver.resolve(...)
  Then:
    - value = "Opus4.5"
    - source = "transcript"
    - confidence >= 90

UT-3.2: Stale Transcript Falls Back
  Given:
    - Transcript: model="Opus4.5", age=2 hours
    - JSON input: model="Sonnet4.5"
  When: modelResolver.resolve(...)
  Then:
    - value = "Sonnet4.5"
    - source = "jsonInput"

UT-3.3: No Transcript Uses JSON
  Given:
    - Transcript: null/missing
    - JSON input: model="Sonnet4.5"
  When: modelResolver.resolve(...)
  Then:
    - value = "Sonnet4.5"
    - source = "jsonInput"

UT-3.4: Nothing Available Uses Settings
  Given:
    - Transcript: null
    - JSON input: null
    - Settings: model="Haiku4.5"
  When: modelResolver.resolve(...)
  Then:
    - value = "Haiku4.5"
    - source = "settings"

UT-3.5: All Sources Missing
  Given: All sources null/empty
  When: modelResolver.resolve(...)
  Then:
    - value = "Claude"
    - source = "default"
    - confidence <= 20

UT-3.6: Disagreement Logged
  Given:
    - Transcript: "Opus4.5"
    - JSON input: "Sonnet4.5"
  When: modelResolver.resolve(...)
  Then: Logger called with disagreement message containing both values

UT-3.7: Model Name Formatting
  Given: Raw model ID "claude-opus-4-5-20251101"
  When: formatModelName(id)
  Then: Returns "Opus4.5"

UT-3.8: Model Name Formatting (variants)
  Test cases:
    - "claude-sonnet-4-5-20250514" → "Sonnet4.5"
    - "claude-haiku-4-5-20251001" → "Haiku4.5"
    - "unknown-model" → "unknown-model" (passthrough)
```

### UT-4: Data Gatherer

```yaml
UT-4.1: Complete Gather Flow
  Given:
    - Valid session ID
    - Existing transcript
    - Valid JSON input
  When: gatherer.gather(sessionId, transcriptPath, jsonInput)
  Then:
    - Returns complete SessionHealth object
    - All fields populated
    - Health file written to store

UT-4.2: Missing Transcript Handling
  Given: Transcript path does not exist
  When: gatherer.gather(...)
  Then:
    - health.transcript.exists = false
    - health.health.status = "critical"
    - health.health.issues contains "Transcript file missing"

UT-4.3: Data Loss Risk Detection
  Given:
    - Transcript mtime = 10 minutes ago
    - Session is active (JSON input provided)
  When: gatherer.gather(...)
  Then:
    - health.alerts.transcriptStale = true
    - health.alerts.dataLossRisk = true
    - health.health.status = "warning" or "critical"

UT-4.4: Secrets Detected
  Given: Transcript contains "sk-1234567890abcdefghij..."
  When: gatherer.gather(...)
  Then:
    - health.alerts.secretsDetected = true
    - health.alerts.secretTypes contains "OpenAI/Anthropic API Key"
    - health.health.status = "critical"

UT-4.5: Healthy Session
  Given:
    - Fresh transcript (1 min old)
    - No secrets
    - Context <70%
  When: gatherer.gather(...)
  Then:
    - health.health.status = "healthy"
    - health.health.issues is empty

UT-4.6: Context Warning
  Given: Context usage at 75%
  When: gatherer.gather(...)
  Then:
    - health.health.status = "warning"
    - health.health.issues contains context warning
```

### UT-5: Thin Statusline

```yaml
UT-5.1: All Components Enabled
  Given:
    - Full health data
    - All config.components = true
  When: thinStatusline.run(jsonInput)
  Then: Output contains all emoji indicators (📁🌿🤖🧠🕐📝⌛💰💬)

UT-5.2: Git Disabled
  Given:
    - Health data with git info
    - config.components.git = false
  When: thinStatusline.run(jsonInput)
  Then: Output does NOT contain 🌿

UT-5.3: Transcript Sync Fresh
  Given:
    - transcript.lastModifiedAgo = "<1m"
    - transcript.isSynced = true
  When: formatTranscriptSync(health)
  Then: Returns "📝:<1m"

UT-5.4: Transcript Sync Warning
  Given:
    - transcript.lastModifiedAgo = "6m"
    - alerts.transcriptStale = true
  When: formatTranscriptSync(health)
  Then: Returns "📝:6m⚠"

UT-5.5: Transcript Sync Critical
  Given:
    - transcript.lastModifiedAgo = "15m"
    - alerts.dataLossRisk = true
  When: formatTranscriptSync(health)
  Then: Returns "📝:15m🔴"

UT-5.6: No Trailing Newline
  When: thinStatusline.run(validInput)
  Then: stdout.write called with string NOT ending in "\n"

UT-5.7: Stale Health Triggers Gather
  Given:
    - Health file exists but gatheredAt > 30 seconds ago
  When: thinStatusline.run(jsonInput)
  Then: gatherer.gather() is called

UT-5.8: Progress Bar Threshold Marker
  Given: context.percentUsed = 50
  When: generateProgressBar(50)
  Then:
    - Result contains "|" at position 9 (78% of 12)
    - First 6 chars are "=" (50% of 12)
    - Pattern: "[======---|--]"

UT-5.9: Secrets Warning Format
  Given:
    - alerts.secretsDetected = true
    - alerts.secretTypes = ["GitHub Token"]
  When: formatSecretsWarning(health)
  Then: Returns "🔐SECRETS!(GitHub Token)"

UT-5.10: Multiple Secrets Types
  Given:
    - alerts.secretsDetected = true
    - alerts.secretTypes = ["GitHub Token", "AWS Key", "Private Key"]
  When: formatSecretsWarning(health)
  Then: Returns "🔐SECRETS!(3 types)"
```

---

## Integration Tests

### IT-1: Full Gather-Store-Read Flow

```yaml
IT-1.1: New Session
  Given: Fresh session with no existing health data
  When:
    1. gatherer.gather(sessionId, transcriptPath, jsonInput)
    2. health = healthStore.readSessionHealth(sessionId)
  Then:
    - Health file exists
    - Read health matches gathered health
    - sessions.json updated to include session

IT-1.2: Update Existing Session
  Given: Session with existing health data (1 min old)
  When:
    1. Modify transcript (add message)
    2. gatherer.gather(same sessionId)
  Then:
    - Health file updated (not duplicated)
    - gatheredAt timestamp updated
    - New transcript stats reflected

IT-1.3: Multiple Sessions
  Given: 5 different sessions
  When:
    1. Gather health for each session
    2. healthStore.updateSessionsSummary()
    3. summary = healthStore.readAllSessions()
  Then:
    - summary.totalSessions = 5
    - All 5 sessions in summary.sessions
    - Each session has correct status
```

### IT-2: Config → Statusline Flow

```yaml
IT-2.1: Toggle Component
  Given:
    - Health data with git info
    - config.components.git = true
  When:
    1. output1 = thinStatusline.run(input)
    2. config.components.git = false
    3. healthStore.writeConfig(config)
    4. output2 = thinStatusline.run(input)
  Then:
    - output1 contains "🌿"
    - output2 does NOT contain "🌿"

IT-2.2: Threshold Change
  Given:
    - Transcript 4 minutes old
    - config.thresholds.transcriptStaleMinutes = 5
  When:
    1. output1 = thinStatusline.run(input) # Not stale yet
    2. config.thresholds.transcriptStaleMinutes = 3
    3. healthStore.writeConfig(config)
    4. output2 = thinStatusline.run(input) # Now stale
  Then:
    - output1 contains "📝:4m" (no warning)
    - output2 contains "📝:4m⚠" (warning)
```

### IT-3: Validation Logging

```yaml
IT-3.1: Disagreement Logged
  Given:
    - Transcript model = "Opus4.5"
    - JSON model = "Sonnet4.5"
  When: gatherer.gather(...)
  Then:
    - Validation log file contains entry
    - Entry has dataPoint = "model"
    - Entry has disagreement message

IT-3.2: Analysis Script Works
  Given: 100+ validation log entries
  When: Run analyze-validation.sh
  Then:
    - No errors
    - Summary shows counts per data point
    - Disagreements listed
```

---

## E2E Tests

### E2E-1: Complete Session Lifecycle

```yaml
Steps:
  1. Create mock transcript file
  2. Set up JSON input with session_id
  3. Run statusline (triggers gather)
  4. Verify health file created
  5. Verify sessions.json updated
  6. Verify statusline output correct
  7. Update transcript (new message)
  8. Run statusline again
  9. Verify health updated
  10. Verify output reflects new data

Assertions:
  - No errors at any step
  - All files have valid JSON
  - Timestamps correctly updated
  - Output matches health data
```

### E2E-2: Data Loss Risk Detection

```yaml
Steps:
  1. Create transcript with mtime = now
  2. Run statusline - should show "📝:<1m"
  3. Artificially set transcript mtime to 10 min ago
  4. Run statusline - should show "📝:10m🔴"
  5. Touch transcript (update mtime)
  6. Run statusline - should show "📝:<1m"

Assertions:
  - Warning appears when transcript stale
  - Warning clears when transcript updated
  - Health status changes appropriately
```

### E2E-3: Secrets Detection Flow

```yaml
Steps:
  1. Create transcript without secrets
  2. Run statusline - no warning
  3. Append line with "sk-abcdef1234567890..." to transcript
  4. Wait for cache expiry (or force refresh)
  5. Run statusline - should show 🔐 warning

Assertions:
  - Warning only appears after secret added
  - Health status = "critical"
  - Alert types correctly identified
```

---

## Manual QA Scenarios

### MQ-1: Real Session Monitoring

```yaml
Scenario: Monitor Active Claude Code Session
Steps:
  1. Start new Claude Code session
  2. Verify statusline appears
  3. Send several messages
  4. Observe: Does 📝 indicator update?
  5. Wait 6+ minutes without interaction
  6. Observe: Does 📝 show warning (⚠)?
  7. Send new message
  8. Observe: Does warning clear?

Expected:
  - 📝 shows fresh time after each message
  - ⚠ appears after 5+ min without interaction
  - Warning clears on new message

Notes:
  - Record actual times
  - Note any discrepancies
```

### MQ-2: Model Switch Detection

```yaml
Scenario: Detect Model Switch Mid-Session
Steps:
  1. Start session with Haiku model
  2. Verify statusline shows "🤖:Haiku"
  3. Switch to Opus using /model command
  4. Observe: What does statusline show?
  5. Send new message
  6. Observe: Does model update?

Expected:
  - Model updates after first message with new model
  - Validation log shows source transition

Notes:
  - This is known limitation - document actual behavior
```

### MQ-3: Widget Visibility

```yaml
Scenario: Verify macOS Widget Shows Sessions
Prerequisites:
  - Widget installed
  - Health store populated

Steps:
  1. Open Notification Center (swipe from right)
  2. Find Claude Sessions widget
  3. Verify all active sessions visible
  4. Check health indicators (🟢🟡🔴) match reality
  5. Tap on a session
  6. Verify action (if any)

Expected:
  - Widget loads without error
  - Sessions list matches health files
  - Health colors correct
  - Refresh happens every 30s

Notes:
  - Test with 1, 5, 10+ sessions
```

### MQ-4: Config Toggle

```yaml
Scenario: Toggle Component via Config
Steps:
  1. Note current statusline output
  2. Edit ~/.claude/session-health/config.json
  3. Set "git": false
  4. Send message in Claude Code
  5. Observe statusline

Expected:
  - Git info (🌿) no longer appears
  - Other components unchanged

Steps (continued):
  6. Set "git": true
  7. Send message
  8. Observe statusline

Expected:
  - Git info reappears
```

### MQ-5: Stress Test - Many Sessions

```yaml
Scenario: Handle Many Concurrent Sessions
Steps:
  1. Open 10 Claude Code sessions
  2. Run statusline command manually in each
  3. Check ~/.claude/session-health/sessions.json

Expected:
  - All 10 sessions listed
  - No duplicate entries
  - No file corruption
  - Summary counts correct

Performance:
  - Individual statusline execution < 200ms
  - Summary update < 500ms
```

---

## Performance Benchmarks

```yaml
PERF-1: Statusline Execution Time
  Target: < 200ms (cached health)
  Target: < 500ms (gather required)
  Measure: Time from invocation to output

PERF-2: Health File Size
  Target: < 5KB per session
  Measure: File size of [session].json

PERF-3: Memory Usage
  Target: < 20MB peak
  Measure: RSS during statusline execution

PERF-4: Summary Update
  Target: < 500ms for 50 sessions
  Measure: Time to updateSessionsSummary()
```

---

## Test Data Fixtures

### Mock Transcript (Small)
```jsonl
{"sessionId":"test-123","type":"user","message":{"content":"Hello"},"timestamp":"2026-01-30T10:00:00Z"}
{"sessionId":"test-123","type":"assistant","message":{"model":"claude-opus-4-5-20251101","content":"Hi"},"timestamp":"2026-01-30T10:00:05Z"}
```

### Mock Transcript (With Secrets)
```jsonl
{"sessionId":"test-456","type":"user","message":{"content":"my api key is sk-1234567890abcdefghijklmnop"},"timestamp":"2026-01-30T10:00:00Z"}
```

### Mock JSON Input
```json
{
  "session_id": "test-123",
  "transcript_path": "/Users/test/.claude/projects/-test/test-123.jsonl",
  "model": {
    "name": "sonnet",
    "display_name": "Sonnet 4.5"
  },
  "context_window": {
    "context_window_size": 200000,
    "current_input_tokens": 50000,
    "cache_read_input_tokens": 30000,
    "current_output_tokens": 5000
  }
}
```

### Mock Config
```json
{
  "components": {
    "directory": true,
    "git": true,
    "model": true,
    "context": true,
    "time": true,
    "transcriptSync": true,
    "budget": false,
    "cost": false
  },
  "thresholds": {
    "transcriptStaleMinutes": 5
  }
}
```

---

**Status**: Test Specifications Complete - Ready for Implementation
