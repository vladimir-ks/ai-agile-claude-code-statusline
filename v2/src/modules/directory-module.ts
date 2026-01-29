/**
 * Directory Module - Show Current Working Directory
 *
 * Displays: 📁:~/.claude or 📁:~/projects/foo
 */

import type { DataModule, DataModuleConfig } from '../broker/data-broker';
import type { ValidationResult } from '../types/validation';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

interface DirectoryData {
  currentDir: string;
  projectDir?: string;
  displayPath: string;
}

class DirectoryModule implements DataModule<DirectoryData> {
  readonly moduleId = 'directory';

  config: DataModuleConfig = {
    timeout: 100,
    cacheTTL: 0  // Real-time (directory doesn't change within session)
  };

  private jsonInput: string = '';

  setJsonInput(jsonInput: string): void {
    this.jsonInput = jsonInput;
  }

  async fetch(sessionId: string): Promise<DirectoryData> {
    try {
      let currentDir = 'unknown';
      let projectDir: string | undefined;

      // Try to get from JSON input first
      if (this.jsonInput) {
        try {
          const parsed = JSON.parse(this.jsonInput);
          currentDir = parsed.workspace?.current_dir || parsed.cwd || currentDir;
          projectDir = parsed.workspace?.project_dir || undefined;
        } catch (error) {
          // JSON parse failed, use fallback
        }
      }

      // Fallback: use process.cwd()
      if (currentDir === 'unknown') {
        currentDir = process.cwd();
      }

      // Replace $HOME with ~ for display
      const home = process.env.HOME || '';
      let displayPath = currentDir;
      if (home && currentDir.startsWith(home)) {
        displayPath = currentDir.replace(home, '~');
      }

      return {
        currentDir,
        projectDir,
        displayPath
      };
    } catch (error) {
      // Fallback to cwd
      const cwd = process.cwd();
      const home = process.env.HOME || '';
      const displayPath = home && cwd.startsWith(home) ? cwd.replace(home, '~') : cwd;

      return {
        currentDir: cwd,
        displayPath
      };
    }
  }

  validate(data: DirectoryData): ValidationResult {
    // Directory data is always valid (has fallback)
    if (!data || !data.currentDir) {
      return {
        valid: false,
        confidence: 0,
        errors: ['Directory data missing']
      };
    }

    return {
      valid: true,
      confidence: 100,
      warnings: []
    };
  }

  format(data: DirectoryData): string {
    if (!data || !data.displayPath) {
      return '📁:unknown';
    }

    // Show project dir if different from current dir
    if (data.projectDir && data.projectDir !== data.currentDir) {
      const home = process.env.HOME || '';
      let projectDisplay = data.projectDir;
      if (home && data.projectDir.startsWith(home)) {
        projectDisplay = data.projectDir.replace(home, '~');
      }

      // Extract basename for compact display
      const projectBasename = projectDisplay.split('/').pop() || projectDisplay;
      return `📁:${data.displayPath} (proj:${projectBasename})`;
    }

    return `📁:${data.displayPath}`;
  }
}

export default DirectoryModule;
export { DirectoryData };
