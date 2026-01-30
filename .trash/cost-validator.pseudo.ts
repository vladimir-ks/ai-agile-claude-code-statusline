/**
 * Cost Validator
 *
 * Validates cost data across multiple sources:
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

import { Validator, DataPoint, ValidationResult } from '../types/validation';

interface CostData {
  totalCost: number;      // Total cost in USD
  hourlyRate: number;     // Cost per hour (burn rate)
  tokensPerMinute: number; // Token throughput
}

class CostValidator implements Validator<CostData> {
  readonly dataType = 'cost';

  validate(
    primary: DataPoint<CostData>,
    secondary: DataPoint<CostData>[]
  ): ValidationResult {
    // Find transcript source
    const transcript = secondary.find(s => s.source === 'transcript');

    // Case 1: Neither source available
    if (!primary.value && !transcript) {
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
    if (primary.value && !transcript) {
      return {
        valid: true,
        confidence: 90, // High confidence (ccusage is authoritative)
        warnings: ['Single source only (transcript not available)'],
        errors: [],
        recommendedSource: 'ccusage',
        metadata: {
          sourceAgreement: 100,
          validationLatency: 0,
          staleness: Date.now() - primary.fetchedAt,
          sourcesChecked: 1
        }
      };
    }

    // Case 3: Both sources available - compare them
    if (primary.value && transcript) {
      return this.compareCosts(primary, transcript);
    }

    // Case 4: Only transcript available (unlikely but handle gracefully)
    if (!primary.value && transcript) {
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
          staleness: Date.now() - transcript.fetchedAt,
          sourcesChecked: secondary.length + 1
        }
      };
    }

    // Should never reach here
    return this.createErrorResult('Unexpected validation state');
  }

  /**
   * Compare costs from ccusage and transcript estimate
   */
  private compareCosts(
    ccusage: DataPoint<CostData>,
    transcript: DataPoint<CostData>
  ): ValidationResult {
    const ccusageCost = ccusage.value.totalCost;
    const transcriptCost = transcript.value.totalCost;

    // Calculate absolute difference
    const diff = Math.abs(ccusageCost - transcriptCost);

    // Tolerance thresholds (absolute dollar amounts)
    const TOLERANCE_GOOD = 0.10;  // ±$0.10 is acceptable (rounding errors)
    const TOLERANCE_WARN = 5.00;  // $0.10-$5.00 is concerning but not critical

    // Case A: Close match (±$0.10)
    if (diff <= TOLERANCE_GOOD) {
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
    if (diff <= TOLERANCE_WARN) {
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
          sourceAgreement: Math.max(0, 100 - (diff / ccusageCost) * 100),
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
        sourceAgreement: Math.max(0, 100 - (diff / ccusageCost) * 100),
        validationLatency: 0,
        staleness: Math.max(
          Date.now() - ccusage.fetchedAt,
          Date.now() - transcript.fetchedAt
        ),
        sourcesChecked: 2
      }
    };
  }

  /**
   * Format cost for display
   */
  private formatCost(cost: number): string {
    if (cost >= 1000) {
      return `${(cost / 1000).toFixed(1)}k`;
    } else if (cost >= 1) {
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
    const hourlyDiff = Math.abs(ccusage.hourlyRate - transcript.hourlyRate);
    const hourlyPct = ccusage.hourlyRate > 0
      ? (hourlyDiff / ccusage.hourlyRate) * 100
      : 0;

    const tpmDiff = Math.abs(ccusage.tokensPerMinute - transcript.tokensPerMinute);
    const tpmPct = ccusage.tokensPerMinute > 0
      ? (tpmDiff / ccusage.tokensPerMinute) * 100
      : 0;

    return {
      hourlyRateMatch: hourlyPct <= 10, // ±10% tolerance
      tokensPerMinuteMatch: tpmPct <= 10
    };
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

export default CostValidator;
