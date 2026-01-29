/**
 * Validation Engine - Multi-Source Data Validation
 *
 * Responsibilities:
 * - Register validators for different data types
 * - Coordinate validation across multiple sources
 * - Track validation metrics
 * - Emit alerts when thresholds exceeded
 * - Provide validation health reports
 *
 * Critical: Non-blocking validation (don't slow down primary data fetch)
 */

import { EventEmitter } from 'events';
import {
  DataPoint,
  ValidationResult,
  Validator,
  ValidationMetrics,
  ValidationConfig,
  ValidationAlert
} from '../types/validation';

class ValidationEngine extends EventEmitter {
  private validators: Map<string, Validator<any>> = new Map();
  private metrics: Map<string, ValidationMetrics> = new Map();
  private config: ValidationConfig;
  private lastValidationTime: Map<string, number> = new Map();

  constructor(config: ValidationConfig) {
    super();
    this.config = config;
  }

  /**
   * Register a validator for a specific data type
   */
  registerValidator<T>(dataType: string, validator: Validator<T>): void {
    this.validators.set(dataType, validator);

    // Initialize metrics for this data type
    if (!this.metrics.has(dataType)) {
      this.metrics.set(dataType, {
        successRate: 100,
        sourceAgreementRate: 100,
        avgValidationLatency: 0,
        falsePositiveRate: 0,
        totalValidations: 0,
        lastUpdated: Date.now()
      });
    }

    this.emit('validator:registered', { dataType });
  }

  /**
   * Validate data from multiple sources
   *
   * CRITICAL: This should be fast (<500ms) to avoid blocking
   */
  async validate<T>(
    dataType: string,
    primary: DataPoint<T>,
    secondary: DataPoint<T>[]
  ): Promise<ValidationResult> {
    const validator = this.validators.get(dataType);

    if (!validator) {
      throw new Error(`No validator registered for data type: ${dataType}`);
    }

    // Check if we should throttle (skip validation)
    if (this.shouldThrottle(dataType)) {
      return this.createThrottledResult(primary);
    }

    const startTime = performance.now();

    try {
      // Run validation
      const result = validator.validate(primary, secondary);

      // Calculate metadata
      const latency = performance.now() - startTime;
      result.metadata = {
        ...result.metadata,
        validationLatency: latency,
        sourcesChecked: secondary.length + 1,
        staleness: this.calculateStaleness([primary, ...secondary])
      };

      // Update metrics
      this.updateMetrics(dataType, result, latency);

      // Update last validation time
      this.lastValidationTime.set(dataType, Date.now());

      // Check alerts
      this.checkAlerts(dataType);

      // Emit events
      this.emitValidationEvents(dataType, result);

      return result;

    } catch (error) {
      const latency = performance.now() - startTime;

      this.emit('validation:error', {
        dataType,
        error: error.message,
        latency
      });

      // Return failed result
      return {
        valid: false,
        confidence: 0,
        warnings: [],
        errors: [`Validation failed: ${error.message}`],
        recommendedSource: primary.source,
        showStaleIndicator: true,
        metadata: {
          sourceAgreement: 0,
          validationLatency: latency,
          staleness: Date.now() - primary.fetchedAt,
          sourcesChecked: secondary.length + 1
        }
      };
    }
  }

  /**
   * Check if validation should be throttled
   *
   * Don't validate every fetch - expensive for high-frequency data
   */
  private shouldThrottle(dataType: string): boolean {
    if (this.config.throttleInterval === 0) {
      return false; // Never throttle
    }

    const lastValidation = this.lastValidationTime.get(dataType);

    if (!lastValidation) {
      return false; // First validation, don't throttle
    }

    const timeSinceLastValidation = Date.now() - lastValidation;

    return timeSinceLastValidation < this.config.throttleInterval;
  }

  /**
   * Create a result for throttled validation (skip secondary sources)
   */
  private createThrottledResult<T>(primary: DataPoint<T>): ValidationResult {
    return {
      valid: true,
      confidence: 90, // High confidence (throttled = assumed good)
      warnings: [],
      errors: [],
      recommendedSource: primary.source,
      metadata: {
        sourceAgreement: 100, // Assumed
        validationLatency: 0,
        staleness: Date.now() - primary.fetchedAt,
        sourcesChecked: 1
      }
    };
  }

  /**
   * Calculate staleness (age of oldest data point)
   */
  private calculateStaleness(dataPoints: DataPoint<any>[]): number {
    const now = Date.now();
    const ages = dataPoints.map(dp => now - dp.fetchedAt);
    return Math.max(...ages);
  }

