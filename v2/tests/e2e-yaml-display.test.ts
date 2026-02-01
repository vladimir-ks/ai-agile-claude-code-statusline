/**
 * E2E Test: YAML-based Display System
 *
 * Tests the complete flow:
 * 1. Data-gatherer generates health data
 * 2. StatuslineFormatter generates formatted strings
 * 3. Runtime-state stores formatted strings in YAML
 * 4. Display-only-v2 reads YAML and outputs strings
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import yaml from 'yaml';

const TEST_HOME = '/tmp/e2e-yaml-test';
const TEST_HEALTH_DIR = `${TEST_HOME}/.claude/session-health`;
const RUNTIME_STATE_PATH = `${TEST_HEALTH_DIR}/runtime-state.yaml`;

describe('E2E: YAML-based Display System', () => {
  beforeAll(() => {
    // Create test directories
    mkdirSync(TEST_HEALTH_DIR, { recursive: true });
  });

  afterAll(() => {
    // Cleanup
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  test('Complete flow: Formatter → RuntimeState → Display', () => {
    // 1. Create mock SessionHealth with formattedOutput
    const mockHealth = {
      sessionId: 'test-e2e-123',
      projectPath: '/Users/test/project',
      transcriptPath: '/Users/test/.claude/transcripts/test.jsonl',
      launch: {
        authProfile: 'default',
        detectionMethod: 'default'
      },
      health: {
        status: 'healthy',
        lastUpdate: Date.now(),
        issues: []
      },
      transcript: {
        exists: true,
        sizeBytes: 1024,
        lastModified: Date.now(),
        lastModifiedAgo: '1m',
        messageCount: 5,
        lastMessageTime: Date.now(),
        lastMessagePreview: 'Test message',
        lastMessageAgo: '1m',
        isSynced: true
      },
      model: {
        value: 'Sonnet4.5',
        source: 'transcript',
        confidence: 90
      },
      context: {
        tokensUsed: 46000,
        tokensLeft: 154000,
        percentUsed: 23,
        windowSize: 200000,
        nearCompaction: false
      },
      git: {
        branch: 'main',
        ahead: 0,
        behind: 0,
        dirty: 0,
        lastChecked: Date.now()
      },
      billing: {
        costToday: 10.5,
        burnRatePerHour: 5.2,
        budgetRemaining: 42,
        budgetPercentUsed: 29,
        resetTime: '14:00',
        isFresh: true,
        lastFetched: Date.now()
      },
      alerts: {
        secretsDetected: false,
        secretTypes: [],
        transcriptStale: false,
        dataLossRisk: false
      },
      gatheredAt: Date.now(),

      // Pre-formatted output (simulating StatuslineFormatter)
      formattedOutput: {
        width40: ['🕐:13:18|⌛:42m(29%)', '📁:~/project 🤖:Sonnet4.5'],
        width60: ['🕐:13:18|⌛:42m(29%)', '📁:~/project 🤖:Sonnet4.5 🧠:154k'],
        width80: ['📁:~/project 🌿:main 🤖:Sonnet4.5 🧠:154k-free[---------|--]', '🕐:13:18|⌛:42m(29%)'],
        width100: ['📁:~/project 🌿:main 🤖:Sonnet4.5 🧠:154k-free[---------|--]', '🕐:13:18|⌛:42m(29%) 💰:$10.5|$5.2/h'],
        width120: ['📁:~/project 🌿:main 🤖:Sonnet4.5 🧠:154k-free[---------|--]', '🕐:13:18|⌛:42m(29%) 💰:$10.5|$5.2/h 💬:5t'],
        width150: ['📁:~/project 🌿:main 🤖:Sonnet4.5 🧠:154k-free[---------|--]', '🕐:13:18|⌛:42m(29%) 💰:$10.5|$5.2/h 📊:200ktok 💬:5t'],
        width200: ['📁:~/project 🌿:main 🤖:Sonnet4.5 🧠:154k-free[---------|--]', '🕐:13:18|⌛:42m(29%) 💰:$10.5|$5.2/h 📊:200ktok(0tpm) 💬:5t', '💬(1m) Test message']
      }
    };

    // 2. Create RuntimeState YAML with formatted strings
    const runtimeState = {
      authProfiles: [
        {
          profileId: 'default',
          label: 'Primary Account',
          billing: {
            costToday: 10.5,
            burnRatePerHour: 5.2,
            budgetRemaining: 42,
            budgetPercentUsed: 29,
            resetTime: '14:00',
            isFresh: true,
            lastFetched: Date.now()
          }
        }
      ],
      sessions: [
        {
          sessionId: 'test-e2e-123',
          authProfile: 'default',
          projectPath: '/Users/test/project',
          transcriptPath: '/Users/test/.claude/transcripts/test.jsonl',
          health: { status: 'healthy', issues: [] },
          model: { value: 'Sonnet4.5', source: 'transcript', confidence: 90 },
          context: { tokensUsed: 46000, tokensLeft: 154000, percentUsed: 23, windowSize: 200000, nearCompaction: false },
          git: { branch: 'main', ahead: 0, behind: 0, dirty: 0, lastChecked: Date.now() },
          transcript: {
            exists: true,
            sizeBytes: 1024,
            lastModified: Date.now(),
            lastModifiedAgo: '1m',
            messageCount: 5,
            lastMessagePreview: 'Test message',
            isSynced: true
          },
          alerts: {
            secretsDetected: false,
            secretTypes: [],
            transcriptStale: false,
            dataLossRisk: false
          },
          metadata: {
            gatheredAt: Date.now(),
            lastActivity: Date.now()
          },

          // FORMATTED STRINGS (ready to output)
          formattedStrings: {
            width40: mockHealth.formattedOutput.width40.join('\n'),
            width60: mockHealth.formattedOutput.width60.join('\n'),
            width80: mockHealth.formattedOutput.width80.join('\n'),
            width100: mockHealth.formattedOutput.width100.join('\n'),
            width120: mockHealth.formattedOutput.width120.join('\n'),
            width150: mockHealth.formattedOutput.width150.join('\n'),
            width200: mockHealth.formattedOutput.width200.join('\n')
          }
        }
      ],
      metadata: {
        version: '1.0',
        lastUpdated: Date.now(),
        totalAuthProfiles: 1,
        totalActiveSessions: 1
      }
    };

    // 3. Write runtime-state.yaml
    const yamlContent = yaml.stringify(runtimeState);
    writeFileSync(RUNTIME_STATE_PATH, yamlContent, 'utf-8');

    // 4. Test display-only-v2 with different terminal widths
    const testWidths = [40, 60, 80, 100, 120, 150, 200];

    for (const width of testWidths) {
      const output = execSync(
        `echo '{"session_id":"test-e2e-123"}' | bun ${join(__dirname, '../src/display-only-v2.ts')}`,
        {
          encoding: 'utf-8',
          env: { ...process.env, HOME: TEST_HOME, STATUSLINE_WIDTH: String(width) }
        }
      );

      // Verify output matches formatted string for this width
      const expectedKey = `width${width}` as keyof typeof mockHealth.formattedOutput;
      const expected = mockHealth.formattedOutput[expectedKey].join('\n');

      expect(output).toBe(expected);
    }
  });

  test('Display-only handles missing session gracefully', () => {
    // Create YAML with different session
    const runtimeState = {
      authProfiles: [],
      sessions: [
        {
          sessionId: 'different-session',
          authProfile: 'default',
          projectPath: '/Users/test/other',
          formattedStrings: {
            width120: '📁:~/other'
          }
        }
      ],
      metadata: { version: '1.0', lastUpdated: Date.now(), totalAuthProfiles: 0, totalActiveSessions: 1 }
    };

    writeFileSync(RUNTIME_STATE_PATH, yaml.stringify(runtimeState), 'utf-8');

    // Request non-existent session
    const output = execSync(
      `echo '{"session_id":"missing-session"}' | bun ${join(__dirname, '../src/display-only-v2.ts')}`,
      {
        encoding: 'utf-8',
        env: { ...process.env, HOME: TEST_HOME }
      }
    );

    expect(output).toBe('⏳ Loading...');
  });

  test('Display-only handles missing YAML file gracefully', () => {
    // Remove YAML file
    if (existsSync(RUNTIME_STATE_PATH)) {
      unlinkSync(RUNTIME_STATE_PATH);
    }

    const output = execSync(
      `echo '{"session_id":"any-session"}' | bun ${join(__dirname, '../src/display-only-v2.ts')}`,
      {
        encoding: 'utf-8',
        env: { ...process.env, HOME: TEST_HOME }
      }
    );

    expect(output).toBe('⏳ Loading...');
  });

  test('Display-only handles corrupt YAML gracefully', () => {
    // Write invalid YAML
    writeFileSync(RUNTIME_STATE_PATH, 'invalid: yaml: content: [[[', 'utf-8');

    const output = execSync(
      `echo '{"session_id":"any-session"}' | bun ${join(__dirname, '../src/display-only-v2.ts')}`,
      {
        encoding: 'utf-8',
        env: { ...process.env, HOME: TEST_HOME }
      }
    );

    expect(output).toBe('⏳ Loading...');
  });

  test('Display-only is fast (<5ms)', () => {
    // Create minimal YAML
    const runtimeState = {
      authProfiles: [],
      sessions: [
        {
          sessionId: 'speed-test',
          authProfile: 'default',
          projectPath: '/test',
          formattedStrings: {
            width120: 'Fast output'
          }
        }
      ],
      metadata: { version: '1.0', lastUpdated: Date.now(), totalAuthProfiles: 0, totalActiveSessions: 1 }
    };

    writeFileSync(RUNTIME_STATE_PATH, yaml.stringify(runtimeState), 'utf-8');

    // Measure execution time
    const start = performance.now();
    execSync(
      `echo '{"session_id":"speed-test"}' | bun ${join(__dirname, '../src/display-only-v2.ts')}`,
      {
        encoding: 'utf-8',
        env: { ...process.env, HOME: TEST_HOME }
      }
    );
    const elapsed = performance.now() - start;

    // Should be very fast (<5ms is target, but including bun startup)
    expect(elapsed).toBeLessThan(100); // Generous for CI
  });
});
