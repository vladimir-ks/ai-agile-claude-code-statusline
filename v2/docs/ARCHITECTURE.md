# Statusline v2 - Architecture

## Critical Problems Solved

**v1 Issues:**
- Session data bleeding (context from chat A shows in chat B)
- Race conditions (15-20 parallel sessions writing same cache files)
- Monolithic bash script (mixing data fetch, validation, rendering)
- Resource waste (each session runs expensive ccusage/git independently)
- Unstable display (disappears/reappears randomly)

**v2 Solutions:**
- Session-isolated data (zero cross-contamination)
- Lock-free architecture (concurrent reads, atomic writes)
- Modular separation (one module = one data source)
- Shared data broker (1 ccusage fetch serves all sessions)
- Reliable rendering (retry logic, fallback states)

---

## Technology Choice: Node.js/TypeScript

**Why NOT Bash:**
- No native JSON parsing (jq subprocess overhead)
- No async I/O (blocking on slow operations)
- No type safety (silent data corruption)
- Weak process isolation (shared global state)

**Why Node.js/TypeScript:**
- Native JSON parsing (zero subprocess overhead)
- Async/await (non-blocking I/O for ccusage/git)
- Type safety (compile-time guarantees)
- Process isolation via worker threads (zero shared state)
- Native to Claude Code ecosystem (same runtime)

