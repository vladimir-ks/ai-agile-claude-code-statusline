/**
 * Context Token Validator - Production Implementation
 *
 * Validates context window token counts across multiple sources with
 * tolerance for estimation errors and comprehensive error handling.
 *
 * Sources:
 * - Primary: JSON stdin (.context_window.current_usage)
 * - Secondary: Transcript (estimated from message content)
 *
 * Rules:
 * - JSON ≈ Transcript (±10%): confidence=100%
 * - JSON vs Transcript 10-50% diff: warn, use JSON, confidence=60%
 * - JSON vs Transcript >50% diff: error, use JSON, confidence=30%, show 🔴
 * - Only JSON: confidence=80%
 * - Neither: fail, confidence=0%, show 🔴
 *
 * Note: Transcript estimation is approximate, so tolerance is higher than other validators
 */

import type { Validator, DataPoint, ValidationResult } from '../types/validation';

interface ContextTokens {
  currentInputTokens: number;
  cacheReadTokens: number;
  currentOutputTokens: number;
  totalCurrentTokens: number;
}

class ContextValidator implements Validator<ContextTokens> {
  readonly dataType = 'context';

  private readonly TOLERANCE_GOOD = 10;   // ±10% is acceptable
  private readonly TOLERANCE_WARN = 50;   // 10-50% is concerning

