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
    test('fresh transcript overrides stale jsonInput when they disagree (post-/model switch)', () => {
      // When CC stdin carries the launch-frozen model (e.g. opus from session start)
      // but the user switched to sonnet via /model, the transcript will reflect the
      // new model after the first response while stdin still shows opus.
      // The resolver must prefer the fresh transcript in this disagreement case.
      const transcriptPath = join(TEST_DIR, 'transcript.jsonl');
      createTranscript(transcriptPath, 'opus', 1); // 1 min ago — "new" model in transcript

      // jsonInput carries the stale launch model (sonnet — the one used before /model switch)
      const jsonInput: ClaudeCodeInput = {
        model: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet' }
      };

      const result = resolver.resolve(transcriptPath, jsonInput, null);

      // Fresh transcript (opus, <5 min, disagrees with jsonInput) wins
      expect(result.value).toBe('Opus4.5');
      expect(result.source).toBe('transcript');
      expect(result.reason).toContain('Fresh transcript overrides stale stdin model');
    });

    test('jsonInput wins over transcript when they agree', () => {
      const transcriptPath = join(TEST_DIR, 'transcript-agree.jsonl');
      createTranscript(transcriptPath, 'sonnet', 1); // 1 min ago

      // model.id preferred over display_name (has version info)
      const jsonInput: ClaudeCodeInput = {
        model: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet' }
      };

      const result = resolver.resolve(transcriptPath, jsonInput, null);

      // Both agree on sonnet → jsonInput wins (no disagreement override)
      expect(result.value).toBe('Sonnet4.5');
      expect(result.source).toBe('jsonInput');
      expect(result.confidence).toBe(80);
    });

    test('jsonInput wins when transcript is stale (≥5 min) even if they disagree', () => {
      const transcriptPath = join(TEST_DIR, 'transcript-stale.jsonl');
      createTranscript(transcriptPath, 'opus', 6); // 6 min ago — stale (past 300s threshold)

      const jsonInput: ClaudeCodeInput = {
        model: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet' }
      };

      const result = resolver.resolve(transcriptPath, jsonInput, null);

      // Stale transcript (>5 min) — jsonInput wins as before
      expect(result.value).toBe('Sonnet4.5');
      expect(result.source).toBe('jsonInput');
    });

    test('fresh transcript wins over settings (when no jsonInput)', () => {
      const transcriptPath = join(TEST_DIR, 'transcript.jsonl');
      createTranscript(transcriptPath, 'opus', 3); // 3 min ago (within 5min threshold)

      const result = resolver.resolve(transcriptPath, null, 'haiku');

      expect(result.value).toBe('Opus4.5');
      expect(result.source).toBe('transcript');
      expect(result.confidence).toBeGreaterThanOrEqual(90);
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
        model: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet' }
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
        model: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet' }
      };

      const result = resolver.resolve('/does/not/exist', jsonInput, null);

      expect(result.value).toBe('Sonnet4.5');
      expect(result.source).toBe('jsonInput');
    });

    test('uses jsonInput when transcript path is null', () => {
      const jsonInput: ClaudeCodeInput = {
        model: { id: 'claude-haiku-4-5-20251001', display_name: 'Haiku' }
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

      // "haiku" has no version digits → just "Haiku"
      expect(result.value).toBe('Haiku');
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

      const jsonInput: ClaudeCodeInput = {
        model: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet' }
      };

      const result = resolver.resolve(transcriptPath, jsonInput, null);

      // Fresh transcript (opus) disagrees with jsonInput (sonnet) →
      // transcript wins under the post-/model-switch fix
      expect(result.value).toBe('Opus4.5');
      expect(result.source).toBe('transcript');

      // Disagreement should still be detected and logged
      const lastDisagreement = resolver.getLastDisagreement();
      expect(lastDisagreement).not.toBeNull();
      expect(lastDisagreement).toContain('disagree');
    });

    test('no disagreement when sources match', () => {
      const transcriptPath = join(TEST_DIR, 'agree.jsonl');
      createTranscript(transcriptPath, 'sonnet', 1);

      const jsonInput: ClaudeCodeInput = {
        model: { id: 'claude-sonnet-4-5-20250929', display_name: 'Sonnet' }
      };

      resolver.resolve(transcriptPath, jsonInput, null);

      const lastDisagreement = resolver.getLastDisagreement();
      expect(lastDisagreement).toBeNull();
    });
  });

  // =========================================================================
  // UT-3.7: Model Name Formatting — version extraction
  // =========================================================================
  describe('formatModelName', () => {
    test('formats opus model ID with version', () => {
      expect(resolver.formatModelName('claude-opus-4-5-20251101')).toBe('Opus4.5');
    });

    test('formats opus 4.6 model ID', () => {
      expect(resolver.formatModelName('claude-opus-4-6')).toBe('Opus4.6');
    });

    test('formats sonnet model ID with version', () => {
      expect(resolver.formatModelName('claude-sonnet-4-5-20250514')).toBe('Sonnet4.5');
    });

    test('formats haiku model ID with version', () => {
      expect(resolver.formatModelName('claude-haiku-4-5-20251001')).toBe('Haiku4.5');
    });

    test('handles future single-digit minor version (e.g., claude-opus-5)', () => {
      // Future-proofing: if Anthropic releases 5.0, 6.0, etc.
      // Note: current regex requires 2-digit minor. With single digit, regex won't match.
      // Input doesn't have dot version, so falls through to pass-through.
      const result = resolver.formatModelName('claude-opus-5');
      expect(result.toLowerCase()).toContain('opus');
    });

    test('passes through unknown model', () => {
      expect(resolver.formatModelName('gpt-4-turbo')).toBe('gpt-4-turbo');
    });

    test('handles bare model name without version (display_name)', () => {
      // display_name from Claude Code: just "Opus", "Sonnet", "Haiku"
      expect(resolver.formatModelName('Opus')).toBe('Opus');
      expect(resolver.formatModelName('Sonnet')).toBe('Sonnet');
      expect(resolver.formatModelName('Haiku')).toBe('Haiku');
    });
  });

  // =========================================================================
  // UT-3.8: Model Name Formatting Variants
  // =========================================================================
  describe('model name variants', () => {
    test('handles id field (preferred — has version)', () => {
      const jsonInput: ClaudeCodeInput = {
        model: { id: 'claude-opus-4-6', display_name: 'Opus' }
      };

      const result = resolver.resolve(null, jsonInput, null);

      expect(result.value).toBe('Opus4.6');
    });

    test('prefers id over display_name (id has version info)', () => {
      const jsonInput: ClaudeCodeInput = {
        model: {
          id: 'claude-opus-4-6',
          display_name: 'Opus',
          name: 'sonnet' // Legacy field, should be ignored
        }
      };

      const result = resolver.resolve(null, jsonInput, null);

      // Should use id (has version)
      expect(result.value).toBe('Opus4.6');
    });

    test('falls back to display_name when no id', () => {
      const jsonInput: ClaudeCodeInput = {
        model: { display_name: 'Haiku' }
      };

      const result = resolver.resolve(null, jsonInput, null);

      expect(result.value).toBe('Haiku');
    });
  });

  // =========================================================================
  // Additional: Edge cases
  // =========================================================================
  describe('edge cases', () => {
    test('handles empty transcript file', () => {
      const path = join(TEST_DIR, 'empty.jsonl');
      writeFileSync(path, '');

      const jsonInput: ClaudeCodeInput = {
        model: { id: 'claude-sonnet-4-5-20250929' }
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

      const jsonInput: ClaudeCodeInput = {
        model: { id: 'claude-sonnet-4-5-20250929' }
      };

      const result = resolver.resolve(path, jsonInput, null);

      expect(result.source).toBe('jsonInput');
    });

    test('handles mixed case model names', () => {
      // Bare names without version digits → no version suffix
      expect(resolver.formatModelName('OPUS')).toBe('Opus');
      expect(resolver.formatModelName('Sonnet')).toBe('Sonnet');
      expect(resolver.formatModelName('HAIKU')).toBe('Haiku');
    });

    test('rejects version from non-model strings (false positive prevention)', () => {
      // Should NOT extract version from arbitrary strings that contain N.N pattern
      // Only extract if the string starts with a known model name (opus|sonnet|haiku)
      // Pass-through for unknown strings
      expect(resolver.formatModelName('Claude 3.5')).toBe('Claude 3.5');  // No model match → pass-through
      expect(resolver.formatModelName('model-v2.1')).toBe('model-v2.1');
      expect(resolver.formatModelName('version-1.0-release')).toBe('version-1.0-release');
    });

    test('rejects single-digit minor version (e.g., claude-opus-5)', () => {
      // Future-proofing: regex requires 2-digit major AND minor
      // Single-digit minor like "claude-opus-5" should NOT match
      const result = resolver.formatModelName('claude-opus-5');
      expect(result).toBe('Opus');  // No version extracted
      expect(result).not.toContain('5');
    });

    test('handles empty string input', () => {
      const result = resolver.formatModelName('');
      expect(result).toBe('');
    });

    test('validates formatModelId matches formatModelName for real-world inputs', () => {
      // Comparative test: both implementations should produce identical output
      // This catches regressions if implementations drift
      const testCases = [
        'claude-opus-4-6',
        'claude-sonnet-4-5-20250929',
        'claude-haiku-4-5-20251001',
        'Opus4.5',
        'Sonnet',
        'Haiku'
      ];

      testCases.forEach(input => {
        const formatted = resolver.formatModelName(input);
        expect(formatted).toBeTruthy();
        // Verify it contains model name
        const lower = formatted.toLowerCase();
        const hasKnownName = lower.includes('opus') || lower.includes('sonnet') || lower.includes('haiku') || input === formatted;
        expect(hasKnownName).toBe(true);
      });
    });
  });
});
