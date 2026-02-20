/**
 * Detection Engine — Type Definitions
 *
 * Core types for the secrets/PII detection module.
 * Designed for zero-dependency, portable detection across
 * Bun, Node, Deno, browser, and WASM environments.
 */

// ── Severity & Category ───────────────────────────────────────────────

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export type Category = 'secret' | 'pii';

// ── Finding (output) ──────────────────────────────────────────────────

/** A single detection result */
export interface Finding {
  /** Rule ID that matched (e.g., "github_pat_classic") */
  rule: string;
  /** Human-readable type (e.g., "GitHub Token") */
  type: string;
  /** Detection category */
  category: Category;
  /** Severity level */
  severity: Severity;
  /** Redacted match value (e.g., "ghp_...xyz7") */
  match: string;
  /** Character offset in input string */
  offset: number;
  /** Match length in characters */
  length: number;
  /** Confidence score 0.0-1.0 (validators can downgrade) */
  confidence: number;
  /** Surrounding text for debugging (optional) */
  context?: string;
}

// ── Rule (detection pattern) ──────────────────────────────────────────

/**
 * A detection rule — regex pattern + optional post-match validator.
 *
 * Validators return a confidence modifier (0.0 = reject, 1.0 = full confidence).
 * When no validator is present, matches get default confidence 1.0.
 */
export interface Rule {
  /** Unique rule identifier (e.g., "github_pat_classic") */
  id: string;
  /** Human-readable type label (e.g., "GitHub Token") */
  type: string;
  /** Detection category */
  category: Category;
  /** Severity level */
  severity: Severity;
  /** Regex pattern (MUST use /g flag) */
  pattern: RegExp;
  /** Brief description of what this rule detects */
  description: string;
  /**
   * Post-match validator. Returns confidence 0.0-1.0.
   * 0.0 = reject match (false positive). 1.0 = full confidence.
   * Receives: matched text, surrounding context (40 chars each side).
   */
  validate?: (match: string, context: string) => number;
}

// ── Configuration ─────────────────────────────────────────────────────

export interface DetectionConfig {
  /** Which categories to detect. Default: both */
  categories?: Category[];
  /** Minimum severity to report. Default: 'high' */
  minSeverity?: Severity;
  /** Minimum confidence to report. Default: 0.7 */
  minConfidence?: number;
  /** Regex patterns to skip (allowlist). Matches checked against raw text. */
  allowlist?: RegExp[];
  /** Maximum findings to return. Default: 100 (perf cap) */
  maxFindings?: number;
  /** Include surrounding context in findings. Default: false */
  includeContext?: boolean;
  /** Context window size (chars each side). Default: 40 */
  contextWindow?: number;
}

// ── Defaults ──────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: Required<DetectionConfig> = {
  categories: ['secret', 'pii'],
  minSeverity: 'high',
  minConfidence: 0.7,
  allowlist: [],
  maxFindings: 100,
  includeContext: false,
  contextWindow: 40,
};

/** Severity ordering for threshold comparison */
export const SEVERITY_ORDER: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};
