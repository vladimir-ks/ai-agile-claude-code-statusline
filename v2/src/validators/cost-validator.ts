/**
 * Cost Validator - Production Implementation
 *
 * Validates cost data across multiple sources with error handling
 * and dollar-amount tolerance thresholds.
 *
 * Sources:
 * - Primary: ccusage blocks (authoritative billing source)
 * - Secondary: Transcript cost metadata (estimated from model + tokens)
 *
 * Rules:
 * - Exact match (±$0.10): confidence=100%
 * - Difference $0.10-$5.00: warn, use ccusage, confidence=70%
 * - Difference >$5.00: error, use ccusage, confidence=50%, show 🔴
 * - Only ccusage: confidence=90% (normal)
 * - Neither: fail, confidence=0%, show 🔴
 *
 * Note: Transcript cost is estimate, ccusage is authoritative
 */

import type { Validator, DataPoint, ValidationResult } from '../types/validation';

interface CostData {
  totalCost: number;          // Total cost in USD
  hourlyRate: number;         // Cost per hour (burn rate)
  tokensPerMinute: number;    // Token throughput
}

class CostValidator implements Validator<CostData> {
  readonly dataType = 'cost';

  private readonly TOLERANCE_GOOD = 0.10;   // ±$0.10 is acceptable (rounding)
  private readonly TOLERANCE_WARN = 5.00;   // $0.10-$5.00 is concerning

