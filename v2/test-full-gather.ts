import { UnifiedDataBroker } from './src/lib/unified-data-broker';
import type { SessionHealth } from './src/types/session-health';

const sessionId = '44be6263-d9b6-44f4-9222-4fc81f160b58';
const transcriptPath = '/Users/vmks/.claude/projects/-Users-vmks--IT-Projects--aigile-os-ingestion/44be6263-d9b6-44f4-9222-4fc81f160b58.jsonl';
const projectPath = '/Users/vmks/_IT_Projects/_aigile-os/ingestion';

console.log("Testing UnifiedDataBroker.gatherAll()...");
const result = await UnifiedDataBroker.gatherAll(sessionId, transcriptPath, projectPath, null);

console.log("\nAuth data:", JSON.stringify({
  authProfile: result.launch.authProfile,
  keychainService: result.launch.keychainService,
  configDir: result.launch.configDir
}, null, 2));

console.log("\nQuota data:", JSON.stringify({
  weeklyBudgetRemaining: result.billing.weeklyBudgetRemaining,
  weeklyBudgetPercentUsed: result.billing.weeklyBudgetPercentUsed,
  weeklyDataStale: result.billing.weeklyDataStale
}, null, 2));

console.log("\nSecret alerts:", JSON.stringify({
  secretsDetected: result.alerts.secretsDetected,
  secretTypes: result.alerts.secretTypes
}, null, 2));
