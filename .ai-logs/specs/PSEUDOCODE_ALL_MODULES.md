# Pseudocode - All Modules

**Purpose**: Define logic before implementation. No actual code - just structure and flow.

---

## Module 1: Health Store Manager

### Purpose
Read/write session health JSON files

### Interface
```
HealthStore:
  readSessionHealth(sessionId) → SessionHealth | null
  writeSessionHealth(sessionId, health) → void
  readAllSessions() → SessionsSummary
  updateSessionsSummary() → void
  readConfig() → StatuslineConfig
  writeConfig(config) → void
```

### Pseudocode
```
class HealthStore:
  basePath = "~/.claude/session-health/"

  function ensureDirectory():
    if not exists(basePath):
      createDirectory(basePath)

  function readSessionHealth(sessionId):
    path = basePath + sessionId + ".json"
    if not exists(path):
      return null
    return parseJson(readFile(path))

  function writeSessionHealth(sessionId, health):
    ensureDirectory()
    path = basePath + sessionId + ".json"
    # Atomic write: write to temp, then rename
    tempPath = path + ".tmp"
    writeFile(tempPath, toJson(health))
    rename(tempPath, path)

  function readAllSessions():
    path = basePath + "sessions.json"
    if not exists(path):
      return { sessions: [], lastUpdated: 0 }
    return parseJson(readFile(path))

  function updateSessionsSummary():
    # Scan all session health files
    sessions = []
    for file in listFiles(basePath, "*.json"):
      if file == "sessions.json" or file == "config.json":
        continue
      health = parseJson(readFile(file))
      sessions.push({
        sessionId: health.sessionId,
        projectPath: health.projectPath,
        shortName: basename(health.projectPath),
        health: health.health.status,
        lastActivity: health.transcript.lastModified,
        lastActivityAgo: formatAgo(health.transcript.lastModified),
        model: health.model.value,
        transcriptSynced: health.transcript.isSynced
      })

    summary = {
      lastUpdated: now(),
      activeSessions: count(sessions, s => s.lastActivityAgo < "1h"),
      totalSessions: length(sessions),
      sessions: sessions
    }

    writeFile(basePath + "sessions.json", toJson(summary))

  function readConfig():
    path = basePath + "config.json"
    if not exists(path):
      return defaultConfig()
    return parseJson(readFile(path))

  function defaultConfig():
    return {
      components: {
        directory: true,
        git: true,
        model: true,
        version: false,  # Usually not needed
        context: true,
        time: true,
        budget: true,
        cost: true,
        usage: false,    # Often redundant
        cache: false,    # Often not useful
        lastMessage: true,
        transcriptSync: true,  # NEW - important
        secrets: true
      },
      thresholds: {
        transcriptStaleMinutes: 5,
        contextWarningPercent: 70,
        budgetWarningPercent: 80
      }
    }
```

---

## Module 2: Transcript Health Monitor

### Purpose
Monitor transcript file for data loss risk

### Interface
```
TranscriptMonitor:
  checkHealth(transcriptPath) → TranscriptHealth
```

