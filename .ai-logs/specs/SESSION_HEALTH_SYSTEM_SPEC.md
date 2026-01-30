# Session Health Monitoring System - Specification

**Version**: 3.0 (Architecture Evolution)
**Date**: 2026-01-30
**Status**: Design Phase - No Code Yet

---

## Vision

Transform from "statusline script" to **Session Health Monitoring System**:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    SESSION HEALTH SYSTEM                             │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │ Data Gatherer│───▶│ Health Store │───▶│ Consumers            │  │
│  │ (per session)│    │ (JSON files) │    │                      │  │
│  └──────────────┘    └──────────────┘    │ • Statusline (thin)  │  │
│                                          │ • macOS Widget       │  │
│                                          │ • API (future)       │  │
│                                          └──────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Problem Statement

### Issue 1: Session Data Loss
> "I exit Claude Code dialogue and conversation data doesn't get saved... returned to an earlier stage"

**Root Cause Hypothesis**:
- Transcript file (`[SESSION_ID].jsonl`) not flushed before exit
- File corruption during write
- Session ID mismatch between memory and disk

**Detection Needed**:
- Monitor transcript file mtime
- Compare expected message count vs actual
- Alert when transcript is stale (not updated recently during active session)

### Issue 2: No Session Visibility
- Can't see health of all sessions at once
- No way to know if a session is "safe" to exit
- No external view of Claude Code state

### Issue 3: Statusline Inflexibility
- Must edit script to change components
- No runtime configuration
- Single output format

---

## Proposed Architecture

### Tier 1: Data Gatherer (Background Process)

**Purpose**: Continuously gather data from all sources, validate, store

**Location**: `~/.claude/health-daemon/` (or run on-demand)

**Responsibilities**:
1. Monitor all active sessions
2. Gather data from each source
3. Validate and compare sources
4. Write health state to JSON files
5. Log anomalies

**Output**: Per-session health file + global summary file

### Tier 2: Health Store (JSON Files)

**Location**: `~/.claude/session-health/`

**Files**:
```
~/.claude/session-health/
├── sessions.json              # Summary of all sessions
├── [SESSION_ID].json          # Detailed health per session
├── config.json                # User preferences (which components to show)
└── alerts.json                # Active warnings/alerts
```

### Tier 3: Consumers

**3A: Statusline Script (Thin)**
- Just reads from health store
- Formats and outputs
- No data gathering logic
- Fast (<50ms)

**3B: macOS Widget (SwiftUI)**
- Reads from health store
- Shows all sessions
- Interactive (hover for details)
- Toggle components on/off (writes to config.json)

**3C: Future API**
- HTTP endpoint exposing health data
- For integrations

---

## Data Model

### Session Health Record

```typescript
interface SessionHealth {
  // Identity
  sessionId: string;           // UUID
  projectPath: string;         // /Users/vmks/project
  transcriptPath: string;      // Full path to .jsonl

  // Health Indicators
  health: {
    status: 'healthy' | 'warning' | 'critical' | 'unknown';
    lastUpdate: number;        // Unix timestamp
    issues: string[];          // Active issues
  };

  // Transcript Health (NEW - addresses data loss concern)
  transcript: {
    exists: boolean;
    sizeBytes: number;
    lastModified: number;      // File mtime
    lastModifiedAgo: string;   // "2m ago", "1h ago"
    messageCount: number;      // Lines in JSONL
    lastMessageTime: number;   // Timestamp of last message
    isSynced: boolean;         // mtime recent = likely synced
  };

  // Session Data
  model: {
    value: string;
    source: 'transcript' | 'json' | 'settings' | 'default';
    confidence: number;
  };

  context: {
    tokensUsed: number;
    tokensLeft: number;
    percentUsed: number;
    nearCompaction: boolean;   // >70%
  };

  git: {
    branch: string;
    ahead: number;
    behind: number;
    dirty: number;
    lastChecked: number;
  };

  // Global Data (shared across sessions)
  billing: {
    costToday: number;
    burnRatePerHour: number;
    budgetRemaining: number;
    budgetPercentUsed: number;
    resetTime: string;         // UTC time
    isFresh: boolean;
    lastFetched: number;
  };

  // Alerts
  alerts: {
    secretsDetected: boolean;
    secretTypes: string[];
    transcriptStale: boolean;  // Not updated in >5 min during active work
    dataLossRisk: boolean;     // Transcript mtime old but session active
  };

  // Timestamps
  gatheredAt: number;          // When this record was created
}
```

