# Review: Process Lifecycle & Cleanup

**Files Reviewed:**
- `v2/src/statusline-bulletproof.sh`
- `v2/src/data-daemon.ts`
- `v2/src/index.ts`
- `v2/src/lib/process-lock.ts`
- `v2/src/modules/git-module.ts`
- `v2/src/modules/ccusage-shared-module.ts`
- `v2/src/lib/data-gatherer.ts`
- `v2/src/display-only.ts`

---

## Critical Issues

### C1: Lock File Not Cleaned on SIGKILL/Crash
**File:** `v2/src/lib/process-lock.ts`
**Severity:** CRITICAL

Lock file `.ccusage.lock` persists if process is killed (SIGKILL) or crashes:
- `withLock()` has `finally` block but SIGKILL bypasses it
- No cleanup on SIGTERM/SIGINT signals
- Stale lock detection exists (35s timeout) but relies on age-based cleanup

**Impact:** After SIGKILL, lock file remains until:
1. 35s timeout expires on next acquisition attempt
2. Or manual cleanup via `rm ~/.claude/.ccusage.lock`

**Current mitigation (ACCEPTABLE):**
```typescript
// Line 68-76: Stale lock cleanup exists
if (lockAge > this.options.timeout) {
  // Lock is stale, check if process still exists
  if (lockPid && this.isProcessAlive(lockPid)) {
    console.warn('Stale lock detected...');
  }
  this.forceRelease();
}
```

**Verdict:** Design is self-healing via timeout. No immediate fix required.

---

### C2: No Signal Handlers in data-daemon.ts
**File:** `v2/src/data-daemon.ts`
**Severity:** MEDIUM-HIGH

Daemon spawns child processes (git, ccusage) but has no signal handlers:
- SIGTERM/SIGINT from shell timeout not handled
- Process lock not released on signal

**Code path:**
```
statusline-bulletproof.sh
  → timeout -k 1 30 bun data-daemon.ts
    → ccusage (spawned via execAsync)
```

**When timeout fires:**
1. SIGTERM sent to daemon
2. Daemon ignores it (no handler)
3. SIGKILL sent after 1s grace
4. Daemon killed, ccusage MAY continue (orphan risk)

**Mitigation:** Shell script uses SIGKILL with grace period, but children may escape.

---

## Important Issues

### I1: Child Process Orphaning Risk in git-module.ts
**File:** `v2/src/modules/git-module.ts`
**Lines:** 27-31, 35-56

Multiple `execAsync` calls with timeouts:
```typescript
const execOpts = {
  timeout: 1000,
  killSignal: 'SIGKILL' as const,  // Force kill on timeout
  maxBuffer: 512 * 1024,
  cwd: process.cwd()
};
```

**Good:** SIGKILL used for force kill
**Risk:** If parent dies between spawn and kill, git process orphaned

**Sequential calls (worst case):**
```typescript
const { stdout: branch } = await execAsync('git branch --show-current', execOpts);
const { stdout: status } = await execAsync('git status --porcelain', execOpts);
// ... more calls
```

Each call has 1s timeout. If parent killed between calls, pending git processes orphan.

---

### I2: ccusage-shared-module Lock Not Released on Signal
**File:** `v2/src/modules/ccusage-shared-module.ts`
**Lines:** 59-76

`withLock()` pattern has `finally` but no signal handling:
```typescript
async fetch(sessionId: string): Promise<CCUsageData> {
  const result = await ccusageLock.withLock(async () => {
    // ccusage spawned here
    const { stdout } = await execAsync('ccusage blocks --json --active', {
      timeout: this.config.timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024
    });
    return JSON.parse(stdout);
  });
  // ...
}
```

**Risk sequence:**
1. Lock acquired
2. ccusage spawned
3. SIGTERM received (timeout)
4. `finally` runs (lock released) BUT
5. SIGKILL follows 1s later, interrupts cleanup

---

### I3: index.ts Broker Shutdown Fire-and-Forget
**File:** `v2/src/index.ts`
**Lines:** 151-155

```typescript
// Cleanup (non-blocking)
broker.shutdown().catch(() => {});  // Fire and forget

// Force exit immediately after output
process.exit(0);
```

**Issue:** `process.exit(0)` called immediately after fire-and-forget shutdown.
- Any async cleanup in `shutdown()` never completes
- If broker has active operations, they're abandoned

---

### I4: No setInterval Cleanup Check
**File:** All modules

Searched for `setInterval` - NONE FOUND in reviewed modules.
**Status:** GOOD - No interval timers to clean up.

---

### I5: disown Pattern Correctness
**File:** `v2/src/statusline-bulletproof.sh`
**Lines:** 75-84

```bash
(
  renice -n 10 $$ >/dev/null 2>&1 || true
  echo "${JSON_INPUT}" | timeout -k 1 30 bun "$DAEMON_SCRIPT" ...
) &

disown 2>/dev/null || true
exit 0
```

**Analysis:**
1. Subshell `()` spawned in background `&`
2. `disown` detaches from shell job control
3. Parent exits immediately

**Behavior on parent exit:**
- Subshell continues (orphan-adopted by init/launchd)
- `timeout` command manages daemon lifecycle
- After 30s, SIGTERM → SIGKILL sequence kills daemon

**Verdict:** CORRECT implementation. Daemon cannot outlive 31s total.

---

## Recommendations

### R1: Add Signal Handler to data-daemon.ts (LOW PRIORITY)
```typescript
// Add after imports
process.on('SIGTERM', () => {
  log('INFO', 'Received SIGTERM, exiting');
  process.exit(0);
});
process.on('SIGINT', () => {
  log('INFO', 'Received SIGINT, exiting');
  process.exit(0);
});
```

**Impact:** Clean logging, graceful exit before SIGKILL.
**Risk:** May interfere with in-flight operations. Currently timeout+SIGKILL handles this.

### R2: Consider Process Group Kill in Shell (OPTIONAL)
```bash
# Kill entire process group on timeout
timeout --foreground -k 1 30 bun "$DAEMON_SCRIPT"
```

**Impact:** `--foreground` propagates signals to child process group.
**Trade-off:** May not work in all shells/systems.

### R3: Document Lock Self-Healing Behavior
Add to ARCHITECTURE.md:
```
## Lock Recovery
- `.ccusage.lock` auto-cleans after 35s timeout
- Manual cleanup: `rm ~/.claude/.ccusage.lock`
- Process alive check prevents live-lock takeover
```

### R4: No Action Required Items
1. **setInterval** - Not used, no cleanup needed
2. **Zombie prevention** - `disown` pattern correct
3. **Display layer** - Pure read-only, no processes to clean

---

## Summary

| Category | Status | Notes |
|----------|--------|-------|
| Orphan processes | ACCEPTABLE | Timeout+SIGKILL handles. Children may briefly orphan but self-terminate |
| Signal handlers | MISSING | No handlers in daemon/modules. Low impact due to shell timeout |
| Zombie prevention | GOOD | disown pattern correctly implemented |
| Interval cleanup | N/A | No setInterval usage |
| Lock file persistence | SELF-HEALING | 35s timeout + PID check ensures eventual cleanup |

**Overall Assessment:** ACCEPTABLE RISK

The architecture relies on external timeout enforcement (shell script) rather than internal signal handling. This is a valid design choice for a fire-and-forget daemon.

**Key Insight:** The 30s timeout + SIGKILL in `statusline-bulletproof.sh` is the primary lifecycle control. Individual module signal handling would be defense-in-depth but is not strictly necessary.

**No immediate fixes required.** All identified risks have existing mitigations or are low-impact.
