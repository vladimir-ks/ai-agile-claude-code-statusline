/**
 * Git Validator
 *
 * Validates git branch data across multiple sources:
 * - Primary: git status output (current working tree state)
 * - Secondary: .git/HEAD file (direct branch reference)
 * - Tertiary: .git/refs/heads/* (branch existence)
 *
 * Rules:
 * - Exact match: confidence=100%
 * - Mismatch: error, use git status, confidence=60%, show 🔴
 * - Only git status: confidence=95% (normal)
 * - Not a git repo: valid but show placeholder, confidence=100%
 */

import { Validator, DataPoint, ValidationResult } from '../types/validation';

interface GitData {
  branch: string;           // Current branch name (e.g., "main")
  ahead: number;            // Commits ahead of remote
  behind: number;           // Commits behind remote
  dirty: number;            // Number of modified/untracked files
  isRepo: boolean;          // Whether current directory is a git repo
}

class GitValidator implements Validator<GitData> {
  readonly dataType = 'git';

  validate(
    primary: DataPoint<GitData>,
    secondary: DataPoint<GitData>[]
  ): ValidationResult {
    // Find HEAD file source
    const headFile = secondary.find(s => s.source === 'git_head');

    // Case 1: Not a git repository
    if (primary.value && !primary.value.isRepo) {
      return {
        valid: true,
        confidence: 100,
        warnings: ['Not a git repository'],
        errors: [],
        recommendedSource: 'none',
        metadata: {
          sourceAgreement: 100,
          validationLatency: 0,
          staleness: 0,
          sourcesChecked: 1
        }
      };
    }

    // Case 2: Primary (git status) not available
    if (!primary.value) {
      return {
        valid: false,
        confidence: 0,
        warnings: [],
        errors: ['Git status unavailable'],
        recommendedSource: 'none',
        showStaleIndicator: true,
        metadata: {
          sourceAgreement: 0,
          validationLatency: 0,
          staleness: 0,
          sourcesChecked: secondary.length + 1
        }
      };
    }

    // Case 3: Only primary (git status) available - NORMAL CASE
    if (primary.value && !headFile) {
      return {
        valid: true,
        confidence: 95, // High confidence (git status is current)
        warnings: ['Single source only (HEAD file not checked)'],
        errors: [],
        recommendedSource: 'git_status',
        metadata: {
          sourceAgreement: 100,
          validationLatency: 0,
          staleness: Date.now() - primary.fetchedAt,
          sourcesChecked: 1
        }
      };
    }

    // Case 4: Both sources available - compare them
    if (primary.value && headFile) {
      return this.compareBranches(primary, headFile);
    }

    // Should never reach here
    return this.createErrorResult('Unexpected validation state');
  }

  /**
   * Compare branch names from git status and HEAD file
   */
  private compareBranches(
    gitStatus: DataPoint<GitData>,
    headFile: DataPoint<GitData>
  ): ValidationResult {
    const statusBranch = gitStatus.value.branch;
    const headBranch = headFile.value.branch;

    // Normalize branch names (strip refs/heads/ prefix if present)
    const normalizedStatus = this.normalizeBranchName(statusBranch);
    const normalizedHead = this.normalizeBranchName(headBranch);

    // Case A: Exact match
    if (normalizedStatus === normalizedHead) {
      return {
        valid: true,
        confidence: 100,
        warnings: [],
        errors: [],
        recommendedSource: 'git_status',
        metadata: {
          sourceAgreement: 100,
          validationLatency: 0,
          staleness: Math.max(
            Date.now() - gitStatus.fetchedAt,
            Date.now() - headFile.fetchedAt
          ),
          sourcesChecked: 2
        }
      };
    }

    // Case B: Mismatch (possible corruption or race condition)
    return {
      valid: false,
      confidence: 60,
      warnings: [],
      errors: [
        `Branch mismatch: git_status="${normalizedStatus}", HEAD="${normalizedHead}"`
      ],
      recommendedSource: 'git_status', // Prefer git status (more reliable)
      showStaleIndicator: true, // Show 🔴 due to inconsistency
      metadata: {
        sourceAgreement: 0, // Complete disagreement
        validationLatency: 0,
        staleness: Math.max(
          Date.now() - gitStatus.fetchedAt,
          Date.now() - headFile.fetchedAt
        ),
        sourcesChecked: 2
      }
    };
  }

  /**
   * Normalize branch name (strip refs/heads/ prefix)
   */
  private normalizeBranchName(branch: string): string {
    if (branch.startsWith('refs/heads/')) {
      return branch.substring('refs/heads/'.length);
    }
    return branch;
  }

  /**
   * Validate git state consistency (optional deep validation)
   */
  validateGitState(
    gitStatus: GitData,
    headFile: GitData
  ): {
    branchExists: boolean;
    refsConsistent: boolean;
    workingTreeClean: boolean;
  } {
    const branchExists = gitStatus.branch !== '' && headFile.branch !== '';
    const refsConsistent = this.normalizeBranchName(gitStatus.branch) ===
                           this.normalizeBranchName(headFile.branch);
    const workingTreeClean = gitStatus.dirty === 0;

    return {
      branchExists,
      refsConsistent,
      workingTreeClean
    };
  }

  /**
   * Check for detached HEAD state
   */
  isDetachedHead(gitData: GitData): boolean {
    // Detached HEAD shows commit SHA instead of branch name
    return gitData.branch.match(/^[0-9a-f]{7,40}$/i) !== null;
  }

  /**
   * Create error result
   */
  private createErrorResult(errorMessage: string): ValidationResult {
    return {
      valid: false,
      confidence: 0,
      warnings: [],
      errors: [errorMessage],
      recommendedSource: 'none',
      showStaleIndicator: true,
      metadata: {
        sourceAgreement: 0,
        validationLatency: 0,
        staleness: 0,
        sourcesChecked: 0
      }
    };
  }
}

export default GitValidator;
