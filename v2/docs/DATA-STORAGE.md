# Data Storage Architecture

Complete documentation of how statusline data is stored, accessed, and configured.

---

## Storage Locations

### Primary Directory
```
~/.claude/session-health/
├── {session-id}.json          # Per-session health data
├── billing-shared.json         # Shared billing cache (all sessions)
├── sessions.json               # Global summary (all active sessions)
├── config.json                 # User configuration
├── daemon.log                  # Background task log (rotated at 200KB)
└── cooldowns/                  # Cooldown timestamps & state files
    ├── git-status.cooldown     # Git command cooldown (30s)
    ├── billing.cooldown        # Billing fetch cooldown (2min)
    ├── cleanup.cooldown        # Cleanup task cooldown (24h)
    ├── {session-id}-secrets-scan.cooldown   # Per-session secrets cooldown (5min)
    ├── {session-id}-transcript.state        # Incremental scan state
    └── {session-id}-gitleaks.state          # GitLeaks scan state
```

---

## File Formats

### 1. Session Health File (`{session-id}.json`)

**Purpose**: Complete health snapshot for one Claude Code session

**Size**: ~1.6KB per session

**Lifespan**: Deleted after 7 days of inactivity (automatic cleanup)

**Structure**:
```json
{
  "sessionId": "001c1b4d-08a7-4b08-9c43-c3a52bc90e10",
  "projectPath": "/Users/vmks/project",
  "transcriptPath": "/Users/vmks/.claude/projects/-Users-vmks-project/session.jsonl",
  "gatheredAt": 1769818965252,

  "health": {
    "status": "healthy" | "warning" | "critical",
    "lastUpdate": 1769818965252,
    "issues": ["List of issues if any"]
  },

  "transcript": {
    "exists": true,
    "sizeBytes": 524288,
    "lastModified": 1769818900000,
    "lastModifiedAgo": "1m",
    "messageCount": 42,
    "lastMessageTime": 1769818850000,
    "lastMessagePreview": "What does the main function do?",
    "lastMessageAgo": "2m",
    "isSynced": true
  },

  "model": {
    "value": "Opus4.5" | "Sonnet4.5" | "Haiku4.5",
    "source": "jsonInput" | "transcript" | "settings" | "default",
    "confidence": 80,
    "reason": "Current session JSON input"
  },

  "context": {
    "tokensUsed": 45000,
    "tokensLeft": 111000,
    "percentUsed": 28,
    "windowSize": 200000,
    "nearCompaction": false
  },

  "git": {
    "branch": "main",
    "ahead": 2,
    "behind": 0,
    "dirty": 3,
    "lastChecked": 1769818938325
  },

  "billing": {
    "costToday": 40.50,
    "burnRatePerHour": 15.20,
    "budgetRemaining": 180,           // minutes
    "budgetPercentUsed": 45,
    "resetTime": "13:00",
    "totalTokens": 85000000,
    "tokensPerMinute": 12500,
    "isFresh": true,
    "lastFetched": 1769818965000
  },

  "alerts": {
    "secretsDetected": false,
    "secretTypes": [],
    "transcriptStale": false,
    "dataLossRisk": false
  }
}
```

### 2. Billing Shared Cache (`billing-shared.json`)

**Purpose**: Prevent duplicate ccusage calls across sessions

**Size**: ~200 bytes

**Lifespan**: Refreshes every 2 minutes

**Structure**:
```json
{
  "costToday": 40.50,
  "burnRatePerHour": 15.20,
  "budgetRemaining": 180,
  "budgetPercentUsed": 45,
  "resetTime": "13:00",
  "totalTokens": 85000000,
  "tokensPerMinute": 12500,
  "isFresh": true,
  "lastFetched": 1769818965000
}
```

### 3. Global Sessions Summary (`sessions.json`)

**Purpose**: Aggregate view of all active sessions

**Size**: ~50 bytes per session

**Refreshed**: On every daemon run

**Structure**:
```json
{
  "lastUpdated": 1769818965000,
  "activeSessions": 12,
  "totalSessions": 79,
  "sessions": [
    {
      "sessionId": "001c1b4d-...",
      "projectPath": "/Users/vmks/project",
      "lastActive": 1769818900000,
      "health": "critical",
      "model": "Opus4.5"
    }
  ],
  "global": {
    "totalCostToday": 40.50,
    "burnRatePerHour": 15.20,
    "budgetRemaining": 180
  },
  "alerts": {
    "sessionsWithSecrets": 0,
    "sessionsWithDataLoss": 1
  }
}
```

### 4. User Configuration (`config.json`)

**Purpose**: Customize thresholds and behavior

**Size**: ~300 bytes

**Structure**:
```json
{
  "thresholds": {
    "contextWarningPercent": 70,
    "transcriptStaleMinutes": 5
  },
  "components": {
    "directory": true,
    "git": true,
    "model": true,
    "context": true,
    "time": true,
    "budget": true,
    "cost": true,
    "usage": true,
    "cache": true,
    "messageCount": true,
    "transcriptSync": true,
    "lastMessage": true,
    "secrets": true
  },
  "cleanup": {
    "sessionRetentionDays": 7,
    "enableAutoCleanup": true
  }
}
```

### 5. Cooldown Files (`cooldowns/*.cooldown`)

**Purpose**: Prevent duplicate work across sessions

**Size**: ~100 bytes each

**Examples**:

**git-status.cooldown**:
```json
{
  "lastChecked": 1769818965000,
  "repoPath": "/Users/vmks/project",
  "resultHash": "abc123"
}
```

**billing.cooldown**:
```json
{
  "lastChecked": 1769818965000,
  "dataAvailable": true
}
```

