# Review: Cache & Multi-Instance Coordination

## Files Analyzed
- `/v2/src/lib/health-store.ts` - Per-session and shared data persistence
- `/v2/src/lib/data-gatherer.ts` - Data orchestration, billing cache logic
- `/v2/src/modules/ccusage-shared-module.ts` - ccusage fetch with locking
- `/v2/src/lib/process-lock.ts` - System-wide filesystem mutex

---

## Race Conditions

### 1. **billing-shared.json Write Race (CRITICAL)**

**Location:** `data-gatherer.ts:144-146`
```
writeFileSync(sharedBillingPath, JSON.stringify(health.billing), { mode: 0o600 });
```

**Issue:** Direct `writeFileSync` - NOT atomic. 10 sessions writing simultaneously can corrupt file.

**Scenario:**
1. Session A reads billing, starts write
2. Session B reads billing, starts write
3. Interleaved writes = corrupted JSON

**Contrast:** `health-store.ts` uses `atomicWrite()` (temp+rename pattern) but billing-shared.json bypasses this.

### 2. **Shared Billing Read-Modify-Write Race (MEDIUM)**

**Location:** `data-gatherer.ts:112-163`

**Issue:** No read lock. Sequence:
1. Session A reads stale shared billing
2. Session B fetches fresh data, writes
3. Session A overwrites with stale data (if its fetch succeeds later)

**Mitigation partial:** Fresh check `< 120000` prevents some overwrites, but window exists.

### 3. **Session Health TOCTOU (LOW)**

**Location:** `health-store.ts:88-105`

```typescript
if (!existsSync(filePath)) {
  return null;
}
const content = readFileSync(filePath, 'utf-8');
```

**Issue:** Time-of-check-to-time-of-use. File can be deleted between check and read.

**Impact:** Low - returns null, graceful degradation.

---

## Lock Issues

### 1. **Lock Holder Crash Mid-Hold (HANDLED)**

**Location:** `process-lock.ts:69-86`

**Design:** Stale lock detection via mtime + process alive check.

**Good:**
- Checks `lockAge > timeout` (35s default)
- Validates PID exists via `process.kill(pid, 0)`
- Force releases if stale

**Issue:** 35s timeout may be too long for crashed process scenarios. User waits 35s before stale detection.

### 2. **Lock Acquisition Race (HANDLED)**

**Location:** `process-lock.ts:89`

```typescript
writeFileSync(this.options.lockPath, String(process.pid), { flag: 'wx' });
```

**Good:** Uses `wx` flag (exclusive create) - atomic on most filesystems.

**Issue:** POSIX advisory locks would be more robust than file-based. Current approach works but is filesystem-dependent.

### 3. **Lock Not Held During Shared Cache Write (CRITICAL)**

**Location:** `data-gatherer.ts:144-146`

Lock is released by `ccusageModule.fetch()` BEFORE shared cache write happens:

```typescript
// ccusageModule.fetch() acquires/releases lock internally
const billingData = await this.ccusageModule.fetch(sessionId);
if (billingData && billingData.isFresh) {
  // ... build health.billing ...
  writeFileSync(sharedBillingPath, ...);  // Lock already released!
}
```

**Result:** Multiple sessions can race to write billing-shared.json after lock release.

### 4. **maxRetries Too Low (MEDIUM)**

**Location:** `process-lock.ts:34`

```typescript
maxRetries: options.maxRetries || 3  // Only retry 3 times (300ms total)
```

**Issue:** ccusage takes 20-30s. With 3 retries at 100ms interval, waiting 300ms is insufficient. Sessions will frequently give up and use stale data.

---

## Stale Detection

### 1. **2-Minute Billing TTL Assessment**

**Location:** `data-gatherer.ts:119-120`

```typescript
const sharedFresh = sharedBilling?.lastFetched &&
                   (Date.now() - sharedBilling.lastFetched) < 120000;
```

**Assessment:**
- ccusage billing block is 5-hour period
- Cost accrues throughout session
- 2-minute TTL = up to 120s stale cost data

