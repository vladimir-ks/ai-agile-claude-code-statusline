/**
 * Detection Engine — Core
 *
 * Pure function detection of secrets and PII in text.
 * Zero dependencies, portable, <1ms for typical chat messages.
 *
 * Usage:
 *   import { detect, DetectionEngine } from './detection-engine';
 *
 *   // One-shot
 *   const findings = detect('my text with ghp_abc123...');
 *
 *   // Reusable (pre-compiled rules)
 *   const engine = new DetectionEngine({ minSeverity: 'critical' });
 *   engine.detect('text');
 */

import type { Finding, Rule, DetectionConfig, Category, Severity } from './types';
import { DEFAULT_CONFIG, SEVERITY_ORDER } from './types';
import { ALL_RULES } from './rulesets';
import { redact, extractContext } from './utils';

export class DetectionEngine {
  private readonly config: Required<DetectionConfig>;
  private rules: Rule[];

  constructor(config?: DetectionConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<DetectionConfig>;
    this.rules = this.filterRules(ALL_RULES);
  }

  /**
   * Detect secrets and PII in text.
   * Returns findings sorted by offset (earliest first).
   */
  detect(text: string): Finding[] {
    if (!text || text.length === 0) return [];

    const findings: Finding[] = [];
    const seen = new Set<string>(); // Dedup by rule+offset

    for (const rule of this.rules) {
      // Reset regex state (critical for /g flag reuse)
      rule.pattern.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = rule.pattern.exec(text)) !== null) {
        // Dedup key: rule ID + offset
        const key = `${rule.id}:${match.index}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const matchText = match[0];
        const offset = match.index;

        // Get surrounding context for validators
        const ctx = extractContext(text, offset, matchText.length, this.config.contextWindow);

        // Run validator (if present)
        let confidence = 1.0;
        if (rule.validate) {
          confidence = rule.validate(matchText, ctx);
          if (confidence < this.config.minConfidence) continue;
        }

        // Check allowlist
        if (this.isAllowlisted(matchText)) continue;

        const finding: Finding = {
          rule: rule.id,
          type: rule.type,
          category: rule.category,
          severity: rule.severity,
          match: redact(matchText),
          offset,
          length: matchText.length,
          confidence,
        };

        if (this.config.includeContext) {
          finding.context = ctx;
        }

        findings.push(finding);

        // Cap findings for performance
        if (findings.length >= this.config.maxFindings) {
          return findings.sort((a, b) => a.offset - b.offset);
        }
      }
    }

    return findings.sort((a, b) => a.offset - b.offset);
  }

  /** Detect only secrets */
  detectSecrets(text: string): Finding[] {
    return this.detect(text).filter(f => f.category === 'secret');
  }

  /** Detect only PII */
  detectPII(text: string): Finding[] {
    return this.detect(text).filter(f => f.category === 'pii');
  }

  /** Fast boolean check: any findings? */
  hasFindings(text: string): boolean {
    // Early exit optimization: detect with maxFindings=1
    const engine = new DetectionEngine({ ...this.config, maxFindings: 1 });
    engine.rules = this.rules;
    return engine.detect(text).length > 0;
  }

  /** Replace all findings with [REDACTED] */
  redactAll(text: string): string {
    const findings = this.detect(text);
    if (findings.length === 0) return text;

    // Sort by offset descending (replace from end to preserve positions)
    const sorted = [...findings].sort((a, b) => b.offset - a.offset);
    let result = text;
    for (const f of sorted) {
      result = result.slice(0, f.offset) + '[REDACTED]' + result.slice(f.offset + f.length);
    }
    return result;
  }

  /** Add a custom rule */
  addRule(rule: Rule): void {
    if (this.meetsMinSeverity(rule.severity) && this.meetsCategory(rule.category)) {
      this.rules.push(rule);
    }
  }

  /** Set allowlist patterns */
  setAllowlist(patterns: RegExp[]): void {
    (this.config as any).allowlist = patterns;
  }

  /** Get current rule count */
  get ruleCount(): number {
    return this.rules.length;
  }

  // ── Private ─────────────────────────────────────────────────────────

  private filterRules(rules: Rule[]): Rule[] {
    return rules.filter(
      r => this.meetsMinSeverity(r.severity) && this.meetsCategory(r.category),
    );
  }

  private meetsMinSeverity(severity: Severity): boolean {
    return SEVERITY_ORDER[severity] >= SEVERITY_ORDER[this.config.minSeverity];
  }

  private meetsCategory(category: Category): boolean {
    return this.config.categories.includes(category);
  }

  private isAllowlisted(text: string): boolean {
    return this.config.allowlist.some(re => re.test(text));
  }
}
