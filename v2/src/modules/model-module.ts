/**
 * Model Module - Current AI Model (Production)
 * Data Source: JSON stdin
 * Session-Specific: YES
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';

interface ModelData {
  sessionId: string;
  modelName: string;
  displayName: string;
}

class ModelModule implements DataModule<ModelData> {
  readonly moduleId = 'model';
  config: DataModuleConfig = { timeout: 100, cacheTTL: 0 };
  private jsonInput: string = '{}';

  setJsonInput(json: string): void {
    this.jsonInput = json || '{}';
  }

  async fetch(sessionId: string): Promise<ModelData> {
    try {
      const parsed = JSON.parse(this.jsonInput);
      const modelName = parsed.model?.name || 'Claude';
      const displayName = parsed.model?.display_name || modelName;

      return { sessionId, modelName, displayName };
    } catch (error) {
      return { sessionId, modelName: 'Claude', displayName: 'Claude' };
    }
  }

  validate(data: ModelData) {
    const errors: string[] = [];
    if (!data?.modelName) errors.push('Model name missing');
    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
      sanitized: {
        sessionId: data?.sessionId || 'unknown',
        modelName: data?.modelName || 'Claude',
        displayName: data?.displayName || data?.modelName || 'Claude'
      }
    };
  }

  format(data: ModelData): string {
    const display = data.displayName
      .replace('Claude ', '')
      .replace('Anthropic', '')
      .trim();
    return `🤖:${display}`;
  }
}

export default ModelModule;
export { ModelData };
