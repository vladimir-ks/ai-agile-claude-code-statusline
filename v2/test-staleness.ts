import { StatuslineFormatter } from './src/lib/statusline-formatter';
import { readFileSync } from 'fs';

const healthFile = '/Users/vmks/.claude/session-health/44be6263-d9b6-44f4-9222-4fc81f160b58.json';
const health = JSON.parse(readFileSync(healthFile, 'utf-8'));

console.log("Session health billing data:");
console.log("  weeklyBudgetRemaining:", health.billing.weeklyBudgetRemaining);
console.log("  weeklyDataStale:", health.billing.weeklyDataStale);
console.log("  weeklyLastModified:", health.billing.weeklyLastModified);
console.log("  Age:", Date.now() - health.billing.weeklyLastModified, "ms");

const variants = StatuslineFormatter.formatAllVariants(health);
console.log("\nFormatted output (width120):");
console.log(variants.width120.join('\n'));

// Strip ANSI codes to see raw text
const stripped = variants.width120.join('\n').replace(/\x1b\[[0-9;]*m/g, '');
console.log("\nStripped (no colors):");
console.log(stripped);

if (stripped.includes('🔺')) {
  console.log("\n❌ STALENESS INDICATOR PRESENT");
} else {
  console.log("\n✅ NO STALENESS INDICATOR");
}
