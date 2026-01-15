---
name: Bug Report
about: Report an issue with the statusline
title: "[BUG] "
labels: bug
---

## Description

A clear and concise description of what the problem is.

## Steps to Reproduce

1. ...
2. ...
3. ...

## Expected Behavior

What should have happened.

## Actual Behavior

What actually happened instead.

## Environment

```bash
# Run these commands and paste output:
bash --version
jq --version
ccusage --version  # or "not installed"
git --version
uname -a
```

**OS**: [macOS/Linux/other]
**Shell**: [bash/zsh/fish/other]

## Debug Output

Please enable debug mode and paste relevant lines:

```bash
~/.claude/statusline.sh --debug
tail -50 ~/.claude/statusline.log
```

Paste the output here:

```
[debug output]
```

## Additional Context

- Did statusline work before?
- Did you recently install/update something?
- Is this blocking your workflow?

---

**Note**: Before reporting, check [Troubleshooting.md](../docs/TROUBLESHOOTING.md) - your issue may already be covered.
