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
    const repoPath = process.cwd();

    // Check cooldown - skip if another session checked recently (per-repo)
    if (!this.cooldownManager.shouldRun('git-status', undefined, repoPath)) {
      // Try to read cached result from cooldown file
      const cooldownData = this.cooldownManager.read('git-status', undefined, repoPath);
      if (cooldownData) {
        // Extract git data from cooldown (it stores the full result)
        const cached: GitData = {
          branch: (cooldownData as any).branch || '',
          ahead: (cooldownData as any).ahead || 0,
          behind: (cooldownData as any).behind || 0,
          dirty: (cooldownData as any).dirty || 0,
          isRepo: (cooldownData as any).isRepo || false
        };
        this.lastResult = cached;
        return cached;
      }
      // No cache in cooldown file - return default
      return { branch: '', ahead: 0, behind: 0, dirty: 0, isRepo: false };
    }

    // Common exec options with proper cleanup
    const execOpts = {
      timeout: 1000,
      killSignal: 'SIGKILL' as const,  // Force kill on timeout
      maxBuffer: 512 * 1024,  // 512KB max
      cwd: repoPath
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

      // Cache result and mark cooldown (per-repo using contextKey)
      // Store full result in cooldown file so other sessions can use it
      this.lastResult = result;
      this.cooldownManager.markComplete('git-status', {
        repoPath,
        ...result  // Store all git data in cooldown file
      }, undefined, repoPath);

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
