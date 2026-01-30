/**
 * Context Token Validator
 *
 * Validates context window token counts across multiple sources:
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
 * Note: Token estimation from transcript is approximate, so tolerance is higher
 */

import { Validator, DataPoint, ValidationResult } from '../types/validation';

interface ContextTokens {
  currentInputTokens: number;
  cacheReadTokens: number;
  currentOutputTokens: number;
  totalCurrentTokens: number;
}

class ContextValidator implements Validator<ContextTokens> {
  readonly dataType = 'context';

  validate(
    primary: DataPoint<ContextTokens>,
    secondary: DataPoint<ContextTokens>[]
  ): ValidationResult {
    // Find transcript source
    const transcript = secondary.find(s => s.source === 'transcript');

    // Case 1: Neither source available
    if (!primary.value && !transcript) {
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

    // Case 2: Only primary (JSON) available
    if (primary.value && !transcript) {
      return {
        valid: true,
        confidence: 80,
        warnings: ['Single source only (transcript not available)'],
        errors: [],
        recommendedSource: 'json',
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
      return this.compareTokenCounts(primary, transcript);
    }

    // Case 4: Only transcript available (fallback)
    if (!primary.value && transcript) {
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
          staleness: Date.now() - transcript.fetchedAt,
          sourcesChecked: secondary.length + 1
        }
      };
    }

    // Should never reach here
    return this.createErrorResult('Unexpected validation state');
  }

  /**
   * Compare token counts from JSON and transcript
   */
  private compareTokenCounts(
    json: DataPoint<ContextTokens>,
    transcript: DataPoint<ContextTokens>
  ): ValidationResult {
    const jsonTotal = json.value.totalCurrentTokens;
    const transcriptTotal = transcript.value.totalCurrentTokens;

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

    // Calculate difference percentage
    const diff = Math.abs(jsonTotal - transcriptTotal);
    const pctDiff = jsonTotal > 0 ? (diff / jsonTotal) * 100 : 100;

    // Tolerance thresholds
    const TOLERANCE_GOOD = 10;  // ±10% is acceptable
    const TOLERANCE_WARN = 50;  // 10-50% is concerning

    // Case A: Close match (±10%)
    if (pctDiff <= TOLERANCE_GOOD) {
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
    if (pctDiff <= TOLERANCE_WARN) {
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
  }

  /**
   * Format token count for display (156k, 2.3M, etc.)
   */
  private formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    } else if (tokens >= 1000) {
      return `${Math.floor(tokens / 1000)}k`;
    } else {
      return `${tokens}`;
    }
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
    const inputDiff = Math.abs(json.currentInputTokens - transcript.currentInputTokens);
    const inputPct = json.currentInputTokens > 0
      ? (inputDiff / json.currentInputTokens) * 100
      : (transcript.currentInputTokens > 0 ? 100 : 0); // If json is 0 but transcript isn't, 100% diff

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
  }
}

export default ContextValidator;
