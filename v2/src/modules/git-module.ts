/**
 * Git Module - Repository Status (Production)
 * Data Source: git commands
 * Session-Specific: NO (shared by repo)
 * Optimization: 30s cooldown to prevent duplicate git calls across sessions
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';
import { exec } from 'child_process';
import { promisify } from 'util';
import CooldownManager from '../lib/cooldown-manager';

const execAsync = promisify(exec);

interface GitData {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
  isRepo: boolean;
}

class GitModule implements DataModule<GitData> {
  readonly moduleId = 'git';
  config: DataModuleConfig = { timeout: 2000, cacheTTL: 30000 };  // 30s cooldown
  private cooldownManager: CooldownManager;
  private lastResult: GitData | null = null;

  constructor(config?: Partial<DataModuleConfig>) {
    if (config) {
      this.config = { ...this.config, ...config };
    }
    this.cooldownManager = new CooldownManager();
  }

  async fetch(sessionId: string): Promise<GitData> {
    // Check cooldown - skip if another session checked recently
    if (!this.cooldownManager.shouldRun('git-status')) {
      // Return cached result if available
      if (this.lastResult) {
        return this.lastResult;
      }
      // No cache but cooldown active - use default
      return { branch: '', ahead: 0, behind: 0, dirty: 0, isRepo: false };
    }

    // Common exec options with proper cleanup
    const execOpts = {
      timeout: 1000,
      killSignal: 'SIGKILL' as const,  // Force kill on timeout
      maxBuffer: 512 * 1024,  // 512KB max
      cwd: process.cwd()
    };

    try {
      const { stdout: branch } = await execAsync('git branch --show-current', execOpts);
      const { stdout: status } = await execAsync('git status --porcelain', execOpts);

      const dirty = status.trim().split('\n').filter(l => l.trim()).length;

      // Get ahead/behind counts
      let ahead = 0;
      let behind = 0;

      try {
        const { stdout: aheadStr } = await execAsync('git rev-list --count @{u}..HEAD', execOpts);
        ahead = parseInt(aheadStr.trim(), 10) || 0;
      } catch {
        // No upstream or error, default to 0
      }

      try {
        const { stdout: behindStr } = await execAsync('git rev-list --count HEAD..@{u}', execOpts);
        behind = parseInt(behindStr.trim(), 10) || 0;
      } catch {
        // No upstream or error, default to 0
      }

      const result: GitData = {
        branch: branch.trim() || 'main',
        ahead,
        behind,
        dirty,
        isRepo: true
      };

      // Cache result and mark cooldown
      this.lastResult = result;
      this.cooldownManager.markComplete('git-status', { repoPath: process.cwd() });

      return result;
    } catch (error) {
      const fallback = { branch: '', ahead: 0, behind: 0, dirty: 0, isRepo: false };
      this.lastResult = fallback;
      return fallback;
    }
  }

  validate(data: GitData) {
    return {
      valid: true,
      errors: [],
      warnings: [],
      sanitized: data
    };
  }

  format(data: GitData): string {
    if (!data.isRepo) return '';

    let status = data.branch;

    // Add ahead/behind if present
    if (data.ahead > 0 || data.behind > 0) {
      status += `+${data.ahead}/-${data.behind}`;
    }

    // Add dirty count
    if (data.dirty > 0) {
      status += `*${data.dirty}`;
    }

    return `🌿:${status}`;
  }
}

export default GitModule;
export { GitData };