### 6. State Files (`cooldowns/*.state`)

**Purpose**: Track incremental processing offsets

**Size**: ~200 bytes each

**{session-id}-transcript.state**:
```json
{
  "lastReadOffset": 524288,
  "lastReadMtime": 1769818900000,
  "messageCount": 42,
  "lastUserMessage": {
    "timestamp": 1769818850000,
    "preview": "What does the main function do?"
  }
}
```

**{session-id}-gitleaks.state**:
```json
{
  "lastScannedOffset": 524288,
  "lastScannedMtime": 1769818900000,
  "knownFindings": [
    "github-pat-abc123",
    "aws-access-xyz789"
  ]
}
```

---

## Data Flow

### Display Layer (Synchronous, <50ms)
```
stdin (JSON from Claude Code)
  ↓
Read {session-id}.json
  ↓
Format statusline
  ↓
stdout
```

### Data Daemon (Background, Fire-and-Forget)
```
stdin (JSON from Claude Code)
  ↓
Check cooldowns
  ↓
Gather data (incremental when possible):
  - Transcript: Incremental scan (only new lines)
  - Model: Extract from JSON/transcript
  - Git: Skip if cooldown active
  - Billing: Skip if cooldown active
  - Secrets: Incremental scan with gitleaks
  ↓
Write {session-id}.json (atomic)
  ↓
Update sessions.json
  ↓
Cleanup (if 24h cooldown expired)
```

---

## Configuration

### Adding Custom Fields

To add custom data to session health:

1. **Extend SessionHealth type** (`v2/src/types/session-health.ts`):
```typescript
export interface SessionHealth {
  // ... existing fields
  customField?: {
    value: any;
    lastUpdated: number;
  };
}
```

2. **Gather data** (`v2/src/lib/data-gatherer.ts`):
```typescript
health.customField = {
  value: await this.fetchCustomData(),
  lastUpdated: Date.now()
};
```

3. **Display** (`v2/src/display-only.ts`):
```typescript
function fmtCustomField(h: SessionHealth): string {
  if (!h.customField) return '';
  return `🔧:${h.customField.value}`;
}
```

### Selective Display

Control what appears in statusline via `config.json`:

```bash
# Disable git info
echo '{"components":{"git":false}}' | jq -s '.[0] * .[1]' ~/.claude/session-health/config.json - > /tmp/config.json
mv /tmp/config.json ~/.claude/session-health/config.json
```

Or programmatically in display-only.ts (line 480):
```typescript
const cfg: ComponentsConfig = { ...DEFAULT_COMPONENTS, ...configRaw?.components };
if (!cfg.git) {
  // Skip git display
}
```

---

## Storage Optimization

### Current Usage (79 sessions)
- Session files: 79 × 1.6KB = 126KB
- Cooldowns: ~30 files × 100B = 3KB
- State files: ~80 files × 200B = 16KB
- Billing/summary: ~1KB
- Logs: ~100KB (rotated)
- **Total: ~250KB**

### Auto-Cleanup (Default Settings)
- Runs daily (24h cooldown)
- Removes sessions >7 days inactive
- Removes orphaned cooldown/state files
- Rotates daemon.log at 200KB

### Manual Cleanup
```bash
# View cleanup stats
bun v2/src/lib/cleanup-manager.ts --stats

# Force cleanup now
bun v2/src/lib/cleanup-manager.ts --force

# Change retention period (config.json)
{
  "cleanup": {
    "sessionRetentionDays": 3,  // Keep only 3 days
    "enableAutoCleanup": true
  }
}
```

---

## Monitoring

### Check Storage Size
```bash
du -sh ~/.claude/session-health/
```

### Count Active Sessions
```bash
ls ~/.claude/session-health/*.json 2>/dev/null | wc -l
```

### View Session Summary
```bash
cat ~/.claude/session-health/sessions.json | jq '.sessions[] | {id: .sessionId, project: .projectPath, health: .health}'
```

### Check Cooldown Status
```bash
# Git cooldown
cat ~/.claude/session-health/cooldowns/git-status.cooldown | jq '.'

# Billing cooldown
cat ~/.claude/session-health/cooldowns/billing.cooldown | jq '.'
```

### Daemon Activity
```bash
# Last 50 lines of daemon log
tail -50 ~/.claude/session-health/daemon.log

# Filter for errors
grep ERROR ~/.claude/session-health/daemon.log

# Filter for specific session
grep "a8e855a4-1b42" ~/.claude/session-health/daemon.log
```

---

## Backup & Export

### Backup All Data
```bash
tar -czf statusline-backup-$(date +%Y%m%d).tar.gz ~/.claude/session-health/
```

### Export to CSV
```bash
# Export session summary to CSV
cat ~/.claude/session-health/sessions.json | jq -r '.sessions[] | [.sessionId, .projectPath, .health, .model] | @csv' > sessions.csv
```

### Import/Restore
```bash
# Restore from backup
tar -xzf statusline-backup-20260131.tar.gz -C ~/
```

---

## Troubleshooting

### Session File Missing
Display shows `⏳` → Health file being created, will appear on next interaction

### Stale Billing (`🔴`)
ccusage lock contention → Another session fetching, data will appear when complete

### Secrets Alert Won't Clear
1. Check state file: `cat ~/.claude/session-health/cooldowns/{session-id}-gitleaks.state`
2. Clear findings: Delete state file, will rescan on next invocation
3. If gitleaks not installed: Falls back to regex (less accurate)

### Cleanup Not Running
Check cooldown: `cat ~/.claude/session-health/cooldowns/cleanup.cooldown`
If >24h old, force cleanup: `rm ~/.claude/session-health/cooldowns/cleanup.cooldown`
