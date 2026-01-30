# Review: Transcript Sync & Data Loss Detection

## Actual Transcript Structure

### Path Convention
```
~/.claude/projects/-[encoded-path]/[session-id].jsonl
Example: ~/.claude/projects/-Users-vmks--IT-Projects--dev-tools-ai-agile-claude-code-statusline/e369e237-5058-4153-9f38-2cf530b597a3.jsonl
```

### JSONL Entry Types Observed
| Type | Fields | Purpose |
|------|--------|---------|
| `file-history-snapshot` | messageId, snapshot, isSnapshotUpdate | File state tracking |
| `user` | role, content, uuid, timestamp, parentUuid | User messages |
| `assistant` | message.model, message.id, content, timestamp | Claude responses |
| `system` | subtype (turn_duration), durationMs, timestamp | Session metadata |
| `progress` | timestamp | Intermediate updates |

### Key Observations
1. **Update frequency:** Claude Code updates transcript on EVERY message exchange
2. **Progress entries:** Written multiple times per second during active response
3. **Model in `assistant` type only:** `message.model` field present in assistant messages
4. **Timestamp format:** ISO 8601 (e.g., `2026-01-30T10:44:26.772Z`)
5. **File sizes:** Range from 2KB (single exchange) to 24MB+ (long sessions)
6. **Line count estimation:** ~1KB per line average (code confirms this at line 78)

## Staleness Detection Accuracy

### Current Implementation (transcript-monitor.ts)

| Check | Location | Threshold | Assessment |
|-------|----------|-----------|------------|
| `isSynced` | L46-47 | <60 seconds | **REASONABLE** - Detects active conversation |
| Health data stale | display-only.ts L301 | 5 minutes | **REASONABLE** - Health JSON refresh interval |
| Transcript stale | config default L259 | 5 minutes | **QUESTIONABLE** - See analysis below |

### 5-Minute Threshold Analysis

**Scenario A - Active Typing Session:**
- User types a message, waits to think for 3-4 minutes
- Transcript NOT updated (no interaction with Claude)
- 5-minute threshold could trigger FALSE POSITIVE

**Scenario B - Reading Long Response:**
- Claude generates long response
- User reads for 6 minutes without action
- Transcript was updated at END of response
- 5-minute threshold triggers - CORRECT behavior

**Scenario C - Actual Stale/Crashed Session:**
- Session hung, no updates for 30 minutes
- 5-minute threshold triggers - CORRECT behavior

**Verdict:** 5 minutes is aggressive. Consider 10-15 minutes to reduce false positives during normal thinking/reading pauses.

## Data Loss Risk Accuracy

### Current Logic (data-gatherer.ts L283-285)
```typescript
private isSessionActive(jsonInput: ClaudeCodeInput | null): boolean {
  return jsonInput !== null && jsonInput.session_id !== undefined;
}
```

### Triggers When:
1. Transcript older than threshold (5 min)
2. AND session appears active (JSON input received)

### Critical Issue: **Logic is Backwards**
- If we RECEIVE jsonInput, the session IS communicating with Claude Code
- If session communicates, transcript SHOULD be updating
- If transcript stale BUT jsonInput received = contradiction OR network issue

**Real data loss risk scenarios:**
1. Claude Code crashed but terminal still open
2. Network disconnection during response
3. Filesystem full/permission error

**Current detection misses:**
- Can't detect if Claude Code process died (no input = no detection)
- No filesystem health check

## Critical Issues

### 1. data-gatherer.ts:283-285 - Active Session Detection Flawed
```typescript
private isSessionActive(jsonInput: ClaudeCodeInput | null): boolean {
  return jsonInput !== null && jsonInput.session_id !== undefined;
}
```
**Problem:** If we received JSON input, session IS active and syncing. This logic creates false positives for dataLossRisk.
**Impact:** Warning shown when no actual risk exists.

### 2. transcript-monitor.ts:77-78 - Message Count Estimation Inaccurate
```typescript
private estimateMessageCount(sizeBytes: number): number {
  return Math.floor(sizeBytes / 1000);
}
```
**Problem:** Assumes ~1KB per line. Actual lines vary wildly:
- Progress entries: ~100-200 bytes
- User messages: 500-5000 bytes (depends on content)
- Assistant messages: 1000-50000+ bytes
- File-history-snapshot: 200-2000 bytes

