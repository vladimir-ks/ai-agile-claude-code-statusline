/**
 * Content Validator Tests (Private Key + Connection String)
 */

import { describe, test, expect } from 'bun:test';
import { privateKeyValidator, connectionStringValidator } from '../../../src/lib/detection-engine/validators/content';

// Generate a realistic base64 block (>200 chars, >80% base64)
const REAL_BASE64 =
  'MIIEpAIBAAKCAQEA0Z3VS5JJcds3xfn/ygWyF8PbnGy0AHB7MhgHcTz6sE2I2yPB' +
  'gMjhxKaGFkLqRyMcRgZLwGFcGBSDkAuSOPxqVWHEGDMK5JHRmFvCYnSSyzBNIKnE' +
  'hVbP8FwFbVeRJdK0MHQeZPf8bSHIkP2zhP+xXVHRKjK3GQH/ATctQ8LnYzTNaYsj' +
  'ZKxBD4PH2qFbDYOakJ7TGQBZSf5BQHIAJ6H0F0QIHJ5EhM+DnAOawBcO1a1LQ2M';

describe('privateKeyValidator', () => {
  test('accepts real private key with dense base64 content', () => {
    const key = `-----BEGIN RSA PRIVATE KEY-----\n${REAL_BASE64}\n-----END RSA PRIVATE KEY-----`;
    expect(privateKeyValidator(key, '')).toBe(1.0);
  });

  test('rejects short placeholder (MIIEpAIBAAKCAQEA...)', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----';
    expect(privateKeyValidator(key, '')).toBe(0.0);
  });

  test('rejects code discussion text between markers', () => {
    const key = '-----BEGIN PRIVATE KEY-----\nSome text about how private keys work and this is definitely not a real key content\n-----END PRIVATE KEY-----';
    expect(privateKeyValidator(key, '')).toBe(0.0);
  });

  test('rejects key with <80% base64 density', () => {
    // Non-base64 characters: {, }, :, @, #, !, etc. (not in [A-Za-z0-9+/=])
    const mixed = '{key}: {value}, @more: #data! '.repeat(10); // ~290 chars, mostly non-base64
    const key = `-----BEGIN PRIVATE KEY-----\n${mixed}\n-----END PRIVATE KEY-----`;
    expect(privateKeyValidator(key, '')).toBe(0.0);
  });

  test('accepts EC private key with real content', () => {
    const key = `-----BEGIN EC PRIVATE KEY-----\n${REAL_BASE64}\n-----END EC PRIVATE KEY-----`;
    expect(privateKeyValidator(key, '')).toBe(1.0);
  });

  test('rejects empty content between markers', () => {
    const key = '-----BEGIN PRIVATE KEY-----\n\n-----END PRIVATE KEY-----';
    expect(privateKeyValidator(key, '')).toBe(0.0);
  });
});

describe('connectionStringValidator', () => {
  test('accepts real connection string with password', () => {
    expect(connectionStringValidator('postgres://admin:s3cretPa$$word@db.example.com:5432/mydb', '')).toBe(1.0);
  });

  test('rejects placeholder password "password"', () => {
    expect(connectionStringValidator('postgres://user:password@localhost/db', '')).toBe(0.0);
  });

  test('rejects placeholder "changeme"', () => {
    expect(connectionStringValidator('mysql://root:changeme@host/db', '')).toBe(0.0);
  });

  test('rejects template variable ${PASSWORD}', () => {
    expect(connectionStringValidator('redis://user:${PASSWORD}@host/0', '')).toBe(0.0);
  });

  test('low confidence for very short password', () => {
    const conf = connectionStringValidator('mongodb://user:abc@host/db', '');
    expect(conf).toBe(0.3);
  });

  test('rejects string without credentials pattern', () => {
    expect(connectionStringValidator('https://example.com/path', '')).toBe(0.0);
  });
});
