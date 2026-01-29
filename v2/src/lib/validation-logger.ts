/**
 * Validation Logger - Simple logging to understand data source behavior
 *
 * Purpose: Log all data sources for each data point, compare them,
 * detect disagreements, and help us understand which source is most reliable.
 *
 * Log format: JSON lines (one JSON object per line) for easy analysis
 * Location: ~/.claude/statusline-validation.jsonl
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname } from 'path';

interface SourceData {
  value: any;
  fetchTimeMs?: number;
  error?: string;
}

interface ValidationEntry {
  ts: number;           // Unix timestamp
  time: string;         // Human readable
  dataPoint: string;    // Which data point (model, git, context, etc.)
  sources: Record<string, SourceData>;
  selected: {
    source: string;     // Which source was used
    value: any;         // What value was selected
    confidence: number; // 0-100
    reason: string;     // Why this source
  };
  disagreement?: string; // If sources disagree, explain
}

class ValidationLogger {
  private logPath: string;
  private enabled: boolean;

  constructor() {
    this.logPath = `${homedir()}/.claude/statusline-validation.jsonl`;
    this.enabled = process.env.STATUSLINE_VALIDATION_LOG !== '0';

    // Ensure directory exists
    const dir = dirname(this.logPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Log a validation entry for a data point
   */
  log(entry: Omit<ValidationEntry, 'ts' | 'time'>): void {
    if (!this.enabled) return;

    const fullEntry: ValidationEntry = {
      ts: Date.now(),
      time: new Date().toISOString(),
      ...entry
    };

    try {
      appendFileSync(this.logPath, JSON.stringify(fullEntry) + '\n');
    } catch (error) {
      // Silent fail - logging should never break statusline
    }
  }

  /**
   * Helper: Compare sources and detect disagreement
   */
  compare(
    dataPoint: string,
    sources: Record<string, SourceData>,
    selectFn: (sources: Record<string, SourceData>) => { source: string; value: any; confidence: number; reason: string }
  ): any {
    const selected = selectFn(sources);

    // Detect disagreements
    const values = Object.entries(sources)
      .filter(([_, data]) => data.value !== null && data.value !== undefined && !data.error)
      .map(([name, data]) => ({ name, value: String(data.value) }));

    const uniqueValues = [...new Set(values.map(v => v.value))];
    const disagreement = uniqueValues.length > 1
      ? `Sources disagree: ${values.map(v => `${v.name}=${v.value}`).join(', ')}`
      : undefined;

    this.log({
      dataPoint,
      sources,
      selected,
      disagreement
    });

    return selected.value;
  }
}

// Singleton instance
const logger = new ValidationLogger();

export default logger;
export { ValidationLogger, ValidationEntry, SourceData };
