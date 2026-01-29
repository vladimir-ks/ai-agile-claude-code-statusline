/**
 * Timestamp Validator - Production Implementation
 *
 * Validates system time consistency across multiple timestamp sources with
 * comprehensive error handling and defensive programming.
 *
 * Sources:
 * - Primary: System clock (Date.now())
 * - Secondary: File modification times (fs.stat)
 * - Tertiary: Git commit timestamps (git log)
 *
 * Rules:
 * - Clock skew <5 seconds: confidence=100%
 * - Clock skew 5-300 seconds (5 min): warn, confidence=80%
 * - Clock skew >300 seconds: error, confidence=50%, show 🔴
 * - Future timestamps detected: error, show 🔴
 *
 * Purpose: Detect system clock issues, NTP failures, timezone problems
 */

import type { Validator, DataPoint, ValidationResult } from '../types/validation';

interface TimestampData {
  systemTime: number;       // System clock timestamp (ms)
  fileTime?: number;        // File modification time (ms)
  gitTime?: number;         // Latest git commit time (ms)
  timezone: string;         // System timezone (e.g., "UTC", "America/New_York")
}

class TimestampValidator implements Validator<TimestampData> {
  readonly dataType = 'timestamp';

  private readonly SKEW_GOOD = 5000;      // 5 seconds (acceptable)
  private readonly SKEW_WARN = 300000;    // 5 minutes (concerning)