### Pseudocode
```
class TranscriptMonitor:

  function checkHealth(transcriptPath):
    result = {
      exists: false,
      sizeBytes: 0,
      lastModified: 0,
      lastModifiedAgo: "unknown",
      messageCount: 0,
      lastMessageTime: 0,
      isSynced: false
    }

    if not exists(transcriptPath):
      return result

    # File stats
    stats = statFile(transcriptPath)
    result.exists = true
    result.sizeBytes = stats.size
    result.lastModified = stats.mtime
    result.lastModifiedAgo = formatAgo(stats.mtime)

    # Count messages (lines in JSONL)
    # Note: For large files, just check last few lines
    if stats.size > 1_000_000:  # >1MB
      # Large file: estimate from file size
      # Average line is ~1KB, so estimate count
      result.messageCount = floor(stats.size / 1000)
      # Read only last 10KB for last message time
      lastChunk = readFileTail(transcriptPath, 10000)
      result.lastMessageTime = extractLastTimestamp(lastChunk)
    else:
      # Small file: count actual lines
      lines = readFileLines(transcriptPath)
      result.messageCount = length(lines)
      if length(lines) > 0:
        lastLine = parseJson(lines[length(lines) - 1])
        result.lastMessageTime = parseTimestamp(lastLine.timestamp)

    # Determine if synced (fresh enough)
    ageSeconds = now() - result.lastModified
    result.isSynced = ageSeconds < 60  # <1 min = synced

    return result

  function formatAgo(timestamp):
    seconds = now() - timestamp
    if seconds < 60:
      return "<1m"
    elif seconds < 3600:
      return floor(seconds / 60) + "m"
    elif seconds < 86400:
      return floor(seconds / 3600) + "h"
    else:
      return floor(seconds / 86400) + "d"

  function extractLastTimestamp(chunk):
    # Find last complete JSON line
    lines = chunk.split("\n").filter(notEmpty)
    for i from length(lines)-1 to 0:
      try:
        obj = parseJson(lines[i])
        if obj.timestamp:
          return parseTimestamp(obj.timestamp)
      catch:
        continue
    return 0
```

---

## Module 3: Data Gatherer

### Purpose
Orchestrate all data gathering, validate, write to health store

### Interface
```
DataGatherer:
  gather(sessionId, transcriptPath, jsonInput) → SessionHealth
```

### Pseudocode
```
class DataGatherer:
  healthStore = new HealthStore()
  transcriptMonitor = new TranscriptMonitor()
  modelResolver = new ModelResolver()
  gitModule = new GitModule()
  billingModule = new BillingModule()
  secretsScanner = new SecretsScanner()
  contextCalculator = new ContextCalculator()

  function gather(sessionId, transcriptPath, jsonInput):
    health = new SessionHealth()
    health.sessionId = sessionId
    health.transcriptPath = transcriptPath
    health.projectPath = extractProjectPath(transcriptPath)
    health.gatheredAt = now()

    # 1. Transcript health (critical for data loss detection)
    health.transcript = transcriptMonitor.checkHealth(transcriptPath)

    # 2. Model (multi-source validation)
    health.model = modelResolver.resolve(transcriptPath, jsonInput)

    # 3. Context window
    health.context = contextCalculator.calculate(jsonInput)

    # 4. Git status (cached 10s)
    health.git = gitModule.getStatus(health.projectPath)

    # 5. Billing (cached 2-5 min, GLOBAL)
    health.billing = billingModule.getData()

    # 6. Secrets scan (cached 5 min)
    if health.transcript.exists:
      secrets = secretsScanner.scan(transcriptPath)
      health.alerts.secretsDetected = secrets.hasSecrets
      health.alerts.secretTypes = secrets.types

    # 7. Data loss risk detection
    health.alerts.transcriptStale = isTranscriptStale(health.transcript)
    health.alerts.dataLossRisk =
      health.alerts.transcriptStale and isSessionLikelyActive(jsonInput)

    # 8. Calculate overall health status
    health.health = calculateOverallHealth(health)

    # 9. Write to health store
    healthStore.writeSessionHealth(sessionId, health)

    # 10. Update global summary (async, non-blocking)
    scheduleAsync(() => healthStore.updateSessionsSummary())

    return health

  function isTranscriptStale(transcript):
    if not transcript.exists:
      return true
    ageMinutes = (now() - transcript.lastModified) / 60
    config = healthStore.readConfig()
    return ageMinutes > config.thresholds.transcriptStaleMinutes

  function isSessionLikelyActive(jsonInput):
    # If we received JSON input, session is active
    return jsonInput != null and jsonInput.session_id != null

  function calculateOverallHealth(health):
    issues = []
    status = 'healthy'

    # Critical issues
    if not health.transcript.exists:
      issues.push("Transcript file missing")
      status = 'critical'

    if health.alerts.secretsDetected:
      issues.push("Secrets detected: " + join(health.alerts.secretTypes, ", "))
      status = 'critical'

    if health.alerts.dataLossRisk:
      issues.push("Data loss risk: transcript not updated in " +
                  health.transcript.lastModifiedAgo)
      if status != 'critical':
        status = 'warning'

    # Warning issues
    if health.context.percentUsed > 70:
      issues.push("Context window " + health.context.percentUsed + "% full")
      if status == 'healthy':
        status = 'warning'

    if not health.billing.isFresh:
      issues.push("Billing data stale")
      if status == 'healthy':
        status = 'warning'

    return {
      status: status,
      lastUpdate: now(),
      issues: issues
    }
```

