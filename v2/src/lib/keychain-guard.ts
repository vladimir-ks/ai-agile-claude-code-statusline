/**
 * Keychain Lock Guard — Prevents macOS SecurityAgent dialog spam
 *
 * PROBLEM: When login keychain is locked (sleep/screensaver/idle), any
 * `security find-generic-password` call triggers an interactive dialog.
 * With multiple sessions calling in parallel, this floods the screen.
 *
 * SOLUTION: Check `security show-keychain-info` first — it's instant,
 * non-interactive, and returns exit code 0 iff keychain is unlocked.
 *
 * Cache: result cached for 30s to avoid redundant checks within a run.
 *
 * Pattern reference: ~/\_claude-configs/hot-swap/scripts/lib/common.sh → _hs_keychain_unlocked()
 */

import { execSync } from 'child_process';

let _cache: { unlocked: boolean; expiresAt: number } | null = null;

/**
 * Check if macOS login keychain is unlocked.
 * Non-interactive, instant. Safe to call from any context.
 * Returns true if unlocked, false if locked or on non-macOS.
 */
export function isKeychainUnlocked(): boolean {
  if (_cache && Date.now() < _cache.expiresAt) {
    return _cache.unlocked;
  }

  const TTL = 30_000;

  try {
    execSync('security show-keychain-info login.keychain-db 2>/dev/null', {
      timeout: 2000,
      stdio: 'ignore',
    });
    _cache = { unlocked: true, expiresAt: Date.now() + TTL };
    return true;
  } catch {
    // Fallback: some systems use login.keychain (without -db suffix)
    try {
      execSync('security show-keychain-info login.keychain 2>/dev/null', {
        timeout: 2000,
        stdio: 'ignore',
      });
      _cache = { unlocked: true, expiresAt: Date.now() + TTL };
      return true;
    } catch {
      _cache = { unlocked: false, expiresAt: Date.now() + TTL };
      return false;
    }
  }
}

/** Clear the cache (for testing). */
export function clearKeychainGuardCache(): void {
  _cache = null;
}