### Global Sessions Summary

```typescript
interface SessionsSummary {
  lastUpdated: number;
  activeSessions: number;
  totalSessions: number;

  sessions: Array<{
    sessionId: string;
    projectPath: string;
    shortName: string;         // Last path component
    health: 'healthy' | 'warning' | 'critical';
    lastActivity: number;
    lastActivityAgo: string;   // "2m ago"
    model: string;
    transcriptSynced: boolean;
  }>;

  // Global metrics
  global: {
    totalCostToday: number;
    burnRatePerHour: number;
    budgetRemaining: number;
  };

  // Alerts across all sessions
  alerts: {
    sessionsWithSecrets: string[];
    sessionsAtRisk: string[];  // Data loss risk
    sessionsNearCompaction: string[];
  };
}
```

### User Configuration

```typescript
interface StatuslineConfig {
  // Components to show (toggle on/off)
  components: {
    directory: boolean;        // 📁
    git: boolean;              // 🌿
    model: boolean;            // 🤖
    version: boolean;          // 📟
    context: boolean;          // 🧠
    time: boolean;             // 🕐
    budget: boolean;           // ⌛
    cost: boolean;             // 💰
    usage: boolean;            // 📊
    cache: boolean;            // 💾
    lastMessage: boolean;      // 💬
    transcriptSync: boolean;   // 📝 NEW - show last save time
    secrets: boolean;          // 🔐
  };

  // Display preferences
  display: {
    maxWidth: number;          // Truncate if longer
    useEmoji: boolean;
    useColor: boolean;
  };

  // Alert thresholds
  thresholds: {
    transcriptStaleMinutes: number;  // Default: 5
    contextWarningPercent: number;   // Default: 70
    budgetWarningPercent: number;    // Default: 80
  };
}
```

---

## New Component: Transcript Sync Indicator

**Purpose**: Show when transcript was last saved to detect data loss risk

**Format Options**:
```
💾:99%|2m      # Cache ratio + last sync time
📝:2m          # Just last sync time
💾:2m⚠         # Warning if >5 min without sync during active session
```

**Logic**:
```
transcriptAge = now - transcript.mtime

if transcriptAge < 60:
  show "📝:<1m"        # Very fresh
elif transcriptAge < 300:
  show "📝:${min}m"    # Normal
elif transcriptAge < 600:
  show "📝:${min}m⚠"   # Warning - 5-10 min stale
else:
  show "📝:${min}m🔴"  # Critical - >10 min stale
```

---

## macOS Widget Specification

### Technology
- **SwiftUI** for widget
- **WidgetKit** for Notification Center integration
- **FileManager** to read JSON health files

### Widget Sizes

**Small (Compact)**:
```
┌─────────────────────┐
│ Claude Sessions (3) │
│ ───────────────────│
│ 🟢 ai-statusline 2m │
│ 🟡 my-project   15m │
│ 🔴 old-work     2h  │
└─────────────────────┘
```

**Medium (Detailed)**:
```
┌─────────────────────────────────────────┐
│ Claude Sessions                    $45.2│
│ ────────────────────────────────────────│
│ 🟢 ai-statusline │ opus │ 2m │ 📝 ok    │
│ 🟡 my-project    │ haiku│ 15m│ 📝 5m⚠  │
│ 🔴 old-work      │ -    │ 2h │ 📝 stale │
│ ────────────────────────────────────────│
│ Budget: 45% used │ Reset: 14:00 UTC     │
└─────────────────────────────────────────┘
```

### Interactivity

**Tap on session**: Open Claude Code to that session (if possible)

**Long press**: Show detail popup with:
- Full project path
- Model details
- Context usage
- Last message preview
- Transcript status

**Configuration (via widget settings)**:
- Toggle which components to show
- Set refresh interval
- Choose which sessions to track

### Widget → Config File

When user toggles a component in widget settings:
1. Widget writes to `~/.claude/session-health/config.json`
2. Statusline reads config on next invocation
3. Shows/hides component accordingly

