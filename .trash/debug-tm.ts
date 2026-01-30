import { readFileSync, statSync } from 'fs';

const path = '/Users/vmks/.claude/projects/-Users-vmks--IT-Projects--dev-tools-ai-agile-claude-code-statusline/e369e237-5058-4153-9f38-2cf530b597a3.jsonl';

const stats = statSync(path);
console.log('File size:', stats.size, 'bytes');
console.log('Size > 1MB?', stats.size > 1_000_000);

// Simulate getLastUserMessageFromTail
const content = readFileSync(path, 'utf-8');
const readSize = Math.min(500000, content.length);
const lastChunk = content.slice(-readSize);
console.log('Read last', readSize, 'bytes');

const lines = lastChunk.split('\n').filter(line => line.trim() !== '');
console.log('Lines in chunk:', lines.length);

// Search for user messages with text
let foundText = 0;
let foundToolResult = 0;
for (let i = lines.length - 1; i >= 0 && foundText < 5; i--) {
  try {
    const obj = JSON.parse(lines[i]);
    if (obj.type === 'user' && obj.message?.content) {
      const content = obj.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            console.log(`Found text at line -${lines.length - i}: "${block.text.slice(0, 40)}..."`);
            foundText++;
            break;
          }
          if (block.type === 'tool_result') {
            foundToolResult++;
          }
        }
      }
    }
  } catch {}
}
console.log('Found', foundText, 'text messages,', foundToolResult, 'tool_result messages');
