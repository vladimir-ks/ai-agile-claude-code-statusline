/**
 * Change Detector - Hash-based change detection for Durable Object sync
 *
 * Only sync when data actually changed.
 * Uses content hash of significant fields (ignoring timestamps, meta).
 *
 * Hash algorithm: FNV-1a 32-bit (fast, no crypto dependency, good distribution)
 */

import { DurableSessionState } from '../types/durable-state';

export class ChangeDetector {

  /**
   * Compute content hash for a durable state.
   * Excludes meta.ua (updatedAt) and meta.hash to avoid circular dependency.
   * Returns hex string of 32-bit FNV-1a hash.
   */
  static computeHash(state: DurableSessionState): string {
    // Build canonical string from significant fields
    const parts: string[] = [
      state.sid,
      state.aid,
      state.hs.st,
      state.hs.is.join(','),
      String(state.bd.ct),
      String(state.bd.br),
      String(state.bd.bp),
      String(state.ac.ts),
      String(state.ac.mc),
      String(state.ac.lm),
      state.ac.sy ? '1' : '0',
      state.mc.mv,
      String(state.mc.cf),
      String(state.mc.tu),
      String(state.mc.tl),
      String(state.mc.cp),
      state.mc.nc ? '1' : '0',
      String(state.al),
    ];

    if (state.bw) {
      parts.push(String(state.bw.wp), String(state.bw.wh), state.bw.rd);
    }

    if (state.gt) {
      parts.push(state.gt.br, String(state.gt.dt));
    }

    const input = parts.join('|');
    return this.fnv1a32(input);
  }

  /**
   * Check if state has changed since last hash.
   */
  static hasChanged(state: DurableSessionState): boolean {
    const currentHash = this.computeHash(state);
    return currentHash !== state.meta.hash;
  }

  /**
   * Stamp hash onto state (mutates state.meta.hash).
   * Returns true if hash changed, false if no change.
   */
  static stamp(state: DurableSessionState): boolean {
    const newHash = this.computeHash(state);
    const changed = newHash !== state.meta.hash;
    state.meta.hash = newHash;
    if (changed) {
      state.meta.uc += 1;
    }
    return changed;
  }

  /**
   * FNV-1a 32-bit hash.
   * Fast, non-cryptographic, good distribution for change detection.
   */
  private static fnv1a32(input: string): string {
    let hash = 0x811c9dc5; // FNV offset basis

    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193); // FNV prime
    }

    // Convert to unsigned 32-bit and then to hex
    return (hash >>> 0).toString(16).padStart(8, '0');
  }
}

export default ChangeDetector;
