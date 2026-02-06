/**
 * Tests for Tier 2 (session) source descriptors
 *
 * Tests descriptor shape, merge logic, and basic fetch behavior.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDefaultHealth } from '../src/types/session-health';
import type { GatherContext } from '../src/lib/sources/types';

// Import source descriptors
import { transcriptSource } from '../src/lib/sources/transcript-source';
import { secretsSource } from '../src/lib/sources/secrets-source';
import { authSource } from '../src/lib/sources/auth-source';
import { sessionCostSource } from '../src/lib/sources/session-cost-source';

function makeCtx(overrides: Partial<GatherContext> = {}): GatherContext {
  return {
    sessionId: 'test-session',
    transcriptPath: null,
    jsonInput: null,
    configDir: null,
    keychainService: null,
    deadline: Date.now() + 20000,
    existingHealth: null,
    projectPath: '/tmp/test',
    ...overrides,
  };
}

// =========================================================================
// Transcript Source
// =========================================================================

describe('transcriptSource', () => {
  describe('descriptor', () => {
    test('has correct id', () => expect(transcriptSource.id).toBe('transcript'));
    test('is tier 2', () => expect(transcriptSource.tier).toBe(2));
    test('has transcript category', () => expect(transcriptSource.freshnessCategory).toBe('transcript'));
    test('has reasonable timeout', () => expect(transcriptSource.timeoutMs).toBeLessThanOrEqual(5000));
  });

  describe('fetch with no transcript', () => {
    test('returns empty when transcriptPath is null', async () => {
      const result = await transcriptSource.fetch(makeCtx({ transcriptPath: null }));
      expect(result.exists).toBe(false);
      expect(result.messageCount).toBe(0);
    });
  });

  describe('fetch with transcript file', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = join(tmpdir(), `transcript-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(tempDir, { recursive: true });
    });

    afterEach(() => {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });

    test('reads transcript file', async () => {
      const transcriptPath = join(tempDir, 'transcript.jsonl');
      const now = new Date().toISOString();
      writeFileSync(transcriptPath, [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' }, timestamp: now }),
        JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi', model: 'claude-opus-4-5-20250929' }, timestamp: now }),
      ].join('\n') + '\n');

      const result = await transcriptSource.fetch(makeCtx({
        sessionId: 'test',
        transcriptPath,
      }));
      expect(result.exists).toBe(true);
      expect(result.messageCount).toBeGreaterThanOrEqual(1);
    });
  });

  describe('merge', () => {
    test('sets transcript on health', async () => {
      const health = createDefaultHealth('test');
      const data = await transcriptSource.fetch(makeCtx({ transcriptPath: null }));
      transcriptSource.merge(health, data);
      expect(health.transcript.exists).toBe(false);
    });
  });
});

// =========================================================================
// Secrets Source
// =========================================================================

describe('secretsSource', () => {
  describe('descriptor', () => {
    test('has correct id', () => expect(secretsSource.id).toBe('secrets_scan'));
    test('is tier 2', () => expect(secretsSource.tier).toBe(2));
    test('has secrets_scan category', () => expect(secretsSource.freshnessCategory).toBe('secrets_scan'));
  });

  describe('fetch with no transcript', () => {
    test('returns not scanned when no transcript', async () => {
      const result = await secretsSource.fetch(makeCtx({ transcriptPath: null }));
      expect(result.hasSecrets).toBe(false);
      expect(result.secretTypes).toEqual([]);
      expect(result.scanned).toBe(false);
    });
  });

  describe('merge', () => {
    test('writes alerts when scanned', () => {
      const health = createDefaultHealth('test');
      secretsSource.merge(health, {
        hasSecrets: true,
        secretTypes: ['API Key', 'AWS Key'],
        scanned: true,
      });
      expect(health.alerts.secretsDetected).toBe(true);
      expect(health.alerts.secretTypes).toEqual(['API Key', 'AWS Key']);
    });

    test('does not overwrite when not scanned', () => {
      const health = createDefaultHealth('test');
      health.alerts.secretsDetected = true;
      health.alerts.secretTypes = ['Private Key'];

      secretsSource.merge(health, {
        hasSecrets: false,
        secretTypes: [],
        scanned: false,
      });

      // Preserved because scanned=false
      expect(health.alerts.secretsDetected).toBe(true);
      expect(health.alerts.secretTypes).toEqual(['Private Key']);
    });
  });
});

// =========================================================================
// Auth Source
// =========================================================================

describe('authSource', () => {
  describe('descriptor', () => {
    test('has correct id', () => expect(authSource.id).toBe('auth_profile'));
    test('is tier 2', () => expect(authSource.tier).toBe(2));
    test('has auth_profile category', () => expect(authSource.freshnessCategory).toBe('auth_profile'));
    test('has low timeout', () => expect(authSource.timeoutMs).toBeLessThanOrEqual(2000));
  });

  describe('fetch with no transcript', () => {
    test('returns default detection', async () => {
      const result = await authSource.fetch(makeCtx({ transcriptPath: null }));
      expect(result).toHaveProperty('authProfile');
      expect(result).toHaveProperty('detectionMethod');
      expect(result.configDir).toBeNull();
      expect(result.keychainService).toBeNull();
    });
  });

  describe('merge', () => {
    test('writes auth data to health.launch', () => {
      const health = createDefaultHealth('test');
      authSource.merge(health, {
        authProfile: 'user@example.com',
        detectionMethod: 'path',
        configDir: '/home/user/.claude',
        keychainService: 'Claude Code-credentials',
        slotId: 'slot-1',
      });
      expect(health.launch.authProfile).toBe('user@example.com');
      expect(health.launch.detectionMethod).toBe('path');
      expect(health.launch.configDir).toBe('/home/user/.claude');
      expect(health.launch.keychainService).toBe('Claude Code-credentials');
    });

    test('does not overwrite configDir if null', () => {
      const health = createDefaultHealth('test');
      health.launch.configDir = '/existing/dir';
      authSource.merge(health, {
        authProfile: 'user@example.com',
        detectionMethod: 'default',
        configDir: null,
        keychainService: null,
        slotId: null,
      });
      expect(health.launch.configDir).toBe('/existing/dir');
    });
  });
});

// =========================================================================
// Cross-source: all Tier 2 descriptors
// =========================================================================

describe('all Tier 2 source descriptors', () => {
  const sources = [
    transcriptSource,
    secretsSource,
    authSource,
    sessionCostSource,
  ];

  test('all have unique IDs', () => {
    const ids = sources.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('all are tier 2', () => {
    for (const src of sources) {
      expect(src.tier).toBe(2);
    }
  });

  test('all have fetch and merge functions', () => {
    for (const src of sources) {
      expect(typeof src.fetch).toBe('function');
      expect(typeof src.merge).toBe('function');
    }
  });

  test('all have freshnessCategory', () => {
    for (const src of sources) {
      expect(typeof src.freshnessCategory).toBe('string');
      expect(src.freshnessCategory.length).toBeGreaterThan(0);
    }
  });

  test('all have positive timeoutMs', () => {
    for (const src of sources) {
      expect(src.timeoutMs).toBeGreaterThan(0);
    }
  });
});

// =========================================================================
// Cross-tier: all sources have no ID collisions
// =========================================================================

describe('cross-tier ID uniqueness', () => {
  test('no Tier 2 IDs collide with Tier 1 or Tier 3', async () => {
    const { contextSource } = await import('../src/lib/sources/context-source');
    const { modelSource } = await import('../src/lib/sources/model-source');
    const { gitSource } = await import('../src/lib/sources/git-source');
    const { billingSource } = await import('../src/lib/sources/billing-source');
    const { quotaSource } = await import('../src/lib/sources/quota-source');
    const { versionSource } = await import('../src/lib/sources/version-source');
    const { notificationSource } = await import('../src/lib/sources/notification-source');
    const { slotRecommendationSource } = await import('../src/lib/sources/slot-recommendation-source');

    const allSources = [
      // Tier 1
      contextSource, modelSource,
      // Tier 2
      transcriptSource, secretsSource, authSource, sessionCostSource,
      // Tier 3
      gitSource, billingSource, quotaSource, versionSource,
      notificationSource, slotRecommendationSource,
    ];

    const ids = allSources.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
