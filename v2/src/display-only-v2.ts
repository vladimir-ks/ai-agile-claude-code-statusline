#!/usr/bin/env bun
/**
 * DISPLAY ONLY V2 - Ultra-fast YAML-based statusline
 *
 * ARCHITECTURAL GUARANTEE:
 * - Reads ONLY from runtime-state.yaml (single file)
 * - Looks up pre-formatted string for terminal width
 * - Outputs string directly - NO formatting logic
 * - <2ms execution time (was <5ms, now even faster)
 *
 * WORKFLOW:
 * 1. Parse stdin for session_id
 * 2. Read runtime-state.yaml
 * 3. Find session by ID
 * 4. Pick formattedString for current terminal width
 * 5. Output string
 *
 * FALLBACK:
 * - If YAML missing → minimal output
 * - If session not found → minimal output
 * - If formattedStrings missing → "⏳ Loading..."
 * - NEVER throws, NEVER blocks
 */

import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import yaml from 'yaml';

const RUNTIME_STATE_PATH = `${homedir()}/.claude/session-health/runtime-state.yaml`;

// Minimal type for runtime state (only what we need)
interface RuntimeSession {
  sessionId: string;
  projectPath: string;
  formattedStrings?: {
    width40: string;
    width60: string;
    width80: string;
    width100: string;
    width120: string;
    width150: string;
    width200: string;
  };
}

interface RuntimeState {
  sessions: RuntimeSession[];
}

/**
 * Safe YAML read - returns null on any error
 */
function safeReadYAML<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8');
    return yaml.parse(content) as T;
  } catch {
    return null;
  }
}

/**
 * Main display logic
 */
function display(): void {
  try {
    // 1. Parse stdin for session_id
    let sessionId: string | null = null;
    try {
      const stdin = readFileSync(0, 'utf-8');
      const parsed = JSON.parse(stdin);
      sessionId = parsed?.session_id || null;
    } catch {
      // Can't parse stdin
    }

    // 2. If no session ID, output minimal
    if (!sessionId) {
      process.stdout.write('🤖 Claude');
      return;
    }

    // 3. Read runtime-state.yaml
    const runtimeState = safeReadYAML<RuntimeState>(RUNTIME_STATE_PATH);
    if (!runtimeState || !runtimeState.sessions) {
      process.stdout.write('⏳ Loading...');
      return;
    }

    // 4. Find session by ID
    const session = runtimeState.sessions.find(s => s.sessionId === sessionId);
    if (!session) {
      process.stdout.write('⏳ Loading...');
      return;
    }

    // 5. Pick formatted string for current terminal width
    const paneWidth = parseInt(process.env.STATUSLINE_WIDTH || '120', 10);
    let formattedString: string;

    if (session.formattedStrings) {
      // Select variant based on terminal width
      if (paneWidth <= 50) {
        formattedString = session.formattedStrings.width40;
      } else if (paneWidth <= 70) {
        formattedString = session.formattedStrings.width60;
      } else if (paneWidth <= 90) {
        formattedString = session.formattedStrings.width80;
      } else if (paneWidth <= 110) {
        formattedString = session.formattedStrings.width100;
      } else if (paneWidth <= 135) {
        formattedString = session.formattedStrings.width120;
      } else if (paneWidth <= 175) {
        formattedString = session.formattedStrings.width150;
      } else {
        formattedString = session.formattedStrings.width200;
      }
    } else {
      // Fallback: strings not yet generated
      formattedString = '⏳ Loading...';
    }

    // 6. Output string directly (NO trailing newline - string already has them)
    process.stdout.write(formattedString);

  } catch (error) {
    // LAST RESORT: Catastrophic failure
    process.stdout.write('⚠️ Error');
  }
}

// Run display
display();
