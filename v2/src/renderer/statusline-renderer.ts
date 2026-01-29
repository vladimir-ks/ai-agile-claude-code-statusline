/**
 * Statusline Renderer - Format and Display (Production)
 *
 * Responsibilities:
 * - Format all module data into single statusline
 * - Apply colors (optional)
 * - Deduplication (prevent unnecessary redraws)
 */

interface RendererOptions {
  useColors: boolean;
  maxWidth?: number;
}

interface StatuslineComponents {
  // System Core
  directory?: string;
  git?: string;
  model?: string;
  version?: string;

  // Context & Time
  context?: string;
  time?: string;

  // Session & Financial
  budget?: string;
  cost?: string;

  // Usage & Health
  usage?: string;
  cache?: string;

  // Last Message
  lastMessage?: string;
}

class StatuslineRenderer {
  private lastOutput: string = '';
  private options: RendererOptions;

  constructor(options: RendererOptions = { useColors: true }) {
    this.options = options;
  }

  /**
   * Render complete statusline
   * Order matches V1: directory, git, model, version, context, time, budget, cost, usage, cache, lastMessage
   */
  render(components: StatuslineComponents): string {
    try {
      // Build statusline from components in correct order
      const parts: string[] = [];

      // Line 1: System Core + Context + Time
      if (components.directory) parts.push(components.directory);
      if (components.git) parts.push(components.git);
      if (components.model) parts.push(components.model);
      if (components.version) parts.push(components.version);
      if (components.context) parts.push(components.context);
      if (components.time) parts.push(components.time);

      // Line 2: Session, Financial, Usage, Health, Last Message
      // (actually all on same line, V1 wraps naturally if too wide)
      if (components.budget) parts.push(components.budget);
      if (components.cost) parts.push(components.cost);
      if (components.usage) parts.push(components.usage);
      if (components.cache) parts.push(components.cache);
      if (components.lastMessage) parts.push(components.lastMessage);

      const output = parts.filter(Boolean).join(' ');

      // Deduplicate (don't redraw if same as last)
      if (output === this.lastOutput) {
        return ''; // Empty string = no update needed
      }

      this.lastOutput = output;
      return output;

    } catch (error) {
      return '⚠ ERR';
    }
  }

  /**
   * Clear last output (force redraw next time)
   */
  clear(): void {
    this.lastOutput = '';
  }
}

export default StatuslineRenderer;
export { RendererOptions, StatuslineComponents };
