---
metadata:
  status: approved
  title: "Contributing Guidelines"
  version: "1.0.0"
---

# Contributing to AI-Agile Claude Code Status Line

Thank you for your interest in contributing! This document provides guidelines for contributing to the project.

## Code of Conduct

Be respectful, constructive, and helpful. We're building a community tool together.

## How to Contribute

### Reporting Bugs

Before opening an issue, check [Troubleshooting.md](docs/TROUBLESHOOTING.md) to see if it's a known issue.

**Include in bug report:**
- System info: `uname -a`, `bash --version`, `jq --version`
- What you expected to happen
- What actually happened
- Steps to reproduce
- Debug output: `~/.claude/statusline.sh --debug && tail -50 ~/.claude/statusline.log`

### Suggesting Features

Features must:
1. **Solve a real problem** (not just nice-to-have)
2. **Stay focused** (statusline is for monitoring, not configuration UI)
3. **Not add background processes** (100% synchronous requirement)
4. **Not require timeouts >5 seconds** (users expect snappy updates)

Open a discussion issue with:
- Problem statement ("Users can't X")
- Proposed solution
- Why it matters
- Alternatives considered

### Submitting Code

#### Prerequisites

- Bash 4.0+
- jq (for testing JSON parsing)
- git (for version control)

#### Setup

```bash
git clone <repo>
cd ai-agile-claude-code-statusline
./examples/test.sh  # Run test suite
```

#### Code Standards

**Bash Style:**

1. **Syntax validation first**
   ```bash
   bash -n scripts/statusline.sh
   ```

2. **Variable naming**
   - Use UPPERCASE for constants: `STATUSLINE_DIR`
   - Use snake_case for functions: `calculate_data_indicator`
   - Use lowercase for internal variables: `result`, `temp_file`

3. **Safety patterns**
   ```bash
   # ✅ Good: Timeouts on external commands
   result=$(timeout 20 ccusage blocks --json 2>/dev/null)

   # ✅ Good: Atomic file operations
   echo "$content" > "$file.tmp.$$" && mv "$file.tmp.$$" "$file"

   # ✅ Good: Defensive validation
   if [ -n "$result" ] && [[ "$result" =~ ^[0-9]+$ ]]; then
       echo "$result"
   fi

   # ❌ Bad: No timeout (can hang)
   result=$(ccusage blocks --json)

   # ❌ Bad: Direct append (not atomic)
   echo "$content" >> "$file"

   # ❌ Bad: No validation
   echo "$result" | jq '.'
   ```

4. **Error handling**
   - Always suppress stderr: `command 2>/dev/null`
   - Never rely on exit codes alone: validate output
   - Provide fallback values, never crash

5. **Comments**
   - Comment the "why," not the "what"
   ```bash
   # ✅ Why: Detect if active block ended to force refresh
   if [ $age_seconds -gt 300 ]; then

   # ❌ What: Check if age > 300
   if [ $age_seconds -gt 300 ]; then
   ```

6. **Functions**
   ```bash
   # Standard function template
   function_name() {
       local arg1="$1"
       local arg2="$2"
       local result=""

       # Implementation
       result=$(do_something "$arg1")

       # Validation
       if [ -z "$result" ]; then
           return 1
       fi

       echo "$result"
       return 0
   }
   ```

#### Testing

**Run the test suite:**
```bash
./examples/test.sh
```

**Add tests for your changes:**
1. Modify `examples/test.sh`
2. Add test case with clear description
3. Include success and failure paths
4. Test with: `bash examples/test.sh`

**Manual testing:**
```bash
# Test with sample input
cat examples/sample-input.json | ./scripts/statusline.sh

# Test with --debug flag
./scripts/statusline.sh --debug < examples/sample-input.json
tail -20 ~/.claude/statusline.log
```

**Safety verification:**
```bash
# Verify no background processes
./scripts/statusline.sh < examples/sample-input.json &
sleep 1
ps aux | grep -E "statusline|ccusage|jq" | grep -v grep
# Expected: Should be empty or just current process
```

#### Commit Messages

Format: `<type>: <description>`

Types:
- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `refactor:` - Code refactoring (no behavior change)
- `test:` - Test additions/changes
- `perf:` - Performance improvement

Examples:
```
feat: Add custom emoji configuration option

fix: Handle jq timeout on large session files

docs: Update TROUBLESHOOTING.md with new issue

refactor: Consolidate cache validation logic

test: Add edge case tests for epoch conversion
```

#### Pull Request Process

1. **Fork and create a feature branch**
   ```bash
   git checkout -b feat/your-feature
   ```

2. **Make your changes**
   - Follow code standards above
   - Test thoroughly
   - Update docs if behavior changed

3. **Verify everything**
   ```bash
   bash -n scripts/statusline.sh     # Syntax check
   ./examples/test.sh                 # Run tests
   ./scripts/statusline.sh --debug    # Manual test
   ```

4. **Create PR with description**
   - Explain what the change does
   - Why it's needed
   - How to test it
   - Any breaking changes

5. **Address review feedback**
   - Respond to all comments
   - Push updates as new commits
   - Re-request review when done

### Improvement Ideas

**High-Value Contributions:**
- [x] Bug fixes from issues
- [x] Documentation improvements
- [x] Test coverage expansion
- [x] Performance optimizations
- [x] New troubleshooting guides
- [x] Example scripts for advanced use cases

**Lower Priority:**
- Custom emoji sets (scope creep)
- Alternative display formats (diverges from standard)
- External integrations (adds maintenance burden)
- Configuration files (increases complexity)

## Project Standards

### Process Safety (Non-Negotiable)

All changes must:
- ✅ Have explicit timeouts on external commands
- ✅ Use atomic file writes (temp → move)
- ✅ Suppress all stderr output
- ✅ Validate all inputs
- ✅ Never spawn background processes
- ✅ Return gracefully on errors

**Verification:**
```bash
# These checks must pass
bash -n scripts/statusline.sh
grep -n "&" scripts/statusline.sh | grep -v "# background"  # Should be 0 results
grep -n "timeout " scripts/statusline.sh | wc -l            # Should be 3+
```

### Documentation Standards

- All `.md` files must use frontmatter with metadata
- Code examples must be bash (user is non-technical)
- Complex logic needs brief explanation
- Keep documentation <2000 lines per file (break into sections)

### Testing Standards

- Tests must verify real behavior, not mocks
- Each test should be independent
- Tests should cover both success and failure paths
- Performance tests should be realistic

## Release Process

Only maintainers publish releases. For version bumps:

1. Update version in CHANGELOG.md
2. Update version in `scripts/statusline.sh` (line 3 comment)
3. Update version in README.md
4. Tag release: `git tag -a v1.0.1 -m "Release notes"`
5. Push: `git push origin main --tags`

## Questions?

- Check docs/ for comprehensive guides
- Enable `--debug` mode for diagnostics
- Open an issue with the `question` label

## License

By contributing, you agree your code will be licensed under the same MIT license as the project.

---

**Last Updated:** 2026-01-15
**Version:** 1.0.0
