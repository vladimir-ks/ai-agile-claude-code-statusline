/**
 * Validation Types
 *
 * Type definitions for multi-source data validation system
 */

/**
 * Data point from a specific source
 */
export interface DataPoint<T> {
  value: T;
  source: string;          // 'json_stdin' | 'transcript' | 'settings.json' | ...
  fetchedAt: number;       // Timestamp when fetched
  ttl?: number;            // Time-to-live (ms)
}

/**
 * Data source configuration
 */
export interface DataSource<T> {
  name: string;
  priority: number;        // 1=primary, 2=secondary, 3=tertiary
  fetch: (sessionId: string) => Promise<T>;
  ttl: number;            // How long data is considered fresh (ms)
  timeout?: number;        // Fetch timeout (ms)
}

/**
 * Validation result
 */
export interface ValidationResult {
  valid: boolean;
  confidence: number;      // 0-100
  warnings: string[];
  errors: string[];
  recommendedSource: string;
  showStaleIndicator?: boolean;  // Show 🔴 in UI
  metadata: {
    sourceAgreement: number;     // % of sources that agree (0-100)
    validationLatency: number;   // Time to validate (ms)
    staleness: number;           // Age of oldest source (ms)
    sourcesChecked: number;      // How many sources were compared
  };
}

/**
 * Validation rule
 */
export interface ValidationRule<T> {
  name: string;
  dataType: string;
  validate: (primary: DataPoint<T>, secondary: DataPoint<T>[]) => ValidationResult;
}

/**
 * Validator interface
 */
export interface Validator<T> {
  dataType: string;
  validate: (primary: DataPoint<T>, secondary: DataPoint<T>[]) => ValidationResult;
}

/**
 * Validation metrics (tracked over time)
 */
export interface ValidationMetrics {
  successRate: number;           // % of validations that passed (0-100)
  sourceAgreementRate: number;   // % of times sources agree (0-100)
  avgValidationLatency: number;  // Average validation time (ms)
  falsePositiveRate: number;     // % of warnings that were incorrect (0-100)
  totalValidations: number;      // Total number of validations performed
  lastUpdated: number;           // Timestamp of last update
}

/**
 * Validation alert configuration
 */
export interface ValidationAlert {
  name: string;
  condition: (metrics: ValidationMetrics) => boolean;
  severity: 'info' | 'warning' | 'error' | 'critical';
  action: string;                // What to do when alert triggers
  enabled: boolean;
}

/**
 * Validation configuration
 */
export interface ValidationConfig {
  enabled: boolean;
  confidenceThreshold: number;   // Minimum confidence to accept primary (0-100)
  stalenessThreshold: number;    // Max staleness before showing 🔴 (ms)
  timeoutMs: number;            // Max time to wait for secondary sources (ms)
  throttleInterval: number;     // Only validate every N ms (0 = always)
  alerts: ValidationAlert[];
}
