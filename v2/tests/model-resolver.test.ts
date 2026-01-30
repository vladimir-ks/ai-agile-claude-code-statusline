/**
 * Model Resolver Tests
 *
 * Tests for multi-source model resolution with disagreement logging
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import ModelResolver from '../src/lib/model-resolver';
import { ClaudeCodeInput } from '../src/types/session-health';

const TEST_DIR = '/tmp/statusline-test-model-resolver';

describe('ModelResolver', () => {
  let resolver: ModelResolver;

  beforeEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
    resolver = new ModelResolver();
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true });
    }
  });

  // =========================================================================
  // Helper: Create transcript with model
  // =========================================================================
  function createTranscript(path: string, model: string, ageMinutes: number = 0): void {
    const timestamp = new Date(Date.now() - ageMinutes * 60 * 1000).toISOString();
    const lines = [
      JSON.stringify({
        type: 'assistant',
        message: { model: `claude-${model.toLowerCase()}-4-5-20251101` },
        timestamp
      })
    ];
    writeFileSync(path, lines.join('\n') + '\n');
  }

  // =========================================================================
  // UT-3.1: Fresh Transcript Wins
  // =========================================================================
  describe('source priority', () => {
    test('fresh transcript wins over jsonInput', () => {
      const transcriptPath = join(TEST_DIR, 'transcript.jsonl');
      createTranscript(transcriptPath, 'opus', 1); // 1 min ago

      const jsonInput: ClaudeCodeInput = {
        model: { name: 'sonnet', display_name: 'Sonnet 4.5' }
      };

      const result = resolver.resolve(transcriptPath, jsonInput, null);

      expect(result.value).toBe('Opus4.5');
      expect(result.source).toBe('transcript');
      expect(result.confidence).toBeGreaterThanOrEqual(90);
    });

    test('fresh transcript wins over settings', () => {
      const transcriptPath = join(TEST_DIR, 'transcript.jsonl');
      createTranscript(transcriptPath, 'opus', 30); // 30 min ago

      const result = resolver.resolve(transcriptPath, null, 'haiku');

      expect(result.value).toBe('Opus4.5');
      expect(result.source).toBe('transcript');
    });
  });

  // =========================================================================
  // UT-3.2: Stale Transcript Falls Back
  // =========================================================================
  describe('stale transcript fallback', () => {
    test('stale transcript (>1h) falls back to jsonInput', () => {
      const transcriptPath = join(TEST_DIR, 'stale.jsonl');
      createTranscript(transcriptPath, 'opus', 120); // 2 hours ago

      const jsonInput: ClaudeCodeInput = {
        model: { name: 'sonnet', display_name: 'Sonnet 4.5' }
      };

      const result = resolver.resolve(transcriptPath, jsonInput, null);

      expect(result.value).toBe('Sonnet4.5');
      expect(result.source).toBe('jsonInput');
    });
  });

  // =========================================================================
  // UT-3.3: No Transcript Uses JSON
  // =========================================================================
  describe('no transcript', () => {
    test('uses jsonInput when no transcript', () => {
      const jsonInput: ClaudeCodeInput = {
        model: { name: 'sonnet', display_name: 'Sonnet 4.5' }
      };

      const result = resolver.resolve('/does/not/exist', jsonInput, null);

      expect(result.value).toBe('Sonnet4.5');
      expect(result.source).toBe('jsonInput');
    });

    test('uses jsonInput when transcript path is null', () => {
      // Use display_name (what Claude Code actually provides)
      const jsonInput: ClaudeCodeInput = {
        model: { display_name: 'Claude Haiku 4.5' }
      };

      const result = resolver.resolve(null, jsonInput, null);

      expect(result.value).toBe('Haiku4.5');
      expect(result.source).toBe('jsonInput');
    });
  });

  // =========================================================================
  // UT-3.4: Nothing Available Uses Settings
  // =========================================================================
  describe('settings fallback', () => {
    test('uses settings when no transcript or jsonInput', () => {
      const result = resolver.resolve(null, null, 'haiku');

      expect(result.value).toBe('Haiku4.5');
      expect(result.source).toBe('settings');
      expect(result.confidence).toBeLessThanOrEqual(50);
    });
  });

  // =========================================================================
  // UT-3.5: All Sources Missing
  // =========================================================================
  describe('default fallback', () => {
    test('returns Claude when all sources missing', () => {
      const result = resolver.resolve(null, null, null);

      expect(result.value).toBe('Claude');
      expect(result.source).toBe('default');
      expect(result.confidence).toBeLessThanOrEqual(20);
    });

    test('returns Claude when jsonInput has no model', () => {
      const jsonInput: ClaudeCodeInput = {
        session_id: 'test'
        // No model field
      };

      const result = resolver.resolve(null, jsonInput, null);

      expect(result.value).toBe('Claude');
      expect(result.source).toBe('default');
    });
  });

  // =========================================================================
  // UT-3.6: Disagreement Logged
  // =========================================================================
  describe('disagreement detection', () => {
    test('detects disagreement between transcript and jsonInput', () => {
      const transcriptPath = join(TEST_DIR, 'disagree.jsonl');
      createTranscript(transcriptPath, 'opus', 1);

      // Use display_name (what Claude Code actually provides)
      const jsonInput: ClaudeCodeInput = {
        model: { display_name: 'Claude Sonnet 4.5' }
      };

      const result = resolver.resolve(transcriptPath, jsonInput, null);

      // Result should use transcript (fresh)
      expect(result.value).toBe('Opus4.5');

      // But disagreement should be detected
      const lastDisagreement = resolver.getLastDisagreement();
      expect(lastDisagreement).not.toBeNull();
      expect(lastDisagreement).toContain('disagree');
    });

    test('no disagreement when sources match', () => {
      const transcriptPath = join(TEST_DIR, 'agree.jsonl');
      createTranscript(transcriptPath, 'sonnet', 1);

      // Use display_name (what Claude Code actually provides)
      const jsonInput: ClaudeCodeInput = {
        model: { display_name: 'Claude Sonnet 4.5' }
      };

      resolver.resolve(transcriptPath, jsonInput, null);

      const lastDisagreement = resolver.getLastDisagreement();
      expect(lastDisagreement).toBeNull();
    });
  });

  // =========================================================================
  // UT-3.7: Model Name Formatting
  // =========================================================================
  describe('formatModelName', () => {
    test('formats opus model ID', () => {
      expect(resolver.formatModelName('claude-opus-4-5-20251101')).toBe('Opus4.5');
    });

    test('formats sonnet model ID', () => {
      expect(resolver.formatModelName('claude-sonnet-4-5-20250514')).toBe('Sonnet4.5');
    });

    test('formats haiku model ID', () => {
      expect(resolver.formatModelName('claude-haiku-4-5-20251001')).toBe('Haiku4.5');
    });

    test('passes through unknown model', () => {
      expect(resolver.formatModelName('gpt-4-turbo')).toBe('gpt-4-turbo');
    });

    test('handles model name without version', () => {
      expect(resolver.formatModelName('opus')).toBe('Opus4.5');
      expect(resolver.formatModelName('sonnet')).toBe('Sonnet4.5');
      expect(resolver.formatModelName('haiku')).toBe('Haiku4.5');
    });
  });

  // =========================================================================
  // UT-3.8: Model Name Formatting Variants
  // =========================================================================
  describe('model name variants', () => {
    test('handles display_name field', () => {
      const jsonInput: ClaudeCodeInput = {
        model: { display_name: 'Claude Opus 4.5' }
      };

      const result = resolver.resolve(null, jsonInput, null);

      expect(result.value).toBe('Opus4.5');
    });

    test('prefers display_name over name (Claude Code convention)', () => {
      // CRITICAL: Claude Code provides display_name as primary, so we should prefer it
      const jsonInput: ClaudeCodeInput = {
        model: {
          display_name: 'Claude Opus 4.5',
          name: 'sonnet' // Legacy field, should be ignored
        }
      };

      const result = resolver.resolve(null, jsonInput, null);

      // Should use display_name (what Claude Code actually provides)
      expect(result.value).toBe('Opus4.5');
    });
  });

  // =========================================================================
  // Additional: Edge cases
  // =========================================================================
  describe('edge cases', () => {
    test('handles empty transcript file', () => {
      const path = join(TEST_DIR, 'empty.jsonl');
      writeFileSync(path, '');

      // Use display_name (what Claude Code actually provides)
      const jsonInput: ClaudeCodeInput = {
        model: { display_name: 'Claude Sonnet 4.5' }
      };

      const result = resolver.resolve(path, jsonInput, null);

      // Should fall back to jsonInput
      expect(result.value).toBe('Sonnet4.5');
      expect(result.source).toBe('jsonInput');
    });

    test('handles transcript with no model field', () => {
      const path = join(TEST_DIR, 'no-model.jsonl');
      writeFileSync(path, JSON.stringify({
        type: 'user',
        message: { content: 'Hello' },
        timestamp: new Date().toISOString()
      }) + '\n');

      // Use display_name (what Claude Code actually provides)
      const jsonInput: ClaudeCodeInput = {
        model: { display_name: 'Claude Sonnet 4.5' }
      };

      const result = resolver.resolve(path, jsonInput, null);

      expect(result.source).toBe('jsonInput');
    });

    test('handles mixed case model names', () => {
      expect(resolver.formatModelName('OPUS')).toBe('Opus4.5');
      expect(resolver.formatModelName('Sonnet')).toBe('Sonnet4.5');
      expect(resolver.formatModelName('HAIKU')).toBe('Haiku4.5');
    });
  });
});