**Performance Target:**
- Cold start: <50ms (vs v1's 20 seconds)
- Hot path: <5ms (vs v1's 10-15ms)
- Memory: <10MB per session (vs v1's ~5MB)
- CPU: <1% when idle, <5% when updating

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    STATUSLINE v2 SYSTEM                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Session A    │  │ Session B    │  │ Session C    │      │
│  │ (chat 123)   │  │ (chat 456)   │  │ (chat 789)   │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                  │                  │               │
│         └──────────────────┼──────────────────┘               │
│                            │                                  │
│                    ┌───────▼────────┐                        │
│                    │  DATA BROKER   │◄─── Singleton          │
│                    │  (Shared Bus)  │                        │
│                    └───────┬────────┘                        │
│                            │                                  │
│         ┌──────────────────┼──────────────────┐              │
│         │                  │                  │              │
│    ┌────▼─────┐      ┌────▼─────┐      ┌────▼─────┐        │
│    │ Context  │      │ Git      │      │ ccusage  │        │
│    │ Module   │      │ Module   │      │ Module   │        │
│    └──────────┘      └──────────┘      └──────────┘        │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

**Key Principles:**
1. **Session Isolation**: Each session has unique ID, zero shared state
2. **Data Broker**: Single shared cache, session-tagged entries
3. **Module Independence**: Each module = one data source, zero dependencies
4. **Retry Logic**: Failed fetches don't crash, use stale data + staleness flag
5. **Async Everything**: Zero blocking operations

---

## Module Design

### Module Contract (Interface)

```typescript
interface DataModule<T> {
  // Unique module identifier
  readonly moduleId: string;

  // Fetch data for specific session
  fetch(sessionId: string, options?: FetchOptions): Promise<T>;

  // Validate fetched data
  validate(data: T): ValidationResult;

  // Format data for display
  format(data: T): string;

  // Configuration
  config: ModuleConfig;
}

interface ModuleConfig {
  // How often to refresh (ms)
  refreshInterval: number;

  // Cache TTL (ms)
  cacheTTL: number;

  // Staleness threshold (ms) - show 🔴 if older
  stalenessThreshold: number;

  // Retry policy
  maxRetries: number;
  retryBackoff: number;

  // Resource limits
  timeout: number;
  maxConcurrent: number;
}
```

### Module Inventory

| Module | Data Source | Refresh Interval | Cache TTL | Notes |
|--------|-------------|------------------|-----------|-------|
| **ContextModule** | JSON stdin | 0ms (real-time) | N/A | No cache, session-specific |
| **GitModule** | `git status` | 10s | 30s | Shared cache by repo path |
| **CostModule** | `ccusage blocks` | 3min | 15min | Shared cache, expensive |
| **WeeklyModule** | `ccusage weekly` | 5min | 1hour | Shared cache, very expensive |
| **ModelModule** | Transcript | 0ms | 1hour | Session-specific, TTL validation |
| **TimeModule** | `Date.now()` | 1s | N/A | No cache, cheap |
| **ProjectModule** | JSON stdin | 0ms | N/A | No cache, session-specific |

**Resource Optimization:**
- **High-cost modules** (ccusage): Shared cache, long TTL, low refresh rate
- **Medium-cost modules** (git): Shared cache by path, medium TTL
- **Zero-cost modules** (JSON stdin): No cache, real-time reads
- **Cheap modules** (time): High refresh, no cache needed

---

## Data Broker Design

### Responsibilities

1. **Session Registry**: Track all active sessions
2. **Cache Management**: Store module outputs with session tags
3. **Fetch Coordination**: Prevent duplicate fetches (e.g., 15 sessions all calling ccusage)
4. **Staleness Tracking**: Timestamp all data, flag stale entries
5. **Eviction**: Remove inactive session data

### Cache Schema

```typescript
interface CacheEntry<T> {
  moduleId: string;
  sessionId: string | null;  // null = shared across sessions
  data: T;
  fetchedAt: number;         // Unix timestamp (ms)
  validUntil: number;        // fetchedAt + cacheTTL
  fetchCount: number;        // Metrics
  lastAccessedAt: number;    // For LRU eviction
}

interface BrokerState {
  // Indexed by: `${moduleId}:${sessionId || 'shared'}`
  cache: Map<string, CacheEntry<any>>;

  // Active fetch promises (deduplication)
  inFlight: Map<string, Promise<any>>;

  // Session metadata
  sessions: Map<string, SessionMeta>;
}

interface SessionMeta {
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  configDir: string;        // ~/.claude or custom
  transcriptPath: string;
}
```

### Fetch Deduplication

**Problem:** 15 parallel sessions all call `ccusage blocks` at once → 15 redundant 20-second fetches

**Solution:** First caller triggers fetch, others await same promise

```typescript
async fetchWithDedup<T>(
  key: string,
  fetchFn: () => Promise<T>
): Promise<T> {
  // Check if fetch already in progress
  if (this.inFlight.has(key)) {
    return this.inFlight.get(key)!;
  }

  // Start fetch
  const promise = fetchFn().finally(() => {
    this.inFlight.delete(key);
  });

  this.inFlight.set(key, promise);
  return promise;
}
```

**Result:** 15 sessions, 1 ccusage fetch, <50ms response for 14 waiting sessions

---

## Rendering Pipeline

### Renderer Contract

```typescript
interface Renderer {
  // Build complete statusline from module outputs
  render(sessionId: string, moduleData: Map<string, any>): string;

  // Handle missing/stale data gracefully
  renderWithFallbacks(
    sessionId: string,
    moduleData: Map<string, any>,
    staleness: Map<string, number>
  ): string;
}
```

### Rendering Strategy

1. **Collect Module Outputs**: Async parallel fetch all modules
2. **Validate Each**: Run module validators, flag invalid data
3. **Check Staleness**: Compare `fetchedAt` to threshold, add 🔴 if stale
4. **Format**: Apply color codes, spacing, separators
5. **Deduplicate**: Hash output, skip print if identical to last
6. **Print**: Atomic write to stdout

**Fallback Hierarchy (if module fails):**
1. Use cached data (even if stale) + show 🔴
2. Use default placeholder (e.g., "Context: calculating...")
3. Omit section entirely (graceful degradation)

---

## Validation Layer

### Validation Rules

Each module implements validators:

```typescript
interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitized?: any;  // Cleaned/coerced data
}

// Example: ContextModule validator
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

  return {
    valid: errors.length === 0,
    errors,
    warnings: [],
    sanitized: this.sanitize(data)
  };
}
```

**Cross-Module Validation:**
- Model from transcript must match model from JSON (warn if mismatch)
- Cost burn rate vs tokens/min (flag if ratio is anomalous)
- Session timestamps (flag if time goes backwards)

---

## Configuration System

### Config File: `v2/config/statusline.config.json`

```json
{
  "modules": {
    "context": {
      "enabled": true,
      "refreshInterval": 0,
      "cacheTTL": 0,
      "stalenessThreshold": 60000,
      "timeout": 100,
      "maxRetries": 0
    },
    "git": {
      "enabled": true,
      "refreshInterval": 10000,
      "cacheTTL": 30000,
      "stalenessThreshold": 120000,
      "timeout": 5000,
      "maxRetries": 2
    },
    "cost": {
      "enabled": true,
      "refreshInterval": 180000,
      "cacheTTL": 900000,
      "stalenessThreshold": 3600000,
      "timeout": 35000,
      "maxRetries": 1
    }
  },
  "renderer": {
    "colorEnabled": true,
    "deduplication": true,
    "rateLimitMs": 100
  },
  "broker": {
    "maxCacheSize": 1000,
    "evictionPolicy": "LRU",
    "sessionTimeoutMs": 3600000
  },
  "performance": {
    "maxConcurrentFetches": 5,
    "fetchPoolSize": 3
  }
}
```

**Per-User Overrides:**
- Environment variables: `STATUSLINE_MODULE_COST_REFRESH=300000`
- User config: `~/.claude/statusline.user.json`
- CLI flags: `--refresh-cost=5m`

---

## Session Isolation Guarantees

### Problem: Data Bleeding

**v1 Scenario:**
1. Chat A uses Haiku, context 80k/200k
2. Chat B uses Sonnet, context 50k/200k
3. Chat A's statusline shows Sonnet (wrong!)
4. Chat A's statusline shows 50k used (wrong!)

**Root Cause:** Shared cache files without session tagging

### v2 Solution: Session-Tagged Entries

```typescript
// Cache key includes session ID for session-specific data
const contextKey = `context:${sessionId}`;
const modelKey = `model:${sessionId}`;

// Shared data uses 'shared' tag (e.g., ccusage is same for all sessions)
const costKey = `cost:shared`;

// Git data is shared by repo path
const gitKey = `git:${repoPath}`;
```

**Read Flow:**
```typescript
async getContextData(sessionId: string): Promise<ContextData> {
  const key = `context:${sessionId}`;
  const cached = broker.cache.get(key);

  if (cached && !isStale(cached)) {
    return cached.data;
  }

  // Fetch fresh data with session isolation
  const data = await fetchContextForSession(sessionId);
  broker.cache.set(key, {
    moduleId: 'context',
    sessionId,  // ← Explicit session tag
    data,
    fetchedAt: Date.now(),
    validUntil: Date.now() + config.cacheTTL
  });

  return data;
}
```

**Guarantee:** Session A can NEVER read session B's data (different cache keys)

---

## Performance Optimizations

### 1. Lazy Module Loading

Only load modules that are enabled:

```typescript
const modules = new Map<string, DataModule<any>>();

for (const [name, config] of Object.entries(moduleConfigs)) {
  if (config.enabled) {
    modules.set(name, await import(`./modules/${name}-module.js`));
  }
}
```

### 2. Parallel Fetch with Timeout

Fetch all modules in parallel, hard timeout if any hang:

```typescript
const fetchPromises = Array.from(modules.entries()).map(
  ([name, module]) =>
    Promise.race([
      module.fetch(sessionId),
      timeout(module.config.timeout)
    ]).catch(err => {
      // Don't let one module failure crash entire statusline
      logger.warn(`Module ${name} failed:`, err);
      return module.getDefaultValue();
    })
);

const results = await Promise.allSettled(fetchPromises);
```

### 3. Incremental Rendering

Only re-render sections that changed:

```typescript
interface RenderState {
  lastHash: string;
  lastSections: Map<string, string>;
}

render(sessionId: string, moduleData: Map<string, any>): string {
  const state = this.states.get(sessionId);
  const sections = new Map<string, string>();

  // Render each section independently
  for (const [moduleName, data] of moduleData) {
    const rendered = modules.get(moduleName)!.format(data);

    // Only update if changed
    if (rendered !== state?.lastSections.get(moduleName)) {
      sections.set(moduleName, rendered);
    } else {
      sections.set(moduleName, state.lastSections.get(moduleName)!);
    }
  }

  // Concatenate
  const output = Array.from(sections.values()).join(' ');

  // Deduplicate
  const hash = hashOutput(output);
  if (hash === state?.lastHash) {
    return '';  // Skip printing
  }

  this.states.set(sessionId, { lastHash: hash, lastSections: sections });
  return output;
}
```

### 4. Worker Thread Pool (Optional)

For truly expensive operations (ccusage), offload to worker threads:

```typescript
import { Worker } from 'worker_threads';

const workerPool = new WorkerPool(3);  // 3 workers

async fetchCostData(): Promise<CostData> {
  return workerPool.exec({
    script: './workers/ccusage-worker.js',
    data: { command: 'blocks --json' }
  });
}
```

**Result:** Main thread never blocks, statusline stays responsive

---

## Error Handling Strategy

### Levels

1. **Module Failure**: Module fetch fails → use cached data + show 🔴
2. **Validation Failure**: Data invalid → sanitize + warn, or use default
3. **Broker Failure**: Broker crash → restart, reload cache from disk
4. **Renderer Failure**: Can't render → print error statusline, log to sentry

### Graceful Degradation

```typescript
try {
  const data = await module.fetch(sessionId);
  const validation = module.validate(data);

  if (!validation.valid) {
    logger.warn('Validation failed:', validation.errors);
    // Use sanitized version or cached fallback
    return validation.sanitized || getCachedFallback(moduleId, sessionId);
  }

  return data;
} catch (err) {
  logger.error('Module fetch failed:', err);

  // Fallback hierarchy
  const cached = getCached(moduleId, sessionId);
  if (cached) {
    markStale(cached);
    return cached.data;
  }

  return module.getDefaultValue();
}
```

### Sentry Integration

```typescript
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: 'production',
  tracesSampleRate: 0.1  // 10% of transactions
});

// Track performance
const transaction = Sentry.startTransaction({
  op: 'statusline.render',
  name: 'Render Statusline'
});

try {
  const output = await renderer.render(sessionId, moduleData);
  transaction.finish();
} catch (err) {
  Sentry.captureException(err, {
    tags: { sessionId, modulesFailed: getFailedModules() }
  });
  transaction.finish();
}
```

---

## Migration Path

### Phase 1: Parallel Operation

- v1 continues as default
- v2 available via `STATUSLINE_VERSION=2` env var
- Both read same config directory

### Phase 2: Testing Period

- Select users opt into v2
- Monitor error rates, performance metrics
- Fix any v2-specific bugs

### Phase 3: Full Migration

- v2 becomes default
- v1 available via `STATUSLINE_VERSION=1` (fallback)
- Deprecation notice for v1

### Phase 4: v1 Removal

- After 2-3 months of stability
- Remove `scripts/statusline.sh`
- v2 becomes only version

---

## Success Metrics

| Metric | v1 (Current) | v2 (Target) | Measurement |
|--------|--------------|-------------|-------------|
| Cold start | 17-20s | <50ms | First invocation |
| Hot path | 10-15ms | <5ms | Cached data |
| Memory per session | ~5MB | <10MB | RSS |
| CPU (idle) | <1% | <0.1% | No updates |
| CPU (active) | 5-10% | <5% | During render |
| Session isolation | ❌ (fails) | ✅ (guaranteed) | Cross-contamination tests |
| Stability (uptime) | 95% | 99.9% | Doesn't disappear |
| Resource sharing | ❌ (duplicate fetches) | ✅ (shared broker) | ccusage call count |

**KPI: Zero session data bleeding incidents in production**

---

## Next Steps

1. Implement skeleton modules (pseudocode → TypeScript)
2. Build data broker with session isolation
3. Create renderer with fallback logic
4. Write unit tests for each module
5. Integration tests for broker + modules
6. E2E tests with 15 parallel sessions
7. Performance benchmarking
8. Documentation + examples
9. Migration guide
