---
metadata:
  status: approved
  title: "Deployment & Publishing Guide"
  version: "1.0.1"
  author: "Vladimir K.S."
---

# Deployment & Publishing Guide

This document guides you through publishing the statusline to GitHub, npm, and community channels.

## Pre-Publication Checklist

- [x] License file present (MIT)
- [x] CONTRIBUTING.md written
- [x] README has value proposition and FAQ
- [x] All documentation complete (5 docs, 80+ pages)
- [x] Issue templates created
- [x] package.json configured
- [x] All tests passing (`examples/test.sh`)
- [x] Syntax validation passing (`bash -n scripts/statusline.sh`)
- [x] Version consistent across files (1.0.1)
- [x] CHANGELOG updated

## GitHub Repository Setup

### 1. Create GitHub Repository

```bash
# Create repo on github.com
# Name: ai-agile-claude-code-statusline
# Description: Real-time cost tracking and session monitoring statusline for Claude Code
# License: MIT
# Template: None (custom setup)
# Visibility: Public

# Clone locally
git clone https://github.com/yourusername/ai-agile-claude-code-statusline.git
cd ai-agile-claude-code-statusline

# Copy package contents
cp -r ~/.claude/ai-agile-claude-code-statusline/* .

# Commit initial
git add .
git commit -m "Initial commit: v1.0.1 production-ready statusline"
git push -u origin main
```

### 2. Configure GitHub Settings

**Branch Protection (main):**
- ✅ Require status checks (tests must pass)
- ✅ Require code review (1 approval)
- ✅ Dismiss stale PR approvals

**Issue Templates:**
- Bug reports (automatic)
- Feature requests (automatic)

**Discussions:**
- Enable GitHub Discussions
- Set up categories:
  - Announcements (releases, updates)
  - Help (troubleshooting, how-to)
  - Ideas (feature brainstorming)

**Pages:**
- Source: docs/ directory
- Theme: Choose clean theme (Slate or Minimal)
- Auto-generates site from README

## npm Package Publication

### 1. Update package.json

```bash
# Update repository URL
sed -i 's|github.com/yourusername|github.com/YOUR_USERNAME|g' package.json

# Verify
cat package.json | grep -A2 '"repository"'
```

### 2. Publish to npm

```bash
# Login to npm (one-time)
npm login

# Publish
npm publish

# Verify
npm view ai-agile-claude-code-statusline
```

**npm Page Will Show:**
- Description
- Installation: `npm install -g ai-agile-claude-code-statusline`
- Documentation link
- GitHub repository link
- Keywords and metadata

### 3. Post-Publication Steps

```bash
# Tag release in git
git tag -a v1.0.1 -m "Release v1.0.1 - production-ready"
git push origin v1.0.1

# Create GitHub release
# Go to Releases tab → Create from tag
# Title: v1.0.1 - Real-time Cost Tracking
# Description: [Copy from CHANGELOG.md]
```

## Community Outreach

### Phase 1: Soft Launch (Week 1)

**Target:** Early adopters, feedback gathering

Channels:
1. **Claude Community Forums**
   - Anthropic Discord: #claude-code-showcase
   - Title: "Show & Tell: Real-time statusline for cost tracking"
   - Highlight: Cost tracking demo, process safety guarantees

2. **Hacker News**
   - Post to: Show HN
   - Title: "Show HN: Real-time Claude Code statusline with cost tracking"
   - Description: Problem statement (surprise bills) + solution + metrics

3. **Reddit**
   - r/OpenAI
   - r/ClaudeAI
   - Title: "Built a cost-tracking statusline for Claude Code (free, open source)"

### Phase 2: Expansion (Week 2-4)

**Target:** Broader developer audience

Channels:
1. **GitHub Trending**
   - Automatically listed if gaining stars
   - Focus on quality documentation (helps ranking)

2. **Product Hunt**
   - Apply to launch if eligible
   - Title: "Claude Code Status Line - Real-time cost tracking"
   - Focus on UX and cost control benefits

3. **Technical Blogs**
   - Dev.to
   - Medium
   - Blog post: "Why I Built a Statusline for Claude Code (And How)"

### Phase 3: Long-term (Month 2+)

**Target:** Sustained adoption, community contributions

Actions:
- Monitor GitHub issues for feedback
- Respond promptly to all issues
- Accept quality PRs
- Feature community contributions in CHANGELOG
- Consider npm weekly newsletter (if >100 downloads/week)

## Marketing Messages

### Twitter/X

```
🎉 Just released: Claude Code Status Line
See your session costs in real-time. Prevent surprise bills with live burn rate tracking. No flicker, no lag, 100% safe.

Open source, MIT licensed.
https://github.com/yourusername/ai-agile-claude-code-statusline

#ClaudeCode #OpenSource #AI
```

### Hacker News

