/**
 * Detection Engine — Public API
 *
 * Secrets and PII detection module.
 * Zero dependencies, portable, <1ms for typical input.
 *
 * @example
 *   import { detect, DetectionEngine } from './detection-engine';
 *
 *   // Quick one-shot scan
 *   const findings = detect('text with ghp_abc...');
 *
 *   // Reusable engine (pre-compiled, configurable)
 *   const engine = new DetectionEngine({ minSeverity: 'critical' });
 *   const findings = engine.detect(text);
 *   const redacted = engine.redactAll(text);
 */

export { DetectionEngine } from './engine';
export type { Finding, Rule, DetectionConfig, Severity, Category } from './types';
export { DEFAULT_CONFIG, SEVERITY_ORDER } from './types';
export { ALL_RULES, SECRET_RULES, PII_RULES, getRulesByCategory, getRuleById } from './rulesets';
export { redact, extractContext } from './utils';
export {
  shannonEntropy,
  entropyValidator,
  luhnCheck,
  creditCardValidator,
  privateKeyValidator,
  connectionStringValidator,
  contextValidator,
} from './validators';

// ── Convenience: Standalone detect function ───────────────────────────

import { DetectionEngine } from './engine';
import type { Finding, DetectionConfig } from './types';

/** Shared default engine instance (lazy-initialized) */
let _defaultEngine: DetectionEngine | null = null;

/**
 * One-shot detection using default configuration.
 * Creates/reuses a shared engine instance.
 */
export function detect(text: string, config?: DetectionConfig): Finding[] {
  if (config) {
    return new DetectionEngine(config).detect(text);
  }
  if (!_defaultEngine) {
    _defaultEngine = new DetectionEngine();
  }
  return _defaultEngine.detect(text);
}
