import { KeychainResolver } from './src/modules/keychain-resolver';

const transcriptPath = '/Users/vmks/.claude/projects/-Users-vmks--IT-Projects--aigile-os-ingestion/44be6263-d9b6-44f4-9222-4fc81f160b58.jsonl';
const result = KeychainResolver.resolveFromTranscript(transcriptPath);
console.log("KeychainResolver.resolveFromTranscript():", JSON.stringify(result, null, 2));