  /**
   * Validate timestamp consistency across sources
   *
   * @throws Never - all errors handled gracefully
   */
  validate(
    primary: DataPoint<TimestampData>,
    secondary: DataPoint<TimestampData>[]
  ): ValidationResult {
    try {
      // Input validation
      if (!this.isValidDataPoint(primary)) {
        return this.createErrorResult('Invalid primary data point');
      }

      if (!Array.isArray(secondary)) {
        return this.createErrorResult('Invalid secondary data points (not array)');
      }

      if (!primary.value || !this.isValidTimestampData(primary.value)) {
        return this.createErrorResult('System time unavailable or invalid');
      }

      const systemTime = primary.value.systemTime;
    const warnings: string[] = [];
    const errors: string[] = [];
    let minConfidence = 100;
    let sourceAgreement = 100;
    let showStaleIndicator = false;

    // Check each secondary source for clock skew
    for (const source of secondary) {
      if (!source.value) continue;

      const result = this.checkClockSkew(
        systemTime,
        source.value,
        source.source
      );

      if (result.error) {
        errors.push(result.error);
        minConfidence = Math.min(minConfidence, 50);
        showStaleIndicator = true;
      } else if (result.warning) {
        warnings.push(result.warning);
        minConfidence = Math.min(minConfidence, 80);
      }

      sourceAgreement = Math.min(sourceAgreement, result.agreement);
    }

    // Check for future timestamps (clock running ahead)
    const futureCheck = this.checkFutureTimestamps(primary, secondary);
    if (futureCheck.error) {
      errors.push(futureCheck.error);
      minConfidence = 50;
      showStaleIndicator = true;
    }

      return {
        valid: errors.length === 0,
        confidence: minConfidence,
        warnings,
        errors,
        recommendedSource: 'system',
        showStaleIndicator,
        metadata: {
          sourceAgreement,
          validationLatency: 0,
          staleness: 0, // Timestamps don't go stale
          sourcesChecked: secondary.length + 1
        }
      };

    } catch (error) {
      return this.createErrorResult(
        `Validation failed with unexpected error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Check clock skew between system time and a secondary source
   */
  private checkClockSkew(
    systemTime: number,
    data: TimestampData,
    sourceName: string
  ): {
    warning?: string;
    error?: string;
    agreement: number;
  } {
    // Determine which timestamp to compare
    let compareTime: number | undefined;
    let compareLabel: string;

    if (data.fileTime) {
      compareTime = data.fileTime;
      compareLabel = 'file mtime';
    } else if (data.gitTime) {
      compareTime = data.gitTime;
      compareLabel = 'git commit';
    } else if (data.systemTime) {
      compareTime = data.systemTime;
      compareLabel = 'system time';
    }

    if (!compareTime) {
      return { agreement: 100 }; // No comparison possible
    }

    const skew = Math.abs(systemTime - compareTime);
    const skewSeconds = Math.floor(skew / 1000);

    // Calculate agreement percentage (100% at 0 skew, 0% at 5+ min)
    const agreement = Math.max(0, 100 - (skew / this.SKEW_WARN) * 100);

    // Case A: Acceptable skew (<5 seconds)
    if (skew <= this.SKEW_GOOD) {
      return { agreement: 100 };
    }

    // Case B: Moderate skew (5 sec - 5 min)
    if (skew <= this.SKEW_WARN) {
      return {
        warning: `Clock skew ${skewSeconds}s detected (${sourceName}: ${compareLabel})`,
        agreement: Math.round(agreement)
      };
    }

    // Case C: Large skew (>5 minutes)
    return {
      error: `Large clock skew ${this.formatDuration(skew)} (${sourceName}: ${compareLabel})`,
      agreement: Math.round(agreement)
    };
  }

  /**
   * Check for future timestamps (clock running ahead)
   *
   * Only triggers for VERY far future timestamps (clock severely ahead).
   * Moderate future timestamps are handled by clock skew check.
   */
  private checkFutureTimestamps(
    primary: DataPoint<TimestampData>,
    secondary: DataPoint<TimestampData>[]
  ): {
    error?: string;
  } {
    const systemTime = primary.value.systemTime;
    // Use 1 hour threshold for files too (matches git) to avoid double-reporting with skew check
    const futureThreshold = 3600000; // 1 hour in future = error

    for (const source of secondary) {
      if (!source.value) continue;

      // Check file time (very far future only)
      if (source.value.fileTime && source.value.fileTime > systemTime + futureThreshold) {
        const ahead = source.value.fileTime - systemTime;
        return {
          error: `Future timestamp detected: file is ${this.formatDuration(ahead)} ahead of system clock`
        };
      }

      // Check git time (same 1 hour threshold)
      if (source.value.gitTime && source.value.gitTime > systemTime + futureThreshold) {
        const ahead = source.value.gitTime - systemTime;
        return {
          error: `Future git commit detected: ${this.formatDuration(ahead)} ahead of system clock`
        };
      }
    }

    return {};
  }

  /**
   * Format duration for display
   */
  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
      return `${days}d ${hours % 24}h`;
    } else if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Validate timezone consistency
   */
  validateTimezone(
    primary: TimestampData,
    secondary: TimestampData[]
  ): {
    consistent: boolean;
    timezones: string[];
  } {
    const timezones = new Set<string>();
    timezones.add(primary.timezone);

    for (const source of secondary) {
      if (source.value?.timezone) {
        timezones.add(source.value.timezone);
      }
    }

    return {
      consistent: timezones.size === 1,
      timezones: Array.from(timezones)
    };
  }

  /**
   * Check if system time is reasonable (not set to 1970 or far future)
   */
  isReasonableSystemTime(systemTime: number): boolean {
    const MIN_REASONABLE = new Date('2020-01-01').getTime(); // After 2020
    const MAX_REASONABLE = new Date('2035-01-01').getTime(); // Before 2035

    return systemTime >= MIN_REASONABLE && systemTime <= MAX_REASONABLE;
  }

  /**
   * Validate timestamp data structure
   */
  private isValidTimestampData(data: TimestampData | null | undefined): boolean {
    if (!data || typeof data !== 'object') {
      return false;
    }

    return typeof data.systemTime === 'number' &&
           isFinite(data.systemTime) &&
           data.systemTime > 0 &&
           typeof data.timezone === 'string' &&
           (!data.fileTime || (typeof data.fileTime === 'number' && isFinite(data.fileTime) && data.fileTime > 0)) &&
           (!data.gitTime || (typeof data.gitTime === 'number' && isFinite(data.gitTime) && data.gitTime > 0));
  }

  /**
   * Validate data point structure
   */
  private isValidDataPoint(dataPoint: DataPoint<TimestampData> | undefined): boolean {
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
   * Create error result
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

export default TimestampValidator;
