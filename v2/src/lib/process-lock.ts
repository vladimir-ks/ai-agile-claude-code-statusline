/**
 * Process Lock - System-Wide Mutex for ccusage
 *
 * Prevents multiple statusline processes from spawning concurrent ccusage calls.
 * Uses filesystem-based locking with atomic operations and stale lock cleanup.
 *
 * CRITICAL: Solves the race condition where 10+ statusline invocations
 * each spawn their own ccusage, consuming 100%+ CPU each.
 */

import { existsSync, statSync, writeFileSync, unlinkSync, readFileSync } from 'fs';

interface LockOptions {
  lockPath: string;
  timeout: number;      // Max age of lock before considering it stale
  retryInterval: number; // How often to check if lock is released
  maxRetries: number;   // Max attempts to acquire lock
}

interface LockResult {
  acquired: boolean;
  reason?: string;
  lockHolder?: number;  // PID of process holding lock
}

class ProcessLock {
  private options: LockOptions;

  constructor(options: Partial<LockOptions> = {}) {
    this.options = {
      lockPath: options.lockPath || `${process.env.HOME}/.claude/.ccusage.lock`,
      timeout: options.timeout || 60000,  // 60s timeout (ccusage can take 25-35s, allow buffer for lock holder)
      retryInterval: options.retryInterval || 5000,  // 5s between retries
      maxRetries: options.maxRetries || 15  // Total ~75s of attempts
    };
  }

  /**
   * Acquire lock (non-blocking with fast retries)
   */
  async acquire(): Promise<LockResult> {
    for (let attempt = 0; attempt < this.options.maxRetries; attempt++) {
      const result = this.tryAcquire();
      if (result.acquired) {
        return result;
      }

      // Wait briefly before retrying
      if (attempt < this.options.maxRetries - 1) {
        await this.sleep(this.options.retryInterval);
      }
    }

    // Final attempt failed
    return { acquired: false, reason: 'Max retries exceeded' };
  }

  /**
   * Try to acquire lock once (atomic check-and-set)
   */
  private tryAcquire(): LockResult {
    try {
      // Check if lock file exists
      if (existsSync(this.options.lockPath)) {
        const lockAge = Date.now() - statSync(this.options.lockPath).mtimeMs;
        const lockPid = this.getLockHolder();

        // CRITICAL: First check if the process holding the lock is still alive
        // This handles the case where a process crashes without releasing the lock
        if (lockPid && !this.isProcessAlive(lockPid)) {
          // Process is dead, release its lock
          console.warn(`[ProcessLock] Lock held by dead process ${lockPid}, releasing`);
          this.forceRelease();
        } else if (lockAge > this.options.timeout) {
          // Lock is stale by time, check if process still exists
          if (lockPid && this.isProcessAlive(lockPid)) {
            // Process exists but lock is old - force release
            console.warn(`[ProcessLock] Stale lock detected (${lockAge}ms old), PID ${lockPid} still alive, forcing release`);
          }

          // Remove stale lock
          this.forceRelease();
        } else {
          // Lock is fresh AND process is alive - someone else is using it
          return {
            acquired: false,
            reason: `Lock held by PID ${lockPid} (age: ${lockAge}ms)`,
            lockHolder: lockPid
          };
        }
      }

      // Acquire lock by writing our PID
      writeFileSync(this.options.lockPath, String(process.pid), { flag: 'wx' });
      return { acquired: true };

    } catch (error: any) {
      // EEXIST means someone else created the lock between our check and write
      if (error.code === 'EEXIST') {
        const lockPid = this.getLockHolder();
        return {
          acquired: false,
          reason: 'Lock acquired by another process during race',
          lockHolder: lockPid
        };
      }

      // Other errors (permissions, disk full, etc.)
      console.error(`[ProcessLock] Error acquiring lock:`, error);
      return { acquired: false, reason: error.message };
    }
  }

  /**
   * Release lock (safe - only if we own it)
   */
  release(): void {
    try {
      if (!existsSync(this.options.lockPath)) {
        return;  // Lock already released
      }

      const lockPid = this.getLockHolder();
      if (lockPid === process.pid) {
        unlinkSync(this.options.lockPath);
      } else {
        console.warn(`[ProcessLock] Attempted to release lock owned by PID ${lockPid} (we are ${process.pid})`);
      }
    } catch (error) {
      // Ignore errors on release (lock may have been cleaned up already)
    }
  }

  /**
   * Force release lock (unsafe - for cleanup only)
   */
  forceRelease(): void {
    try {
      if (existsSync(this.options.lockPath)) {
        unlinkSync(this.options.lockPath);
      }
    } catch (error) {
      // Ignore errors
    }
  }

  /**
   * Get PID of process holding lock
   */
  private getLockHolder(): number | null {
    try {
      if (!existsSync(this.options.lockPath)) {
        return null;
      }

      const content = readFileSync(this.options.lockPath, 'utf-8').trim();
      const pid = parseInt(content, 10);
      return isNaN(pid) ? null : pid;
    } catch (error) {
      return null;
    }
  }

  /**
   * Check if process is still alive
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // Send signal 0 to check if process exists (doesn't actually send a signal)
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Execute function with lock held
   */
  async withLock<T>(fn: () => Promise<T>): Promise<T | null> {
    const lockResult = await this.acquire();

    if (!lockResult.acquired) {
      console.warn(`[ProcessLock] Failed to acquire lock: ${lockResult.reason}`);
      return null;  // Return null instead of throwing
    }

    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

export default ProcessLock;
export { LockOptions, LockResult };
