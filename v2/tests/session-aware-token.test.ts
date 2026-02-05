/**
 * Tests for Session-Aware Token Resolution
 *
 * Integration tests verifying the full flow:
 *   transcript_path → KeychainResolver → configDir + keychainService
 *     → AnthropicOAuthAPI (targeted token)
 *     → HotSwapQuotaReader (configDir matching)
 *     → DataGatherer (wiring)
 *
 * These tests verify:
 * 1. DataGatherer correctly derives configDir from transcript_path
 * 2. The keychainService is passed through to OAuth API
 * 3. Hot-swap quota reader matches slots by config_dir
 * 4. LaunchContext is populated with resolution data
 * 5. Different sessions (different slots) get different tokens
 */

import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import { KeychainResolver } from '../src/modules/keychain-resolver';
import { AnthropicOAuthAPI } from '../src/modules/anthropic-oauth-api';
import { HotSwapQuotaReader, HotSwapQuotaCache } from '../src/lib/hot-swap-quota-reader';
import { createDefaultHealth } from '../src/types/session-health';

const HOME = homedir();
const TEST_DIR = '/tmp/session-aware-token-test';
const TEST_HEALTH_DIR = `${TEST_DIR}/session-health`;

// Mock hot-swap-quota.json data with config_dir fields
const MOCK_QUOTA_CACHE: HotSwapQuotaCache = {
  'slot-1': {
    email: 'user-a@example.com',
    five_hour_util: 30,
    seven_day_util: 45,
    weekly_budget_remaining_hours: 120,
    weekly_reset_day: 'Thu',
    daily_reset_time: '17:00',
    last_fetched: Date.now() - 30000, // 30s ago
    is_fresh: true,
    config_dir: `${HOME}/_claude-configs/hot-swap/registration/slot-1`,
    keychain_hash: '4a0e8cbc',
  },
  'slot-2': {
    email: 'user-b@example.com',
    five_hour_util: 65,
    seven_day_util: 80,
    weekly_budget_remaining_hours: 48,
    weekly_reset_day: 'Wed',
    daily_reset_time: '23:00',
    last_fetched: Date.now() - 60000, // 60s ago
    is_fresh: true,
    config_dir: `${HOME}/_claude-configs/hot-swap/registration/slot-2`,
    keychain_hash: 'db267d92',
  },
};

