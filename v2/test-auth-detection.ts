import { authSource } from './src/lib/sources/auth-source';

// Test with user's actual session
const ctx = {
  transcriptPath: '/Users/vmks/.claude/projects/-Users-vmks--IT-Projects--aigile-os-ingestion/44be6263-d9b6-44f4-9222-4fc81f160b58.jsonl',
  projectPath: '/Users/vmks/_IT_Projects/_aigile-os/ingestion',
  existingHealth: null
};

console.log("Testing auth-source.fetch()...");
const result = await authSource.fetch(ctx as any);
console.log("Result:", JSON.stringify(result, null, 2));
