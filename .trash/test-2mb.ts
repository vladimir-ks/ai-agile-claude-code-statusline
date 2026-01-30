import TranscriptMonitor from '/Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/transcript-monitor';

const monitor = new TranscriptMonitor();
const path = '/Users/vmks/.claude/projects/-Users-vmks--IT-Projects--dev-tools-ai-agile-claude-code-statusline/e369e237-5058-4153-9f38-2cf530b597a3.jsonl';

console.time('checkHealth');
const health = monitor.checkHealth(path);
console.timeEnd('checkHealth');

console.log('lastMessagePreview:', JSON.stringify(health.lastMessagePreview));
console.log('lastMessageAgo:', health.lastMessageAgo);
