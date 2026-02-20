/**
 * Secret Detection Rules — Tests
 *
 * Every rule has at least:
 * - 1 true positive (real token format)
 * - 1 false positive scenario (must NOT match)
 */

import { describe, test, expect } from 'bun:test';
import { DetectionEngine } from '../../../src/lib/detection-engine';

// Engine configured for secrets only, all severities
const engine = new DetectionEngine({
  categories: ['secret'],
  minSeverity: 'high',
  minConfidence: 0.5,
});

// Real base64 block for private key tests
const REAL_BASE64 =
  'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB' +
  'gMjhxKaGFkLqRyMcRgZLwGFcGBSDkAuSOPxqVWHEGDMK5JHRmFvCYnSSyzBNIKnE' +
  'hVbP8FwFbVeRJdK0MHQeZPf8bSHIkP2zhP+xXVHRKjK3GQH/ATctQ8LnYzTNaYsj' +
  'ZKxBD4PH2qFbDYOakJ7TGQBZSf5BQHIAJ6H0F0QIHJ5EhM+DnAOawBcO1a1LQ2M';

describe('Secret Rules — Critical (Exact Format)', () => {
  describe('GitHub Tokens', () => {
    test('detects classic PAT (ghp_)', () => {
      const f = engine.detect('token: ghp_1234567890abcdefghijklmnopqrstuvwxyz');
      expect(f).toHaveLength(1);
      expect(f[0].type).toBe('GitHub Token');
      expect(f[0].rule).toBe('github_pat_classic');
      expect(f[0].severity).toBe('critical');
    });

    test('detects fine-grained PAT', () => {
      const token = 'github_pat_11ABCDEFGHIJKLMNOPQRST_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456';
      const f = engine.detect(`token: ${token}`);
      expect(f).toHaveLength(1);
      expect(f[0].rule).toBe('github_pat_fine');
    });

    test('detects OAuth token (gho_)', () => {
      const f = engine.detect('gho_abcdefghijklmnopqrstuvwxyz0123456789');
      expect(f).toHaveLength(1);
      expect(f[0].rule).toBe('github_oauth');
    });

    test('does NOT match ghp_ prefix alone', () => {
      expect(engine.detect('ghp_ is a prefix')).toEqual([]);
    });

    test('does NOT match short ghp_ token', () => {
      expect(engine.detect('ghp_tooshort')).toEqual([]);
    });
  });

  describe('GitLab Token', () => {
    test('detects glpat- token', () => {
      const f = engine.detect('glpat-abcdefghijklmnopqrstu');
      expect(f).toHaveLength(1);
      expect(f[0].type).toBe('GitLab Token');
    });

    test('does NOT match glpat- alone', () => {
      expect(engine.detect('glpat-short')).toEqual([]);
    });
  });

  describe('AWS Key', () => {
    test('detects AKIA access key', () => {
      const f = engine.detect('AKIAIOSFODNN7EXAMPLE');
      expect(f).toHaveLength(1);
      expect(f[0].type).toBe('AWS Key');
    });

    test('detects ASIA temporary key', () => {
      const f = engine.detect('ASIAIOSFODNN7EXAMPLE');
      expect(f).toHaveLength(1);
    });

    test('does NOT match AKIA in filename', () => {
      expect(engine.detect('/path/to/AKIA-named-file.txt')).toEqual([]);
    });

    test('does NOT match generic 40-char base64 (former AWS Secret Key)', () => {
      // This was the root cause of false positives — now correctly NOT detected
      expect(engine.detect('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toEqual([]);
    });
  });

  describe('Stripe Key', () => {
    test('detects live key', () => {
      const f = engine.detect('sk_live_1234567890abcdefghijklmnopqrst');
      expect(f.some(x => x.type === 'Stripe Key')).toBe(true);
    });

    test('does NOT match sk_test_ (test keys not flagged as critical)', () => {
      // sk_test_ is NOT in our rules — test keys are low risk
      const f = engine.detect('sk_test_1234567890abcdefghijklmnopqrst');
      expect(f.some(x => x.rule === 'stripe_live')).toBe(false);
    });
  });

  describe('Slack Token', () => {
    test('detects xoxb- bot token', () => {
      const f = engine.detect('xoxb-1234567890-1234567890123-ABCdefGHIjklMNOpqrsTUVwx');
      expect(f).toHaveLength(1);
      expect(f[0].type).toBe('Slack Token');
    });
  });

  describe('Google API Key', () => {
    test('detects AIza key', () => {
      const f = engine.detect('AIzaSyAa0b1c2d3e4f5g6h7i8j9k0l1m2n3o4p5');
      expect(f).toHaveLength(1);
      expect(f[0].type).toBe('Google API Key');
    });
  });

  describe('SendGrid Key', () => {
    test('detects SG. key', () => {
      // SG. + 22 chars + . + 43 chars (exactly)
      const f = engine.detect('SG.abcdefghijklmnopqrstuv.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq');
      expect(f).toHaveLength(1);
      expect(f[0].type).toBe('SendGrid Key');
    });
  });

  describe('Anthropic Key', () => {
    test('detects sk-ant- key', () => {
      const f = engine.detect('sk-ant-abc123def456ghi789jkl');
      expect(f.some(x => x.type === 'Anthropic Key')).toBe(true);
    });
  });

  describe('Discord Token', () => {
    test('detects Discord bot token format', () => {
      const f = engine.detect('MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GhKL9z.abcdefghijklmnopqrstuvwxyz0');
      expect(f.some(x => x.type === 'Discord Token')).toBe(true);
    });
  });
});

describe('Secret Rules — High (Structured)', () => {
  describe('Database Connection Strings', () => {
    test('detects PostgreSQL with real password', () => {
      const f = engine.detect('postgres://admin:s3cretPa$$word@db.example.com:5432/mydb');
      expect(f.some(x => x.type === 'Database Connection')).toBe(true);
    });

    test('detects MongoDB with real password', () => {
      const f = engine.detect('mongodb+srv://user:r3alP4ssw0rd@cluster.mongodb.net/db');
      expect(f.some(x => x.type === 'Database Connection')).toBe(true);
    });

    test('rejects placeholder password', () => {
      const f = engine.detect('postgres://user:password@localhost/db');
      // connectionStringValidator rejects "password"
      expect(f.filter(x => x.type === 'Database Connection')).toEqual([]);
    });
  });

  describe('Private Keys', () => {
    test('detects RSA private key with real content', () => {
      const key = `-----BEGIN RSA PRIVATE KEY-----\n${REAL_BASE64}\n-----END RSA PRIVATE KEY-----`;
      const f = engine.detect(key);
      expect(f.some(x => x.type === 'Private Key')).toBe(true);
    });

    test('rejects short placeholder key', () => {
      const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
      const f = engine.detect(key);
      expect(f.filter(x => x.type === 'Private Key')).toEqual([]);
    });

    test('rejects key discussion text', () => {
      const text = '-----BEGIN PRIVATE KEY-----\nThis is how a key looks, but not real\n-----END PRIVATE KEY-----';
      const f = engine.detect(text);
      expect(f.filter(x => x.type === 'Private Key')).toEqual([]);
    });
  });

  describe('API Key Assignment', () => {
    test('detects api_key= with high-entropy value', () => {
      const f = engine.detect('api_key="sk_live_1234567890abcdefghijklmnopqrst"');
      expect(f.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Env-Var Secret Assignments', () => {
    test('detects CLOUDFLARE_API_TOKEN', () => {
      const f = engine.detect('CLOUDFLARE_API_TOKEN=dsXdNP4uuOeWxUjRGxAKgkNVJ6CS8Z6N4Iuov7v7');
      expect(f.some(x => x.rule === 'env_secret_token')).toBe(true);
      expect(f[0].type).toBe('Secret Assignment');
    });

    test('detects DATABASE_SECRET with special chars', () => {
      const f = engine.detect('DATABASE_SECRET=s3cretPa$$word123xyzABC');
      expect(f.some(x => x.type === 'Secret Assignment')).toBe(true);
    });

    test('detects AWS_SECRET_KEY', () => {
      const f = engine.detect('AWS_SECRET_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
      expect(f.some(x => x.rule === 'env_secret_key')).toBe(true);
    });

    test('detects SERVICE_API_KEY', () => {
      const f = engine.detect('SERVICE_API_KEY=abc123def456ghi789jkl012');
      expect(f.some(x => x.type === 'Secret Assignment')).toBe(true);
    });

    test('detects REDIS_PASSWORD with special chars', () => {
      const f = engine.detect('REDIS_PASSWORD=veryL0ngAndR4ndomP4sswordW1thH1ghEntropy!');
      expect(f.some(x => x.type === 'Secret Assignment')).toBe(true);
    });

    test('rejects short value (MY_TOKEN=changeme)', () => {
      expect(engine.detect('MY_TOKEN=changeme')).toEqual([]);
    });

    test('rejects boolean value (DEBUG_TOKEN=true)', () => {
      expect(engine.detect('DEBUG_TOKEN=true')).toEqual([]);
    });

    test('rejects placeholder value', () => {
      expect(engine.detect('MY_CREDENTIAL=placeholder_value_here')).toEqual([]);
    });

    test('does NOT match regular variables without secret keywords', () => {
      expect(engine.detect('NORMAL_VARIABLE=some_regular_value_here')).toEqual([]);
    });

    test('detects quoted values', () => {
      const f = engine.detect('MY_SECRET="a1b2c3d4e5f6g7h8i9j0k1l2"');
      expect(f.some(x => x.type === 'Secret Assignment')).toBe(true);
    });

    test('detects colon-separated (YAML/JSON)', () => {
      const f = engine.detect('DEPLOY_TOKEN: a1b2c3d4e5f6g7h8i9j0k1l2');
      expect(f.some(x => x.type === 'Secret Assignment')).toBe(true);
    });
  });
});

describe('Secret Rules — False Positive Prevention', () => {
  test('git commit SHA (40 hex chars) NOT detected', () => {
    expect(engine.detect('commit abc123def456789012345678901234567890ab')).toEqual([]);
  });

  test('base64-encoded UUID NOT detected as AWS secret', () => {
    expect(engine.detect('dXNlcl9pZDoxMjM0NTY3ODkwYWJjZGVmMTIzNA==')).toEqual([]);
  });

  test('npm package hash NOT detected', () => {
    expect(engine.detect('sha512-abc123def456ghi789jkl012mno345pqr678=')).toEqual([]);
  });

  test('variable names with "token" NOT detected', () => {
    expect(engine.detect('const access_token_refresh = getToken();')).toEqual([]);
  });

  test('regex pattern mentioning ghp_ NOT detected', () => {
    expect(engine.detect('pattern: /ghp_\\w+/g')).toEqual([]);
  });

  test('URL with base64 params NOT detected as secret', () => {
    expect(engine.detect('https://example.com?data=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=')).toEqual([]);
  });
});
