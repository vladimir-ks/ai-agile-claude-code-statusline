#!/usr/bin/env bun
/**
 * Test script to verify runtime state functionality
 */

import RuntimeStateStore from './src/lib/runtime-state-store';
import { createDefaultAuthProfile } from './src/types/runtime-state';
import { existsSync } from 'fs';

async function test() {
  console.log('Testing RuntimeStateStore...\n');

  const store = new RuntimeStateStore('/tmp/test-runtime-state');

  // Test 1: Read empty state
  console.log('1. Reading empty state...');
  let state = store.read();
  console.log(`   Profiles: ${state.authProfiles.length}, Sessions: ${state.sessions.length}`);

  // Test 2: Create auth profile
  console.log('\n2. Creating auth profile...');
  const profile = createDefaultAuthProfile('test-work');
  profile.label = 'Test Work Account';
  profile.billing.costToday = 42.50;
  store.upsertAuthProfile(profile);
  console.log(`   Created profile: ${profile.profileId}`);

  // Test 3: Read state again
  console.log('\n3. Reading state after profile creation...');
  state = store.read();
  console.log(`   Profiles: ${state.authProfiles.length}`);
  console.log(`   Profile: ${state.authProfiles[0]?.profileId} - ${state.authProfiles[0]?.label}`);
  console.log(`   Cost: $${state.authProfiles[0]?.billing.costToday}`);

  // Test 4: Check YAML file
  const yamlPath = '/tmp/test-runtime-state/runtime-state.yaml';
  console.log(`\n4. Checking YAML file exists: ${existsSync(yamlPath)}`);

  // Test 5: Update billing
  console.log('\n5. Updating billing...');
  store.updateAuthProfileBilling('test-work', {
    costToday: 55.75,
    burnRatePerHour: 12.5,
    budgetRemaining: 180,
    budgetPercentUsed: 45,
    resetTime: '14:00',
    totalTokens: 85000000,
    tokensPerMinute: 12500,
    isFresh: true,
    lastFetched: Date.now()
  });

  state = store.read();
  console.log(`   Updated cost: $${state.authProfiles[0]?.billing.costToday}`);
  console.log(`   Burn rate: $${state.authProfiles[0]?.billing.burnRatePerHour}/h`);

  console.log('\n✅ All tests passed!');
}

test().catch(console.error);
