# P5 Scope: Transcript Sync & Data Loss Detection

## Mission
Validate that transcript sync detection is ACCURATE.
Verify data loss risk calculations are meaningful.
Check staleness thresholds are reasonable.

## Read First
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/00-COMMON-BRIEF.md

## Review These Files
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/transcript-monitor.ts
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/lib/data-gatherer.ts (transcript section)
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/src/display-only.ts (fmtTranscriptSync)
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/v2/tests/unit/lib/transcript-monitor.test.ts

## Validation Tasks
1. What is the actual transcript path structure?
2. How does Claude Code update transcripts? On every message? Periodically?
3. Is the 5-minute staleness threshold reasonable?
4. What triggers data loss risk vs just stale?
5. Is the "lastModifiedAgo" calculation accurate?
6. What happens when transcript doesn't exist?

## Commands to Run for Validation
```bash
# Find actual transcript files
find ~/.claude/projects -name "*.jsonl" -mmin -60 | head -5

# Check transcript modification time
ls -la ~/.claude/projects/-Users-vmks--IT-Projects--dev-tools-ai-agile-claude-code-statusline/*.jsonl 2>/dev/null | head -3
```

## Write Output To
- /Users/vmks/_IT_Projects/_dev_tools/ai-agile-claude-code-statusline/.aigile/deep-review/260130-1153-statusline-v3/P5-review.md
