/**
 * Context Validator
 *
 * Filters out matches that appear in code blocks, example text,
 * URLs, or near placeholder keywords.
 */

/** Words that suggest the surrounding text is an example, not a real secret */
const EXAMPLE_KEYWORDS = [
  'example', 'sample', 'test', 'placeholder', 'dummy', 'fake',
  'mock', 'demo', 'tutorial', 'template', 'EXAMPLE', 'SAMPLE',
];

/**
 * Context-aware confidence adjustment.
 * Downgrades confidence when match appears in:
 * - Markdown code fences (``` blocks)
 * - Near example/placeholder keywords
 *
 * Returns confidence modifier (0.0-1.0). Multiply with existing confidence.
 */
export function contextValidator(match: string, context: string): number {
  // Check if inside markdown code fence
  if (isInsideCodeFence(context)) return 0.3;

  // Check for nearby example keywords
  const lowerCtx = context.toLowerCase();
  for (const keyword of EXAMPLE_KEYWORDS) {
    if (lowerCtx.includes(keyword)) return 0.4;
  }

  return 1.0;
}

/**
 * Heuristic: detect if the context contains code fence markers.
 * This is a best-effort check on the local context window.
 */
function isInsideCodeFence(context: string): boolean {
  // Look for ``` in the context (before or after the match)
  const fenceCount = (context.match(/```/g) || []).length;
  // Odd number of fences = we're likely inside one
  return fenceCount % 2 === 1;
}
