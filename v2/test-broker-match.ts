import { QuotaBrokerClient } from './src/lib/quota-broker-client';

// Test 1: Match by keychainService
const keychainService = "Claude Code-credentials-4a0e8cbc";
const quota1 = QuotaBrokerClient.getActiveQuota(undefined, keychainService, undefined);
console.log("Match by keychainService:", quota1 ? `✓ ${quota1.email} (${quota1.weeklyBudgetRemaining}h)` : "✗ No match");

// Test 2: Match by email
const email = "vlad@vladks.com";
const quota2 = QuotaBrokerClient.getActiveQuota(undefined, undefined, email);
console.log("Match by email:", quota2 ? `✓ ${quota2.email} (${quota2.weeklyBudgetRemaining}h)` : "✗ No match");

// Test 3: No match (wrong service)
const wrongService = "Claude Code-credentials-wrong";
const quota3 = QuotaBrokerClient.getActiveQuota(undefined, wrongService, undefined);
console.log("Wrong keychainService:", quota3 ? `✓ ${quota3.email}` : "✗ No match (expected)");
