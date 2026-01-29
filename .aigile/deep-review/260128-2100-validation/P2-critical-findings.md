---
metadata:
  review: "P2 - UX & Documentation Validation"
  date: "2026-01-28"
  severity: "Critical User Experience Gaps"
---

# P2: Critical Findings Summary

## Three Contradictions That Break User Trust

### 1. Model Detection Priority Conflicted Across Docs

**CLAUDE.md says:**
```
Primary: Transcript `.message.model`
Fallback: JSON `model.display_name`
Never: settings.json
```

**DATA_SOURCES.md says:**
```
Primary: Transcript `.message.model`
Fallback: JSON `model.display_name`
Never: settings.json
```

**DEPLOYMENT_GUIDE.md says:**
```
PRIMARY: JSON Input (real-time)
FALLBACK: Transcript (session-specific, with TTL)
Never: settings.json
```

**User Impact:** When debugging model detection, user gets 2 conflicting answers depending which doc they read.

---

### 2. Installation Instructions Scattered Across 4 Different Locations

| File | Location | Approach | Path Type |
|------|----------|----------|-----------|
| README.md | lines 11-40 | git clone GitHub | Relative `~/_dev_tools/aigile` |
| CLAUDE.md | lines 29-45 | cp from current dir | Relative `scripts/` |
| DEPLOYMENT_GUIDE.md | lines 30-66 | git pull + jq update | Absolute `/Users/vmks/...` |
| DEPLOYMENT.md | lines 40-50 | npm publish focus | Not installation |

**User Path:**
1. Reads README, tries `git clone` → GitHub URL fails
2. Searches docs, finds DEPLOYMENT_GUIDE
3. Discovers ABSOLUTE path required
4. Still unclear which is "correct"

**New User Time Sink:** 20-30 minutes debugging conflicting instructions

---

### 3. Cache Clearing Has 3 Different Recipes

**CLAUDE.md + README.md:**
```bash
rm ~/.claude/.ccusage_cache.json
rm ~/.claude/.data_freshness.json
```

**DEPLOYMENT_GUIDE.md (option 1):**
```bash
rm -f ~/.claude/.last_model_name ~/.claude/.statusline.hash ~/.claude/.git_status_cache
```

**DEPLOYMENT_GUIDE.md (option 2):**
```bash
STATUSLINE_FORCE_REFRESH=1 echo "" | ~/.claude/statusline.sh
```

**User Question:** "Why are there 3 different ways? Which one do I use?"

**Answer:** No guidance. User must infer from context.

---

## Four Major Installation Friction Points

### A. Prerequisites Not Complete

**Current (README.md):**
```
- **bash** 4.0+
- **jq** - `brew install jq`
- **ccusage** - `npm install -g @anthropic-sdk/ccusage`
- **git** (for status tracking)
```

**Missing:**
1. Node.js required for ccusage but not mentioned
2. macOS and Linux commands are different (only brew shown)
3. Version of ccusage not specified
4. What if user is on Windows (WSL)? Not mentioned
5. No verification step before installation

**Result:** User installs dependencies, gets blank statusline, unsure which prerequisite failed

---

### B. Configuration Step Lacks Safety

**Current (CLAUDE.md, lines 35-45):**
```bash
Add to ~/.claude/settings.json:
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/statusline.sh",
    "padding": 0
  }
}
```

**Issues:**
1. No instruction to backup settings.json first
2. No JSON syntax validation
3. User could corrupt file if editing by hand
4. No verification test after modification
5. No restart instruction

**Risk:** User corrupts settings.json, breaks Claude Code

---

### C. Installation Verification is Weak

**Current (README.md):**
```bash
bash -n ~/.claude/statusline.sh
cat ~/_dev_tools/aigile/examples/sample-input.json | ~/.claude/statusline.sh
```

**Problems:**
1. First command only checks syntax
2. Second command has hardcoded path (fails if installed elsewhere)
3. No success criteria stated (what should output look like?)
4. No failure diagnosis (blank output = ?)

**User Experience:** Gets blank output, no guidance on why

---

### D. Configuration Path is Ambiguous

**CLAUDE.md shows:**
```
"command": "~/.claude/statusline.sh"
```

**But DEPLOYMENT_GUIDE shows:**
```
"command": "/Users/vmks/_dev_tools/.../scripts/statusline.sh"
```

**User Question:** "Which path should I use? Are they the same?"

**Answer:** DEPLOYMENT_GUIDE is "correct" (absolute path), but docs don't explain why

---

## Missing: User-Friendly Getting Help Path

