# Statusline v2 - Production-Grade Modular Architecture

**Status:** 🚧 Design Phase (Pseudocode Complete)

## Critical Problems Solved

| Problem (v1) | Solution (v2) |
|--------------|---------------|
| Session data bleeding (Chat A shows Chat B's context) | Session-tagged cache keys, zero shared state |
| 15 parallel ccusage calls (300+ seconds wasted) | Fetch deduplication (1 call for all sessions) |
| Monolithic 1300-line bash script | Modular TypeScript (one module = one data source) |
| Race conditions on shared cache files | Lock-free async architecture |
| Unstable display (disappears randomly) | Retry logic + fallback to stale data |
| Resource waste per session | Shared data broker, <10MB per session |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  15 Parallel Claude Code Sessions              │
│  Each gets correct session-specific data       │
└─────────┬───────────────────────────────────────┘
          │
    ┌─────▼──────┐
    │ Data Broker│ ◄─── Singleton (shared by all sessions)
    │ (Caching)  │
    └─────┬──────┘
          │
    ┌─────▼───────────────────────────┐
    │  Modules (Independent Workers)   │
    ├──────────┬──────────┬───────────┤
    │ Context  │   Git    │  Cost     │
    │ (JSON)   │  (exec)  │ (ccusage) │
    └──────────┴──────────┴───────────┘
```

**Key Design Principles:**
1. **Session Isolation**: `context:sessionId` vs `cost:shared`
2. **Fetch Deduplication**: Await in-flight promises
3. **Validation Layer**: Every data point validated before display
4. **Graceful Degradation**: Stale data + 🔴 better than crash

---

## Technology Stack

- **Language:** TypeScript (Node.js runtime)
- **Why NOT Bash:**
  - No native JSON parsing (subprocess overhead)
  - No async I/O (blocking on slow operations)
  - No type safety (silent data corruption)
  - Weak process isolation

- **Why TypeScript:**
  - Native JSON parsing (zero subprocess overhead)
  - Async/await for non-blocking I/O
  - Compile-time type safety
  - Same runtime as Claude Code

---

## Module Inventory

| Module | Data Source | Refresh | Cache TTL | Session-Specific? |
|--------|-------------|---------|-----------|-------------------|
| **Context** | JSON stdin | Real-time | 0ms | ✅ Yes |
| **Git** | `git status` | 10s | 30s | ❌ No (by repo) |
| **Cost** | `ccusage blocks` | 3min | 15min | ❌ No (shared) |
| **Weekly** | `ccusage weekly` | 5min | 1hour | ❌ No (shared) |
| **Model** | Transcript | Real-time | 1hour | ✅ Yes |
| **Time** | `Date.now()` | 1s | 0ms | ❌ No |
| **Project** | JSON stdin | Real-time | 0ms | ✅ Yes |

**Resource Optimization Strategy:**
- **Expensive modules** (ccusage): Long TTL, low refresh, shared cache
- **Cheap modules** (JSON, time): No cache, high refresh
- **Medium modules** (git): Medium TTL, shared by repo path

---

## Session Isolation Guarantees

### Problem (v1)
```
Session A (Chat 123): Sonnet, 80k/200k tokens
Session B (Chat 456): Haiku, 50k/200k tokens

Session A statusline shows: Haiku, 50k/200k ❌ WRONG
```

### Solution (v2)
```typescript
// Session-specific cache keys
const contextKeyA = "context:123";  // Session A
const contextKeyB = "context:456";  // Session B

// Shared cache key (same for all sessions)
const costKey = "cost:shared";

// Session A can ONLY read "context:123", not "context:456"
// Enforced by broker.getData(moduleId, sessionId)
```

**Guarantee:** Cross-session data contamination is **architecturally impossible**

---

## Performance Targets

| Metric | v1 (Bash) | v2 (TypeScript) |
|--------|-----------|-----------------|
| Cold start | 17-20s | <50ms |
| Hot path (cached) | 10-15ms | <5ms |
| Memory per session | ~5MB | <10MB |
| CPU (idle) | <1% | <0.1% |
| CPU (active) | 5-10% | <5% |
| Session isolation | ❌ Fails | ✅ Guaranteed |
| Stability (uptime) | 95% | 99.9% |

---

## Repository Structure

```
v2/
├── README.md                       # This file
├── package.json                    # Dependencies
├── tsconfig.json                   # TypeScript config
│
├── docs/
│   ├── ARCHITECTURE.md             # Complete architecture docs
│   ├── DIAGRAMS.md                 # Mermaid diagrams
│   ├── MIGRATION.md                # v1 → v2 migration guide
│   └── API.md                      # Module API reference
│
├── config/
│   ├── statusline.config.json      # Main configuration
│   └── statusline.config.schema.json  # JSON schema
│
├── src/
│   ├── index.ts                    # Entry point
│   ├── types.ts                    # Shared type definitions
│   │
│   ├── broker/
│   │   └── data-broker.pseudo.ts   # Data broker (cache + coordination)
│   │
│   ├── modules/
│   │   ├── context-module.pseudo.ts   # Context window data
│   │   ├── cost-module.pseudo.ts      # ccusage billing data
│   │   ├── git-module.pseudo.ts       # Git status
│   │   ├── model-module.pseudo.ts     # Model detection
│   │   ├── time-module.pseudo.ts      # Current time
│   │   └── project-module.pseudo.ts   # Project directory
│   │
│   ├── renderer/
│   │   └── statusline-renderer.pseudo.ts  # Format & display
│   │
│   ├── validators/
│   │   └── data-validator.pseudo.ts   # Cross-module validation
│   │
│   └── utils/
│       ├── logger.ts               # Logging utility
│       ├── cache.ts                # Cache utilities
│       └── exec.ts                 # Subprocess utilities
│
├── tests/
│   ├── unit/
│   │   ├── context-module.test.ts
│   │   ├── cost-module.test.ts
│   │   ├── data-broker.test.ts
│   │   └── ...
│   │
│   ├── integration/
│   │   ├── session-isolation.test.ts
│   │   ├── fetch-deduplication.test.ts
│   │   └── cache-eviction.test.ts
│   │
│   └── e2e/
│       ├── parallel-sessions.test.ts  # 15 sessions simultaneously
│       └── stability.test.ts          # Run for 1 hour
│
└── examples/
    ├── basic-usage.ts              # Simple example
    ├── parallel-sessions.ts        # Stress test example
    └── monitoring.ts               # Metrics example
```

---

## Configuration

### Module Configuration

Each module supports:

```json
{
  "enabled": true,
  "refreshInterval": 180000,      // How often to refresh (ms)
  "cacheTTL": 900000,              // How long cache valid (ms)
  "stalenessThreshold": 3600000,   // Show 🔴 if older (ms)
  "timeout": 35000,                // Fetch timeout (ms)
  "maxRetries": 1                  // Retry attempts
}
```

**Tuning Examples:**

```javascript
// Low-resource mode (15-20 parallel sessions)
{
  "cost": { "refreshInterval": 300000 }  // 5 min instead of 3 min
}

// High-accuracy mode (single session)
{
  "git": { "refreshInterval": 5000 }     // 5 sec instead of 10 sec
}

// Debug mode (no caching)
{
  "cost": { "cacheTTL": 0 }              // Always fetch fresh
}
```

### Environment Variable Overrides

```bash
# Override refresh interval for cost module
export STATUSLINE_MODULE_COST_REFRESH=300000

# Disable color output
export STATUSLINE_RENDERER_COLOR=false

# Enable debug logging
export STATUSLINE_LOG_LEVEL=debug
```

---

## Data Validation

Each module implements validators to catch corruption:

**Example: Context Module Validator**

```typescript
validate(data: ContextData): ValidationResult {
  const errors: string[] = [];

  // Rule 1: Context window size must be positive
  if (data.contextWindowSize <= 0) {
    errors.push('Invalid context_window_size: must be > 0');
  }

  // Rule 2: Used tokens can't exceed window
  if (data.currentTokens > data.contextWindowSize) {
    errors.push('Current tokens exceed window size');
  }

  // Rule 3: Session ID format
  if (!/^[a-f0-9-]{36}$/.test(data.sessionId)) {
    errors.push('Invalid session ID format');
  }

  return { valid: errors.length === 0, errors };
}
```

**Cross-Module Validation:**
- Model from transcript vs model from JSON (warn if mismatch)
- Cost/hour vs tokens/min ratio (flag anomalies)
- Timestamps monotonicity (flag time going backwards)

---

## Error Handling Strategy

### Levels

1. **Module Failure** → Use cached data + show 🔴
2. **Validation Failure** → Sanitize data + warn, or use default
3. **Broker Failure** → Restart, reload cache from disk
4. **Renderer Failure** → Print error statusline, log to Sentry

### Graceful Degradation

```typescript
try {
  const data = await module.fetch(sessionId);
  const validation = module.validate(data);

  if (!validation.valid) {
    // Use sanitized version or cached fallback
    return validation.sanitized || getCachedFallback();
  }

  return data;
} catch (err) {
  // Fallback hierarchy:
  // 1. Cached data (even if stale) + 🔴
  // 2. Module default value
  // 3. Omit section entirely
  const cached = getCached();
  if (cached) {
    return { ...cached, stale: true };
  }

  return module.getDefaultValue();
}
```

---

## Migration Path

### Phase 1: Parallel Operation (Week 1-2)
- v1 continues as default
- v2 available via `STATUSLINE_VERSION=2` env var
- Both read same `~/.claude` config directory
- Monitor v2 error rates

### Phase 2: Testing Period (Week 3-4)
- Select users opt into v2
- Fix any v2-specific bugs
- Performance tuning
- Edge case handling

### Phase 3: Full Migration (Week 5-6)
- v2 becomes default
- v1 available via `STATUSLINE_VERSION=1` (fallback)
- Deprecation notice for v1

### Phase 4: v1 Removal (Week 7+)
- After 2-3 months of v2 stability
- Remove `scripts/statusline.sh`
- v2 becomes only version

---

## Success Metrics

**Primary KPI:** Zero session data bleeding incidents in production

**Secondary Metrics:**
- Cache hit rate: >90% (reduces ccusage calls)
- Fetch deduplication: 15 sessions → 1 ccusage call
- Staleness false positives: <1% (accurate freshness tracking)
- Memory per session: <10MB
- Stability uptime: >99.9%

---

## Development Roadmap

### Current Status: 📋 Design Complete

**Completed:**
- [x] Architecture documentation
- [x] Mermaid diagrams
- [x] Module pseudocode (Context, Cost)
- [x] Broker pseudocode
- [x] Configuration system design

**Next Steps:**

1. **Phase 1: Implementation (Week 1-2)**
   - [ ] Convert pseudocode to TypeScript
   - [ ] Implement remaining modules (Git, Model, Time, Project)
   - [ ] Implement renderer
   - [ ] Implement validators

2. **Phase 2: Testing (Week 3)**
   - [ ] Unit tests for each module
   - [ ] Integration tests for broker
   - [ ] E2E tests with 15 parallel sessions
   - [ ] Memory leak tests

3. **Phase 3: Performance (Week 4)**
   - [ ] Benchmark against v1
   - [ ] Optimize hot paths
   - [ ] Profile memory usage
   - [ ] Stress testing

4. **Phase 4: Integration (Week 5)**
   - [ ] Claude Code integration
   - [ ] Migration tooling
   - [ ] Documentation
   - [ ] Release candidate

5. **Phase 5: Production (Week 6+)**
   - [ ] Beta release
   - [ ] Monitoring & metrics
   - [ ] Bug fixes
   - [ ] Stable release

---

## Contributing

See `docs/CONTRIBUTING.md` for development setup and guidelines.

---

## License

Same as parent project (statusline v1)

---

**Questions or Feedback:**
- GitHub Issues: [ai-agile-claude-code-statusline/issues](https://github.com/vladimir-ks/ai-agile-claude-code-statusline/issues)
- Architecture discussions: Create RFC in `docs/rfcs/`