---

## Data Gatherer Design

### Triggering Options

**Option A: On-Demand (Recommended)**
- Statusline invocation triggers data gathering
- Writes to health store
- Widget reads periodically

**Option B: Background Daemon**
- Separate process running continuously
- Updates health store every N seconds
- More complex, more resource usage

**Option C: Hybrid**
- Statusline writes current session health
- Periodic sweep updates all sessions

### Gather Flow (Pseudocode)

```
function gatherSessionHealth(sessionId, transcriptPath):
  health = new SessionHealth()
  health.sessionId = sessionId
  health.gatheredAt = now()

  # 1. Transcript health (NEW - critical for data loss detection)
  if fileExists(transcriptPath):
    stats = statFile(transcriptPath)
    health.transcript.exists = true
    health.transcript.sizeBytes = stats.size
    health.transcript.lastModified = stats.mtime
    health.transcript.lastModifiedAgo = formatAgo(stats.mtime)
    health.transcript.messageCount = countLines(transcriptPath)

    # Data loss risk detection
    age = now() - stats.mtime
    if age > 300 and sessionIsActive():  # >5 min and active
      health.alerts.transcriptStale = true
      health.alerts.dataLossRisk = true
  else:
    health.transcript.exists = false
    health.health.status = 'critical'
    health.health.issues.push('Transcript file missing')

  # 2. Model (multi-source)
  health.model = resolveModel(transcriptPath, jsonInput, settings)

  # 3. Context (from JSON input)
  health.context = calculateContext(jsonInput)

  # 4. Git (cached)
  health.git = getGitStatus(cached: 10s)

  # 5. Billing (global, cached)
  health.billing = getBillingData(cached: 2min)

  # 6. Secrets scan (cached)
  health.alerts.secretsDetected = scanForSecrets(transcriptPath, cached: 5min)

  # 7. Determine overall health
  health.health.status = calculateOverallHealth(health)

  # 8. Write to health store
  writeJson("~/.claude/session-health/${sessionId}.json", health)

  # 9. Update global summary
  updateSessionsSummary()

  return health
```

---

## Thin Statusline Design

### Current (Fat - does everything)
```
[Read JSON] → [Parse] → [Fetch ccusage] → [Fetch git] → [Read transcript] → [Format] → [Output]
```

### Proposed (Thin - just display)
```
[Read health JSON] → [Read config JSON] → [Format enabled components] → [Output]
```

### Pseudocode
```
function statusline():
  # 1. Get session ID from JSON input
  sessionId = parseJsonInput().session_id

  # 2. Read health data (pre-gathered)
  healthFile = "~/.claude/session-health/${sessionId}.json"
  if not fileExists(healthFile) or fileAge(healthFile) > 30:
    # Health data stale or missing - trigger gather
    triggerGather(sessionId)

  health = readJson(healthFile)

  # 3. Read user config
  config = readJson("~/.claude/session-health/config.json")

  # 4. Format only enabled components
  parts = []
  if config.components.directory: parts.push(formatDirectory(health))
  if config.components.git: parts.push(formatGit(health))
  if config.components.model: parts.push(formatModel(health))
  if config.components.context: parts.push(formatContext(health))
  if config.components.time: parts.push(formatTime())
  if config.components.transcriptSync: parts.push(formatTranscriptSync(health))
  if config.components.cost: parts.push(formatCost(health))
  # ... etc

  # 5. Output (no trailing newline!)
  process.stdout.write(parts.join(' '))
```

---

## File Structure

```
~/.claude/
├── session-health/                    # NEW - Health Store
│   ├── sessions.json                  # Summary of all sessions
│   ├── config.json                    # User preferences
│   ├── alerts.json                    # Active alerts
│   ├── [SESSION_ID_1].json            # Per-session health
│   ├── [SESSION_ID_2].json
│   └── ...
│
├── projects/                          # Existing - Transcripts
│   └── -[PROJECT_PATH]/
│       ├── [SESSION_ID].jsonl
│       └── sessions-index.json
│
├── tasks/                             # Existing - Task storage
│   └── [SESSION_ID]/
│
└── (other existing files)
```

---

## Testing Strategy

### Unit Tests

