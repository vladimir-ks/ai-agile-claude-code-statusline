/**
 * Secret Detection Rules
 *
 * 13 critical (exact format tokens) + 7 high (structured patterns).
 * No medium rules included — those belong in context-dependent layer.
 *
 * Design: Every critical rule uses a unique prefix that can ONLY appear
 * in a real token. This guarantees near-zero false positives.
 */

import type { Rule } from '../types';
import { privateKeyValidator, connectionStringValidator } from '../validators/content';
import { entropyValidator, shannonEntropy } from '../validators/entropy';

/** Placeholder values commonly found in .env.example / docs */
const ENV_PLACEHOLDERS = new Set([
  'your_token_here', 'your_secret_here', 'your_key_here',
  'changeme', 'change_me', 'replace_me', 'xxx', 'TODO',
  'your_password', 'your_api_key', 'INSERT_HERE',
]);

/**
 * Validator for env-var secret assignments.
 * Extracts the value portion (after = or : or space) and checks entropy.
 * Rejects placeholders and low-entropy values.
 */
function envSecretValidator(match: string, _context: string): number {
  // Extract value after the assignment operator
  const assignIdx = match.search(/[=:]\s*["']?/);
  if (assignIdx === -1) return 0.0;

  const valueStart = match.slice(assignIdx).replace(/^[=:\s"']+/, '');
  const value = valueStart.replace(/["'\s]+$/, '');

  if (!value || value.length < 16) return 0.0;

  // Reject known placeholders
  if (ENV_PLACEHOLDERS.has(value.toLowerCase())) return 0.0;

  // Entropy check on the value only
  const entropy = shannonEntropy(value);
  if (entropy < 3.5) return 0.0;

  // High entropy + long value = real secret
  return entropy >= 4.0 ? 1.0 : 0.7;
}

// ── Critical: Exact Format Tokens ─────────────────────────────────────
// Confidence = 1.0 by default. These have distinctive prefixes that
// cannot appear in normal text/code.

export const SECRET_RULES: Rule[] = [
  // GitHub
  {
    id: 'github_pat_classic',
    type: 'GitHub Token',
    category: 'secret',
    severity: 'critical',
    pattern: /\bghp_[A-Za-z0-9_]{36,}\b/g,
    description: 'GitHub Personal Access Token (classic)',
  },
  {
    id: 'github_pat_fine',
    type: 'GitHub Token',
    category: 'secret',
    severity: 'critical',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9]{59}\b/g,
    description: 'GitHub Fine-Grained Personal Access Token',
  },
  {
    id: 'github_oauth',
    type: 'GitHub OAuth',
    category: 'secret',
    severity: 'critical',
    pattern: /\bgho_[a-zA-Z0-9]{36}\b/g,
    description: 'GitHub OAuth App Token',
  },

  // GitLab
  {
    id: 'gitlab_pat',
    type: 'GitLab Token',
    category: 'secret',
    severity: 'critical',
    pattern: /\bglpat-[a-zA-Z0-9_-]{20,}\b/g,
    description: 'GitLab Personal Access Token',
  },

  // AWS
  {
    id: 'aws_access_key',
    type: 'AWS Key',
    category: 'secret',
    severity: 'critical',
    pattern: /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
    description: 'AWS Access Key ID (AKIA/ASIA/AROA/AIDA prefix)',
  },
  // NOTE: AWS Secret Key pattern (/[A-Za-z0-9/+=]{40}/) intentionally OMITTED.
  // It matches ANY 40-char base64 string — UUIDs, git SHAs, npm hashes, etc.
  // Zero precision. AWS access key (AKIA) detection is sufficient.

  // Stripe
  {
    id: 'stripe_live',
    type: 'Stripe Key',
    category: 'secret',
    severity: 'critical',
    pattern: /\bsk_live_[A-Za-z0-9]{24,}\b/g,
    description: 'Stripe Live API Key',
  },

  // Slack
  {
    id: 'slack_token',
    type: 'Slack Token',
    category: 'secret',
    severity: 'critical',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    description: 'Slack Bot/App/User Token',
  },

  // Google
  {
    id: 'google_api',
    type: 'Google API Key',
    category: 'secret',
    severity: 'critical',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    description: 'Google API Key',
  },

  // SendGrid
  {
    id: 'sendgrid',
    type: 'SendGrid Key',
    category: 'secret',
    severity: 'critical',
    pattern: /\bSG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}\b/g,
    description: 'SendGrid API Key',
  },

  // Anthropic
  {
    id: 'anthropic_key',
    type: 'Anthropic Key',
    category: 'secret',
    severity: 'critical',
    pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
    description: 'Anthropic API Key',
  },

  // OpenAI
  {
    id: 'openai_key',
    type: 'OpenAI Key',
    category: 'secret',
    severity: 'critical',
    pattern: /\bsk-[a-zA-Z0-9]{20,}\b/g,
    description: 'OpenAI API Key',
  },

  // Discord
  {
    id: 'discord_token',
    type: 'Discord Token',
    category: 'secret',
    severity: 'critical',
    pattern: /\b[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27}\b/g,
    description: 'Discord Bot/User Token',
  },

  // JWT
  {
    id: 'jwt',
    type: 'JWT',
    category: 'secret',
    severity: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    description: 'JSON Web Token (3-part base64url)',
  },

  // ── High: Structured Patterns (need validation) ─────────────────────

  // Generic API key assignment (exact keyword at start of name)
  {
    id: 'api_key_assign',
    type: 'API Key',
    category: 'secret',
    severity: 'high',
    pattern: /\b(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token)["\s:=]+["']?([A-Za-z0-9_\-]{20,})["']?\b/gi,
    description: 'Generic API key in assignment context',
    validate: entropyValidator,
  },

  // Env-var style secret assignments: ANYTHING_TOKEN=value, ANYTHING_SECRET=value, etc.
  // Catches: CLOUDFLARE_API_TOKEN=xxx, DATABASE_SECRET=xxx, MY_PASSWORD=xxx, SERVICE_KEY=xxx
  // Requires high-entropy value (>3.5 bits/char) AND length >=20 chars to avoid false positives.
  {
    id: 'env_secret_token',
    type: 'Secret Assignment',
    category: 'secret',
    severity: 'high',
    pattern: /\b[A-Z][A-Z0-9_]*(?:_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIAL)["\s:=]+["']?([^\s"']{20,})["']?/g,
    description: 'Environment variable with _TOKEN/_SECRET/_PASSWORD suffix and high-entropy value',
    validate: envSecretValidator,
  },
  {
    id: 'env_secret_key',
    type: 'Secret Assignment',
    category: 'secret',
    severity: 'high',
    pattern: /\b[A-Z][A-Z0-9_]*(?:_API_KEY|_APIKEY|_ACCESS_KEY|_SECRET_KEY|_PRIVATE_KEY|_AUTH_KEY)["\s:=]+["']?([^\s"']{16,})["']?/g,
    description: 'Environment variable with _API_KEY/_SECRET_KEY suffix and high-entropy value',
    validate: envSecretValidator,
  },

  // Database connection strings
  {
    id: 'db_connection_postgres',
    type: 'Database Connection',
    category: 'secret',
    severity: 'high',
    pattern: /\bpostgres(?:ql)?:\/\/[^:]+:[^@]+@[^\s"']+/gi,
    description: 'PostgreSQL connection string with credentials',
    validate: connectionStringValidator,
  },
  {
    id: 'db_connection_mongodb',
    type: 'Database Connection',
    category: 'secret',
    severity: 'high',
    pattern: /\bmongodb(?:\+srv)?:\/\/[^:]+:[^@]+@[^\s"']+/gi,
    description: 'MongoDB connection string with credentials',
    validate: connectionStringValidator,
  },
  {
    id: 'db_connection_mysql',
    type: 'Database Connection',
    category: 'secret',
    severity: 'high',
    pattern: /\bmysql:\/\/[^:]+:[^@]+@[^\s"']+/gi,
    description: 'MySQL connection string with credentials',
    validate: connectionStringValidator,
  },
  {
    id: 'db_connection_redis',
    type: 'Database Connection',
    category: 'secret',
    severity: 'high',
    pattern: /\bredis:\/\/[^:]+:[^@]+@[^\s"']+/gi,
    description: 'Redis connection string with credentials',
    validate: connectionStringValidator,
  },

  // Azure
  {
    id: 'azure_connection',
    type: 'Azure Connection String',
    category: 'secret',
    severity: 'high',
    pattern: /DefaultEndpointsProtocol=https;AccountName=[^;]+;AccountKey=[^;]+/gi,
    description: 'Azure Storage connection string',
  },

  // Twilio
  {
    id: 'twilio_key',
    type: 'Twilio Key',
    category: 'secret',
    severity: 'high',
    pattern: /\bSK[a-f0-9]{32}\b/g,
    description: 'Twilio API Key',
    validate: (match, ctx) => entropyValidator(match, ctx, 3.0, 10),
  },

  // Private Keys — capped at 4KB, with content validation
  {
    id: 'private_key_rsa',
    type: 'Private Key',
    category: 'secret',
    severity: 'high',
    pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]{10,4096}?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    description: 'RSA/Generic PEM Private Key',
    validate: privateKeyValidator,
  },
  {
    id: 'private_key_ec',
    type: 'Private Key',
    category: 'secret',
    severity: 'high',
    pattern: /-----BEGIN\s+EC\s+PRIVATE\s+KEY-----[\s\S]{10,4096}?-----END\s+EC\s+PRIVATE\s+KEY-----/g,
    description: 'EC PEM Private Key',
    validate: privateKeyValidator,
  },
  {
    id: 'private_key_openssh',
    type: 'Private Key',
    category: 'secret',
    severity: 'high',
    pattern: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----[\s\S]{10,4096}?-----END\s+OPENSSH\s+PRIVATE\s+KEY-----/g,
    description: 'OpenSSH Private Key',
    validate: privateKeyValidator,
  },
];
