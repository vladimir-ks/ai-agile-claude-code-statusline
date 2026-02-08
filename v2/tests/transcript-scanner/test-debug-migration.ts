import { StateManager } from '../../src/lib/transcript-scanner/state-manager';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const tempDir = join(tmpdir(), `test-migrate-${Date.now()}`);
mkdirSync(tempDir, { recursive: true});

// Set TEST_STATE_DIR
process.env.TEST_STATE_DIR = tempDir;

console.log('TEST_STATE_DIR:', tempDir);

// Create cooldowns dir
const cooldownsDir = join(tempDir, 'cooldowns');
mkdirSync(cooldownsDir, { recursive: true });
console.log('Created cooldowns:', cooldownsDir);

// Create old state file
const sessionId = 'test-migrate';
const oldStatePath = join(cooldownsDir, `${sessionId}-transcript.state`);
const oldState = {
  lastReadOffset: 100,
  lastReadMtime: 123456,
  messageCount: 5,
  lastUserMessage: { timestamp: 123456, preview: 'test' }
};
writeFileSync(oldStatePath, JSON.stringify(oldState));
console.log('Created old state:', oldStatePath);
console.log('Old state exists:', existsSync(oldStatePath));

// Try to load (should trigger migration)
const loaded = StateManager.load(sessionId);
console.log('Loaded state:', loaded);

// Check if new state was created
const newStatePath = StateManager.getStatePath(sessionId);
console.log('New state path:', newStatePath);
console.log('New state exists:', existsSync(newStatePath));
