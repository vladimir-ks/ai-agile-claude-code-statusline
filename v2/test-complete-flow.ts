import DataGatherer from './src/lib/data-gatherer';

const sessionId = 'test-complete-' + Date.now();
const transcriptPath = '/Users/vmks/.claude/projects/-Users-vmks--IT-Projects--aigile-os-ingestion/44be6263-d9b6-44f4-9222-4fc81f160b58.jsonl';
const jsonInput = {
  session_id: sessionId,
  transcript_path: transcriptPath,
  start_directory: '/Users/vmks/_IT_Projects/_aigile-os/ingestion'
};

console.log("Testing complete data flow through DataGatherer...\n");

const gatherer = new DataGatherer();
const health = await gatherer.gather(sessionId, transcriptPath, jsonInput);

console.log("Result:");
console.log("  Auth:", {
  authProfile: health.launch.authProfile,
  keychainService: health.launch.keychainService,
  configDir: health.launch.configDir
});
console.log("  Quota:", {
  weeklyBudgetRemaining: health.billing.weeklyBudgetRemaining,
  weeklyBudgetPercentUsed: health.billing.weeklyBudgetPercentUsed,
  weeklyDataStale: health.billing.weeklyDataStale
});
console.log("  Secrets:", {
  detected: health.alerts.secretsDetected,
  types: health.alerts.secretTypes?.slice(0, 3)
});