  /**
   * Update rolling metrics for a data type
   */
  private updateMetrics(
    dataType: string,
    result: ValidationResult,
    latency: number
  ): void {
    const metrics = this.metrics.get(dataType)!;

    // Increment total validations
    metrics.totalValidations++;

    // Rolling average (90% old, 10% new) for smooth metrics
    const alpha = 0.1;

    metrics.avgValidationLatency =
      (metrics.avgValidationLatency * (1 - alpha)) + (latency * alpha);

    metrics.successRate =
      (metrics.successRate * (1 - alpha)) + ((result.valid ? 100 : 0) * alpha);

    metrics.sourceAgreementRate =
      (metrics.sourceAgreementRate * (1 - alpha)) +
      (result.metadata.sourceAgreement * alpha);

    // Update timestamp
    metrics.lastUpdated = Date.now();

    this.emit('metrics:updated', { dataType, metrics });
  }

  /**
   * Emit events based on validation result
   */
  private emitValidationEvents(dataType: string, result: ValidationResult): void {
    if (!result.valid) {
      this.emit('validation:failed', { dataType, result });
    }

    if (result.confidence < this.config.confidenceThreshold) {
      this.emit('validation:low-confidence', {
        dataType,
        confidence: result.confidence,
        warnings: result.warnings
      });
    }

    if (result.showStaleIndicator) {
      this.emit('validation:stale-data', { dataType });
    }

    if (result.warnings.length > 0) {
      this.emit('validation:warnings', {
        dataType,
        warnings: result.warnings
      });
    }

    if (result.errors.length > 0) {
      this.emit('validation:errors', {
        dataType,
        errors: result.errors
      });
    }
  }

  /**
   * Check alert conditions and emit alerts
   */
  private checkAlerts(dataType: string): void {
    const metrics = this.metrics.get(dataType);

    if (!metrics) {
      return;
    }

    for (const alert of this.config.alerts) {
      if (!alert.enabled) {
        continue;
      }

      if (alert.condition(metrics)) {
        this.emit('alert:triggered', {
          dataType,
          alert: alert.name,
          severity: alert.severity,
          action: alert.action,
          metrics
        });
      }
    }
  }

  /**
   * Get metrics for a specific data type
   */
  getMetrics(dataType: string): ValidationMetrics | null {
    return this.metrics.get(dataType) || null;
  }

  /**
   * Get overall validation health across all data types
   */
  getOverallHealth(): {
    avgSuccessRate: number;
    avgLatency: number;
    avgAgreementRate: number;
    worstPerformer: string | null;
    totalValidations: number;
  } {
    const allMetrics = Array.from(this.metrics.entries());

    if (allMetrics.length === 0) {
      return {
        avgSuccessRate: 100,
        avgLatency: 0,
        avgAgreementRate: 100,
        worstPerformer: null,
        totalValidations: 0
      };
    }

    const avgSuccessRate =
      allMetrics.reduce((sum, [_, m]) => sum + m.successRate, 0) /
      allMetrics.length;

    const avgLatency =
      allMetrics.reduce((sum, [_, m]) => sum + m.avgValidationLatency, 0) /
      allMetrics.length;

    const avgAgreementRate =
      allMetrics.reduce((sum, [_, m]) => sum + m.sourceAgreementRate, 0) /
      allMetrics.length;

    const totalValidations = allMetrics.reduce(
      (sum, [_, m]) => sum + m.totalValidations,
      0
    );

    // Find worst performer (lowest success rate)
    const worst = allMetrics.reduce(
      (min, [name, metrics]) => {
        return metrics.successRate < (min?.metrics.successRate || 100)
          ? { name, metrics }
          : min;
      },
      null as { name: string; metrics: ValidationMetrics } | null
    );

    return {
      avgSuccessRate,
      avgLatency,
      avgAgreementRate,
      worstPerformer: worst?.name || null,
      totalValidations
    };
  }

  /**
   * Reset metrics for a data type (useful for testing)
   */
  resetMetrics(dataType: string): void {
    if (this.metrics.has(dataType)) {
      this.metrics.set(dataType, {
        successRate: 100,
        sourceAgreementRate: 100,
        avgValidationLatency: 0,
        falsePositiveRate: 0,
        totalValidations: 0,
        lastUpdated: Date.now()
      });

      this.emit('metrics:reset', { dataType });
    }
  }

  /**
   * Get all registered validators
   */
  getValidators(): string[] {
    return Array.from(this.validators.keys());
  }

  /**
   * Check if a validator is registered
   */
  hasValidator(dataType: string): boolean {
    return this.validators.has(dataType);
  }
}

export default ValidationEngine;
