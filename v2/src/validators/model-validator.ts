/**
 * Model Validator - Production Implementation
 *
 * Validates model name across multiple sources with error handling
 * and defensive programming.
 *
 * Sources (priority order):
 * - Primary: JSON stdin (.model.display_name)
 * - Secondary: Transcript (.message.model)
 * - Tertiary: settings.json (.model) - fallback default
 *
 * Rules:
 * - Exact match: confidence=100%
 * - Mismatch JSON vs Transcript: warn, use JSON, confidence=70%
 * - Mismatch JSON vs settings: info (expected), confidence=90%
 * - No JSON, use Transcript if <1h old: confidence=80%
 * - No JSON, use settings: confidence=50%
 */

import type { Validator, DataPoint, ValidationResult } from '../types/validation';

class ModelValidator implements Validator<string> {
  readonly dataType = 'model';

  private readonly TRANSCRIPT_TTL = 3600000; // 1 hour in ms

  /**
   * Validate model name across multiple sources
   *
   * @throws Never - all errors handled gracefully
   */
  validate(
    primary: DataPoint<string>,
    secondary: DataPoint<string>[]
  ): ValidationResult {
    try {
      // Input validation
      if (!this.isValidDataPoint(primary)) {
        return this.createErrorResult('Invalid primary data point');
      }

      if (!Array.isArray(secondary)) {
        return this.createErrorResult('Invalid secondary data points (not array)');
      }

      // Find transcript and settings sources
      const transcript = secondary.find(s => s?.source === 'transcript');
      const settings = secondary.find(s => s?.source === 'settings.json');

      // Case 1: Primary (JSON stdin) available
      if (this.hasValue(primary)) {
        return this.validateWithPrimary(primary, transcript, settings);
      }

      // Case 2: No primary, use transcript if fresh
      if (transcript && this.isFresh(transcript, this.TRANSCRIPT_TTL)) {
        return {
          valid: true,
          confidence: 80,
          warnings: ['Using transcript as primary source (JSON not available)'],
          errors: [],
          recommendedSource: 'transcript',
          metadata: {
            sourceAgreement: 100,
            validationLatency: 0,
            staleness: this.calculateStaleness([transcript]),
            sourcesChecked: secondary.length + 1
          }
        };
      }

      // Case 3: Fallback to settings.json (default)
      if (settings && this.hasValue(settings)) {
        return {
          valid: true,
          confidence: 50,
          warnings: ['Using settings.json default (no session-specific data)'],
          errors: [],
          recommendedSource: 'settings.json',
          showStaleIndicator: true, // Low confidence, show 🔴
          metadata: {
            sourceAgreement: 0,
            validationLatency: 0,
            staleness: this.calculateStaleness([settings]),
            sourcesChecked: secondary.length + 1
          }
        };
      }

      // Case 4: No sources available
      return {
        valid: false,
        confidence: 0,
        warnings: [],
        errors: ['No model data available from any source'],
        recommendedSource: 'none',
        showStaleIndicator: true,
        metadata: {
          sourceAgreement: 0,
          validationLatency: 0,
          staleness: 0,
          sourcesChecked: secondary.length + 1
        }
      };

    } catch (error) {
      // Catch-all error handler - should never reach here if defensive programming is correct
      return this.createErrorResult(
        `Validation failed with unexpected error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Validate when primary source (JSON) is available
   */
  private validateWithPrimary(
    primary: DataPoint<string>,
    transcript: DataPoint<string> | undefined,
    settings: DataPoint<string> | undefined
  ): ValidationResult {
    const warnings: string[] = [];
    let sourceAgreement = 100;

    // Check agreement with transcript
    if (transcript && this.hasValue(transcript)) {
      if (primary.value !== transcript.value) {
        warnings.push(
          `Model mismatch: JSON="${this.sanitizeString(primary.value)}", Transcript="${this.sanitizeString(transcript.value)}"`
        );
        sourceAgreement -= 30; // Disagreement penalty
      }
    }

    // Check agreement with settings (expected to differ)
    // Settings is just default, not current model - no penalty
    if (settings && this.hasValue(settings) && primary.value !== settings.value) {
      // This is normal - don't penalize
    }

    // Calculate confidence
    let confidence = 100;

    if (warnings.length > 0) {
      confidence = 70; // Mismatch with transcript
    } else if (!transcript || !this.hasValue(transcript)) {
      confidence = 90; // Only one source
      warnings.push('Only one source available (transcript not checked)');
    }

    return {
      valid: true,
      confidence,
      warnings,
      errors: [],
      recommendedSource: 'json',
      metadata: {
        sourceAgreement,
        validationLatency: 0,
        staleness: this.calculateStaleness([primary, transcript, settings].filter(Boolean) as DataPoint<string>[]),
        sourcesChecked: 1 + (transcript ? 1 : 0) + (settings ? 1 : 0)
      }
    };
  }

  /**
   * Check if data point is fresh (within TTL)
   */
  private isFresh(dataPoint: DataPoint<string>, ttlMs: number): boolean {
    if (!this.isValidDataPoint(dataPoint)) {
      return false;
    }

    const age = Date.now() - dataPoint.fetchedAt;
    return age >= 0 && age < ttlMs;
  }

  /**
   * Check if data point has a valid value
   */
  private hasValue(dataPoint: DataPoint<string> | undefined): boolean {
    if (!dataPoint) {
      return false;
    }

    return dataPoint.value !== null &&
           dataPoint.value !== undefined &&
           dataPoint.value !== '';
  }

  /**
   * Validate data point structure
   */
  private isValidDataPoint(dataPoint: DataPoint<string> | undefined): boolean {
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
  private calculateStaleness(dataPoints: DataPoint<string>[]): number {
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
   * Sanitize string for safe logging (prevent injection)
   * Used for model names in warning messages - shorter to fit both names
   */
  private sanitizeString(value: string): string {
    if (typeof value !== 'string') {
      return String(value);
    }

    // Truncate to 50 chars (allows 2 names + prefix to fit in <200 chars)
    const maxLength = 50;
    const truncated = value.length > maxLength
      ? value.substring(0, maxLength) + '...'
      : value;

    // Remove newlines and control characters
    return truncated.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim();
  }

  /**
   * Sanitize error message (longer limit for full error text)
   */
  private sanitizeErrorMessage(value: string): string {
    if (typeof value !== 'string') {
      return String(value);
    }

    // Truncate to 200 characters
    const truncated = value.length > 200
      ? value.substring(0, 200) + '...'
      : value;

    // Remove control characters (prevent injection)
    return truncated.replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim();
  }

  /**
   * Create error result with consistent structure
   */
  private createErrorResult(errorMessage: string): ValidationResult {
    return {
      valid: false,
      confidence: 0,
      warnings: [],
      errors: [this.sanitizeErrorMessage(errorMessage)],
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

export default ModelValidator;