**Appropriateness:** Reasonable tradeoff. More frequent = more ccusage calls. Less frequent = stale display.

**Recommendation:** Consider variable TTL based on burn rate. High activity = shorter TTL.

### 2. **Session Health Stale Check**

**Location:** `health-store.ts:296-302`

```typescript
isStale(sessionId: string, maxAgeMs: number = 30000): boolean {
  const health = this.readSessionHealth(sessionId);
  if (!health) { return true; }
  return (Date.now() - health.gatheredAt) > maxAgeMs;
}
```

**Good:** 30s default appropriate for display layer.

---

## Session Cleanup

### 1. **No Cleanup Timer (ISSUE)**

**Finding:** No automatic cleanup of old session health files.

**Evidence:** `listSessionIds()` returns all `.json` files except `sessions.json`, `config.json`, `alerts.json`.

**Impact:** Unbounded growth if sessions accumulate:
```
~/.claude/session-health/
  session-abc123.json
  session-def456.json
  ... (hundreds over time)
```

### 2. **deleteSession Exists But Unused**

**Location:** `health-store.ts:286-291`

Method exists but no caller identified in reviewed code. Cleanup must be manual.

---

## Shared vs Session Data

### 1. **Clear Separation (GOOD)**

**Shared (global):**
- `billing-shared.json` - Cross-session billing cache
- `sessions.json` - Global summary
- `config.json` - User preferences

**Per-session:**
- `{sessionId}.json` - Individual health data

### 2. **Cross-Contamination Risk (LOW)**

**Location:** `data-gatherer.ts:124`

```typescript
health.billing = { ...sharedBilling };
```

**Analysis:** Object spread creates shallow copy. Billing has no nested mutable objects, so this is safe.

### 3. **Session ID Collision (THEORETICAL)**

**Risk:** If two Claude Code instances use same session ID:
- They write to same health file
- Last-write-wins semantics

**Mitigation:** Claude Code generates unique session IDs. Low practical risk.

---

## Recommendations

### Critical (Fix Immediately)

1. **Use atomicWrite for billing-shared.json**
   ```
   // data-gatherer.ts:144-146
   // Replace writeFileSync with health store's atomicWrite pattern
   ```

2. **Hold lock during shared cache write**
   ```
   // Either:
   // a) Move shared cache write inside ccusage module
   // b) Return lock and let caller write within scope
   ```

### High Priority

3. **Increase maxRetries or implement exponential backoff**
   - Current 300ms total wait insufficient for 20-30s ccusage
   - Consider: 5 retries with doubling interval (100, 200, 400, 800, 1600 = 3.1s)

4. **Implement session cleanup**
   ```
   // On daemon start: cleanup sessions older than 7 days
   // Or: lazy cleanup when file count > 100
   ```

### Medium Priority

5. **Variable billing TTL based on burn rate**
   - Low activity (< $1/h): 5 minute TTL
   - High activity (> $5/h): 1 minute TTL

6. **Reduce stale lock timeout for crashed processes**
   - Consider 10s initial check, 35s full timeout
   - Or: Use proper advisory locks (flock)

### Low Priority

7. **Add lock metrics for observability**
   - Track lock contention frequency
   - Log to daemon.log for troubleshooting

---

## Summary

| Category | Status | Issues |
|----------|--------|--------|
| Race Conditions | **HIGH RISK** | billing-shared.json non-atomic write, lock released before cache write |
| Lock Mechanism | Adequate | File-based works, but not held during critical section |
| Stale Detection | Good | 2-min TTL reasonable for use case |
| Session Cleanup | **MISSING** | No automatic cleanup, unbounded growth |
| Data Separation | Good | Clear shared vs session boundary |

**Overall Assessment:** Architecture is sound but has one critical gap - the billing-shared.json write path bypasses atomic write protections and occurs outside the lock scope. High-concurrency scenarios (10+ sessions) will experience data corruption under load.

**Priority Fixes:**
1. atomicWrite for billing-shared.json
2. Extend lock scope to include cache write
3. Add session cleanup mechanism
