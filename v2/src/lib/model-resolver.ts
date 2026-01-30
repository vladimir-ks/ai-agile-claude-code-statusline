/**
 * Model Resolver - Multi-source model resolution with validation
 *
 * Priority:
 * 1. Fresh transcript (<1 hour) - highest confidence
 * 2. JSON input from Claude Code - current session
 * 3. Settings.json - global default
 * 4. "Claude" - fallback
 *
 * Logs disagreements between sources for analysis
 */

import { existsSync, readFileSync, statSync } from 'fs';
import { ModelInfo, ClaudeCodeInput } from '../types/session-health';
import validationLogger from './validation-logger';

interface SourceData {
  value: string;
  age: number;      // seconds since data was created
  confidence: number;
}

class ModelResolver {
  private lastDisagreement: string | null = null;

  /**
   * Resolve model from multiple sources
   */
  resolve(
    transcriptPath: string | null,
    jsonInput: ClaudeCodeInput | null,
    settingsModel: string | null
  ): ModelInfo {
    const sources: Record<string, SourceData | null> = {};

    // Source 1: Transcript (last message model)
    if (transcriptPath && existsSync(transcriptPath)) {
      const transcriptModel = this.extractModelFromTranscript(transcriptPath);
      if (transcriptModel) {
        sources.transcript = {
          value: this.formatModelName(transcriptModel.model),
          age: (Date.now() - transcriptModel.timestamp) / 1000,
          confidence: this.calculateTranscriptConfidence(transcriptModel.timestamp)
        };
      }
    }

    // Source 2: JSON input
    // FIX: Claude Code provides display_name, id, or model_id - not 'name'
    if (jsonInput?.model) {
      const modelName = jsonInput.model.display_name || jsonInput.model.id || jsonInput.model.model_id;
      if (modelName) {
        sources.jsonInput = {
          value: this.formatModelName(modelName),
          age: 0, // Real-time
          confidence: 80
        };
      }
    }

    // Source 3: Settings
    if (settingsModel) {
      sources.settings = {
        value: this.formatModelName(settingsModel),
        age: Infinity,
        confidence: 30
      };
    }

    // Select best source
    const selected = this.selectBest(sources);

    // Detect and log disagreement
    this.lastDisagreement = this.detectDisagreement(sources);

    // Log for validation analysis
    validationLogger.log({
      dataPoint: 'model',
      sources: Object.fromEntries(
        Object.entries(sources).map(([k, v]) => [k, v ? { value: v.value, fetchTimeMs: 0 } : { value: null, error: 'not available' }])
      ),
      selected: {
        source: selected.source,
        value: selected.value,
        confidence: selected.confidence,
        reason: selected.reason || ''
      },
      disagreement: this.lastDisagreement || undefined
    });

    return {
      value: selected.value,
      source: selected.source as ModelInfo['source'],
      confidence: selected.confidence,
      reason: selected.reason
    };
  }

  /**
   * Select the best source based on priority and freshness
   */
  private selectBest(sources: Record<string, SourceData | null>): {
    source: string;
    value: string;
    confidence: number;
    reason: string;
  } {
    const transcript = sources.transcript;
    const jsonInput = sources.jsonInput;
    const settings = sources.settings;

    // Priority 1: Fresh transcript (<1 hour = 3600 seconds)
    if (transcript && transcript.age < 3600) {
      return {
        source: 'transcript',
        value: transcript.value,
        confidence: transcript.confidence,
        reason: `Fresh transcript (${this.formatAge(transcript.age)} old)`
      };
    }

    // Priority 2: JSON input (current session)
    if (jsonInput) {
      return {
        source: 'jsonInput',
        value: jsonInput.value,
        confidence: jsonInput.confidence,
        reason: 'Current session JSON input'
      };
    }

    // Priority 3: Settings (global default)
    if (settings) {
      return {
        source: 'settings',
        value: settings.value,
        confidence: settings.confidence,
        reason: 'Fallback to settings.json'
      };
    }

    // Priority 4: Default
    return {
      source: 'default',
      value: 'Claude',
      confidence: 10,
      reason: 'No source available'
    };
  }

  /**
   * Extract model from transcript file (last assistant message with model)
   */
  private extractModelFromTranscript(path: string): { model: string; timestamp: number } | null {
    try {
      const stats = statSync(path);
      if (stats.size === 0) {
        return null;
      }

      const content = readFileSync(path, 'utf-8');

      // For large files, only check last 50KB
      const chunk = stats.size > 50000 ? content.slice(-50000) : content;
      const lines = chunk.split('\n').filter(line => line.trim() !== '');

      // Search from end for assistant message with model
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.message?.model) {
            return {
              model: obj.message.model,
              timestamp: obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now()
            };
          }
        } catch {
          // Invalid JSON line, continue
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Calculate confidence based on transcript age
   * Fresher = higher confidence
   */
  private calculateTranscriptConfidence(timestamp: number): number {
    const ageSeconds = (Date.now() - timestamp) / 1000;

    if (ageSeconds < 60) return 98;       // <1 min
    if (ageSeconds < 300) return 95;      // <5 min
    if (ageSeconds < 900) return 90;      // <15 min
    if (ageSeconds < 1800) return 85;     // <30 min
    if (ageSeconds < 3600) return 75;     // <1 hour
    return 50;                             // >1 hour (stale)
  }

  /**
   * Format model ID to display name
   */
  formatModelName(modelId: string): string {
    const lower = modelId.toLowerCase();

    if (lower.includes('opus')) {
      return 'Opus4.5';
    } else if (lower.includes('sonnet')) {
      return 'Sonnet4.5';
    } else if (lower.includes('haiku')) {
      return 'Haiku4.5';
    }

    // Pass through unknown models
    return modelId;
  }

  /**
   * Detect disagreement between sources
   */
  private detectDisagreement(sources: Record<string, SourceData | null>): string | null {
    const availableSources = Object.entries(sources)
      .filter(([_, data]) => data !== null)
      .map(([name, data]) => ({ name, value: data!.value }));

    if (availableSources.length < 2) {
      return null; // Need at least 2 sources to disagree
    }

    const uniqueValues = [...new Set(availableSources.map(s => s.value))];

    if (uniqueValues.length > 1) {
      const details = availableSources.map(s => `${s.name}=${s.value}`).join(', ');
      return `Sources disagree: ${details}`;
    }

    return null;
  }

  /**
   * Format age in seconds to human-readable
   */
  private formatAge(seconds: number): string {
    if (seconds < 60) return '<1m';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
  }

  /**
   * Get the last disagreement message (for testing)
   */
  getLastDisagreement(): string | null {
    return this.lastDisagreement;
  }
}

export default ModelResolver;
