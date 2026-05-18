/**
 * Git Source — Tier 3 (global, shared cache)
 *
 * Fetches git status: branch, ahead/behind, dirty count.
 * Uses GitModule with 30s cooldown.
 * Per-project (contextKey = projectPath).
 */

import type { DataSourceDescriptor, GatherContext } from './types';
import type { GitInfo, SessionHealth } from '../../types/session-health';
import GitModule from '../../modules/git-module';

const gitModule = new GitModule({
  id: 'git',
  name: 'Git Module',
  enabled: true,
  cacheTTL: 30000,
});

export interface GitSourceData {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
  fetchedAt: number;
}

export const gitSource: DataSourceDescriptor<GitSourceData> = {
  id: 'git_status',
  tier: 3,
  freshnessCategory: 'git_status',
  timeoutMs: 5000,

  async fetch(ctx: GatherContext): Promise<GitSourceData> {
    const fetchStart = Date.now();
    // F-D2: pass ctx.projectPath so gitModule uses the session's project directory
    // rather than process.cwd() (which is the daemon's CWD, not the project).
    const gitData = await gitModule.fetch(ctx.sessionId, ctx.projectPath);

    return {
      branch: gitData?.branch || '',
      ahead: gitData?.ahead || 0,
      behind: gitData?.behind || 0,
      dirty: gitData?.dirty || 0,
      fetchedAt: fetchStart,
    };
  },

  merge(target: SessionHealth, data: GitSourceData): void {
    target.git = {
      branch: data.branch,
      ahead: data.ahead,
      behind: data.behind,
      dirty: data.dirty,
      lastChecked: data.fetchedAt,
    };
  },
};

export default gitSource;
