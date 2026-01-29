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
    try {
      const { stdout: branch } = await execAsync('git branch --show-current', {
        timeout: 1000,
        cwd: process.cwd()
      });

      const { stdout: status } = await execAsync('git status --porcelain', {
        timeout: 1000,
        cwd: process.cwd()
      });

      const dirty = status.trim().split('\n').filter(l => l.trim()).length;

      return {
        branch: branch.trim() || 'main',
        ahead: 0,
        behind: 0,
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
    const dirty = data.dirty > 0 ? `*${data.dirty}` : '';
    return `🌿:${data.branch}${dirty}`;
  }
}

export default GitModule;
export { GitData };