**Data Gatherer Tests**:
```
test_transcript_health_detection:
  - Given: transcript exists, mtime 2 min ago
  - When: gatherTranscriptHealth()
  - Then: lastModifiedAgo = "2m", isSynced = true

test_transcript_stale_detection:
  - Given: transcript exists, mtime 10 min ago, session active
  - When: gatherTranscriptHealth()
  - Then: transcriptStale = true, dataLossRisk = true

test_transcript_missing:
  - Given: transcript does not exist
  - When: gatherTranscriptHealth()
  - Then: exists = false, health.status = 'critical'
```

**Config Tests**:
```
test_component_toggle:
  - Given: config.components.git = false
  - When: formatStatusline(health, config)
  - Then: output does not contain 🌿

test_all_components_enabled:
  - Given: all components = true
  - When: formatStatusline(health, config)
  - Then: output contains all emojis
```

**Health Calculation Tests**:
```
test_healthy_session:
  - Given: transcript fresh, no secrets, context < 70%
  - Then: health.status = 'healthy'

test_warning_session:
  - Given: transcript 6 min old, session active
  - Then: health.status = 'warning'

test_critical_session:
  - Given: transcript missing OR secrets detected
  - Then: health.status = 'critical'
```

### Integration Tests

```
test_full_flow:
  1. Create mock session with transcript
  2. Run data gatherer
  3. Verify health JSON written correctly
  4. Run thin statusline
  5. Verify output matches health data

test_config_persistence:
  1. Widget toggles component off
  2. Write to config.json
  3. Run statusline
  4. Verify component not shown
```

### Manual QA Scenarios

```
Scenario: Detect Stale Transcript
1. Start Claude Code session
2. Send several messages
3. Wait 6 minutes without interaction
4. Check statusline shows 📝:6m⚠
5. Send new message
6. Verify indicator updates to 📝:<1m

Scenario: Widget Shows All Sessions
1. Open multiple Claude Code sessions
2. Open Notification Center widget
3. Verify all sessions visible
4. Verify health status correct for each
5. Tap session - verify opens correctly

Scenario: Toggle Component
1. In widget settings, disable 🌿 git
2. Return to Claude Code
3. Verify statusline no longer shows branch
4. Re-enable in widget
5. Verify branch reappears
```

---

## Implementation Phases

### Phase 1: Health Store & Data Model
- Define JSON schemas
- Create health store directory structure
- Implement read/write utilities

### Phase 2: Data Gatherer
- Implement per-module data gathering
- Add transcript health monitoring
- Write to health store

### Phase 3: Thin Statusline
- Refactor to read from health store
- Add config-based component filtering
- Add transcript sync indicator

### Phase 4: macOS Widget
- Create SwiftUI widget project
- Implement session list view
- Add configuration UI
- Test in Notification Center

### Phase 5: Polish & Testing
- Comprehensive test suite
- Performance optimization
- Documentation

---

## Resource Considerations

**File I/O**:
- Health JSON: ~2KB per session (small)
- Read once per statusline invocation
- Write once per gather (every few seconds)

**Memory**:
- Widget: ~10MB (typical SwiftUI)
- Statusline: ~5MB (minimal)
- No persistent daemon needed

**CPU**:
- Gathering: Runs on statusline invocation
- ccusage: 2-5 min cache (expensive operation cached)
- Git: 10s cache
- Minimal continuous load

---

## Open Questions

1. **Widget → Claude Code**: Can we deep-link to open a specific session?
2. **Session Activity Detection**: How to know if session is "active" vs "idle"?
3. **Daemon vs On-Demand**: Is on-demand gathering sufficient?
4. **Widget Refresh**: How often should widget poll health files?
5. **Cross-Machine Sync**: Should config.json sync via iCloud?

---

## Success Criteria

- [ ] Transcript sync time visible in statusline (📝:Xm)
- [ ] Data loss risk detected and warned
- [ ] Widget shows all sessions with health status
- [ ] Components toggleable without editing code
- [ ] Health data available as JSON for other consumers
- [ ] No increase in resource usage vs current statusline
- [ ] All tests pass
- [ ] 1-week stability test with no data loss incidents

---

**Status**: Specification Complete - Ready for Implementation Planning
