/**
 * Unit Tests - Git Validator
 *
 * Tests multi-source git branch validation
 */

import { describe, test, expect } from 'bun:test';
import GitValidator from '../../../src/validators/git-validator.pseudo';
import type { DataPoint } from '../../../src/types/validation';

interface GitData {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
  isRepo: boolean;
}

describe('GitValidator', () => {
  const validator = new GitValidator();

  // Helper to create data points
  function createDataPoint(
    git: GitData,
    source: string,
    age = 0
  ): DataPoint<GitData> {
    return {
      value: git,
      source,
      fetchedAt: Date.now() - age
    };
  }

  // Helper to create git data
  function createGit(
    branch: string,
    ahead = 0,
    behind = 0,
    dirty = 0,
    isRepo = true
  ): GitData {
    return { branch, ahead, behind, dirty, isRepo };
  }

  describe('Both sources available - comparison', () => {
    test('Exact match - confidence 100%', () => {
      const gitStatus = createDataPoint(createGit('main', 2, 0, 1), 'git_status');
      const headFile = createDataPoint(createGit('main'), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
      expect(result.recommendedSource).toBe('git_status');
    });

    test('Match with refs/heads/ prefix normalized', () => {
      const gitStatus = createDataPoint(createGit('main'), 'git_status');
      const headFile = createDataPoint(createGit('refs/heads/main'), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(0); // Normalized correctly
    });

    test('Branch mismatch - confidence 60%, error, show 🔴', () => {
      const gitStatus = createDataPoint(createGit('main'), 'git_status');
      const headFile = createDataPoint(createGit('develop'), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(60);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Branch mismatch');
      expect(result.errors[0]).toContain('main');
      expect(result.errors[0]).toContain('develop');
      expect(result.showStaleIndicator).toBe(true);
      expect(result.recommendedSource).toBe('git_status'); // Prefer git status
    });
  });

  describe('Single source scenarios', () => {
    test('Only git status available - confidence 95% (NORMAL CASE)', () => {
      const gitStatus = createDataPoint(createGit('main', 0, 0, 0), 'git_status');

      const result = validator.validate(gitStatus, []);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(95);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Single source only');
      expect(result.recommendedSource).toBe('git_status');
    });

    test('Git status unavailable - fail with confidence 0', () => {
      const gitStatus: DataPoint<GitData> = {
        value: null as any,
        source: 'git_status',
        fetchedAt: Date.now()
      };

      const result = validator.validate(gitStatus, []);

      expect(result.valid).toBe(false);
      expect(result.confidence).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('Git status unavailable');
      expect(result.showStaleIndicator).toBe(true);
    });
  });

  describe('Not a git repository', () => {
    test('isRepo=false - valid with confidence 100% (expected)', () => {
      const gitStatus = createDataPoint(createGit('', 0, 0, 0, false), 'git_status');

      const result = validator.validate(gitStatus, []);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('Not a git repository');
      expect(result.recommendedSource).toBe('none');
    });
  });

  describe('Branch name normalization', () => {
    test('Feature branch with slashes normalized correctly', () => {
      const gitStatus = createDataPoint(createGit('feature/add-validation'), 'git_status');
      const headFile = createDataPoint(createGit('refs/heads/feature/add-validation'), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
    });

    test('Release branch normalized correctly', () => {
      const gitStatus = createDataPoint(createGit('release/v2.0'), 'git_status');
      const headFile = createDataPoint(createGit('refs/heads/release/v2.0'), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.valid).toBe(true);
    });

    test('Hotfix branch normalized correctly', () => {
      const gitStatus = createDataPoint(createGit('hotfix/urgent-fix'), 'git_status');
      const headFile = createDataPoint(createGit('refs/heads/hotfix/urgent-fix'), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.valid).toBe(true);
    });
  });

  describe('Detached HEAD detection', () => {
    test('Detached HEAD with short SHA detected', () => {
      const gitData = createGit('a1b2c3d', 0, 0, 0);

      const isDetached = validator.isDetachedHead(gitData);

      expect(isDetached).toBe(true);
    });

    test('Detached HEAD with full SHA detected', () => {
      const gitData = createGit('a1b2c3d4e5f6789012345678901234567890abcd', 0, 0, 0);

      const isDetached = validator.isDetachedHead(gitData);

      expect(isDetached).toBe(true);
    });

    test('Normal branch name not detected as detached', () => {
      const gitData = createGit('main', 0, 0, 0);

      const isDetached = validator.isDetachedHead(gitData);

      expect(isDetached).toBe(false);
    });

    test('Branch name with numbers not falsely detected', () => {
      const gitData = createGit('feature-123', 0, 0, 0);

      const isDetached = validator.isDetachedHead(gitData);

      expect(isDetached).toBe(false);
    });
  });

  describe('Git state validation (deep validation)', () => {
    test('validateGitState with clean working tree', () => {
      const gitStatus = createGit('main', 0, 0, 0);
      const headFile = createGit('main');

      const state = validator.validateGitState(gitStatus, headFile);

      expect(state.branchExists).toBe(true);
      expect(state.refsConsistent).toBe(true);
      expect(state.workingTreeClean).toBe(true);
    });

    test('validateGitState with dirty working tree', () => {
      const gitStatus = createGit('main', 0, 0, 5); // 5 dirty files
      const headFile = createGit('main');

      const state = validator.validateGitState(gitStatus, headFile);

      expect(state.branchExists).toBe(true);
      expect(state.refsConsistent).toBe(true);
      expect(state.workingTreeClean).toBe(false);
    });

    test('validateGitState with inconsistent refs', () => {
      const gitStatus = createGit('main');
      const headFile = createGit('develop');

      const state = validator.validateGitState(gitStatus, headFile);

      expect(state.branchExists).toBe(true);
      expect(state.refsConsistent).toBe(false);
      expect(state.workingTreeClean).toBe(true);
    });

    test('validateGitState with empty branch names', () => {
      const gitStatus = createGit('');
      const headFile = createGit('');

      const state = validator.validateGitState(gitStatus, headFile);

      expect(state.branchExists).toBe(false); // Empty branches
      expect(state.refsConsistent).toBe(true); // Both empty = consistent
    });
  });

  describe('Metadata validation', () => {
    test('Staleness calculated from oldest source', () => {
      const gitStatus = createDataPoint(createGit('main'), 'git_status', 3000);
      const headFile = createDataPoint(createGit('main'), 'git_head', 8000);

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.metadata.staleness).toBeGreaterThanOrEqual(8000); // Max age
      expect(result.metadata.sourcesChecked).toBe(2);
    });

    test('Source agreement zero on mismatch', () => {
      const gitStatus = createDataPoint(createGit('main'), 'git_status');
      const headFile = createDataPoint(createGit('develop'), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.metadata.sourceAgreement).toBe(0); // Complete disagreement
    });

    test('Source agreement 100 on match', () => {
      const gitStatus = createDataPoint(createGit('main'), 'git_status');
      const headFile = createDataPoint(createGit('main'), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.metadata.sourceAgreement).toBe(100);
    });
  });

  describe('Edge cases', () => {
    test('Empty branch name in git status', () => {
      const gitStatus = createDataPoint(createGit('', 0, 0, 0), 'git_status');
      const headFile = createDataPoint(createGit('main'), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      // Should detect mismatch
      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    test('Very long branch name handled gracefully', () => {
      const longBranch = 'feature/very-long-branch-name-that-exceeds-normal-length-' + 'x'.repeat(200);
      const gitStatus = createDataPoint(createGit(longBranch), 'git_status');
      const headFile = createDataPoint(createGit(`refs/heads/${longBranch}`), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
    });

    test('Branch name with special characters', () => {
      const specialBranch = 'feature/fix-#123-bug@v2';
      const gitStatus = createDataPoint(createGit(specialBranch), 'git_status');
      const headFile = createDataPoint(createGit(specialBranch), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      expect(result.valid).toBe(true);
    });

    test('Ahead/behind counts do not affect validation', () => {
      const gitStatus = createDataPoint(createGit('main', 10, 5, 3), 'git_status');
      const headFile = createDataPoint(createGit('main', 0, 0, 0), 'git_head');

      const result = validator.validate(gitStatus, [headFile]);

      // Should still match (only branch name matters)
      expect(result.valid).toBe(true);
      expect(result.confidence).toBe(100);
    });
  });
});