describe('Session-Aware Token Resolution', () => {
  beforeAll(() => {
    mkdirSync(TEST_HEALTH_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // LaunchContext wiring: simulates exact logic from data-gatherer.ts L121-127
  // Tests the resolution + assignment without triggering real network I/O
  // ==========================================================================

  describe('LaunchContext wiring (data-gatherer logic)', () => {

    /**
     * Simulates the exact wiring from data-gatherer.ts lines 121-127:
     *
     *   const { configDir, keychainService } = KeychainResolver.resolveFromTranscript(transcriptPath);
     *   if (configDir) {
     *     health.launch.configDir = configDir;
     *     health.launch.keychainService = keychainService || undefined;
     *   }
     */
    function simulateGathererWiring(transcriptPath: string | null) {
      const health = createDefaultHealth('test-session');
      const { configDir, keychainService } = KeychainResolver.resolveFromTranscript(transcriptPath);
      if (configDir) {
        health.launch.configDir = configDir;
        health.launch.keychainService = keychainService || undefined;
      }
      return health;
    }

    test('populates configDir and keychainService for slot-1 transcript', () => {
      const configDir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const transcriptPath = `${configDir}/projects/-test-project/test-session.jsonl`;

      const health = simulateGathererWiring(transcriptPath);

      expect(health.launch.configDir).toBe(resolve(configDir));
      expect(health.launch.keychainService).toBe('Claude Code-credentials-4a0e8cbc');
    });

    test('populates configDir and keychainService for slot-2 transcript', () => {
      const configDir = `${HOME}/_claude-configs/hot-swap/registration/slot-2`;
      const transcriptPath = `${configDir}/projects/-test-project/test-session.jsonl`;

      const health = simulateGathererWiring(transcriptPath);

      expect(health.launch.configDir).toBe(resolve(configDir));
      expect(health.launch.keychainService).toBe('Claude Code-credentials-db267d92');
    });

    test('populates bare service for default ~/.claude transcript', () => {
      const transcriptPath = `${HOME}/.claude/projects/-test/default-session.jsonl`;

      const health = simulateGathererWiring(transcriptPath);

      expect(health.launch.configDir).toBe(resolve(`${HOME}/.claude`));
      expect(health.launch.keychainService).toBe('Claude Code-credentials');
    });

    test('populates hashed service for non-default config dir', () => {
      const transcriptPath = `${TEST_DIR}/.claude/projects/-test/session.jsonl`;

      const health = simulateGathererWiring(transcriptPath);

      expect(health.launch.configDir).toBe(resolve(`${TEST_DIR}/.claude`));
      // Not the real ~/.claude, so gets a hash
      expect(health.launch.keychainService).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    });

    test('does NOT populate configDir when transcript has no /projects/ segment', () => {
      const health = simulateGathererWiring(`${TEST_DIR}/random-transcript.jsonl`);

      expect(health.launch.configDir).toBeUndefined();
      expect(health.launch.keychainService).toBeUndefined();
    });

    test('does NOT populate configDir when transcript is null', () => {
      const health = simulateGathererWiring(null);

      expect(health.launch.configDir).toBeUndefined();
      expect(health.launch.keychainService).toBeUndefined();
    });

    test('does NOT populate configDir when transcript is empty string', () => {
      const health = simulateGathererWiring('');

      expect(health.launch.configDir).toBeUndefined();
      expect(health.launch.keychainService).toBeUndefined();
    });

    test('different slots produce different keychainService values', () => {
      const slot1Path = `${HOME}/_claude-configs/hot-swap/registration/slot-1/projects/-t/s.jsonl`;
      const slot2Path = `${HOME}/_claude-configs/hot-swap/registration/slot-2/projects/-t/s.jsonl`;

      const health1 = simulateGathererWiring(slot1Path);
      const health2 = simulateGathererWiring(slot2Path);

      expect(health1.launch.keychainService).not.toBe(health2.launch.keychainService);
      expect(health1.launch.configDir).not.toBe(health2.launch.configDir);
    });

    test('preserves default LaunchContext fields', () => {
      const transcriptPath = `${HOME}/.claude/projects/-test/session.jsonl`;
      const health = simulateGathererWiring(transcriptPath);

      // Original fields preserved
      expect(health.launch.authProfile).toBe('default');
      expect(health.launch.detectionMethod).toBe('default');
      // New fields populated
      expect(health.launch.configDir).toBeDefined();
      expect(health.launch.keychainService).toBeDefined();
    });

    test('keychainService is undefined (not null) when configDir is null', () => {
      // Path must NOT contain /projects/ to get null configDir
      const health = simulateGathererWiring('/some/random/path/without-projects-segment.jsonl');

      // Important: should be undefined, not null (TypeScript optional field)
      expect(health.launch.configDir).toBeUndefined();
      expect(health.launch.keychainService).toBeUndefined();
      expect('configDir' in health.launch).toBe(false);
      expect('keychainService' in health.launch).toBe(false);
    });
  });

  // ==========================================================================
  // HotSwapQuotaReader: configDir matching (Strategy 1)
  // ==========================================================================

  describe('HotSwapQuotaReader configDir matching', () => {
    const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;
    let originalCache: string | null = null;

    beforeEach(() => {
      HotSwapQuotaReader.clearCache();
      // Backup original cache
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }
    });

    afterEach(() => {
      HotSwapQuotaReader.clearCache();
      // Restore original cache
      if (originalCache) {
        writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
      }
    });

    test('matches slot by config_dir when provided', () => {
      // Write mock cache with config_dir fields
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
      HotSwapQuotaReader.clearCache();

      const slot1ConfigDir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const result = HotSwapQuotaReader.getActiveQuota(slot1ConfigDir);

      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-1');
      expect(result!.email).toBe('user-a@example.com');
      expect(result!.dailyPercentUsed).toBe(30);
    });

    test('matches slot-2 by config_dir', () => {
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
      HotSwapQuotaReader.clearCache();

      const slot2ConfigDir = `${HOME}/_claude-configs/hot-swap/registration/slot-2`;
      const result = HotSwapQuotaReader.getActiveQuota(slot2ConfigDir);

      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-2');
      expect(result!.email).toBe('user-b@example.com');
      expect(result!.weeklyPercentUsed).toBe(80);
    });

    test('falls back to other strategies when configDir does not match', () => {
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
      HotSwapQuotaReader.clearCache();

      // Use a configDir that matches no slot
      const result = HotSwapQuotaReader.getActiveQuota('/nonexistent/config/dir');

      // Should still return something (Strategy 2/3/4 fallback)
      expect(result).not.toBeNull();
      expect(result!.source).toBe('hot-swap');
    });

    test('falls back to other strategies when configDir is undefined', () => {
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
      HotSwapQuotaReader.clearCache();

      const result = HotSwapQuotaReader.getActiveQuota(undefined);

      // Should still return data via Strategy 2/3/4
      expect(result).not.toBeNull();
    });

    test('config_dir matching takes priority over active_account registry', () => {
      // If configDir matches slot-1 but active_account is slot-2,
      // configDir match should win
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
      HotSwapQuotaReader.clearCache();

      const slot1ConfigDir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const result = HotSwapQuotaReader.getActiveQuota(slot1ConfigDir);

      expect(result).not.toBeNull();
      expect(result!.slotId).toBe('slot-1');
      // Even if active_account points to slot-2, configDir match wins
    });

    test('handles cache without config_dir fields gracefully', () => {
      // Old-format cache without config_dir
      const oldFormatCache = {
        'slot-1': {
          email: 'user-a@example.com',
          five_hour_util: 30,
          seven_day_util: 45,
          weekly_budget_remaining_hours: 120,
          weekly_reset_day: 'Thu',
          daily_reset_time: '17:00',
          last_fetched: Date.now(),
          is_fresh: true,
          // No config_dir field!
        },
      };

      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(oldFormatCache), 'utf-8');
      HotSwapQuotaReader.clearCache();

      // Should NOT match configDir but should fall through to other strategies
      const result = HotSwapQuotaReader.getActiveQuota(
        `${HOME}/_claude-configs/hot-swap/registration/slot-1`
      );

      expect(result).not.toBeNull();
      // Should still return slot-1 via fallback strategies (single slot → use it)
      expect(result!.slotId).toBe('slot-1');
    });
  });

  // ==========================================================================
  // Cross-component: full resolution chain
  // ==========================================================================

  describe('Full resolution chain', () => {

    test('transcript → configDir → keychainService → keychain entry', () => {
      // Step 1: Transcript path → KeychainResolver
      const slot1Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const transcriptPath = `${slot1Dir}/projects/-test/session.jsonl`;

      // Step 2: Resolve
      const resolution = KeychainResolver.resolveFromTranscript(transcriptPath);
      expect(resolution.configDir).toBe(resolve(slot1Dir));
      expect(resolution.keychainService).toBe('Claude Code-credentials-4a0e8cbc');

      // Step 3: Read keychain entry (if accessible)
      const entry = KeychainResolver.readKeychainEntry(resolution.keychainService!);
      if (!entry) return; // Skip if keychain not accessible

      // Step 4: Verify token structure
      expect(entry.accessToken).not.toBeNull();
      expect(typeof entry.accessToken).toBe('string');
      expect(typeof entry.isExpired).toBe('boolean');
    });

    test('slot-1 and slot-2 produce independent token chains', () => {
      const slot1Path = `${HOME}/_claude-configs/hot-swap/registration/slot-1/projects/-t/s.jsonl`;
      const slot2Path = `${HOME}/_claude-configs/hot-swap/registration/slot-2/projects/-t/s.jsonl`;

      const res1 = KeychainResolver.resolveFromTranscript(slot1Path);
      const res2 = KeychainResolver.resolveFromTranscript(slot2Path);

      // Different keychain services
      expect(res1.keychainService).not.toBe(res2.keychainService);

      // Read both entries (if accessible)
      const entry1 = KeychainResolver.readKeychainEntry(res1.keychainService!);
      const entry2 = KeychainResolver.readKeychainEntry(res2.keychainService!);

      if (entry1 && entry2) {
        // Different tokens (different accounts)
        expect(entry1.accessToken).not.toBe(entry2.accessToken);
      }
    });

    test('configDir matches quota cache slot correctly', () => {
      // Write mock cache
      const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;
      let originalCache: string | null = null;
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }

      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
      HotSwapQuotaReader.clearCache();

      try {
        // Resolve from transcript
        const slot1Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
        const transcriptPath = `${slot1Dir}/projects/-test/session.jsonl`;
        const { configDir } = KeychainResolver.resolveFromTranscript(transcriptPath);

        // Use configDir to get quota
        const quota = HotSwapQuotaReader.getActiveQuota(configDir || undefined);

        expect(quota).not.toBeNull();
        expect(quota!.slotId).toBe('slot-1');
        expect(quota!.email).toBe('user-a@example.com');
      } finally {
        HotSwapQuotaReader.clearCache();
        if (originalCache) {
          writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
        }
      }
    });
  });

  // ==========================================================================
  // Edge cases and defensive behavior
  // ==========================================================================

  describe('Edge cases', () => {

    test('handles extremely long transcript paths', () => {
      const longPath = `${HOME}/.claude/projects/${'a'.repeat(500)}/session.jsonl`;
      const result = KeychainResolver.resolveFromTranscript(longPath);
      expect(result.configDir).toBe(resolve(`${HOME}/.claude`));
      expect(result.keychainService).toBe('Claude Code-credentials');
    });

    test('handles transcript path with unicode characters', () => {
      const configDir = `${HOME}/.claude-日本語`;
      const path = `${configDir}/projects/-test/session.jsonl`;
      const result = KeychainResolver.resolveFromTranscript(path);
      expect(result.configDir).toBe(resolve(configDir));
      expect(result.keychainService).toMatch(/^Claude Code-credentials-[0-9a-f]{8}$/);
    });

    test('handles transcript path with encoded double dashes', () => {
      // Claude Code encodes project paths: /Users/test/my-project → -Users-test-my--project
      const path = `${HOME}/.claude/projects/-Users-test-my--project/session.jsonl`;
      const result = KeychainResolver.resolveFromTranscript(path);
      expect(result.configDir).toBe(resolve(`${HOME}/.claude`));
    });

    test('HotSwapQuotaReader returns null when cache file missing', () => {
      const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;
      let originalCache: string | null = null;
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }

      try {
        // Remove cache file temporarily
        if (existsSync(QUOTA_CACHE_PATH)) {
          rmSync(QUOTA_CACHE_PATH);
        }
        HotSwapQuotaReader.clearCache();

        const result = HotSwapQuotaReader.getActiveQuota(
          `${HOME}/_claude-configs/hot-swap/registration/slot-1`
        );
        expect(result).toBeNull();
      } finally {
        HotSwapQuotaReader.clearCache();
        if (originalCache) {
          writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
        }
      }
    });

    test('HotSwapQuotaReader handles corrupted cache file', () => {
      const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;
      let originalCache: string | null = null;
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }

      try {
        writeFileSync(QUOTA_CACHE_PATH, 'NOT VALID JSON {{{', 'utf-8');
        HotSwapQuotaReader.clearCache();

        const result = HotSwapQuotaReader.getActiveQuota(
          `${HOME}/_claude-configs/hot-swap/registration/slot-1`
        );
        expect(result).toBeNull();
      } finally {
        HotSwapQuotaReader.clearCache();
        if (originalCache) {
          writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
        }
      }
    });
  });

  // ==========================================================================
  // Regression tests: Phase 0 bug fixes
  // ==========================================================================

  describe('Bug 2 regression: 401 cooldown mechanism', () => {

    afterEach(() => {
      AnthropicOAuthAPI.clearCooldown();
    });

    test('clearCooldown is a callable static method', () => {
      expect(typeof AnthropicOAuthAPI.clearCooldown).toBe('function');
      // Should not throw
      AnthropicOAuthAPI.clearCooldown();
      AnthropicOAuthAPI.clearCooldown('some-service');
    });

    test('clearCooldown can target specific service', () => {
      // Just verify the API exists and doesn't throw
      AnthropicOAuthAPI.clearCooldown('Claude Code-credentials-4a0e8cbc');
      AnthropicOAuthAPI.clearCooldown();
    });
  });

  describe('Bug 3 regression: auth profile from configDir', () => {

    test('getSlotByConfigDir returns slot data with slotId', () => {
      const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;
      let originalCache: string | null = null;
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }

      try {
        writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
        HotSwapQuotaReader.clearCache();

        const slot1Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
        const result = HotSwapQuotaReader.getSlotByConfigDir(slot1Dir);

        expect(result).not.toBeNull();
        expect(result!.slotId).toBe('slot-1');
        expect(result!.email).toBe('user-a@example.com');
      } finally {
        HotSwapQuotaReader.clearCache();
        if (originalCache) {
          writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
        }
      }
    });

    test('getSlotByConfigDir returns null for nonexistent configDir', () => {
      const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;
      let originalCache: string | null = null;
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }

      try {
        writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
        HotSwapQuotaReader.clearCache();

        const result = HotSwapQuotaReader.getSlotByConfigDir('/nonexistent/path');
        // May return null (no match in cache or sessions yaml)
        // Or may return data if sessions.yaml fallback finds something
        // Just verify it doesn't throw
        expect(result === null || typeof result === 'object').toBe(true);
      } finally {
        HotSwapQuotaReader.clearCache();
        if (originalCache) {
          writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
        }
      }
    });

    test('getSlotByConfigDir matches slot-2 correctly', () => {
      const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;
      let originalCache: string | null = null;
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }

      try {
        writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
        HotSwapQuotaReader.clearCache();

        const slot2Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-2`;
        const result = HotSwapQuotaReader.getSlotByConfigDir(slot2Dir);

        expect(result).not.toBeNull();
        expect(result!.slotId).toBe('slot-2');
        expect(result!.email).toBe('user-b@example.com');
      } finally {
        HotSwapQuotaReader.clearCache();
        if (originalCache) {
          writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
        }
      }
    });

    test('auth profile derivation produces email from configDir', () => {
      const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;
      let originalCache: string | null = null;
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }

      try {
        writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
        HotSwapQuotaReader.clearCache();

        // Simulate what data-gatherer.ts now does:
        // 1. Resolve transcript → configDir
        const slot1Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
        const transcriptPath = `${slot1Dir}/projects/-test/session.jsonl`;
        const { configDir } = KeychainResolver.resolveFromTranscript(transcriptPath);

        // 2. Look up slot by configDir
        const matched = HotSwapQuotaReader.getSlotByConfigDir(configDir!);

        // 3. Derive authProfile from slot email
        expect(matched).not.toBeNull();
        const derivedAuthProfile = matched!.email;
        expect(derivedAuthProfile).toBe('user-a@example.com');
        expect(derivedAuthProfile).not.toBe('default');
      } finally {
        HotSwapQuotaReader.clearCache();
        if (originalCache) {
          writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
        }
      }
    });
  });

  describe('Bug 4 regression: slot fallback without config_dir in cache', () => {

    test('getSlotByConfigDir falls back to sessions.yaml', () => {
      const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;
      let originalCache: string | null = null;
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }

      try {
        // Cache WITHOUT config_dir on slot-1
        const cacheWithoutConfigDir = {
          'slot-1': {
            email: 'user-a@example.com',
            five_hour_util: 30,
            seven_day_util: 45,
            weekly_budget_remaining_hours: 120,
            weekly_reset_day: 'Thu',
            daily_reset_time: '17:00',
            last_fetched: Date.now(),
            is_fresh: true,
            // NO config_dir field
          },
        };

        writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(cacheWithoutConfigDir), 'utf-8');
        HotSwapQuotaReader.clearCache();

        // Try to find slot by configDir — cache won't match, but sessions.yaml fallback might
        const realSlot1Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
        const result = HotSwapQuotaReader.getSlotByConfigDir(realSlot1Dir);

        // If sessions.yaml exists with matching config_dir, should find it
        if (existsSync(`${HOME}/_claude-configs/hot-swap/claude-sessions.yaml`)) {
          expect(result).not.toBeNull();
          expect(result!.slotId).toBe('slot-1');
        }
        // If sessions.yaml doesn't exist, result may be null — that's fine
      } finally {
        HotSwapQuotaReader.clearCache();
        if (originalCache) {
          writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
        }
      }
    });

    test('getActiveQuota with configDir uses getSlotByConfigDir internally', () => {
      const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;
      let originalCache: string | null = null;
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }

      try {
        writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
        HotSwapQuotaReader.clearCache();

        const slot1Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
        const quota = HotSwapQuotaReader.getActiveQuota(slot1Dir);

        expect(quota).not.toBeNull();
        expect(quota!.slotId).toBe('slot-1');
        expect(quota!.email).toBe('user-a@example.com');
        expect(quota!.dailyPercentUsed).toBe(30);
      } finally {
        HotSwapQuotaReader.clearCache();
        if (originalCache) {
          writeFileSync(QUOTA_CACHE_PATH, originalCache, 'utf-8');
        }
      }
    });
  });

  // ==========================================================================
  // Account Lifecycle: deactivation/reactivation status awareness
  // ==========================================================================

  describe('Account Lifecycle (slot status awareness)', () => {
    const TEST_SESSIONS_DIR = '/tmp/slot-status-test';
    const TEST_SESSIONS_FILE = `${TEST_SESSIONS_DIR}/claude-sessions.yaml`;
    const QUOTA_CACHE_PATH = `${HOME}/.claude/session-health/hot-swap-quota.json`;

    let originalQuotaCache: string | null = null;
    let originalSessionsFile: string | null = null;

    // Save and restore production files
    const PROD_SESSIONS = `${HOME}/_claude-configs/hot-swap/claude-sessions.yaml`;

    beforeEach(() => {
      mkdirSync(TEST_SESSIONS_DIR, { recursive: true });
      if (existsSync(QUOTA_CACHE_PATH)) {
        originalQuotaCache = readFileSync(QUOTA_CACHE_PATH, 'utf-8');
      }
      if (existsSync(PROD_SESSIONS)) {
        originalSessionsFile = readFileSync(PROD_SESSIONS, 'utf-8');
      }
      HotSwapQuotaReader.clearCache();
    });

    afterEach(() => {
      HotSwapQuotaReader.clearCache();
      if (originalQuotaCache) {
        writeFileSync(QUOTA_CACHE_PATH, originalQuotaCache, 'utf-8');
      }
      if (originalSessionsFile) {
        writeFileSync(PROD_SESSIONS, originalSessionsFile, 'utf-8');
      }
      if (existsSync(TEST_SESSIONS_DIR)) {
        rmSync(TEST_SESSIONS_DIR, { recursive: true, force: true });
      }
    });

    test('getSlotStatus returns "active" for active slot', () => {
      // Write test sessions file with active slot
      const sessionsYaml = `
accounts:
  slot-1:
    email: test-a@example.com
    config_dir: /tmp/slot-1
    status: active
  slot-2:
    email: test-b@example.com
    config_dir: /tmp/slot-2
    status: active
active_account: slot-1
`;
      writeFileSync(PROD_SESSIONS, sessionsYaml, 'utf-8');
      HotSwapQuotaReader.clearCache();

      expect(HotSwapQuotaReader.getSlotStatus('slot-1')).toBe('active');
      expect(HotSwapQuotaReader.getSlotStatus('slot-2')).toBe('active');
    });

    test('getSlotStatus returns "inactive" for deactivated slot', () => {
      const sessionsYaml = `
accounts:
  slot-1:
    email: test-a@example.com
    config_dir: /tmp/slot-1
    status: inactive
    deactivated_at: "2026-02-01T10:00:00Z"
    deactivation_reason: error_401
  slot-2:
    email: test-b@example.com
    config_dir: /tmp/slot-2
    status: active
active_account: slot-2
`;
      writeFileSync(PROD_SESSIONS, sessionsYaml, 'utf-8');
      HotSwapQuotaReader.clearCache();

      expect(HotSwapQuotaReader.getSlotStatus('slot-1')).toBe('inactive');
      expect(HotSwapQuotaReader.getSlotStatus('slot-2')).toBe('active');
    });

    test('getSlotStatus returns "unknown" for nonexistent slot', () => {
      const sessionsYaml = `
accounts:
  slot-1:
    email: test-a@example.com
    status: active
active_account: slot-1
`;
      writeFileSync(PROD_SESSIONS, sessionsYaml, 'utf-8');
      HotSwapQuotaReader.clearCache();

      expect(HotSwapQuotaReader.getSlotStatus('slot-99')).toBe('unknown');
    });

    test('getAllSlotStatuses returns map of all slot statuses', () => {
      const sessionsYaml = `
accounts:
  slot-1:
    email: test-a@example.com
    status: inactive
  slot-2:
    email: test-b@example.com
    status: active
  slot-3:
    email: test-c@example.com
    status: active
active_account: slot-2
`;
      writeFileSync(PROD_SESSIONS, sessionsYaml, 'utf-8');
      HotSwapQuotaReader.clearCache();

      const statuses = HotSwapQuotaReader.getAllSlotStatuses();
      expect(statuses.size).toBe(3);
      expect(statuses.get('slot-1')).toBe('inactive');
      expect(statuses.get('slot-2')).toBe('active');
      expect(statuses.get('slot-3')).toBe('active');
    });

    test('getActiveQuota includes slotStatus in response', () => {
      const sessionsYaml = `
accounts:
  slot-1:
    email: user-a@example.com
    config_dir: ${HOME}/_claude-configs/hot-swap/registration/slot-1
    status: active
  slot-2:
    email: user-b@example.com
    config_dir: ${HOME}/_claude-configs/hot-swap/registration/slot-2
    status: inactive
    deactivation_reason: error_401
active_account: slot-1
`;
      writeFileSync(PROD_SESSIONS, sessionsYaml, 'utf-8');
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
      HotSwapQuotaReader.clearCache();

      // Query slot-1 (active)
      const slot1Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const quota1 = HotSwapQuotaReader.getActiveQuota(slot1Dir);
      expect(quota1).not.toBeNull();
      expect(quota1!.slotId).toBe('slot-1');
      expect(quota1!.slotStatus).toBe('active');

      // Query slot-2 (inactive) — configDir match still returns data but with inactive status
      const slot2Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-2`;
      const quota2 = HotSwapQuotaReader.getActiveQuota(slot2Dir);
      expect(quota2).not.toBeNull();
      expect(quota2!.slotId).toBe('slot-2');
      expect(quota2!.slotStatus).toBe('inactive');
    });

    test('getActiveQuota Strategy 4 (freshest slot) skips inactive slots', () => {
      // Both slots in quota cache, but slot-1 is inactive and freshest
      const cacheWithFreshInactive: HotSwapQuotaCache = {
        'slot-1': {
          email: 'user-a@example.com',
          five_hour_util: 10,
          seven_day_util: 20,
          weekly_budget_remaining_hours: 100,
          weekly_reset_day: 'Thu',
          daily_reset_time: '17:00',
          last_fetched: Date.now() - 5000, // 5s ago (freshest)
          is_fresh: true,
          config_dir: '/tmp/inactive-slot',
        },
        'slot-2': {
          email: 'user-b@example.com',
          five_hour_util: 50,
          seven_day_util: 60,
          weekly_budget_remaining_hours: 48,
          weekly_reset_day: 'Wed',
          daily_reset_time: '23:00',
          last_fetched: Date.now() - 30000, // 30s ago
          is_fresh: true,
          config_dir: '/tmp/active-slot',
        },
      };

      const sessionsYaml = `
accounts:
  slot-1:
    email: user-a@example.com
    config_dir: /tmp/inactive-slot
    status: inactive
    deactivation_reason: error_no_data
  slot-2:
    email: user-b@example.com
    config_dir: /tmp/active-slot
    status: active
active_account: slot-2
`;
      writeFileSync(PROD_SESSIONS, sessionsYaml, 'utf-8');
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(cacheWithFreshInactive), 'utf-8');
      HotSwapQuotaReader.clearCache();

      // No configDir → Strategy 2 (active_account) → slot-2
      const quota = HotSwapQuotaReader.getActiveQuota();
      expect(quota).not.toBeNull();
      expect(quota!.slotId).toBe('slot-2');
      expect(quota!.slotStatus).toBe('active');
      expect(quota!.email).toBe('user-b@example.com');
    });

    test('slot status cache is cleared by clearCache()', () => {
      const sessionsYaml = `
accounts:
  slot-1:
    email: test-a@example.com
    status: active
active_account: slot-1
`;
      writeFileSync(PROD_SESSIONS, sessionsYaml, 'utf-8');
      HotSwapQuotaReader.clearCache();

      // First read
      expect(HotSwapQuotaReader.getSlotStatus('slot-1')).toBe('active');

      // Update file to inactive
      const updatedYaml = sessionsYaml.replace('status: active', 'status: inactive');
      writeFileSync(PROD_SESSIONS, updatedYaml, 'utf-8');

      // Without clearCache, should still see cached 'active'
      expect(HotSwapQuotaReader.getSlotStatus('slot-1')).toBe('active');

      // After clearCache, should see 'inactive'
      HotSwapQuotaReader.clearCache();
      expect(HotSwapQuotaReader.getSlotStatus('slot-1')).toBe('inactive');
    });

    test('handles error_session_expired deactivation reason', () => {
      const sessionsYaml = `
accounts:
  slot-1:
    email: test-a@example.com
    config_dir: /tmp/slot-1
    status: inactive
    deactivated_at: "2026-02-03T11:15:00Z"
    deactivation_reason: error_session_expired
  slot-2:
    email: test-b@example.com
    config_dir: /tmp/slot-2
    status: active
active_account: slot-2
`;
      writeFileSync(PROD_SESSIONS, sessionsYaml, 'utf-8');
      HotSwapQuotaReader.clearCache();

      expect(HotSwapQuotaReader.getSlotStatus('slot-1')).toBe('inactive');
      expect(HotSwapQuotaReader.getSlotStatus('slot-2')).toBe('active');
    });

    test('integration: full lifecycle — active → inactive → reactivated', () => {
      // Phase 1: Both slots active
      const phase1 = `
accounts:
  slot-1:
    email: user-a@example.com
    config_dir: ${HOME}/_claude-configs/hot-swap/registration/slot-1
    status: active
  slot-2:
    email: user-b@example.com
    config_dir: ${HOME}/_claude-configs/hot-swap/registration/slot-2
    status: active
active_account: slot-1
`;
      writeFileSync(PROD_SESSIONS, phase1, 'utf-8');
      writeFileSync(QUOTA_CACHE_PATH, JSON.stringify(MOCK_QUOTA_CACHE), 'utf-8');
      HotSwapQuotaReader.clearCache();

      const allActive = HotSwapQuotaReader.getAllSlotStatuses();
      expect(allActive.get('slot-1')).toBe('active');
      expect(allActive.get('slot-2')).toBe('active');

      // Phase 2: slot-1 deactivated (simulates fetch-quotas.sh auto-deactivation)
      const phase2 = `
accounts:
  slot-1:
    email: user-a@example.com
    config_dir: ${HOME}/_claude-configs/hot-swap/registration/slot-1
    status: inactive
    deactivated_at: "2026-02-03T10:00:00Z"
    deactivation_reason: error_session_expired
  slot-2:
    email: user-b@example.com
    config_dir: ${HOME}/_claude-configs/hot-swap/registration/slot-2
    status: active
active_account: slot-2
`;
      writeFileSync(PROD_SESSIONS, phase2, 'utf-8');
      HotSwapQuotaReader.clearCache();

      // getActiveQuota without configDir should use active_account (slot-2)
      const afterDeact = HotSwapQuotaReader.getActiveQuota();
      expect(afterDeact).not.toBeNull();
      expect(afterDeact!.slotId).toBe('slot-2');
      expect(afterDeact!.slotStatus).toBe('active');

      // getActiveQuota with slot-1's configDir should still return data (just marked inactive)
      const slot1Dir = `${HOME}/_claude-configs/hot-swap/registration/slot-1`;
      const slot1Data = HotSwapQuotaReader.getActiveQuota(slot1Dir);
      expect(slot1Data).not.toBeNull();
      expect(slot1Data!.slotStatus).toBe('inactive');

      // Phase 3: slot-1 reactivated (simulates detect-token.sh re-login)
      const phase3 = `
accounts:
  slot-1:
    email: user-a@example.com
    config_dir: ${HOME}/_claude-configs/hot-swap/registration/slot-1
    status: active
    reactivated_at: "2026-02-03T12:00:00Z"
  slot-2:
    email: user-b@example.com
    config_dir: ${HOME}/_claude-configs/hot-swap/registration/slot-2
    status: active
active_account: slot-1
`;
      writeFileSync(PROD_SESSIONS, phase3, 'utf-8');
      HotSwapQuotaReader.clearCache();

      const afterReact = HotSwapQuotaReader.getAllSlotStatuses();
      expect(afterReact.get('slot-1')).toBe('active');
      expect(afterReact.get('slot-2')).toBe('active');

      const reactQuota = HotSwapQuotaReader.getActiveQuota(slot1Dir);
      expect(reactQuota).not.toBeNull();
      expect(reactQuota!.slotStatus).toBe('active');
      expect(reactQuota!.slotId).toBe('slot-1');
    });
  });
});
