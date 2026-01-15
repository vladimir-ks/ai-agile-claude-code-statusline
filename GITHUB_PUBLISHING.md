---
metadata:
  status: approved
  title: "GitHub Publishing Guide"
  version: "1.0.1"
---

# Publishing to GitHub

This guide walks you through publishing the statusline to a public GitHub repository.

## Prerequisites

- GitHub account (https://github.com/signup)
- Git installed locally
- SSH key configured (or use HTTPS)

## Step 1: Create GitHub Repository

1. **Go to github.com** and log in
2. **Click "+" → "New repository"**
3. **Repository name:** `ai-agile-claude-code-statusline`
4. **Description:** "Real-time cost tracking and session monitoring statusline for Claude Code"
5. **Visibility:** Public
6. **Initialize:** Don't initialize (we already have git)
7. **Create repository**

## Step 2: Add Remote & Push

```bash
cd ~/_dev_tools/ai-agile-claude-code-statusline

# Add GitHub as remote
git remote add origin https://github.com/YOUR_USERNAME/ai-agile-claude-code-statusline.git

# Rename branch to main (optional but recommended)
git branch -m master main

# Push to GitHub
git push -u origin main

# Verify
git remote -v
```

## Step 3: Create Initial Release

```bash
# Create a tag for v1.0.1
git tag -a v1.0.1 -m "Release v1.0.1 - Production-ready statusline"
git push origin v1.0.1
```

## Step 4: Configure GitHub Repository

### A. Add Topics
Go to repository settings → About section
Add topics:
- `claude-code`
- `statusline`
- `cost-tracking`
- `bash`
- `open-source`

### B. Enable Discussions
Settings → Features → Enable Discussions
Categories:
- **Announcements** - Release notes, updates
- **Help** - Getting help, troubleshooting
- **Ideas** - Feature requests, brainstorming

### C. Configure Branch Protection
Settings → Branches → Add rule for `main`
- Require status checks (if CI configured)
- Require code review (1 approval)
- Dismiss stale PR approvals

### D. Add GitHub Pages (Optional)
Settings → Pages
- Source: Deploy from a branch
- Branch: main, /root
- Generate site from README.md

## Step 5: Update Repository Files

### Update README
In README.md, replace:
```bash
git clone https://github.com/yourusername/ai-agile-claude-code-statusline.git
```
With your actual username:
```bash
git clone https://github.com/YOUR_USERNAME/ai-agile-claude-code-statusline.git
```

### Update DEPLOYMENT.md
Replace repository URLs:
```bash
sed -i 's|yourusername|YOUR_USERNAME|g' DEPLOYMENT.md
```

### Commit these updates
```bash
git add README.md DEPLOYMENT.md
git commit -m "docs: Update GitHub URLs with actual repository link"
git push origin main
```

## Step 6: Announce the Release

Use the messages in DEPLOYMENT.md to announce on:
- **Hacker News** (Ask HN section)
- **Reddit** (r/OpenAI, r/ClaudeAI)
- **Bluesky/Twitter** (via Claude AI communities)
- **Dev.to** (technical community)

## Step 7: Monitor Repository

### First Week
- Respond to all issues and PRs
- Fix any critical bugs reported
- Gather user feedback

### Ongoing
- Monitor GitHub issues 2x/week
- Merge quality PRs within 1 week
- Publish updates monthly
- Update docs based on user questions

## Troubleshooting

### "fatal: remote origin already exists"
```bash
git remote remove origin
git remote add origin https://github.com/YOUR_USERNAME/ai-agile-claude-code-statusline.git
```

### "Permission denied (publickey)"
You need to configure SSH keys. Use HTTPS instead:
```bash
git remote set-url origin https://github.com/YOUR_USERNAME/ai-agile-claude-code-statusline.git
```

### "branch 'main' set up to track 'origin/main'"
This is normal - your local main branch is tracking the remote.

## Next Steps (After Publishing)

1. **npm Package** - Publish to npm (see DEPLOYMENT.md)
2. **Create Release Notes** - Write detailed v1.0.1 release notes
3. **Enable CI/CD** - Add GitHub Actions for testing
4. **Sponsor Button** - Add GitHub Sponsors if interested in donations

## Commands Quick Reference

```bash
# Check status
cd ~/_dev_tools/ai-agile-claude-code-statusline
git status
git log --oneline

# Make changes
git add .
git commit -m "feat: description"
git push origin main

# Create new release
git tag -a v1.0.2 -m "Release v1.0.2"
git push origin v1.0.2
```

---

**Status:** Ready to publish
**Location:** ~/_dev_tools/ai-agile-claude-code-statusline/
**Last Updated:** 2026-01-15
