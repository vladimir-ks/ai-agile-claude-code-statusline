/**
 * Git Validator - Production Implementation
 *
 * Validates git branch data across multiple sources with error handling
 * and defensive programming.
 *
 * Sources:
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

import type { Validator, DataPoint, ValidationResult } from '../types/validation';

interface GitData {
  branch: string;           // Current branch name (e.g., "main")
  ahead: number;            // Commits ahead of remote
  behind: number;           // Commits behind remote
  dirty: number;            // Number of modified/untracked files
  isRepo: boolean;          // Whether current directory is a git repo
}

class GitValidator implements Validator<GitData> {
  readonly dataType = 'git';

  /**
   * Validate git branch data across sources
   *
   * @throws Never - all errors handled gracefully
   */
  validate(
    primary: DataPoint<GitData>,
    secondary: DataPoint<GitData>[]
  ): ValidationResult {
    try {
      // Input validation
      if (!this.isValidDataPoint(primary)) {
        return this.createErrorResult('Invalid primary data point');
      }

      if (!Array.isArray(secondary)) {
        return this.createErrorResult('Invalid secondary data points (not array)');
      }

      // Validate git data structure
      if (primary.value && !this.isValidGitData(primary.value)) {
        return this.createErrorResult('Invalid git data structure in primary source');
      }

      // Find HEAD file source
      const headFile = secondary.find(s => s?.source === 'git_head');

      if (headFile?.value && !this.isValidGitData(headFile.value)) {
        return this.createErrorResult('Invalid git data structure in HEAD file');
      }

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
      if (!this.hasValue(primary)) {
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
      if (this.hasValue(primary) && (!headFile || !this.hasValue(headFile))) {
        return {
          valid: true,
          confidence: 95, // High confidence (git status is current)
          warnings: ['Single source only (HEAD file not checked)'],
          errors: [],
          recommendedSource: 'git_status',
          metadata: {
            sourceAgreement: 100,
            validationLatency: 0,
            staleness: this.calculateStaleness([primary]),
            sourcesChecked: 1
          }
        };
      }

      // Case 4: Both sources available - compare them
      if (this.hasValue(primary) && headFile && this.hasValue(headFile)) {
        return this.compareBranches(primary, headFile);
      }

      // Should never reach here
      return this.createErrorResult('Unexpected validation state');

    } catch (error) {
      return this.createErrorResult(
        `Validation failed with unexpected error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Compare branch names from git status and HEAD file
   */
  private compareBranches(
    gitStatus: DataPoint<GitData>,
    headFile: DataPoint<GitData>
  ): ValidationResult {
    try {
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
          `Branch mismatch: git_status="${this.sanitizeBranchName(normalizedStatus)}", HEAD="${this.sanitizeBranchName(normalizedHead)}"`
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

    } catch (error) {
      return this.createErrorResult(
        `Branch comparison failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Normalize branch name (strip refs/heads/ prefix)
   */
  private normalizeBranchName(branch: string): string {
    if (typeof branch !== 'string') {
      return '';
    }

    const trimmed = branch.trim();

    if (trimmed.startsWith('refs/heads/')) {
      return trimmed.substring('refs/heads/'.length);
    }

    return trimmed;
  }

  /**
   * Sanitize branch name for safe logging (prevent injection)
   */
  private sanitizeBranchName(branch: string): string {
    if (typeof branch !== 'string') {
      return '';
    }

    // Truncate very long branch names
    const maxLength = 100;
    const truncated = branch.length > maxLength
      ? branch.substring(0, maxLength) + '...'
      : branch;

    // Remove newlines and control characters
    return truncated.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim();
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
    try {
      if (!this.isValidGitData(gitStatus) || !this.isValidGitData(headFile)) {
        return {
          branchExists: false,
          refsConsistent: false,
          workingTreeClean: false
        };
      }

      const branchExists = gitStatus.branch !== '' && headFile.branch !== '';
      const refsConsistent = this.normalizeBranchName(gitStatus.branch) ===
                             this.normalizeBranchName(headFile.branch);
      const workingTreeClean = gitStatus.dirty === 0;

      return {
        branchExists,
        refsConsistent,
        workingTreeClean
      };

    } catch (error) {
      return {
        branchExists: false,
        refsConsistent: false,
        workingTreeClean: false
      };
    }
  }

  /**
   * Check for detached HEAD state
   */
  isDetachedHead(gitData: GitData): boolean {
    try {
      if (!this.isValidGitData(gitData)) {
        return false;
      }

      // Detached HEAD shows commit SHA instead of branch name
      // SHA is 7-40 hex characters
      const branch = gitData.branch.trim();
      return /^[0-9a-f]{7,40}$/i.test(branch);

    } catch (error) {
      return false;
    }
  }

  /**
   * Check if data point has valid git data
   */
  private hasValue(dataPoint: DataPoint<GitData> | undefined): boolean {
    if (!dataPoint || !dataPoint.value) {
      return false;
    }

    return this.isValidGitData(dataPoint.value);
  }

  /**
   * Validate git data structure
   */
  private isValidGitData(git: GitData | null | undefined): boolean {
    if (!git || typeof git !== 'object') {
      return false;
    }

    return typeof git.branch === 'string' &&
           typeof git.ahead === 'number' &&
           typeof git.behind === 'number' &&
           typeof git.dirty === 'number' &&
           typeof git.isRepo === 'boolean' &&
           isFinite(git.ahead) &&
           isFinite(git.behind) &&
           isFinite(git.dirty) &&
           git.ahead >= 0 &&
           git.behind >= 0 &&
           git.dirty >= 0;
  }

  /**
   * Validate data point structure
   */
  private isValidDataPoint(dataPoint: DataPoint<GitData> | undefined): boolean {
    if (!dataPoint) {
      return false;
    }

    return typeof dataPoint === 'object' &&
           'source' in dataPoint &&
           'fetchedAt' in dataPoint &&
           typeof dataPoint.fetchedAt === 'number' &&
           dataPoint.fetchedAt > 0;
  }

  /**
   * Calculate staleness (age of oldest data point)
   */
  private calculateStaleness(dataPoints: DataPoint<GitData>[]): number {
    if (dataPoints.length === 0) {
      return 0;
    }

    const now = Date.now();
    const ages = dataPoints
      .filter(dp => dp && typeof dp.fetchedAt === 'number')
      .map(dp => now - dp.fetchedAt);

    return ages.length > 0 ? Math.max(...ages, 0) : 0;
  }

  /**
   * Create error result with consistent structure
   */
  private createErrorResult(errorMessage: string): ValidationResult {
    return {
      valid: false,
      confidence: 0,
      warnings: [],
      errors: [String(errorMessage).substring(0, 200)],
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
