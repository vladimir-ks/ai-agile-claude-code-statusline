/**
 * Git Module - Repository Status (Production)
 * Data Source: git commands
 * Session-Specific: NO (shared by repo)
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';
import { exec } from 'child_process';
import { promisify } from 'util';

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
  config: DataModuleConfig = { timeout: 2000, cacheTTL: 10000 };  // 10s cache

  async fetch(sessionId: string): Promise<GitData> {
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

      return {
        branch: branch.trim() || 'main',
        ahead,
        behind,
        dirty,
        isRepo: true
      };
    } catch (error) {
      return { branch: '', ahead: 0, behind: 0, dirty: 0, isRepo: false };
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
