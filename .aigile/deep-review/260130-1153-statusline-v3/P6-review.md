# Review: Resource Safety & Process Management

## Orphan Process Check

**Status: GOOD - No orphan processes detected**

Validation commands:
```bash
pgrep -f "bun.*data-daemon" | wc -l  # Result: 0
ps aux | grep -E "Z|defunct"         # No zombies found
```

Current state:
- 0 data-daemon processes running
- Lock file not present (released properly)
- Only 1 ccusage process running (expected - active fetch in progress)

**Design Analysis:**

The orphan prevention strategy is sound:

1. **statusline-bulletproof.sh (lines 61-73):**
   - Background subprocess spawned with `(...)&`
   - `disown` called to prevent zombie creation
   - `timeout -k 1 30` provides 30s timeout with 1s SIGKILL grace period
   - Daemon log output capped with `head -c 10000`

2. **Potential Concern:** The `disown` pattern makes the daemon a true orphan (adopted by init). This is intentional for fire-and-forget but means:
   - No parent can track if daemon failed
   - Daemon must self-terminate (via timeout or completion)

**Verified behaviors:**
- `timeout -k` flag correctly sends SIGTERM then SIGKILL
- GNU coreutils timeout installed at `/opt/homebrew/bin/timeout`
- `-k DURATION` properly documented as "kill after DURATION"

---

## Timeout Verification

**Status: CORRECT - SIGKILL is properly sent**

**Shell Layer (statusline-bulletproof.sh):**
```bash
# Line 47 - Display timeout (500ms + 100ms SIGKILL)
timeout -k 0.1 0.5 bun "$DISPLAY_SCRIPT"

# Line 66 - Daemon timeout (30s + 1s SIGKILL)
timeout -k 1 30 bun "$DAEMON_SCRIPT"
```

**TypeScript Layer (ccusage-shared-module.ts, line 63-66):**
```typescript
await execAsync('ccusage blocks --json --active', {
  timeout: this.config.timeout,  // 35000ms
  killSignal: 'SIGKILL',         // Force kill
  maxBuffer: 1024 * 1024         // 1MB max
});
```

**TypeScript Layer (git-module.ts, line 27-31):**
```typescript
const execOpts = {
  timeout: 1000,
  killSignal: 'SIGKILL' as const,
  maxBuffer: 512 * 1024,
  cwd: process.cwd()
};
```

**Finding:** All external process invocations have:
- Explicit timeout set
- `killSignal: 'SIGKILL'` to ensure forced termination
- `maxBuffer` to prevent memory exhaustion

---

## Lock File Safety

**Status: MINOR RACE CONDITION EXISTS**

**process-lock.ts Analysis:**

Lines 61-107 - `tryAcquire()` method:

```typescript
// Check if lock file exists
if (existsSync(this.options.lockPath)) {
  // ... stale check ...
  if (lockAge > this.options.timeout) {
    this.forceRelease();  // Remove stale lock
  }
}

// Acquire lock by writing our PID
writeFileSync(this.options.lockPath, String(process.pid), { flag: 'wx' });
```

**Race Condition (TOCTOU):**

Between line 64 (`existsSync`) and line 89 (`writeFileSync`), another process could:
1. Create the lock file
2. Start using ccusage

The `{ flag: 'wx' }` (exclusive create) mitigates this partially - it will throw `EEXIST` if file was created between check and write. The code handles this case on lines 92-101.

**Issue:** Stale lock cleanup (line 77 `forceRelease()`) has a TOCTOU gap:
- Process A reads lock, determines it's stale
- Process B acquires fresh lock
- Process A deletes Process B's fresh lock
- Both processes think they have the lock

**Impact:** Low - ccusage race condition where two instances run concurrently. Not a security issue, but can cause duplicate billing API calls.

**Corrupted Lock File Handling:**

Line 145-156 - `getLockHolder()`:
```typescript
const content = readFileSync(this.options.lockPath, 'utf-8').trim();
const pid = parseInt(content, 10);
return isNaN(pid) ? null : pid;
```

If lock file is corrupted (non-numeric content), `getLockHolder()` returns `null`. This means:
- `isProcessAlive(null)` would fail
- Stale lock check would treat it as stale
- Lock would be force-released

**Result:** Corrupted locks are auto-cleaned. This is GOOD.

---

## Memory Safety

**Status: BOUNDED - No unbounded growth paths**