---

## Module 4: Model Resolver (Multi-Source)

### Purpose
Resolve model from multiple sources, pick best, log disagreements

### Pseudocode
```
class ModelResolver:
  logger = new ValidationLogger()

  function resolve(transcriptPath, jsonInput):
    sources = {}

    # Source 1: Transcript (last message model)
    if exists(transcriptPath):
      transcriptModel = extractModelFromTranscript(transcriptPath)
      if transcriptModel:
        sources.transcript = {
          value: transcriptModel.model,
          age: now() - transcriptModel.timestamp,
          confidence: calculateConfidence(transcriptModel)
        }

    # Source 2: JSON input
    if jsonInput and jsonInput.model:
      sources.jsonInput = {
        value: jsonInput.model.name or jsonInput.model.display_name,
        age: 0,  # Real-time
        confidence: 80
      }

    # Source 3: Settings.json (fallback)
    settingsModel = readSettingsModel()
    if settingsModel:
      sources.settings = {
        value: settingsModel,
        age: Infinity,  # Static
        confidence: 30
      }

    # Select best source
    selected = selectBest(sources)

    # Log for analysis
    logger.log({
      dataPoint: "model",
      sources: sources,
      selected: selected,
      disagreement: detectDisagreement(sources)
    })

    return {
      value: selected.value,
      source: selected.source,
      confidence: selected.confidence
    }

  function selectBest(sources):
    # Priority: fresh transcript > jsonInput > settings
    if sources.transcript and sources.transcript.age < 3600:
      # Transcript is <1 hour old
      return {
        source: "transcript",
        value: sources.transcript.value,
        confidence: sources.transcript.confidence,
        reason: "Fresh transcript (<1h)"
      }

    if sources.jsonInput:
      return {
        source: "jsonInput",
        value: sources.jsonInput.value,
        confidence: sources.jsonInput.confidence,
        reason: "Current session JSON"
      }

    if sources.settings:
      return {
        source: "settings",
        value: sources.settings.value,
        confidence: sources.settings.confidence,
        reason: "Fallback to settings"
      }

    return {
      source: "default",
      value: "Claude",
      confidence: 10,
      reason: "No source available"
    }

  function extractModelFromTranscript(path):
    # Read last 50KB to find most recent model
    chunk = readFileTail(path, 50000)
    lines = chunk.split("\n").filter(notEmpty).reverse()

    for line in lines:
      try:
        obj = parseJson(line)
        if obj.message and obj.message.model:
          return {
            model: formatModelName(obj.message.model),
            timestamp: parseTimestamp(obj.timestamp)
          }
      catch:
        continue

    return null

  function formatModelName(modelId):
    # "claude-opus-4-5-20251101" → "Opus4.5"
    # "claude-sonnet-4-5-20250514" → "Sonnet4.5"
    # etc.
    if contains(modelId, "opus"):
      return "Opus4.5"
    elif contains(modelId, "sonnet"):
      return "Sonnet4.5"
    elif contains(modelId, "haiku"):
      return "Haiku4.5"
    else:
      return modelId

  function detectDisagreement(sources):
    values = unique(
      Object.values(sources)
        .filter(s => s != null)
        .map(s => s.value)
    )
    if length(values) > 1:
      return "Sources disagree: " +
        Object.entries(sources)
          .map(([k, v]) => k + "=" + v.value)
          .join(", ")
    return null
```

---

## Module 5: Thin Statusline

### Purpose
Read health data, format according to config, output

