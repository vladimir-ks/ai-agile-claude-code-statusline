/**
 * Shannon Entropy Validator
 *
 * Calculates information entropy of a string.
 * High entropy (>4.0 for 20+ char strings) suggests randomness → likely a secret.
 * Low entropy suggests dictionary words or patterns → likely NOT a secret.
 */

/**
 * Calculate Shannon entropy (bits per character).
 * Range: 0 (all same char) to ~6.5 (fully random printable ASCII).
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) || 0) + 1);
  }

  let entropy = 0;
  const len = s.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Entropy-based validator for secret detection rules.
 * Returns confidence 0.0-1.0.
 *
 * @param match - The matched text
 * @param _context - Surrounding text (unused here)
 * @param minEntropy - Minimum entropy threshold. Default: 3.5
 * @param minLength - Minimum string length to apply entropy check. Default: 20
 */
export function entropyValidator(
  match: string,
  _context: string,
  minEntropy: number = 3.5,
  minLength: number = 20,
): number {
  // Short strings: skip entropy check (pattern match is sufficient)
  if (match.length < minLength) return 1.0;

  const entropy = shannonEntropy(match);

  if (entropy >= minEntropy) return 1.0;

  // Below threshold: reduce confidence proportionally
  // entropy=0 → 0.0, entropy=threshold → 1.0
  return Math.max(0, entropy / minEntropy);
}
