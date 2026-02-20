/**
 * Secret Detector — Transcript Scanner Extractor
 *
 * Adapter that wraps the detection-engine for use in the
 * UnifiedTranscriptScanner pipeline.
 *
 * Responsibilities:
 * - Stringify ParsedLine data (recursive object → text)
 * - Delegate detection to DetectionEngine (single source of truth for rules)
 * - Generate fingerprints for cross-scan deduplication
 * - Return Secret[] (transcript scanner interface)
 *
 * The detection-engine handles: pattern matching, validation, redaction.
 * This adapter handles: transcript format, fingerprinting, line tracking.
 */

import type { ParsedLine, Secret } from '../types';
import type { DataExtractor } from '../types';
import { createHash } from 'crypto';
import { DetectionEngine } from '../../detection-engine';

/** Shared engine instance — secrets only, high+ severity */
const engine = new DetectionEngine({
  categories: ['secret'],
  minSeverity: 'high',
  minConfidence: 0.5,
});

export class SecretDetector implements DataExtractor<Secret[]> {
  readonly id = 'secrets';
  readonly shouldCache = true;
  readonly cacheTTL = 300_000; // 5 minutes

  /**
   * Extract secrets from transcript lines.
   *
   * Strategy:
   * 1. Stringify each line's data (recursively handle nested objects)
   * 2. Delegate to DetectionEngine for pattern matching + validation
   * 3. Generate fingerprints for deduplication across scans
   * 4. Map Finding[] → Secret[] (transcript scanner interface)
   */
  extract(lines: ParsedLine[]): Secret[] {
    const secrets: Secret[] = [];
    const seen = new Set<string>(); // Fingerprint deduplication

    for (const line of lines) {
      if (!line.data) continue;

      const text = this.stringifyData(line.data);
      const findings = engine.detectSecrets(text);

      for (const finding of findings) {
        // Reconstruct the raw match for fingerprinting.
        // finding.match is redacted, so use rule+offset as fingerprint base.
        const fingerprintSource = `${finding.rule}:${finding.match}:${finding.length}`;
        const fingerprint = this.generateFingerprint(fingerprintSource, finding.type);

        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);

        secrets.push({
          type: finding.type,
          fingerprint,
          line: line.lineNumber,
          match: finding.match,
        });
      }
    }

    return secrets;
  }

  /**
   * Stringify data structure recursively.
   * Handles objects, arrays, primitives.
   */
  private stringifyData(data: any): string {
    if (typeof data === 'string') return data;
    if (typeof data === 'number' || typeof data === 'boolean') return String(data);
    if (data === null || data === undefined) return '';
    if (Array.isArray(data)) {
      return data.map(item => this.stringifyData(item)).join(' ');
    }
    if (typeof data === 'object') {
      return Object.values(data).map(value => this.stringifyData(value)).join(' ');
    }
    return '';
  }

  /**
   * Generate unique fingerprint for deduplication.
   * Format: type-keyword_hash
   */
  private generateFingerprint(secret: string, type?: string): string {
    const hash = createHash('sha256')
      .update(secret)
      .digest('hex')
      .slice(0, 12);
    const typeKey = type ? type.toLowerCase().split(' ')[0] : 'unknown';
    return `${typeKey}_${hash}`;
  }
}

export default SecretDetector;