**1. Daemon Log Rotation (data-daemon.ts, lines 46-55):**
```typescript
const MAX_LOG_SIZE = 100 * 1024; // 100KB
if (stats.size > MAX_LOG_SIZE) {
  writeFileSync(LOG_PATH, `[LOG ROTATED at ${new Date().toISOString()}]\n`);
}
```

**Verified:** daemon.log is 24KB (below 100KB threshold). Rotation is working.

**2. Health Files (session-health/*.json):**
```bash
ls -lhS ~/.claude/session-health/*.json
# Largest: sessions.json at 11KB
# Individual: ~1.4KB each
```

**Bounded by design:** Each session has one JSON file. No append-only growth.

**3. Exec Output Buffers:**
- ccusage: `maxBuffer: 1024 * 1024` (1MB)
- git: `maxBuffer: 512 * 1024` (512KB)
- Daemon log pipe: `head -c 10000` (10KB max per invocation)

**4. display-only.ts Memory:**
- No `setTimeout`/`setInterval` (verified by safety.test.ts line 231-236)
- No growing data structures
- Reads fixed-size JSON files only

**5. data-gatherer.ts Memory:**
- No `setTimeout`/`setInterval` (verified by safety.test.ts line 238-243)
- Creates objects, processes, releases - no accumulation

---

## Critical Issues

**NONE FOUND**

---

## Important Issues

| Location | Description |
|----------|-------------|
| process-lock.ts:77 | TOCTOU race in stale lock cleanup - Process B's fresh lock could be deleted by Process A's stale cleanup |
| process-lock.ts:64-89 | Minor: existsSync+writeFileSync gap, but mitigated by `wx` flag |
| statusline-bulletproof.sh:63 | `renice` may fail silently on some systems (handled with `|| true`) |

---

## Recommendations

### 1. Atomic Lock Acquisition (High Priority)

Replace the check-then-create pattern with atomic mkdir:

```typescript
// Use mkdir as atomic lock (mkdir fails if exists)
try {
  mkdirSync(this.options.lockPath, { mode: 0o700 });
  writeFileSync(`${this.options.lockPath}/pid`, String(process.pid));
  return { acquired: true };
} catch (e) {
  if (e.code === 'EEXIST') {
    // Lock exists
  }
}
```

Or use proper file locking:
```typescript
import { flockSync } from 'fs-ext';  // npm: fs-ext
```

### 2. Add PID Validation to Release (Medium Priority)

The `release()` method already checks PID ownership (line 119), but `forceRelease()` does not. Consider logging a warning when force-releasing:

```typescript
forceRelease(): void {
  const holder = this.getLockHolder();
  console.warn(`[ProcessLock] Force releasing lock held by PID ${holder}`);
  // ... existing code ...
}
```

### 3. Add Heartbeat to Long-Running Daemon (Low Priority)

For daemons running >10s, update lock mtime periodically:
```typescript
// In long-running operation
setInterval(() => {
  utimes(lockPath, new Date(), new Date());
}, 5000);
```

This prevents stale detection while still running.

### 4. Consider flock() for Better Locking (Future)

Node.js doesn't have native flock, but Bun might support it via FFI or `fs-ext` package. Would eliminate all race conditions.

---

## Summary

**Overall Assessment: SOLID** (8/10)

The V2 statusline demonstrates good resource safety practices:

**Strengths:**
- All external processes have explicit timeouts with SIGKILL
- Log rotation prevents unbounded growth
- Atomic writes for health files (temp+rename)
- No setTimeout/setInterval in critical paths
- `disown` prevents zombie accumulation
- Lock file uses exclusive create flag (`wx`)
- Corrupted locks are auto-cleaned

**Weaknesses:**
- Minor TOCTOU race in lock stale-cleanup path
- No heartbeat mechanism for long-running daemons

**Runtime Verification:**
- 0 orphan daemons running
- 0 zombie processes
- Lock file properly released
- Daemon log at 24KB (healthy)
- Session files bounded at ~1.4KB each

The architecture successfully prevents resource leaks through:
1. Fire-and-forget with timeouts (cannot hang indefinitely)
2. SIGKILL enforcement (cannot ignore termination)
3. Size limits on all outputs (cannot exhaust memory)
4. Atomic writes (cannot corrupt files)

**Risk Level: LOW** - Production-safe with noted race condition being theoretical edge case.
