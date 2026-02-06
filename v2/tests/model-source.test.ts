/**
 * Tests for v2/src/lib/sources/model-source.ts
 *
 * Tier 1 source: Model resolution from JSON input, transcript, settings.
 * Wraps ModelResolver with descriptor API.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { modelSource, getSettingsModel } from '../src/lib/sources/model-source';
import type { GatherContext } from '../src/lib/sources/types';
import { createDefaultHealth } from '../src/types/session-health';

function makeCtx(overrides: Partial<GatherContext> = {}): GatherContext {
  return {
    sessionId: 'test',
    transcriptPath: overrides.transcriptPath ?? null,
    jsonInput: overrides.jsonInput ?? null,
    configDir: null,
    keychainService: null,
    deadline: Date.now() + 5000,
    existingHealth: null,
    projectPath: '.',
    ...overrides,
  };
}

describe('modelSource', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = join(tmpdir(), `model-src-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Descriptor shape
  // -------------------------------------------------------------------------

  describe('descriptor', () => {
    test('has correct id', () => {
      expect(modelSource.id).toBe('model');
    });

    test('is tier 1', () => {
      expect(modelSource.tier).toBe(1);
    });

    test('has model freshnessCategory', () => {
      expect(modelSource.freshnessCategory).toBe('model');
    });

    test('has no dependencies', () => {
      expect(modelSource.dependencies).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // fetch — JSON input priority
  // -------------------------------------------------------------------------

  describe('fetch with JSON input', () => {
    test('resolves model from JSON input display_name', async () => {
      const result = await modelSource.fetch(makeCtx({
        jsonInput: {
          session_id: 'test',
          model: { display_name: 'claude-sonnet-4-5-20250929' },
        } as any,
      }));
      expect(result.value).toBe('Sonnet4.5');
      expect(result.source).toBe('jsonInput');
    });

    test('resolves model from JSON input id', async () => {
      const result = await modelSource.fetch(makeCtx({
        jsonInput: {
          session_id: 'test',
          model: { id: 'claude-opus-4-5-20250929' },
        } as any,
      }));
      expect(result.value).toBe('Opus4.5');
    });

    test('resolves model from JSON input model_id', async () => {
      const result = await modelSource.fetch(makeCtx({
        jsonInput: {
          session_id: 'test',
          model: { model_id: 'claude-haiku-4-5-20251001' },
        } as any,
      }));
      expect(result.value).toBe('Haiku4.5');
    });
  });

  // -------------------------------------------------------------------------
  // fetch — transcript source
  // -------------------------------------------------------------------------

  describe('fetch with transcript', () => {
    test('resolves model from fresh transcript', async () => {
      const transcriptPath = join(tempDir, 'transcript.jsonl');
      const now = new Date().toISOString();
      writeFileSync(transcriptPath, JSON.stringify({
        message: { model: 'claude-opus-4-5-20250929' },
        timestamp: now,
      }) + '\n');

      const result = await modelSource.fetch(makeCtx({
        transcriptPath,
        jsonInput: null,
      }));
      // Without JSON input, should fall through to transcript or settings
      // Transcript model only used if <5 min old (which it is)
      expect(result.value).toContain('Opus');
    });
  });

  // -------------------------------------------------------------------------
  // fetch — fallback
  // -------------------------------------------------------------------------

  describe('fetch fallback', () => {
    test('returns Claude as fallback when no sources available', async () => {
      const result = await modelSource.fetch(makeCtx());
      // Could be "Claude" or from settings.json on this machine
      expect(result.value).toBeDefined();
      expect(typeof result.value).toBe('string');
      expect(result.value.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // merge
  // -------------------------------------------------------------------------

  describe('merge', () => {
    test('sets model on target health', async () => {
      const health = createDefaultHealth('test');
      const data = await modelSource.fetch(makeCtx({
        jsonInput: {
          session_id: 'test',
          model: { display_name: 'claude-sonnet-4-5-20250929' },
        } as any,
      }));
      modelSource.merge(health, data);
      expect(health.model.value).toBe('Sonnet4.5');
      expect(health.model.source).toBe('jsonInput');
    });

    test('sets updatedAt on model', async () => {
      const health = createDefaultHealth('test');
      const before = Date.now();
      const data = await modelSource.fetch(makeCtx());
      modelSource.merge(health, data);
      expect(health.model.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  // -------------------------------------------------------------------------
  // getSettingsModel
  // -------------------------------------------------------------------------

  describe('getSettingsModel', () => {
    test('returns string or null (depends on machine state)', () => {
      const result = getSettingsModel();
      // On test machines, settings.json may or may not exist
      expect(result === null || typeof result === 'string').toBe(true);
    });
  });
});
