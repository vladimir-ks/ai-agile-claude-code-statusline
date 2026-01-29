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

class StatuslineRenderer {
  private lastOutput: string = '';
  private options: RendererOptions;

  constructor(options: RendererOptions = { useColors: true }) {
    this.options = options;
  }

  /**
   * Render complete statusline
   */
  render(components: {
    context?: string;
    model?: string;
    cost?: string;
    git?: string;
    time?: string;
  }): string {
    try {
      // Build statusline from components
      const parts: string[] = [];

      if (components.git) parts.push(components.git);
      if (components.model) parts.push(components.model);
      if (components.context) parts.push(components.context);
      if (components.time) parts.push(components.time);
      if (components.cost) parts.push(components.cost);

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
export { RendererOptions };
