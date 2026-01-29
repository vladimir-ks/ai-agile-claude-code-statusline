/**
 * Version Module - Claude Code Version Display
 *
 * Displays: 📟:v2.1.22
 */

import type { DataModule, DataModuleConfig, ValidationResult } from '../types/data-module';

interface VersionData {
  version: string;
  displayVersion: string;
}

class VersionModule implements DataModule<VersionData> {
  readonly moduleId = 'version';

  config: DataModuleConfig = {
    timeout: 100,
    cacheTTL: 0  // Real-time (version doesn't change within session)
  };

  private jsonInput: string = '';

  setJsonInput(jsonInput: string): void {
    this.jsonInput = jsonInput;
  }

  async fetch(sessionId: string): Promise<VersionData> {
    try {
      let version = '';

      // Try to get from JSON input
      if (this.jsonInput) {
        try {
          const parsed = JSON.parse(this.jsonInput);
          version = parsed.version || parsed.cc_version || '';
        } catch (error) {
          // JSON parse failed, version stays empty
        }
      }

      // If no version found, return empty
      if (!version || version === 'null') {
        return {
          version: '',
          displayVersion: ''
        };
      }

      return {
        version,
        displayVersion: `v${version}`
      };
    } catch (error) {
      return {
        version: '',
        displayVersion: ''
      };
    }
  }

  validate(data: VersionData): ValidationResult {
    // Version is optional, always valid
    return {
      valid: true,
      confidence: 100,
      warnings: []
    };
  }

  format(data: VersionData): string {
    if (!data || !data.displayVersion) {
      return '';  // Don't show if no version available
    }

    return `📟:${data.displayVersion}`;
  }
}

export default VersionModule;
export { VersionData };
