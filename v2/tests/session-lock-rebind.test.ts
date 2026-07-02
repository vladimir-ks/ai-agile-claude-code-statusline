/**
 * Regression: a session resumed in a DIFFERENT slot must rebind its lock's slot
 * identity (slotId/configDir/keychainService/email) to the current detection.
 *
 * Bug (QR-P1): getOrCreate treated slot identity as immutable — a session launched
 * in slot-2, later resumed under slot-1 (claude --resume with CLAUDE_CONFIG_DIR=S1),
 * kept rendering 👤S2|<old email> on the statusline forever.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import SessionLockManager from '../src/lib/session-lock-manager';

const SID = 'test-rebind-0702';
const LOCK = `${homedir()}/.claude/session-health/${SID}.lock`;

function cleanup() {
  try { if (existsSync(LOCK)) unlinkSync(LOCK); } catch { /* ignore */ }
}

describe('SessionLockManager slot rebind on resume-in-different-slot', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test('rebinds slotId/configDir/email when current detection differs', () => {
    const first = SessionLockManager.create(
      SID, 'slot-2', '/cfg/slots/S2/general', 'kc-S2', 'old@ex.com', '/t/S2.jsonl'
    );
    expect(first.slotId).toBe('slot-2');

    const rebound = SessionLockManager.getOrCreate(
      SID, 'slot-1', '/cfg/slots/S1/general', 'kc-S1', 'new@ex.com', '/t/S1.jsonl'
    );
    expect(rebound.slotId).toBe('slot-1');
    expect(rebound.configDir).toBe('/cfg/slots/S1/general');
    expect(rebound.keychainService).toBe('kc-S1');
    expect(rebound.email).toBe('new@ex.com');
    expect(rebound.transcriptPath).toBe('/t/S1.jsonl');
    // session identity preserved
    expect(rebound.sessionId).toBe(SID);
    expect(rebound.launchedAt).toBe(first.launchedAt);
    // persisted, not just returned
    const onDisk = SessionLockManager.read(SID);
    expect(onDisk?.slotId).toBe('slot-1');
    expect(onDisk?.email).toBe('new@ex.com');
  });

  test('same slot → identity untouched', () => {
    const first = SessionLockManager.create(
      SID, 'slot-1', '/cfg/slots/S1/general', 'kc-S1', 'a@ex.com', '/t/a.jsonl'
    );
    const again = SessionLockManager.getOrCreate(
      SID, 'slot-1', '/cfg/slots/S1/general', 'kc-S1', 'a@ex.com', '/t/a.jsonl'
    );
    expect(again.slotId).toBe('slot-1');
    expect(again.email).toBe('a@ex.com');
    expect(again.launchedAt).toBe(first.launchedAt);
  });

  test('degraded detection (empty slotId/configDir) must NOT clobber a good lock', () => {
    SessionLockManager.create(
      SID, 'slot-2', '/cfg/slots/S2/general', 'kc-S2', 'keep@ex.com', '/t/keep.jsonl'
    );
    const kept = SessionLockManager.getOrCreate(SID, '', '', '', '', '');
    expect(kept.slotId).toBe('slot-2');
    expect(kept.configDir).toBe('/cfg/slots/S2/general');
    expect(kept.email).toBe('keep@ex.com');
  });
});