### Pseudocode
```
class ThinStatusline:
  healthStore = new HealthStore()
  gatherer = new DataGatherer()

  function run(jsonInput):
    # Parse JSON input
    sessionId = jsonInput.session_id
    transcriptPath = jsonInput.transcript_path

    if not sessionId:
      # No session - output minimal
      output("⚠ No session")
      return

    # Check if health data exists and is fresh
    health = healthStore.readSessionHealth(sessionId)

    if not health or isStale(health):
      # Need to gather fresh data
      health = gatherer.gather(sessionId, transcriptPath, jsonInput)

    # Read user config
    config = healthStore.readConfig()

    # Format output
    parts = []

    if config.components.directory:
      parts.push(formatDirectory(health))

    if config.components.git:
      parts.push(formatGit(health))

    if config.components.model:
      parts.push(formatModel(health))

    if config.components.context:
      parts.push(formatContext(health))

    if config.components.time:
      parts.push(formatTime())

    if config.components.transcriptSync:
      parts.push(formatTranscriptSync(health))

    if config.components.budget:
      parts.push(formatBudget(health))

    if config.components.cost:
      parts.push(formatCost(health))

    if config.components.lastMessage:
      parts.push(formatLastMessage(health))

    if config.components.secrets and health.alerts.secretsDetected:
      parts.push(formatSecretsWarning(health))

    # Output (NO trailing newline!)
    output = parts.filter(notEmpty).join(" ")
    process.stdout.write(output)

  function isStale(health):
    # Health data older than 30 seconds is stale
    return (now() - health.gatheredAt) > 30

  function formatDirectory(health):
    path = health.projectPath
    # Shorten home directory
    path = path.replace(homedir(), "~")
    # Truncate if too long
    if length(path) > 30:
      path = "~/" + basename(path)
    return "📁:" + path

  function formatGit(health):
    if not health.git or not health.git.branch:
      return ""

    result = "🌿:" + health.git.branch

    if health.git.ahead > 0:
      result += "+" + health.git.ahead
    if health.git.behind > 0:
      result += "/-" + health.git.behind
    if health.git.dirty > 0:
      result += "*" + health.git.dirty

    return result

  function formatModel(health):
    return "🤖:" + health.model.value

  function formatContext(health):
    left = formatTokens(health.context.tokensLeft)
    bar = generateProgressBar(health.context.percentUsed)
    return "🧠:" + left + "left" + bar

  function formatTime():
    now = new Date()
    hours = padZero(now.getHours())
    mins = padZero(now.getMinutes())
    return "🕐:" + hours + ":" + mins

  function formatTranscriptSync(health):
    # NEW: Show when transcript was last saved
    if not health.transcript.exists:
      return "📝:⚠missing"

    ago = health.transcript.lastModifiedAgo

    if health.alerts.transcriptStale:
      return "📝:" + ago + "⚠"
    elif health.alerts.dataLossRisk:
      return "📝:" + ago + "🔴"
    else:
      return "📝:" + ago

  function formatBudget(health):
    if not health.billing.isFresh:
      return "⌛:🔴stale"

    hours = floor(health.billing.budgetRemaining / 60)
    mins = health.billing.budgetRemaining % 60
    pct = health.billing.budgetPercentUsed

    return "⌛:" + hours + "h" + mins + "m(" + pct + "%)" + health.billing.resetTime

  function formatCost(health):
    if not health.billing.isFresh:
      return ""
    if health.billing.costToday == 0:
      return ""

    cost = formatMoney(health.billing.costToday)
    rate = formatMoney(health.billing.burnRatePerHour)

    return "💰:" + cost + "|" + rate + "/h"

  function formatLastMessage(health):
    # From transcript - last message time and preview
    if not health.transcript.exists:
      return ""

    time = formatTime(health.transcript.lastMessageTime)
    # Preview would require reading transcript - skip for thin version
    return "💬:" + time

  function formatSecretsWarning(health):
    count = length(health.alerts.secretTypes)
    if count == 1:
      return "🔐SECRETS!(" + health.alerts.secretTypes[0] + ")"
    else:
      return "🔐SECRETS!(" + count + " types)"

  function generateProgressBar(percentUsed):
    width = 12
    thresholdPos = floor(width * 0.78)  # 78% threshold
    usedPos = floor(width * percentUsed / 100)

    bar = ""
    for i from 0 to width-1:
      if i == thresholdPos:
        bar += "|"
      elif i < usedPos:
        bar += "="
      else:
        bar += "-"

    return "[" + bar + "]"
```

