/**
 * Content Validator — Private Key + Structured Content
 *
 * Validates that PEM-formatted private keys contain real base64 content,
 * not just discussion snippets or code examples.
 */

/**
 * Validate private key content between BEGIN/END markers.
 * Real keys: >80% base64 characters and >200 chars of inner content.
 * Short placeholders like "MIIEpAIBAAKCAQEA..." are correctly rejected.
 *
 * Returns confidence 0.0 (reject) or 1.0 (real key).
 */
export function privateKeyValidator(match: string, _context: string): number {
  // Extract inner content (between markers)
  const inner = match
    .replace(/-----BEGIN[^-]*-----/, '')
    .replace(/-----END[^-]*-----/, '');

  const stripped = inner.replace(/\s/g, '');
  const totalChars = stripped.length;

  // Too short — placeholder or discussion snippet
  if (totalChars < 200) return 0.0;

  // Count base64 characters
  const base64Count = (stripped.match(/[A-Za-z0-9+/=]/g) || []).length;
  const base64Ratio = base64Count / totalChars;

  // Real keys are >80% base64 content
  if (base64Ratio < 0.8) return 0.0;

  return 1.0;
}

/**
 * Validate database connection string has actual credentials.
 * Rejects patterns with obviously fake credentials or placeholders.
 *
 * Returns confidence 0.0-1.0.
 */
export function connectionStringValidator(match: string, _context: string): number {
  // Extract password portion (between : and @)
  const passMatch = match.match(/:\/\/[^:]+:([^@]+)@/);
  if (!passMatch) return 0.0;

  const password = passMatch[1];

  // Reject obvious placeholders
  const placeholders = [
    'password', 'pass', 'secret', 'changeme', 'xxx', 'your_password',
    'PASSWORD', 'PASS', 'SECRET', 'CHANGEME', 'YOUR_PASSWORD',
    '<password>', '{password}', '${PASSWORD}', '%s',
  ];
  if (placeholders.includes(password)) return 0.0;

  // Very short password — likely placeholder
  if (password.length < 4) return 0.3;

  return 1.0;
}