```
Show HN: Real-time cost tracking statusline for Claude Code

Problem: Claude Code sessions can silently run expensive operations.
Users don't realize they're spending $50/hour until the bill arrives.

Solution: Statusline displays hourly burn rate, daily cost, and session
time—all in one line. Updates every interaction. Sub-100ms overhead.

Features:
- Real-time cost tracking (every 10 sec)
- Hourly burn rate visible
- Token usage + git status (one line)
- Zero flicker (hash deduplication)
- 100% safe (no background processes)

Open source, MIT licensed. Full documentation. Installation <5 min.

https://github.com/yourusername/ai-agile-claude-code-statusline
```

### Reddit

```
Built a free, open-source statusline for Claude Code that shows your
session costs in real-time.

I got tired of being surprised by bills, so I added a statusline that
displays hourly burn rate, daily spend, and time until session reset.
Updates every interaction, never slows down your workflow.

Key features:
- Real-time cost tracking (updates every 10 seconds)
- Session time remaining + reset time
- Token usage + git status in one compact line
- Zero UI flicker (smart deduplication)
- Process safety verified (no zombie processes)

MIT licensed, fully documented, <5 min installation.

Feedback welcome!
```

## Version Management

### Semantic Versioning

```
MAJOR.MINOR.PATCH

1.0.1
│ │ └─ Bug fixes (UI flicker, edge cases)
│ └─── Features (new components, API changes)
└───── Breaking changes (major redesign)
```

### Release Cadence

- **Security fixes:** Released within 24 hours (PATCH)
- **Bug fixes:** Bundled weekly (PATCH)
- **Features:** Monthly or as needed (MINOR)
- **Breaking changes:** Rare (MAJOR)

### Publishing Process

```bash
# 1. Create release branch
git checkout -b release/v1.0.2

# 2. Update version
# - package.json: "version": "1.0.2"
# - CHANGELOG.md: Add v1.0.2 section
# - README.md: Update version badge

# 3. Commit
git commit -m "chore: bump version to 1.0.2"

# 4. Create PR, merge after approval
git push origin release/v1.0.2
# [Create PR on GitHub, get approval, merge]

# 5. Tag and publish
git tag -a v1.0.2 -m "Release v1.0.2"
git push origin v1.0.2
npm publish  # Auto-publishes from latest tag

# 6. Create GitHub release
# Go to Releases → Create from tag
```

## Success Metrics

**Track these metrics after launch:**

- GitHub stars (target: 50+ in first month)
- npm downloads (target: 100+/month)
- GitHub issues (quality of feedback)
- Community PRs (# and quality)
- Twitter mentions (brand awareness)
- Installation success (setup.sh completion rate)

**After 3 months:**
- If <50 stars: Re-evaluate marketing approach
- If 50-200 stars: Excellent early adoption
- If >200 stars: Strong community traction

## Troubleshooting Publications

### Issue: Low GitHub Stars

**Causes:**
- README not compelling enough
- Discovery problem (not listed on major boards)
- Timing (launched during quiet period)

**Fixes:**
1. Improve README (add screenshots, demo GIF)
2. Cross-post to more communities (Product Hunt, DEV.to)
3. Write technical blog post explaining solution
4. Engage with commenters on Hacker News / Reddit

### Issue: Installation Failures

**Track via:**
- GitHub issues (#failures)
- setup.sh error reports

**Common causes:**
- Bash <4.0 (add version check)
- jq not installed (improve prereq docs)
- ccusage auth issues (add troubleshooting)

### Issue: Community PRs With Low Quality

**Prevention:**
- CONTRIBUTING.md is clear and detailed
- Issue templates guide problem reporting
- Code style enforced in reviews

**Management:**
- Politely request revisions (don't merge broken code)
- Point to CONTRIBUTING.md for standards
- Offer help: "Happy to merge after [specific fix]"

## Long-term Maintenance

**Minimum effort (month 2+):**
- Monitor issues 2x/week
- Merge quality PRs within 1 week
- Publish updates monthly
- Update docs when user feedback suggests confusion

**Growth maintenance (if >500 stars):**
- Consider sponsorship (GitHub Sponsors)
- Create example blog posts
- Feature community projects that use statusline
- Maintain compatibility with new Claude Code versions

**Archive strategy (if inactive):**
- Document maintenance status clearly
- Accept limited PRs
- Point users to forks if needed

---

## Rollout Timeline

```
Week 1:  GitHub repo + README polish
         Soft launch (friends, community forums)
         Gather initial feedback

Week 2:  npm package publication
         Broader outreach (HN, Reddit, Twitter)
         Respond to issues

Week 3:  Evaluate feedback
         Bug fixes if critical issues
         Update docs based on FAQs

Week 4:  Assess adoption metrics
         Plan month 2 features (if viable)
         Continue community engagement
```

---

**Last Updated:** 2026-01-15
**Status:** Ready to Deploy
**Estimated Time to Publish:** 1-2 hours
