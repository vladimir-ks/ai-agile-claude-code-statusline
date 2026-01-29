/**
 * Validation Engine - Multi-Source Data Validation (Production)
 *
 * Responsibilities:
 * - Register validators for different data types
 * - Coordinate validation across multiple sources
 * - Track validation metrics
 * - Emit alerts when thresholds exceeded
 * - Provide validation health reports
 *
 * Critical: Non-blocking validation (don't slow down primary data fetch)
 *
 * Defensive Programming:
 * - All inputs validated (non-null, correct types, bounds)
 * - All operations wrapped in try/catch
 * - Never throws - always returns valid result or error result
 * - Event listener cleanup to prevent leaks
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

    // Validate and sanitize config
    this.config = this.validateConfig(config);

    // Set reasonable max listeners limit
    this.setMaxListeners(100);
  }

  /**
   * Validate configuration object
   */
  private validateConfig(config: ValidationConfig): ValidationConfig {
    try {
      if (!config || typeof config !== 'object') {
        throw new Error('Invalid config');
      }

      return {
        throttleInterval: Math.max(0, Math.min(config.throttleInterval || 0, 300000)), // Max 5 min
        confidenceThreshold: Math.max(0, Math.min(config.confidenceThreshold || 70, 100)),
        alerts: Array.isArray(config.alerts) ? config.alerts : []
      };
    } catch (error) {
      // Fallback to safe defaults
      return {
        throttleInterval: 0,
        confidenceThreshold: 70,
        alerts: []
      };
    }
  }

  /**
   * Register a validator for a specific data type
   *
   * @throws Never - validates inputs, emits error event on failure
   */
  registerValidator<T>(dataType: string, validator: Validator<T>): void {
    try {
      // Input validation
      if (typeof dataType !== 'string' || dataType.trim() === '') {
        this.emit('validator:error', {
          error: 'Invalid dataType (must be non-empty string)'
        });
        return;
      }

      if (!validator || typeof validator.validate !== 'function') {
        this.emit('validator:error', {
          dataType,
          error: 'Invalid validator (must have validate method)'
        });
        return;
      }

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

    } catch (error) {
      this.emit('validator:error', {
        dataType,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Validate data from multiple sources
   *
   * CRITICAL: This should be fast (<500ms) to avoid blocking
   *
   * @throws Never - all errors handled gracefully
   */
  async validate<T>(
    dataType: string,
    primary: DataPoint<T>,
    secondary: DataPoint<T>[]
  ): Promise<ValidationResult> {
    const startTime = performance.now();

    try {
      // Input validation
      if (typeof dataType !== 'string' || dataType.trim() === '') {
        return this.createErrorResult('Invalid dataType', primary, startTime);
      }

      if (!this.isValidDataPoint(primary)) {
        return this.createErrorResult('Invalid primary data point', primary, startTime);
      }

      if (!Array.isArray(secondary)) {
        return this.createErrorResult('Invalid secondary array (not an array)', primary, startTime);
      }

      const validator = this.validators.get(dataType);

      if (!validator) {
        return this.createErrorResult(`No validator registered for: ${dataType}`, primary, startTime);
      }

      // Check if we should throttle (skip validation)
      if (this.shouldThrottle(dataType)) {
        return this.createThrottledResult(primary);
      }

      // Run validation (validator.validate() never throws)
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
        error: error instanceof Error ? error.message : String(error),
        latency
      });

      // Return failed result
      return this.createErrorResult(
        error instanceof Error ? error.message : String(error),
        primary,
        startTime
      );
    }
  }

  /**
   * Validate data point structure
   */
  private isValidDataPoint<T>(dataPoint: DataPoint<T> | undefined): boolean {
    if (!dataPoint || typeof dataPoint !== 'object') {
      return false;
    }

    return 'source' in dataPoint &&
           'fetchedAt' in dataPoint &&
           typeof dataPoint.fetchedAt === 'number' &&
           dataPoint.fetchedAt > 0 &&
           isFinite(dataPoint.fetchedAt);
  }

  /**
   * Create error result for validation failures
   */
  private createErrorResult<T>(
    errorMessage: string,
    primary: DataPoint<T>,
    startTime: number
  ): ValidationResult {
    const latency = performance.now() - startTime;

    // Sanitize error message
    const sanitized = typeof errorMessage === 'string'
      ? errorMessage.substring(0, 200).replace(/[\r\n\t\x00-\x1f\x7f]/g, ' ').trim()
      : 'Unknown validation error';

    return {
      valid: false,
      confidence: 0,
      warnings: [],
      errors: [sanitized],
      recommendedSource: primary?.source || 'none',
      showStaleIndicator: true,
      metadata: {
        sourceAgreement: 0,
        validationLatency: latency,
        staleness: this.isValidDataPoint(primary) ? Date.now() - primary.fetchedAt : 0,
        sourcesChecked: 1
      }
    };
  }

  /**
   * Check if validation should be throttled
   *
   * Don't validate every fetch - expensive for high-frequency data
   */
  private shouldThrottle(dataType: string): boolean {
    try {
      if (this.config.throttleInterval === 0) {
        return false; // Never throttle
      }

      const lastValidation = this.lastValidationTime.get(dataType);

      if (!lastValidation || !isFinite(lastValidation)) {
        return false; // First validation or invalid timestamp
      }

      const timeSinceLastValidation = Date.now() - lastValidation;

      return timeSinceLastValidation >= 0 && timeSinceLastValidation < this.config.throttleInterval;

    } catch (error) {
      // On error, don't throttle (safer to validate)
      return false;
    }
  }

  /**
   * Create a result for throttled validation (skip secondary sources)
   */
  private createThrottledResult<T>(primary: DataPoint<T>): ValidationResult {
    try {
      return {
        valid: true,
        confidence: 90, // High confidence (throttled = assumed good)
        warnings: [],
        errors: [],
        recommendedSource: primary?.source || 'none',
        metadata: {
          sourceAgreement: 100, // Assumed
          validationLatency: 0,
          staleness: this.isValidDataPoint(primary) ? Date.now() - primary.fetchedAt : 0,
          sourcesChecked: 1
        }
      };
    } catch (error) {
      // Fallback to safe result
      return {
        valid: true,
        confidence: 90,
        warnings: [],
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
  }

  /**
   * Calculate staleness (age of oldest data point)
   */
  private calculateStaleness(dataPoints: DataPoint<any>[]): number {
    try {
      if (!Array.isArray(dataPoints) || dataPoints.length === 0) {
        return 0;
      }

      const now = Date.now();
      const ages = dataPoints
        .filter(dp => dp && typeof dp.fetchedAt === 'number' && isFinite(dp.fetchedAt))
        .map(dp => Math.max(0, now - dp.fetchedAt));

      return ages.length > 0 ? Math.max(...ages, 0) : 0;

    } catch (error) {
      return 0;
    }
  }

  /**
   * Update rolling metrics for a data type
   */
  private updateMetrics(
    dataType: string,
    result: ValidationResult,
    latency: number
  ): void {
    try {
      const metrics = this.metrics.get(dataType);

      if (!metrics) {
        return; // Metrics not initialized
      }

      // Validate inputs
      if (!isFinite(latency) || latency < 0) {
        latency = 0;
      }

      // Increment total validations
      metrics.totalValidations++;

      // Rolling average (90% old, 10% new) for smooth metrics
      const alpha = 0.1;

      metrics.avgValidationLatency =
        (metrics.avgValidationLatency * (1 - alpha)) + (latency * alpha);

      metrics.successRate =
        (metrics.successRate * (1 - alpha)) + ((result.valid ? 100 : 0) * alpha);

      const agreement = Math.max(0, Math.min(result.metadata?.sourceAgreement || 0, 100));
      metrics.sourceAgreementRate =
        (metrics.sourceAgreementRate * (1 - alpha)) + (agreement * alpha);

      // Update timestamp
      metrics.lastUpdated = Date.now();

      this.emit('metrics:updated', { dataType, metrics });

    } catch (error) {
      this.emit('metrics:error', {
        dataType,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Emit events based on validation result
   */
  private emitValidationEvents(dataType: string, result: ValidationResult): void {
    try {
      if (!result.valid) {
        this.emit('validation:failed', { dataType, result });
      }

      if (typeof result.confidence === 'number' &&
          result.confidence < this.config.confidenceThreshold) {
        this.emit('validation:low-confidence', {
          dataType,
          confidence: result.confidence,
          warnings: result.warnings || []
        });
      }

      if (result.showStaleIndicator) {
        this.emit('validation:stale-data', { dataType });
      }

      if (Array.isArray(result.warnings) && result.warnings.length > 0) {
        this.emit('validation:warnings', {
          dataType,
          warnings: result.warnings
        });
      }

      if (Array.isArray(result.errors) && result.errors.length > 0) {
        this.emit('validation:errors', {
          dataType,
          errors: result.errors
        });
      }
    } catch (error) {
      // Suppress event emission errors (non-critical)
    }
  }

  /**
   * Check alert conditions and emit alerts
   */
  private checkAlerts(dataType: string): void {
    try {
      const metrics = this.metrics.get(dataType);

      if (!metrics) {
        return;
      }

      if (!Array.isArray(this.config.alerts)) {
        return;
      }

      for (const alert of this.config.alerts) {
        if (!alert || !alert.enabled) {
          continue;
        }

        if (typeof alert.condition !== 'function') {
          continue;
        }

        try {
          if (alert.condition(metrics)) {
            this.emit('alert:triggered', {
              dataType,
              alert: alert.name || 'unnamed',
              severity: alert.severity || 'warning',
              action: alert.action || 'none',
              metrics
            });
          }
        } catch (conditionError) {
          // Suppress individual alert condition errors
        }
      }
    } catch (error) {
      // Suppress alert checking errors (non-critical)
    }
  }

  /**
   * Get metrics for a specific data type
   */
  getMetrics(dataType: string): ValidationMetrics | null {
    try {
      if (typeof dataType !== 'string') {
        return null;
      }

      return this.metrics.get(dataType) || null;
    } catch (error) {
      return null;
    }
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
    try {
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
        allMetrics.reduce((sum, [_, m]) => sum + (m?.successRate || 0), 0) /
        allMetrics.length;

      const avgLatency =
        allMetrics.reduce((sum, [_, m]) => sum + (m?.avgValidationLatency || 0), 0) /
        allMetrics.length;

      const avgAgreementRate =
        allMetrics.reduce((sum, [_, m]) => sum + (m?.sourceAgreementRate || 0), 0) /
        allMetrics.length;

      const totalValidations = allMetrics.reduce(
        (sum, [_, m]) => sum + (m?.totalValidations || 0),
        0
      );

      // Find worst performer (lowest success rate)
      const worst = allMetrics.reduce(
        (min, [name, metrics]) => {
          if (!metrics) return min;
          const successRate = metrics.successRate || 0;
          const minRate = min?.metrics?.successRate || 100;
          return successRate < minRate ? { name, metrics } : min;
        },
        null as { name: string; metrics: ValidationMetrics } | null
      );

      return {
        avgSuccessRate: Math.max(0, Math.min(avgSuccessRate, 100)),
        avgLatency: Math.max(0, avgLatency),
        avgAgreementRate: Math.max(0, Math.min(avgAgreementRate, 100)),
        worstPerformer: worst?.name || null,
        totalValidations: Math.max(0, totalValidations)
      };

    } catch (error) {
      // Return safe defaults
      return {
        avgSuccessRate: 100,
        avgLatency: 0,
        avgAgreementRate: 100,
        worstPerformer: null,
        totalValidations: 0
      };
    }
  }

  /**
   * Reset metrics for a data type (useful for testing)
   */
  resetMetrics(dataType: string): void {
    try {
      if (typeof dataType !== 'string' || !this.metrics.has(dataType)) {
        return;
      }

      this.metrics.set(dataType, {
        successRate: 100,
        sourceAgreementRate: 100,
        avgValidationLatency: 0,
        falsePositiveRate: 0,
        totalValidations: 0,
        lastUpdated: Date.now()
      });

      this.emit('metrics:reset', { dataType });

    } catch (error) {
      this.emit('metrics:error', {
        dataType,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Get all registered validators
   */
  getValidators(): string[] {
    try {
      return Array.from(this.validators.keys());
    } catch (error) {
      return [];
    }
  }

  /**
   * Has validator (check if validator is registered)
   */
  hasValidator(dataType: string): boolean {
    try {
      if (typeof dataType !== 'string') {
        return false;
      }

      return this.validators.has(dataType);
    } catch (error) {
      return false;
    }
  }

  /**
   * Cleanup (remove all listeners)
   */
  destroy(): void {
    try {
      this.removeAllListeners();
      this.validators.clear();
      this.metrics.clear();
      this.lastValidationTime.clear();
    } catch (error) {
      // Suppress cleanup errors
    }
  }
}

export default ValidationEngine;
