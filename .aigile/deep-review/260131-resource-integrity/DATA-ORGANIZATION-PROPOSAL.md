# Data Organization - Current State & Proposal

**Context**: You want the session data storage to be clear, organized, and functional - not to implement auth swapping (that's separate).

---

## Current Data Storage (What Exists Now)

### Files in `~/.claude/session-health/`

```
~/.claude/session-health/
├── {session-id}.json          # Per-session health (one per Claude window)
├── billing-shared.json         # Shared billing cache (ALL sessions)
├── sessions.json               # Global summary (all active sessions)
├── config.json                 # User configuration
├── daemon.log                  # Background task log
└── cooldowns/                  # Cooldown timestamps
    ├── git-status.cooldown
    ├── billing.cooldown
    ├── cleanup.cooldown
    ├── {session-id}-secrets-scan.cooldown
    ├── {session-id}-transcript.state
    └── {session-id}-gitleaks.state
```

### Problem: Billing Data is "Shared" But Should Be Per-Auth

Currently ONE `billing-shared.json` serves ALL sessions. This assumes:
- All sessions use the same authentication
- All sessions share the same billing limits

This is incorrect if you run multiple Claude accounts (claude1, claude2, claude3).

---

## Proposed Improved Organization

### Two-Level Structure

```yaml
# ~/.claude/session-health/runtime-state.yaml

# Part 1: Authentication profiles (shared data)
authProfiles:
  - profileId: "default"           # Auto-detected or user-defined
    label: "Primary Account"
    billing:                        # Profile-specific billing
      costToday: 90.05
      burnRatePerHour: 29.59
      budgetRemaining: 116
      budgetPercentUsed: 61
      resetTime: "02:00"
      totalTokens: 85000000
      tokensPerMinute: 12500
      isFresh: true
      lastFetched: 1769817805217
    metadata:
      detectionMethod: "auto"      # or "manual" if user-defined
      firstSeen: 1769800000000
      lastUsed: 1769818372317
      totalSessions: 42

  # Additional profiles if multiple authentications detected
  - profileId: "alt-account"
    label: "Secondary Account"
    billing:
      costToday: 15.23
      # ... same structure

# Part 2: Active sessions (session-specific data)
sessions:
  - sessionId: "fa47fa81-c6d7-4908-adb6-5e24e75b61b6"
    authProfile: "default"         # Which auth this session uses
    projectPath: "/Users/vmks/project"
    transcriptPath: "/Users/vmks/.claude/projects/.../session.jsonl"

    # Session health (from existing health files)
    health:
      status: "warning"
      lastUpdate: 1769818965252
      issues: ["Context 75% full"]

    model:
      value: "Opus4.5"
      source: "jsonInput"
      confidence: 80

    context:
      tokensUsed: 45000
      tokensLeft: 111000
      percentUsed: 28
      windowSize: 200000
      nearCompaction: false

    git:
      branch: "main"
      ahead: 2
      behind: 0
      dirty: 3
      lastChecked: 1769818938325

    transcript:
      exists: true
      sizeBytes: 524288
      lastModified: 1769818900000
      lastModifiedAgo: "1m"
      messageCount: 42
      lastMessagePreview: "What does the main function do?"
      isSynced: true

    alerts:
      secretsDetected: false
      transcriptStale: false
      dataLossRisk: false

    metadata:
      gatheredAt: 1769818965252
      lastActivity: 1769818372317

# Global metadata
metadata:
  version: "1.0"
  lastUpdated: 1769818372605
  totalAuthProfiles: 2
  totalActiveSessions: 2
```

### Why This Structure?

1. **Clear separation**: Auth data vs session data
2. **No duplication**: Billing stored once per auth profile, not per session
3. **Easy queries**:
   - "Which sessions are using auth profile X?"
   - "What's the billing for auth profile Y?"
   - "How many sessions are active right now?"
4. **Scalable**: Add new auth profiles without changing structure
5. **Backward compatible**: Can migrate from existing files

---

## Migration from Current Structure

### Step 1: Create Unified File (Non-Breaking)

```typescript
// In data-gatherer.ts, AFTER writing individual health file:

// Read existing billing-shared.json
const sharedBilling = readBillingShared();

// Create or update runtime-state.yaml
const runtimeState = readRuntimeState() || createDefault();

// Ensure default auth profile exists
if (!runtimeState.authProfiles.find(p => p.profileId === 'default')) {
  runtimeState.authProfiles.push({
    profileId: 'default',
    label: 'Primary Account',
    billing: sharedBilling,
    metadata: {
      detectionMethod: 'auto',
      firstSeen: Date.now(),
      lastUsed: Date.now(),
      totalSessions: 0
    }
  });
}

// Update session entry
const sessionIndex = runtimeState.sessions.findIndex(s => s.sessionId === sessionId);
if (sessionIndex >= 0) {
  runtimeState.sessions[sessionIndex] = buildSessionEntry(health);
} else {
  runtimeState.sessions.push(buildSessionEntry(health));
}

// Write atomically
writeRuntimeState(runtimeState);
```

### Step 2: Keep Backward Compatibility

```typescript
// KEEP existing files:
// - {session-id}.json (display-only.ts reads this)
// - billing-shared.json (ccusage module reads this)
// - sessions.json (tools may depend on it)

// ADD new file:
// - runtime-state.yaml (comprehensive view)

// Both coexist - no breaking changes
```

### Step 3: Gradual Migration

**Phase A** (Immediate - No Risk):
- Create `runtime-state.yaml` alongside existing files
- Populate with data from existing files
- Display layer STILL reads old files (no changes)

**Phase B** (Later - When Stable):
- Update display layer to read `runtime-state.yaml`
- Deprecate individual files (but keep for 1-2 versions)

**Phase C** (Future - Optional):
- Remove old file structure
- Use only `runtime-state.yaml`

---

## Key Design Decisions

### Why YAML over JSON?

**PRO YAML**:
- Human-editable (users can manually define auth profiles)
- Comments supported (document what each profile is)
- Multi-line strings for metadata
- Cleaner syntax for nested data

**PRO JSON**:
- Faster parsing (marginal - ~1ms difference)
- No external dependencies (YAML needs yaml library)
- Existing tooling expects JSON

**Recommendation**: Start with JSON, allow YAML as option
- Default: `runtime-state.json`
- If `runtime-state.yaml` exists, use that instead
- Best of both worlds

### Auth Profile Detection

**Strategy**: Fingerprint billing data to auto-detect profiles

```typescript
function detectAuthProfile(billing: BillingInfo): string {
  // Create fingerprint from billing characteristics
  const fingerprint = hashBillingPattern(billing);

  // Try to match existing profile
  const existing = authProfiles.find(p => p.billingFingerprint === fingerprint);

  if (existing) {
    return existing.profileId;
  }

  // Create new profile
  const newProfile = {
    profileId: `auto_${Date.now()}`,
    label: `Auto-detected Account ${authProfiles.length + 1}`,
    billingFingerprint: fingerprint,
    billing: billing,
    metadata: {
      detectionMethod: 'auto',
      firstSeen: Date.now()
    }
  };

  authProfiles.push(newProfile);
  return newProfile.profileId;
}
```

**Billing Fingerprint** (deterministic hash):
- Reset time (e.g., "02:00" UTC)
- Daily budget limit (if available)
- Token usage patterns
- Cost-per-hour baseline

Different accounts → different fingerprints

### Linking Sessions to Auth

```typescript
// In data-gatherer.ts, when fetching billing:

const billingData = await this.ccusageModule.fetch(sessionId);

if (billingData?.isFresh) {
  // Detect which auth profile this belongs to
  const profileId = detectAuthProfile(billingData);

  // Update session → profile mapping
  sessionAuthLink[sessionId] = profileId;

  // Store billing in profile (not globally)
  updateAuthProfileBilling(profileId, billingData);
}
```

---

## Display Layer Impact

### Current Display (No Changes Needed)

```typescript
// display-only.ts reads {session-id}.json
const health = safeReadJson<SessionHealth>(healthPath);

// Works as-is - no migration needed
```

### Enhanced Display (Optional Future)

```typescript
// display-only.ts reads runtime-state.json/yaml
const runtimeState = safeReadRuntimeState();

// Find session
const session = runtimeState.sessions.find(s => s.sessionId === sessionId);

// Get auth profile
const profile = runtimeState.authProfiles.find(p => p.profileId === session?.authProfile);

// Display auth indicator (OPTIONAL - only if enabled)
if (cfg.showAuthProfile && profile) {
  parts.push(`👤:${profile.profileId}`);
}

// Display billing from profile (not shared global)
if (profile?.billing) {
  parts.push(fmtCost(profile.billing));
}
```

---

## Implementation Checklist

### Phase 1: Data Organization (This is YOUR requirement)

- [ ] Create `runtime-state.json` schema (TypeScript types)
- [ ] Implement read/write functions (atomic writes like health-store)
- [ ] In data-gatherer, populate runtime-state after health write
- [ ] Migrate existing data on first run (billing-shared → default profile)
- [ ] Keep existing files unchanged (backward compatibility)
- [ ] Test with 3+ concurrent sessions

### Phase 2: Auth Detection (OPTIONAL - for future auth swapping)

- [ ] Implement billing fingerprint algorithm
- [ ] Auto-detect auth profiles from billing patterns
- [ ] Track session → auth profile mapping
- [ ] Per-profile billing caches instead of shared global
- [ ] Log when sessions switch between profiles

### Phase 3: Display Integration (OPTIONAL)

- [ ] Update display-only.ts to read runtime-state
- [ ] Add auth profile indicator (if user enables it)
- [ ] Show billing from correct profile (not global shared)
- [ ] Deprecate old file reads

---

## File Structure After Implementation

```
~/.claude/session-health/
├── runtime-state.json         # NEW: Unified state (auth + sessions)
│   ├── authProfiles[]
│   └── sessions[]
│
├── {session-id}.json          # KEEP: Individual health (backward compat)
├── billing-shared.json         # KEEP: Global billing cache (for now)
├── sessions.json               # KEEP: Global summary (for now)
├── config.json                 # KEEP: User configuration
├── daemon.log                  # KEEP: Logging
│
└── cooldowns/                  # KEEP: Cooldown tracking
    └── ...

# Future (Phase 3):
# - runtime-state.json becomes primary source
# - Old files deprecated (but kept for 1-2 versions)
```

---

## Summary

**Your Goal**: Organize data storage to be clear, correct, and functional

**Solution**:
1. Create `runtime-state.json` with two-part structure (auth profiles + sessions)
2. Populate from existing data (non-breaking)
3. Keep existing files for backward compatibility
4. Gradually migrate display layer to new structure

**NOT in scope** (separate task):
- Auth swapping mechanism
- Keychain integration
- Shell alias detection
- Mid-session auth changes

**Result**:
- Clear data organization ✅
- Easy to query "which sessions use which auth" ✅
- Scalable for multiple authentications ✅
- Backward compatible ✅
- Foundation for future auth swapping (but not implementing it now)