  /**
   * Validate cost data across sources
   *
   * @throws Never - all errors handled gracefully
   */
  validate(
    primary: DataPoint<CostData>,
    secondary: DataPoint<CostData>[]
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

      // Check for explicitly invalid cost data
      if (primary.value && !this.areValidCosts(primary.value)) {
        return this.createErrorResult('Invalid cost data in ccusage source (negative or malformed)');
      }

      if (transcript?.value && !this.areValidCosts(transcript.value)) {
        return this.createErrorResult('Invalid cost data in transcript source (negative or malformed)');
      }

      // Case 1: Neither source available
      if (!this.hasValue(primary) && (!transcript || !this.hasValue(transcript))) {
        return {
          valid: false,
          confidence: 0,
          warnings: [],
          errors: ['No cost data available'],
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

      // Case 2: Only primary (ccusage) available - NORMAL CASE
      if (this.hasValue(primary) && (!transcript || !this.hasValue(transcript))) {
        return {
          valid: true,
          confidence: 90, // High confidence (ccusage is authoritative)
          warnings: ['Single source only (transcript not available)'],
          errors: [],
          recommendedSource: 'ccusage',
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
        return this.compareCosts(primary, transcript);
      }

      // Case 4: Only transcript available (unlikely but handle gracefully)
      if (!this.hasValue(primary) && transcript && this.hasValue(transcript)) {
        return {
          valid: true,
          confidence: 50, // Low confidence (estimate only)
          warnings: ['Using transcript estimate (ccusage not available)'],
          errors: [],
          recommendedSource: 'transcript',
          showStaleIndicator: true, // Show 🔴 for low confidence
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
   * Compare costs from ccusage and transcript estimate
   */
  private compareCosts(
    ccusage: DataPoint<CostData>,
    transcript: DataPoint<CostData>
  ): ValidationResult {
    try {
      const ccusageCost = ccusage.value.totalCost;
      const transcriptCost = transcript.value.totalCost;

      // Calculate absolute difference
      const diff = Math.abs(ccusageCost - transcriptCost);

      // Case A: Close match (±$0.10)
      if (diff <= this.TOLERANCE_GOOD) {
        return {
          valid: true,
          confidence: 100,
          warnings: [],
          errors: [],
          recommendedSource: 'ccusage',
          metadata: {
            sourceAgreement: 100,
            validationLatency: 0,
            staleness: Math.max(
              Date.now() - ccusage.fetchedAt,
              Date.now() - transcript.fetchedAt
            ),
            sourcesChecked: 2
          }
        };
      }

      // Case B: Moderate difference ($0.10-$5.00)
      if (diff <= this.TOLERANCE_WARN) {
        return {
          valid: true,
          confidence: 70,
          warnings: [
            `Cost mismatch $${diff.toFixed(2)}: ` +
            `ccusage=$${this.formatCost(ccusageCost)}, ` +
            `transcript=$${this.formatCost(transcriptCost)}`
          ],
          errors: [],
          recommendedSource: 'ccusage', // Always prefer ccusage (authoritative)
          metadata: {
            sourceAgreement: Math.max(0, 100 - (diff / Math.max(ccusageCost, 0.01)) * 100),
            validationLatency: 0,
            staleness: Math.max(
              Date.now() - ccusage.fetchedAt,
              Date.now() - transcript.fetchedAt
            ),
            sourcesChecked: 2
          }
        };
      }

      // Case C: Large difference (>$5.00)
      return {
        valid: false,
        confidence: 50,
        warnings: [],
        errors: [
          `Large cost mismatch $${diff.toFixed(2)}: ` +
          `ccusage=$${this.formatCost(ccusageCost)}, ` +
          `transcript=$${this.formatCost(transcriptCost)}`
        ],
        recommendedSource: 'ccusage', // Still use ccusage (authoritative)
        showStaleIndicator: true, // Show 🔴 due to large discrepancy
        metadata: {
          sourceAgreement: Math.max(0, 100 - (diff / Math.max(ccusageCost, 0.01)) * 100),
          validationLatency: 0,
          staleness: Math.max(
            Date.now() - ccusage.fetchedAt,
            Date.now() - transcript.fetchedAt
          ),
          sourcesChecked: 2
        }
      };

    } catch (error) {
      return this.createErrorResult(
        `Cost comparison failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Format cost for display
   */
  private formatCost(cost: number): string {
    // Validate input
    if (typeof cost !== 'number' || !isFinite(cost)) {
      return '0.00';
    }

    const absCost = Math.abs(cost);

    if (absCost >= 1000) {
      return `${(cost / 1000).toFixed(1)}k`;
    } else if (absCost >= 1) {
      return cost.toFixed(2);
    } else {
      return cost.toFixed(3); // Show more precision for cents
    }
  }

  /**
   * Validate burn rate separately (optional deep validation)
   */
  validateBurnRate(
    ccusage: CostData,
    transcript: CostData
  ): {
    hourlyRateMatch: boolean;
    tokensPerMinuteMatch: boolean;
  } {
    try {
      if (!this.areValidCosts(ccusage) || !this.areValidCosts(transcript)) {
        return {
          hourlyRateMatch: false,
          tokensPerMinuteMatch: false
        };
      }

      const hourlyDiff = Math.abs(ccusage.hourlyRate - transcript.hourlyRate);
      const hourlyPct = ccusage.hourlyRate > 0
        ? (hourlyDiff / ccusage.hourlyRate) * 100
        : (transcript.hourlyRate > 0 ? 100 : 0);

      const tpmDiff = Math.abs(ccusage.tokensPerMinute - transcript.tokensPerMinute);
      const tpmPct = ccusage.tokensPerMinute > 0
        ? (tpmDiff / ccusage.tokensPerMinute) * 100
        : (transcript.tokensPerMinute > 0 ? 100 : 0);

      return {
        hourlyRateMatch: hourlyPct <= 10, // ±10% tolerance
        tokensPerMinuteMatch: tpmPct <= 10
      };

    } catch (error) {
      return {
        hourlyRateMatch: false,
        tokensPerMinuteMatch: false
      };
    }
  }

  /**
   * Check if data point has valid cost values
   */
  private hasValue(dataPoint: DataPoint<CostData> | undefined): boolean {
    if (!dataPoint || !dataPoint.value) {
      return false;
    }

    return this.areValidCosts(dataPoint.value);
  }

  /**
   * Validate cost structure and values
   */
  private areValidCosts(cost: CostData | null | undefined): boolean {
    if (!cost || typeof cost !== 'object') {
      return false;
    }

    return typeof cost.totalCost === 'number' &&
           typeof cost.hourlyRate === 'number' &&
           typeof cost.tokensPerMinute === 'number' &&
           isFinite(cost.totalCost) &&
           isFinite(cost.hourlyRate) &&
           isFinite(cost.tokensPerMinute) &&
           cost.totalCost >= 0 &&
           cost.hourlyRate >= 0 &&
           cost.tokensPerMinute >= 0;
  }

  /**
   * Validate data point structure
   */
  private isValidDataPoint(dataPoint: DataPoint<CostData> | undefined): boolean {
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
  private calculateStaleness(dataPoints: DataPoint<CostData>[]): number {
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

export default CostValidator;