---

## Module 6: macOS Widget (SwiftUI)

### Purpose
Display session health in Notification Center

### Pseudocode (Swift-like)
```
// Widget Entry
struct SessionHealthEntry: TimelineEntry {
  date: Date
  sessions: [SessionSummary]
  globalCost: Double
  budgetRemaining: Int
}

// Widget Provider
struct SessionHealthProvider: TimelineProvider {

  func getTimeline(context, completion) {
    // Read from health store
    let sessionsPath = homeDir + "/.claude/session-health/sessions.json"
    let data = readFile(sessionsPath)
    let summary = parseJson(data) as SessionsSummary

    let entry = SessionHealthEntry(
      date: Date(),
      sessions: summary.sessions.map { s in
        SessionSummary(
          id: s.sessionId,
          name: s.shortName,
          health: s.health,
          lastActivity: s.lastActivityAgo,
          model: s.model,
          synced: s.transcriptSynced
        )
      },
      globalCost: summary.global.totalCostToday,
      budgetRemaining: summary.global.budgetRemaining
    )

    // Refresh every 30 seconds
    let nextUpdate = Date().addingTimeInterval(30)
    let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
    completion(timeline)
  }
}

// Widget View
struct SessionHealthWidget: View {
  entry: SessionHealthEntry

  var body: some View {
    VStack(alignment: .leading) {
      // Header
      HStack {
        Text("Claude Sessions")
          .font(.headline)
        Spacer()
        Text("$" + formatMoney(entry.globalCost))
          .font(.caption)
      }

      Divider()

      // Session list
      ForEach(entry.sessions.prefix(5)) { session in
        SessionRow(session: session)
      }

      if entry.sessions.count > 5 {
        Text("+" + (entry.sessions.count - 5) + " more")
          .font(.caption)
          .foregroundColor(.secondary)
      }

      Divider()

      // Footer
      HStack {
        Text("Budget: " + entry.budgetRemaining + "h left")
          .font(.caption)
      }
    }
    .padding()
  }
}

struct SessionRow: View {
  session: SessionSummary

  var body: some View {
    HStack {
      // Health indicator
      Circle()
        .fill(healthColor(session.health))
        .frame(width: 8, height: 8)

      // Project name
      Text(session.name)
        .lineLimit(1)

      Spacer()

      // Model
      Text(session.model)
        .font(.caption)
        .foregroundColor(.secondary)

      // Last activity
      Text(session.lastActivity)
        .font(.caption)
        .foregroundColor(.secondary)

      // Sync indicator
      if !session.synced {
        Image(systemName: "exclamationmark.triangle")
          .foregroundColor(.yellow)
      }
    }
  }

  func healthColor(_ status: String) -> Color {
    switch status {
      case "healthy": return .green
      case "warning": return .yellow
      case "critical": return .red
      default: return .gray
    }
  }
}

// Widget Configuration (for toggling components)
struct ConfigurationIntent: WidgetConfigurationIntent {
  @Parameter(title: "Show Directory")
  var showDirectory: Bool = true

  @Parameter(title: "Show Git")
  var showGit: Bool = true

  @Parameter(title: "Show Model")
  var showModel: Bool = true

  // ... etc for each component
}

// Intent handler writes to config.json
struct IntentHandler: INExtension {
  func handle(intent: ConfigurationIntent, completion: @escaping () -> Void) {
    let config = StatuslineConfig(
      components: ComponentsConfig(
        directory: intent.showDirectory,
        git: intent.showGit,
        model: intent.showModel,
        // ... etc
      )
    )

    let configPath = homeDir + "/.claude/session-health/config.json"
    writeFile(configPath, toJson(config))

    completion()
  }
}
```

