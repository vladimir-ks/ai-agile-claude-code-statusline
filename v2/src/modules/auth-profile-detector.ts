/**
 * Auth Profile Detector - Multi-method profile detection
 *
 * Detection Priority:
 * 1. CLAUDE_AUTH_PROFILE env var (explicit, highest priority)
 * 2. Project path patterns (user-configured)
 * 3. Billing fingerprint (auto-detect over time)
 * 4. 'default' profile (ultimate fallback)
 */

import { minimatch } from 'minimatch';
import { createHash } from 'crypto';
import { AuthProfile } from '../types/runtime-state';
import { BillingInfo, LaunchContext } from '../types/session-health';

export class AuthProfileDetector {
  /**
   * Detect auth profile using hybrid approach
   */
  static detectProfile(
    projectPath: string,
    billing: BillingInfo | null,
    profiles: AuthProfile[]
  ): LaunchContext {
    // Priority 1: Environment variable (explicit)
    const envProfile = process.env.CLAUDE_AUTH_PROFILE;
    if (envProfile) {
      const profile = profiles.find(p => p.profileId === envProfile);
      if (profile) {
        return {
          authProfile: envProfile,
          detectionMethod: 'env',
          launchAlias: this.detectLaunchAlias()
        };
      }
    }

    // Priority 2: Path pattern matching (user-configured)
    const pathProfile = this.matchByPath(projectPath, profiles);
    if (pathProfile) {
      return {
        authProfile: pathProfile.profileId,
        detectionMethod: 'path',
        launchAlias: this.detectLaunchAlias()
      };
    }

    // Priority 3: Billing fingerprint (auto-detect)
    if (billing && billing.isFresh) {
      const fingerprint = this.calculateBillingFingerprint(billing);
      const fingerprintProfile = profiles.find(p => p.billingFingerprint === fingerprint);
      if (fingerprintProfile) {
        return {
          authProfile: fingerprintProfile.profileId,
          detectionMethod: 'fingerprint',
          launchAlias: this.detectLaunchAlias()
        };
      }
    }

    // Priority 4: Default fallback
    return {
      authProfile: 'default',
      detectionMethod: 'default',
      launchAlias: this.detectLaunchAlias()
    };
  }

  /**
   * Match project path against configured path patterns
   */
  private static matchByPath(projectPath: string, profiles: AuthProfile[]): AuthProfile | null {
    for (const profile of profiles) {
      if (!profile.pathPatterns || profile.pathPatterns.length === 0) {
        continue;
      }

      for (const pattern of profile.pathPatterns) {
        if (minimatch(projectPath, pattern)) {
          return profile;
        }
      }
    }

    return null;
  }

  /**
   * Calculate billing fingerprint for profile matching
   *
   * Creates a stable hash based on billing characteristics that are
   * consistent across sessions but different between accounts.
   */
  static calculateBillingFingerprint(billing: BillingInfo): string {
    // Use reset time + rounded cost pattern (stable across day)
    // budgetRemaining changes constantly, so use cost tier instead
    const costTier = Math.floor(billing.costToday / 10) * 10; // Round to nearest $10
    const pattern = `${billing.resetTime}-${costTier}-${billing.budgetPercentUsed}`;

    return createHash('md5').update(pattern).digest('hex').substring(0, 8);
  }

  /**
   * Attempt to detect launch alias from environment
   *
   * Limited: Can only detect if user sets CLAUDE_ALIAS env var in their wrapper.
   */
  private static detectLaunchAlias(): string | undefined {
    // Check if user set explicit alias env var
    const alias = process.env.CLAUDE_ALIAS || process.env.CLAUDE_LAUNCH_ALIAS;
    return alias || undefined;
  }

  /**
   * Extract project language from path or git config
   */
  static detectProjectLanguage(projectPath: string): string | undefined {
    // Simple heuristic based on path
    const path = projectPath.toLowerCase();

    if (path.includes('node_modules') || path.endsWith('.js') || path.endsWith('.ts')) {
      return 'TypeScript/JavaScript';
    }
    if (path.includes('python') || path.endsWith('.py')) {
      return 'Python';
    }
    if (path.includes('rust') || path.endsWith('.rs')) {
      return 'Rust';
    }
    if (path.includes('go') || path.endsWith('.go')) {
      return 'Go';
    }

    return undefined;
  }

  /**
   * Extract repo name from git remote or directory name
   */
  static extractRepoName(projectPath: string, gitRemote?: string): string | undefined {
    if (gitRemote) {
      // Extract from git remote URL
      // git@github.com:user/repo.git -> repo
      // https://github.com/user/repo.git -> repo
      const match = gitRemote.match(/[\/:]([^\/]+?)(?:\.git)?$/);
      if (match) {
        return match[1];
      }
    }

    // Fallback to directory name
    const parts = projectPath.split('/');
    return parts[parts.length - 1] || undefined;
  }
}