**Current State:**
- User sees problem
- Searches README → Generic, no troubleshooting link
- Searches CLAUDE.md → Points to TROUBLESHOOTING.md
- Searches TROUBLESHOOTING.md → 6 issues documented

**Time to Find Help:** 5+ minutes of searching

**Better:** README should have:
```
## Troubleshooting

Having issues? Start here:
- **Statusline is blank?** → [See Issue 1](docs/TROUBLESHOOTING.md#issue-1)
- **Cost data is stale?** → [See Issue 2](docs/TROUBLESHOOTING.md#issue-2)
- **Model won't update?** → [See Debugging Guide](#model-switching)
```

---

## Missing: FAQ for Common Questions

**Users will ask:**

| Question | Where in Docs? | Answer Time |
|----------|---|---|
| Why does it freeze for 20 seconds? | TROUBLESHOOTING Issue 5 | 2 min search |
| How often does cost update? | ARCHITECTURE.md line 118 | 3 min search |
| Is it safe to delete cache files? | TROUBLESHOOTING Issue 2 | 2 min search |
| How do I upgrade it? | NOT DOCUMENTED | 5 min search |
| How do I uninstall it? | NOT DOCUMENTED | 5 min search |
| Which cache should I delete? | 3 different recipes | 5 min search |

**Missing:** FAQ.md with 20 common questions

---

## Documentation Quality Metrics

| Dimension | Score | Evidence |
|-----------|-------|----------|
| **Technical Accuracy** | 8/10 | No errors found, but contradictions |
| **Completeness** | 7/10 | Most topics covered but scattered |
| **Clarity** | 5/10 | Uses advanced terminology without explanation |
| **Searchability** | 4/10 | No index, no FAQ, scattered across 5+ docs |
| **User Friendliness** | 4/10 | Assumes technical knowledge, no decision trees |
| **Maintainability** | 6/10 | Same info repeated in 4 places → update burden |

**Overall: 5.7/10** - Good reference material, poor user experience

---

## Installation Time Estimates

**With Perfect Docs (Ideal):**
- Read prerequisites: 2 min
- Install dependencies: 5 min (brew/apt)
- Copy script: 1 min
- Configure settings.json: 2 min
- Test: 1 min
- **Total: 11 minutes**

**With Current Docs (Reality):**
- Read multiple installation guides: 10 min
- Clarify which path to use: 5 min
- Install dependencies: 5 min
- Configure settings.json: 3 min
- Debug blank statusline: 10 min
- Find troubleshooting guide: 5 min
- **Total: 38 minutes**

**Friction Cost:** 27 minutes (70% wasted on clarification)

---

## Recommendations: Top 3 Priority Fixes

### Fix #1: Create Single INSTALLATION.md

**Consolidate 4 guides into 1:**
```
INSTALLATION.md
├─ Prerequisites (by OS: macOS, Linux, WSL)
├─ Installation (step-by-step)
├─ Verification (before config)
├─ Configuration (safe method with validation)
├─ Testing (in Claude Code)
└─ Troubleshooting (quick links)
```

**Impact:** Eliminates conflicting instructions, saves 15-20 min per user

---

### Fix #2: Reconcile Model Detection Priority

**Choose ONE correct order and update everywhere:**
- CLAUDE.md
- DATA_SOURCES.md
- DEPLOYMENT_GUIDE.md
- QA_TEST_SCENARIOS.md

**Verify with:** Actual implementation in scripts/statusline.sh

**Impact:** Users can trust documentation

---

### Fix #3: Create FAQ.md

**20 common questions:**
1. Why is statusline blank?
2. Why doesn't cost update?
3. Why does it freeze sometimes?
4. How often does data refresh?
5. Is it safe to delete cache files?
... (15 more)

**Impact:** Saves 5+ minutes per user support interaction

---

## Risk Assessment: Current State

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| User installs wrong version | Medium | User confusion | Single INSTALLATION.md |
| User corrupts settings.json | Low-Medium | Breaks Claude Code | Config validation script |
| User trusts wrong docs | Medium | Incorrect mental model | Reconcile contradictions |
| User abandons installation | Medium-High | Lost adoption | FAQ + decision trees |
| User wastes 30 min debugging | High | Negative impression | Clear installation path |

---

## Conclusion

**aigile is technically excellent but UX documentation needs urgent consolidation.**

The project will see **significantly higher adoption and lower support burden** after resolving documentation contradictions and consolidating scattered instructions.

---

**Next Step:** See P2-review.md for detailed analysis with specific fixes for all 15 issues identified.