---

## Testing Pseudocode

### Unit Tests
```
describe "HealthStore":
  test "creates directory if not exists":
    given: healthDir does not exist
    when: healthStore.ensureDirectory()
    then: healthDir exists

  test "writes and reads session health":
    given: valid health object
    when: healthStore.writeSessionHealth("session-1", health)
    then: healthStore.readSessionHealth("session-1") equals health

  test "atomic write prevents corruption":
    given: health object
    when: write fails midway
    then: previous file unchanged (temp file deleted)

describe "TranscriptMonitor":
  test "detects missing transcript":
    given: path does not exist
    when: checkHealth(path)
    then: result.exists == false

  test "calculates age correctly":
    given: file modified 5 minutes ago
    when: checkHealth(path)
    then: result.lastModifiedAgo == "5m"

  test "detects stale transcript":
    given: file modified 10 minutes ago
    when: checkHealth(path) with threshold 5 minutes
    then: result.isSynced == false

describe "ModelResolver":
  test "prefers fresh transcript over jsonInput":
    given: transcript with model "Opus4.5" (age: 1 min)
           jsonInput with model "Sonnet4.5"
    when: resolve()
    then: result.value == "Opus4.5", result.source == "transcript"

  test "falls back to jsonInput when transcript stale":
    given: transcript with model "Opus4.5" (age: 2 hours)
           jsonInput with model "Sonnet4.5"
    when: resolve()
    then: result.value == "Sonnet4.5", result.source == "jsonInput"

  test "logs disagreement when sources differ":
    given: transcript "Opus4.5", jsonInput "Sonnet4.5"
    when: resolve()
    then: logger.log called with disagreement message

describe "ThinStatusline":
  test "respects component config":
    given: config.components.git = false
           health with git data
    when: run()
    then: output does not contain "🌿"

  test "shows transcript sync warning":
    given: health.alerts.transcriptStale = true
           health.transcript.lastModifiedAgo = "6m"
    when: formatTranscriptSync(health)
    then: result == "📝:6m⚠"

  test "no trailing newline":
    when: run(validInput)
    then: output does not end with "\n"
```

### Integration Tests
```
describe "Full Flow":
  test "gather → store → read → format":
    given: mock session with transcript
    when:
      gatherer.gather(sessionId, transcriptPath, jsonInput)
      output = thinStatusline.run(jsonInput)
    then:
      health file exists at session-health/[sessionId].json
      output contains expected components

  test "config change affects output":
    given: gathered health data
    when:
      config.components.git = false
      healthStore.writeConfig(config)
      output = thinStatusline.run(jsonInput)
    then:
      output does not contain git info

  test "widget reads correct data":
    given: multiple sessions with health data
    when: widget provider.getTimeline()
    then: entry.sessions matches stored health files
```

---

## File Locations Summary

```
Source Files:
  v2/src/lib/health-store.ts           # Read/write health JSON
  v2/src/lib/transcript-monitor.ts     # Transcript health checks
  v2/src/lib/data-gatherer.ts          # Orchestrate gathering
  v2/src/lib/model-resolver.ts         # Multi-source model resolution
  v2/src/statusline-thin.ts            # Thin statusline entry point

  widget/SessionHealthWidget/          # SwiftUI widget project
    Sources/
      SessionHealthWidget.swift
      Provider.swift
      Views/SessionRow.swift
      IntentHandler.swift

Test Files:
  v2/tests/health-store.test.ts
  v2/tests/transcript-monitor.test.ts
  v2/tests/data-gatherer.test.ts
  v2/tests/model-resolver.test.ts
  v2/tests/statusline-thin.test.ts
  v2/tests/integration/full-flow.test.ts

Data Files (runtime):
  ~/.claude/session-health/
    sessions.json
    config.json
    [session-id].json
```

---

**Status**: Pseudocode Complete - Ready for Test Implementation
