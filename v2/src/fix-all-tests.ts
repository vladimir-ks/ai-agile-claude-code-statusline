#!/usr/bin/env bun
/**
 * Bulk Test Fixer - Adds withFormattedOutput to all test files
 *
 * This script updates all test files that write health JSON
 * to also generate formattedOutput using the helper.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const TESTS_DIR = join(__dirname, '../tests');

// Pattern to match health object writes before JSON.stringify
const healthWritePattern = /writeFileSync\([^,]+,\s*JSON\.stringify\((\{[^}]+health[^}]+\}|health)\)/g;

function fixTestFile(filePath: string): boolean {
  const content = readFileSync(filePath, 'utf-8');

  // Check if already has withFormattedOutput import
  if (content.includes('withFormattedOutput')) {
    console.log(`✓ ${filePath} - Already fixed`);
    return false;
  }

  // Check if file writes health JSON
  if (!content.includes('JSON.stringify') || !content.includes('health')) {
    console.log(`- ${filePath} - No health writes detected`);
    return false;
  }

  let modified = content;

  // Add import if not present
  const importLine = "import { withFormattedOutput } from './helpers/with-formatted-output';";
  const importSection = modified.match(/import .* from ['"]bun:test['"];/);

  if (importSection && !modified.includes(importLine)) {
    modified = modified.replace(
      importSection[0],
      `${importSection[0]}\n${importLine}`
    );
  }

  // Wrap health objects with withFormattedOutput
  // This is a simple pattern - may need manual review for complex cases
  modified = modified.replace(
    /const health = (\{[\s\S]*?\});/g,
    'const healthData = $1;\n      const health = withFormattedOutput(healthData);'
  );

  if (modified !== content) {
    writeFileSync(filePath, modified, 'utf-8');
    console.log(`✅ ${filePath} - FIXED`);
    return true;
  }

  return false;
}

// Process all test files
const testFiles = readdirSync(TESTS_DIR)
  .filter(f => f.endsWith('.test.ts'))
  .map(f => join(TESTS_DIR, f));

let fixedCount = 0;
for (const file of testFiles) {
  if (fixTestFile(file)) {
    fixedCount++;
  }
}

console.log(`\n📊 Summary: Fixed ${fixedCount}/${testFiles.length} test files`);
console.log('\n⚠️  IMPORTANT: Run tests and manually review changes!');
console.log('   Some complex patterns may need manual fixes.\n');
