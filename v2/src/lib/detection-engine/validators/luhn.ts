/**
 * Luhn Checksum Validator
 *
 * Validates credit card numbers using the Luhn-10 algorithm.
 * Also rejects trivially invalid sequences (all same digit, sequential).
 */

/**
 * Validate a number string using the Luhn algorithm.
 * Returns true if the checksum is valid.
 */
export function luhnCheck(digits: string): boolean {
  // Strip non-digit chars (spaces, dashes)
  const clean = digits.replace(/\D/g, '');
  if (clean.length < 13 || clean.length > 19) return false;

  let sum = 0;
  let alternate = false;

  for (let i = clean.length - 1; i >= 0; i--) {
    let n = parseInt(clean[i], 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }

  return sum % 10 === 0;
}

/**
 * Reject trivially invalid credit card numbers.
 * - All same digit (e.g., 0000000000000000)
 * - Sequential ascending (1234567890123456)
 */
export function isTriviallyCreditCard(digits: string): boolean {
  const clean = digits.replace(/\D/g, '');

  // All same digit
  if (new Set(clean).size === 1) return false;

  // Sequential ascending
  let sequential = true;
  for (let i = 1; i < clean.length; i++) {
    if (parseInt(clean[i], 10) !== (parseInt(clean[i - 1], 10) + 1) % 10) {
      sequential = false;
      break;
    }
  }
  if (sequential) return false;

  return true;
}

/**
 * Credit card validator for detection rules.
 * Returns confidence 0.0-1.0.
 */
export function creditCardValidator(match: string, _context: string): number {
  const clean = match.replace(/\D/g, '');

  // Reject trivial sequences
  if (!isTriviallyCreditCard(clean)) return 0.0;

  // Luhn check
  if (!luhnCheck(clean)) return 0.0;

  return 1.0;
}
