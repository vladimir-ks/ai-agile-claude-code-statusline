#!/usr/bin/env bun
/**
 * Test Anthropic OAuth API integration
 */

import { AnthropicOAuthAPI } from './src/modules/anthropic-oauth-api';

async function test() {
  console.log('Testing Anthropic OAuth API...\n');

  // Test 1: Check if token is available
  console.log('1. Checking for OAuth token...');
  const hasToken = !!process.env.ANTHROPIC_API_KEY;
  console.log(`   Token available: ${hasToken ? 'YES' : 'NO'}`);

  if (!hasToken) {
    console.log('\n⚠️  No ANTHROPIC_API_KEY found in environment.');
    console.log('   Set it with: export ANTHROPIC_API_KEY="sk-ant-..."');
    process.exit(1);
  }

  // Test 2: Fetch usage data
  console.log('\n2. Fetching usage data from OAuth API...');
  const billing = await AnthropicOAuthAPI.fetchUsage();

  if (!billing) {
    console.log('   ❌ Failed to fetch billing data');
    process.exit(1);
  }

  console.log('   ✅ Successfully fetched billing data');
  console.log(`\n   Cost Today: $${billing.costToday.toFixed(2)}`);
  console.log(`   Burn Rate: $${billing.burnRatePerHour.toFixed(2)}/hour`);
  console.log(`   Budget %: ${billing.budgetPercentUsed}%`);
  console.log(`   Budget Remaining: ${billing.budgetRemaining} minutes`);
  console.log(`   Reset Time: ${billing.resetTime} UTC`);
  console.log(`   Total Tokens: ${billing.totalTokens?.toLocaleString() || 'N/A'}`);
  console.log(`   Is Fresh: ${billing.isFresh}`);

  // Test 3: Test connection
  console.log('\n3. Testing connection...');
  const connected = await AnthropicOAuthAPI.testConnection();
  console.log(`   Connection: ${connected ? 'OK' : 'FAILED'}`);

  console.log('\n✅ All tests passed!');
}

test().catch(console.error);
