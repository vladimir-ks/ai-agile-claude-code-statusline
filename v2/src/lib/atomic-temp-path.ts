/**
 * Temp path for an atomic write (write + rename).
 *
 * Unique per writer AND per call: concurrent processes sharing `<file>.tmp`
 * truncate each other's in-flight bytes and the loser's rename publishes a
 * byte-mix or throws ENOENT. Shape `<file>.tmp.<pid>.<seq><rand>` is the one the
 * litter prune matches (`statusline-bulletproof.sh` `find -name '*.tmp.*'`).
 * contract: health-store.test.ts "atomic write temp paths"
 */
let seq = 0;

export function atomicTempPath(filePath: string): string {
  const unique = `${(seq++).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${filePath}.tmp.${process.pid}.${unique}`;
}

export default atomicTempPath;