  /**
   * Validate context token counts across sources
   *
   * @throws Never - all errors handled gracefully
   */
  validate(
    primary: DataPoint<ContextTokens>,
    secondary: DataPoint<ContextTokens>[]
  ): ValidationResult {
    try {
      // Input validation
      if (!this.isValidDataPoint(primary)) {
        return this.createErrorResult('Invalid primary data point');
      }

      if (!Array.isArray(secondary)) {
        return this.createErrorResult('Invalid secondary data points (not array)');
      }

      // Find transcript source
      const transcript = secondary.find(s => s?.source === 'transcript');

      // Check for explicitly invalid data (negative tokens, etc.)
      if (primary.value && !this.areValidTokens(primary.value)) {
        return this.createErrorResult('Invalid token counts in JSON source (negative or malformed)');
      }

      if (transcript?.value && !this.areValidTokens(transcript.value)) {
        return this.createErrorResult('Invalid token counts in transcript source (negative or malformed)');
      }

      // Case 1: Neither source available
      if (!this.hasValue(primary) && (!transcript || !this.hasValue(transcript))) {
        return {
          valid: false,
          confidence: 0,
          warnings: [],
          errors: ['No context token data available'],
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

      // Case 2: Only primary (JSON) available - NORMAL CASE
      if (this.hasValue(primary) && (!transcript || !this.hasValue(transcript))) {
        return {
          valid: true,
          confidence: 80,
          warnings: ['Single source only (transcript not available)'],
          errors: [],
          recommendedSource: 'json',
          metadata: {
            sourceAgreement: 100,
            validationLatency: 0,
            staleness: this.calculateStaleness([primary]),
            sourcesChecked: 1
          }
        };
      }

      // Case 3: Both sources available - compare them
      if (this.hasValue(primary) && transcript && this.hasValue(transcript)) {
        return this.compareTokenCounts(primary, transcript);
      }

      // Case 4: Only transcript available (fallback)
      if (!this.hasValue(primary) && transcript && this.hasValue(transcript)) {
        return {
          valid: true,
          confidence: 60,
          warnings: ['Using transcript estimate (JSON not available)'],
          errors: [],
          recommendedSource: 'transcript',
          showStaleIndicator: true, // Lower confidence
          metadata: {
            sourceAgreement: 0,
            validationLatency: 0,
            staleness: this.calculateStaleness([transcript]),
            sourcesChecked: secondary.length + 1
          }
        };
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
   * Compare token counts from JSON and transcript
   */
  private compareTokenCounts(
    json: DataPoint<ContextTokens>,
    transcript: DataPoint<ContextTokens>
  ): ValidationResult {
    try {
      // Validate token values
      if (!this.areValidTokens(json.value)) {
        return this.createErrorResult('Invalid token counts in JSON source');
      }

      if (!this.areValidTokens(transcript.value)) {
        return this.createErrorResult('Invalid token counts in transcript source');
      }

      const jsonTotal = json.value.totalCurrentTokens;
      const transcriptTotal = transcript.value.totalCurrentTokens;

      // Validate totals are non-negative
      if (jsonTotal < 0 || transcriptTotal < 0) {
        return this.createErrorResult('Negative token counts detected');
      }

      // Handle zero case
      if (jsonTotal === 0 && transcriptTotal === 0) {
        return {
          valid: true,
          confidence: 100,
          warnings: [],
          errors: [],
          recommendedSource: 'json',
          metadata: {
            sourceAgreement: 100,
            validationLatency: 0,
            staleness: Math.max(
              Date.now() - json.fetchedAt,
              Date.now() - transcript.fetchedAt
            ),
            sourcesChecked: 2
          }
        };
      }

      // Calculate difference percentage (avoid division by zero)
      const diff = Math.abs(jsonTotal - transcriptTotal);
      const pctDiff = jsonTotal > 0 ? (diff / jsonTotal) * 100 : 100;

      // Case A: Close match (±10%)
      if (pctDiff <= this.TOLERANCE_GOOD) {
        return {
          valid: true,
          confidence: 100,
          warnings: [],
          errors: [],
          recommendedSource: 'json',
          metadata: {
            sourceAgreement: Math.max(0, 100 - pctDiff),
            validationLatency: 0,
            staleness: Math.max(
              Date.now() - json.fetchedAt,
              Date.now() - transcript.fetchedAt
            ),
            sourcesChecked: 2
          }
        };
      }

      // Case B: Moderate difference (10-50%)
      if (pctDiff <= this.TOLERANCE_WARN) {
        return {
          valid: true,
          confidence: 60,
          warnings: [
            `Token count mismatch ${pctDiff.toFixed(0)}%: ` +
            `JSON=${this.formatTokens(jsonTotal)}, ` +
            `Transcript=${this.formatTokens(transcriptTotal)}`
          ],
          errors: [],
          recommendedSource: 'json', // Prefer JSON (more accurate)
          metadata: {
            sourceAgreement: Math.max(0, 100 - pctDiff),
            validationLatency: 0,
            staleness: Math.max(
              Date.now() - json.fetchedAt,
              Date.now() - transcript.fetchedAt
            ),
            sourcesChecked: 2
          }
        };
      }

      // Case C: Large difference (>50%)
      return {
        valid: false,
        confidence: 30,
        warnings: [],
        errors: [
          `Large token count mismatch ${pctDiff.toFixed(0)}%: ` +
          `JSON=${this.formatTokens(jsonTotal)}, ` +
          `Transcript=${this.formatTokens(transcriptTotal)}`
        ],
        recommendedSource: 'json', // Still prefer JSON
        showStaleIndicator: true, // Show 🔴 due to large discrepancy
        metadata: {
          sourceAgreement: Math.max(0, 100 - pctDiff),
          validationLatency: 0,
          staleness: Math.max(
            Date.now() - json.fetchedAt,
            Date.now() - transcript.fetchedAt
          ),
          sourcesChecked: 2
        }
      };

    } catch (error) {
      return this.createErrorResult(
        `Token comparison failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Format token count for display (156k, 2.3M, etc.)
   */
  private formatTokens(tokens: number): string {
    // Validate input
    if (typeof tokens !== 'number' || !isFinite(tokens)) {
      return '0';
    }

    const absTokens = Math.abs(tokens);

    if (absTokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (absTokens >= 1000) {
      return `${Math.floor(tokens / 1000)}k`;
    } else {
      return `${Math.floor(tokens)}`;
    }
  }

  /**
   * Validate detailed breakdown (optional deep validation)
   */
  validateBreakdown(
    json: ContextTokens,
    transcript: ContextTokens
  ): {
    inputMatch: boolean;
    cacheMatch: boolean;
    outputMatch: boolean;
  } {
    try {
      // Validate inputs
      if (!this.areValidTokens(json) || !this.areValidTokens(transcript)) {
        return {
          inputMatch: false,
          cacheMatch: false,
          outputMatch: false
        };
      }

      const inputDiff = Math.abs(json.currentInputTokens - transcript.currentInputTokens);
      const inputPct = json.currentInputTokens > 0
        ? (inputDiff / json.currentInputTokens) * 100
        : (transcript.currentInputTokens > 0 ? 100 : 0);

      const cacheDiff = Math.abs(json.cacheReadTokens - transcript.cacheReadTokens);
      const cachePct = json.cacheReadTokens > 0
        ? (cacheDiff / json.cacheReadTokens) * 100
        : (transcript.cacheReadTokens > 0 ? 100 : 0);

      const outputDiff = Math.abs(json.currentOutputTokens - transcript.currentOutputTokens);
      const outputPct = json.currentOutputTokens > 0
        ? (outputDiff / json.currentOutputTokens) * 100
        : (transcript.currentOutputTokens > 0 ? 100 : 0);

      return {
        inputMatch: inputPct <= 10,
        cacheMatch: cachePct <= 10,
        outputMatch: outputPct <= 10
      };

    } catch (error) {
      // On error, return all false
      return {
        inputMatch: false,
        cacheMatch: false,
        outputMatch: false
      };
    }
  }

  /**
   * Check if data point has valid token values
   */
  private hasValue(dataPoint: DataPoint<ContextTokens> | undefined): boolean {
    if (!dataPoint || !dataPoint.value) {
      return false;
    }

    return this.areValidTokens(dataPoint.value);
  }

  /**
   * Validate token structure and values
   */
  private areValidTokens(tokens: ContextTokens | null | undefined): boolean {
    if (!tokens || typeof tokens !== 'object') {
      return false;
    }

    return typeof tokens.currentInputTokens === 'number' &&
           typeof tokens.cacheReadTokens === 'number' &&
           typeof tokens.currentOutputTokens === 'number' &&
           typeof tokens.totalCurrentTokens === 'number' &&
           isFinite(tokens.currentInputTokens) &&
           isFinite(tokens.cacheReadTokens) &&
           isFinite(tokens.currentOutputTokens) &&
           isFinite(tokens.totalCurrentTokens) &&
           tokens.currentInputTokens >= 0 &&
           tokens.cacheReadTokens >= 0 &&
           tokens.currentOutputTokens >= 0 &&
           tokens.totalCurrentTokens >= 0;
  }

  /**
   * Validate data point structure
   */
  private isValidDataPoint(dataPoint: DataPoint<ContextTokens> | undefined): boolean {
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
  private calculateStaleness(dataPoints: DataPoint<ContextTokens>[]): number {
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
      errors: [String(errorMessage).substring(0, 200)], // Truncate error messages
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

export default ContextValidator;
