/**
 * Model Validator
 *
 * Validates model name across multiple sources:
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

import { Validator, DataPoint, ValidationResult } from '../types/validation';

class ModelValidator implements Validator<string> {
  readonly dataType = 'model';

  validate(
    primary: DataPoint<string>,
    secondary: DataPoint<string>[]
  ): ValidationResult {
    // Find transcript and settings sources
    const transcript = secondary.find(s => s.source === 'transcript');
    const settings = secondary.find(s => s.source === 'settings.json');

    // Case 1: Primary (JSON stdin) available
    if (primary.value) {
      return this.validateWithPrimary(primary, transcript, settings);
    }

    // Case 2: No primary, use transcript if fresh
    if (transcript && this.isFresh(transcript, 3600000)) { // 1 hour TTL
      return {
        valid: true,
        confidence: 80,
        warnings: ['Using transcript as primary source (JSON not available)'],
        errors: [],
        recommendedSource: 'transcript',
        metadata: {
          sourceAgreement: 100,
          validationLatency: 0,
          staleness: Date.now() - transcript.fetchedAt,
          sourcesChecked: secondary.length + 1
        }
      };
    }

    // Case 3: Fallback to settings.json (default)
    if (settings) {
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
          staleness: Date.now() - settings.fetchedAt,
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
    if (transcript) {
      if (primary.value !== transcript.value) {
        warnings.push(
          `Model mismatch: JSON="${primary.value}", Transcript="${transcript.value}"`
        );
        sourceAgreement -= 30; // Disagreement penalty
      }
    }

    // Check agreement with settings (expected to differ)
    if (settings && primary.value !== settings.value) {
      // This is normal - settings is just default, not current model
      // Don't penalize agreement score
    }

    // Calculate confidence
    let confidence = 100;

    if (warnings.length > 0) {
      confidence = 70; // Mismatch with transcript
    } else if (!transcript) {
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
        staleness: Date.now() - primary.fetchedAt,
        sourcesChecked: 1 + (transcript ? 1 : 0) + (settings ? 1 : 0)
      }
    };
  }

  /**
   * Check if data point is fresh (within TTL)
   */
  private isFresh(dataPoint: DataPoint<string>, ttlMs: number): boolean {
    const age = Date.now() - dataPoint.fetchedAt;
    return age < ttlMs;
  }
}

export default ModelValidator;