**Impact:** Message count displayed can be off by 2-10x.

### 3. display-only.ts:217-223 - fmtTranscriptSync Missing Context
```typescript
function fmtTranscriptSync(h: SessionHealth): string {
  if (!h.transcript?.exists) return `📝:${c('warning')}⚠${rst()}`;
  const ago = h.transcript.lastModifiedAgo || '?';
  if (h.alerts?.dataLossRisk) return `📝:${c('critical')}${ago}🔴${rst()}`;
  if (h.alerts?.transcriptStale) return `📝:${c('warning')}${ago}⚠${rst()}`;
  return `📝:${c('transcript')}${ago}${rst()}`;
}
```
**Problem:** Shows staleness warning without context. User may not understand why warning appears during normal reading pause.

## Important Issues

### 1. transcript-monitor.ts:84-101 - Inefficient Large File Handling
```typescript
private getLastTimestampFromTail(path: string): number {
  const content = readFileSync(path, 'utf-8');  // Reads ENTIRE file
  const lastChunk = content.slice(-readSize);   // Then slices
```
**Problem:** Reads entire file into memory, then slices. For 24MB files, wastes memory.
**Fix:** Use Bun's streaming API or file descriptors to read only last N bytes.

### 2. data-gatherer.ts:141-147 - Configurable Threshold Not Used Consistently
```typescript
const config = this.healthStore.readConfig();
health.alerts.transcriptStale = this.transcriptMonitor.isTranscriptStale(
  health.transcript,
  config.thresholds.transcriptStaleMinutes
);
```
**Problem:** Threshold comes from config, but default (5 min) may be inappropriate.
**Note:** This is just configuration concern, not a bug.

### 3. model-resolver.ts:160-184 - Reads Entire Transcript for Model
**Problem:** For 24MB transcript, reads entire file just to find model in last few messages.
**Mitigation exists:** Slices last 50KB (L163), but still reads whole file first.

## Gaps

### 1. No Heartbeat Detection
- Can't detect if Claude Code process is alive without receiving JSON input
- If user closes terminal, stale transcript persists with no warning

### 2. No Filesystem Health Check
- Doesn't verify write permissions before claiming "synced"
- Doesn't check disk space

### 3. No Crash Recovery Detection
- Can't distinguish "reading long response" from "session crashed"
- Both show same staleness indicator

## Recommendations

### Priority 1: Fix dataLossRisk Logic
```typescript
// Only flag risk if transcript stale AND we haven't received recent input
hasDataLossRisk(health: TranscriptHealth, lastInputTime: number, thresholdMinutes: number): boolean {
  const transcriptStale = this.isTranscriptStale(health, thresholdMinutes);
  const inputRecent = (Date.now() - lastInputTime) < thresholdMinutes * 60 * 1000;
  // Risk = transcript stale AND we're not receiving input (session might be dead)
  return transcriptStale && !inputRecent;
}
```

### Priority 2: Increase Default Staleness Threshold
Change `transcriptStaleMinutes` from 5 to 10 or 15 minutes to reduce false positives during normal reading/thinking pauses.

### Priority 3: Optimize Large File Reading
Use Bun's file streaming or `read()` with offset to avoid loading entire transcript into memory.

### Priority 4: Add Context to Staleness Warning
Display "📝:8m (reading?)" instead of just "📝:8m⚠" to indicate staleness might be normal.

## Summary

**Overall Assessment:** FUNCTIONAL but with logical flaws

**Transcript Structure Understanding:** ACCURATE - correctly identifies JSONL format, types, and timestamp location.

**Staleness Detection:** PARTIALLY ACCURATE
- File mtime comparison is correct
- 5-minute threshold is aggressive (false positives likely)
- 60-second isSynced threshold is reasonable

**Data Loss Risk Detection:** FLAWED
- Logic inverted: triggers when session IS active (receiving input)
- Should trigger when session appears INACTIVE but transcript stale
- Current implementation creates false positives

**Performance Concerns:**
- Large file handling inefficient (reads entire file into memory)
- Message count estimation unreliable

**Recommendation:** Fix dataLossRisk logic before production deployment. Current implementation may confuse users with false warnings.
