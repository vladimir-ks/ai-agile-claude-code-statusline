import { quotaSource } from './src/lib/sources/quota-source';

// Simulate session context (using default ~/.claude)
const ctx = {
  transcriptPath: '/Users/vmks/.claude/projects/-Users-vmks--IT-Projects--aigile-os-ingestion/44be6263-d9b6-44f4-9222-4fc81f160b58.jsonl',
  configDir: '/Users/vmks/.claude',
  keychainService: 'Claude Code-credentials', // Default keychain (no hash)
  authEmail: undefined,
  projectPath: '/Users/vmks/_IT_Projects/_aigile-os/ingestion',
  existingHealth: null
};

console.log("Testing quota-source.fetch() with default keychain...");
const result = await quotaSource.fetch(ctx as any);
console.log("Result:", JSON.stringify(result, null, 2));
