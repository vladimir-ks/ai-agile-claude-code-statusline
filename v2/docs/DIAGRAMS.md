# Statusline v2 - Architecture Diagrams

## System Overview

```mermaid
graph TB
    subgraph "Multiple Claude Code Sessions"
        S1[Session A<br/>Chat 123]
        S2[Session B<br/>Chat 456]
        S3[Session C<br/>Chat 789]
    end

    subgraph "Statusline v2 Process"
        BROKER[Data Broker<br/>Singleton]

        subgraph "Modules"
            M1[Context Module]
            M2[Git Module]
            M3[Cost Module]
            M4[Model Module]
            M5[Time Module]
        end

        RENDERER[Renderer]
        VALIDATOR[Validator]
    end

    subgraph "External Data Sources"
        JSON[JSON stdin]
        GIT[git status]
        CCUSAGE[ccusage CLI]
        TRANSCRIPT[Transcript file]
    end

    S1 -->|request| BROKER
    S2 -->|request| BROKER
    S3 -->|request| BROKER

    BROKER -->|orchestrate| M1
    BROKER -->|orchestrate| M2
    BROKER -->|orchestrate| M3
    BROKER -->|orchestrate| M4
    BROKER -->|orchestrate| M5

    M1 -->|fetch| JSON
    M2 -->|fetch| GIT
    M3 -->|fetch| CCUSAGE
    M4 -->|fetch| TRANSCRIPT
    M5 -->|internal| M5

    M1 -->|data| VALIDATOR
    M2 -->|data| VALIDATOR
    M3 -->|data| VALIDATOR
    M4 -->|data| VALIDATOR
    M5 -->|data| VALIDATOR

    VALIDATOR -->|validated| BROKER
    BROKER -->|assemble| RENDERER
    RENDERER -->|output| S1
    RENDERER -->|output| S2
    RENDERER -->|output| S3
```

---

## Data Flow: Single Session Request

```mermaid
sequenceDiagram
    participant Session
    participant Broker
    participant ContextMod as Context Module
    participant GitMod as Git Module
    participant CostMod as Cost Module
    participant Cache
    participant Renderer

    Session->>Broker: getStatusline(sessionId)

    Note over Broker: Check session registry
    Broker->>Broker: registerSession(sessionId)

    par Parallel Module Fetch
        Broker->>ContextMod: fetch(sessionId)
        ContextMod->>Cache: get("context:sessionId")
        alt Cache Miss
            Cache-->>ContextMod: null
            ContextMod->>ContextMod: readJSONStdin()
            ContextMod->>Cache: set("context:sessionId", data)
        else Cache Hit
            Cache-->>ContextMod: cached data
        end
        ContextMod-->>Broker: context data

    and
        Broker->>GitMod: fetch(sessionId)
        GitMod->>Cache: get("git:repoPath")
        alt Cache Stale
            Cache-->>GitMod: stale data
            GitMod->>GitMod: exec("git status")
            GitMod->>Cache: set("git:repoPath", data)
        else Cache Fresh
            Cache-->>GitMod: fresh data
        end
        GitMod-->>Broker: git data

    and
        Broker->>CostMod: fetch(sessionId)
        CostMod->>Cache: get("cost:shared")
        alt Cache Stale
            CostMod->>CostMod: Check if another fetch in-flight
            alt Fetch In-Flight
                CostMod->>CostMod: await existing promise
            else No Fetch
                CostMod->>CostMod: exec("ccusage blocks")
                CostMod->>Cache: set("cost:shared", data)
            end
        else Cache Fresh
            Cache-->>CostMod: fresh data
        end
        CostMod-->>Broker: cost data
    end

    Broker->>Broker: validate all data
    Broker->>Broker: check staleness
    Broker->>Renderer: render(moduleData, staleness)
    Renderer->>Renderer: format + colors
    Renderer->>Renderer: deduplicate vs last output
    Renderer-->>Session: statusline string
```

---

## Session Isolation Mechanism

```mermaid
graph LR
    subgraph "Session A (Chat 123)"
        SA[Request:<br/>sessionId=123]
    end

    subgraph "Session B (Chat 456)"
        SB[Request:<br/>sessionId=456]
    end

    subgraph "Broker Cache"
        subgraph "Session-Specific Data"
            CA123["context:123<br/>model:123<br/>transcript:123"]
            CA456["context:456<br/>model:456<br/>transcript:456"]
        end

        subgraph "Shared Data"
            SHARED["cost:shared<br/>git:repoPath"]
        end
    end

    SA -->|read| CA123
    SA -->|read| SHARED
    SB -->|read| CA456
    SB -->|read| SHARED

    SA -.->|❌ CANNOT read| CA456
    SB -.->|❌ CANNOT read| CA123

    style CA123 fill:#e1f5e1
    style CA456 fill:#fff4e1
    style SHARED fill:#e1f0ff
```

**Key Insight:**
- Session 123 can ONLY read `context:123`, `model:123`, etc.
- Sessions share expensive data (`cost:shared`, `git:repoPath`)
- Cache keys include session ID for isolation

---

## Module Fetch Deduplication

```mermaid
sequenceDiagram
    participant S1 as Session 1
    participant S2 as Session 2
    participant S3 as Session 3
    participant Broker
    participant CostMod as Cost Module
    participant CCUSAGE as ccusage CLI

    Note over S1,S3: All 3 sessions request statusline at same time

    S1->>Broker: getStatusline(session1)
    S2->>Broker: getStatusline(session2)
    S3->>Broker: getStatusline(session3)

    par Parallel Requests
        Broker->>CostMod: fetch(session1)
    and
        Broker->>CostMod: fetch(session2)
    and
        Broker->>CostMod: fetch(session3)
    end

    CostMod->>CostMod: Check cache: MISS
    CostMod->>CostMod: Check inFlight["cost:shared"]

    alt First Caller (session1)
        CostMod->>CCUSAGE: exec("ccusage blocks --json")
        Note over CostMod: Set inFlight["cost:shared"] = promise
        CostMod->>CostMod: await ccusage (20 seconds)
        CCUSAGE-->>CostMod: JSON data
        CostMod->>CostMod: Delete inFlight["cost:shared"]
        CostMod-->>Broker: cost data (session1)
    end

    alt Second Caller (session2)
        CostMod->>CostMod: inFlight["cost:shared"] exists
        CostMod->>CostMod: await same promise
        Note over CostMod: No new ccusage call!
        CostMod-->>Broker: cost data (session2)
    end

    alt Third Caller (session3)
        CostMod->>CostMod: inFlight["cost:shared"] exists
        CostMod->>CostMod: await same promise
        Note over CostMod: No new ccusage call!
        CostMod-->>Broker: cost data (session3)
    end

    Note over S1,S3: All 3 sessions get data<br/>Only 1 ccusage call made
```

**Result:** 15 parallel sessions = 1 ccusage fetch (vs v1's 15 fetches)

---

## Validation Pipeline

```mermaid
graph TD
    FETCH[Module Fetches Data]
    VALIDATE{Validator:<br/>Data Valid?}
    SANITIZE[Sanitize Data]
    CACHED{Cached<br/>Fallback<br/>Exists?}
    DEFAULT[Use Default Value]
    STALE[Mark as Stale 🔴]
    RENDER[Render Output]

    FETCH -->|raw data| VALIDATE
    VALIDATE -->|✅ Valid| RENDER
    VALIDATE -->|❌ Invalid| SANITIZE
    SANITIZE -->|Can Fix| STALE
    SANITIZE -->|Cannot Fix| CACHED
    CACHED -->|Yes| STALE
    CACHED -->|No| DEFAULT
    STALE --> RENDER
    DEFAULT --> RENDER

    style VALIDATE fill:#fff4e1
    style RENDER fill:#e1f5e1
    style DEFAULT fill:#ffe1e1
```

**Validation Rules:**
- Context: `currentTokens <= contextWindow`, `sessionId` format
- Git: `ahead/behind` are integers, branch name valid
- Cost: `costUSD >= 0`, `burnRate >= 0`, timestamps valid
- Model: Model name in known list, not empty string

---

## Cache Eviction Strategy

```mermaid
graph LR
    subgraph "Broker Cache (Max 1000 entries)"
        E1[Entry 1<br/>lastAccessed: 1000]
        E2[Entry 2<br/>lastAccessed: 2000]
        E3[Entry 3<br/>lastAccessed: 3000]
        DOTS[...]
        E1000[Entry 1000<br/>lastAccessed: 10000]
    end

    NEW[New Entry<br/>Needs Space]

    NEW -->|Trigger| EVICT{Cache Full?}
    EVICT -->|Yes| LRU[Find LRU Entry]
    EVICT -->|No| INSERT[Insert New]

    LRU -->|E1 is oldest| REMOVE[Remove E1]
    REMOVE --> INSERT

    style EVICT fill:#fff4e1
    style LRU fill:#ffe1e1
    style INSERT fill:#e1f5e1
```

**Eviction Policy (LRU):**
1. Track `lastAccessedAt` on every cache read
2. When cache reaches max size (1000 entries)
3. Find entry with oldest `lastAccessedAt`
4. Remove it, insert new entry

**Session Timeout:**
- If session inactive for >1 hour, evict all session-specific entries
- Shared entries (`cost:shared`) never evicted due to timeout

---

## Renderer Deduplication

```mermaid
sequenceDiagram
    participant Broker
    participant Renderer
    participant HashStore
    participant Output

    Broker->>Renderer: render(sessionId, moduleData)

    Renderer->>Renderer: Format each module
    Note over Renderer: Context: 🧠:156kleft<br/>Git: 🌿:main+5/-0<br/>Cost: 💰:$42.3

    Renderer->>Renderer: Concatenate sections
    Note over Renderer: Full output string

    Renderer->>Renderer: Compute MD5 hash
    Renderer->>HashStore: Get last hash for session
    HashStore-->>Renderer: previousHash

    alt Hash Changed
        Renderer->>Output: Print statusline
        Renderer->>HashStore: Save new hash
    else Hash Identical
        Note over Renderer: Skip printing<br/>(prevent flicker)
    end
```

**Why Deduplication Matters:**
- Terminal redraws cause flicker
- If data hasn't changed, don't redraw
- Hash comparison is <1ms, print is ~5ms

---

## Error Recovery Flow

```mermaid
graph TD
    START[Module Fetch Starts]
    TIMEOUT{Timeout?}
    RETRY{Retry<br/>Available?}
    SUCCESS{Success?}
    CACHED{Cached<br/>Data?}
    STALE[Use Cached + 🔴]
    DEFAULT[Use Default]
    RENDER[Render Output]
    LOG[Log Error to Sentry]

    START --> TIMEOUT
    TIMEOUT -->|No| SUCCESS
    TIMEOUT -->|Yes| RETRY
    RETRY -->|Yes| START
    RETRY -->|No| LOG

    SUCCESS -->|Yes| RENDER
    SUCCESS -->|No| CACHED

    CACHED -->|Yes| STALE
    CACHED -->|No| DEFAULT

    STALE --> RENDER
    DEFAULT --> RENDER
    LOG --> CACHED

    style SUCCESS fill:#e1f5e1
    style STALE fill:#fff4e1
    style DEFAULT fill:#ffe1e1
    style LOG fill:#ffd4d4
```

**Retry Policy:**
- Max 2 retries for git module
- Max 1 retry for cost module (expensive)
- Max 0 retries for context module (cheap, should never fail)
- Exponential backoff: 100ms, 200ms, 400ms

---

## Performance: Parallel Fetch

```mermaid
gantt
    title Module Fetch Timeline (v1 vs v2)
    dateFormat X
    axisFormat %Lms

    section v1 (Sequential)
    Context (10ms)   :0, 10
    Git (100ms)      :10, 110
    Cost (20000ms)   :110, 20110
    Model (50ms)     :20110, 20160
    Total: 20160ms   :crit, 0, 20160

    section v2 (Parallel)
    Context (10ms)   :0, 10
    Git (100ms)      :0, 100
    Cost (20000ms)   :0, 20000
    Model (50ms)     :0, 50
    Total: 20000ms   :milestone, 20000, 20000

    section v2 (Cached)
    Context (5ms)    :0, 5
    Git (2ms)        :0, 2
    Cost (1ms)       :0, 1
    Model (1ms)      :0, 1
    Total: 5ms       :milestone, 5, 5
```

**Speedup:**
- v1 sequential: 20.16 seconds (cold start)
- v2 parallel: 20 seconds (cold start, limited by slowest module)
- v2 cached: 5ms (hot path)

**Why v2 Cached is Fast:**
- All modules read from in-memory cache
- No subprocess spawns (ccusage, git)
- No file I/O (except final print)

---

## Configuration Cascade

```mermaid
graph TD
    DEFAULT[Default Config<br/>v2/config/statusline.config.json]
    USER[User Override<br/>~/.claude/statusline.user.json]
    ENV[Environment Variables<br/>STATUSLINE_MODULE_*]
    CLI[CLI Flags<br/>--refresh-cost=5m]
    FINAL[Final Config]

    DEFAULT --> MERGE1[Merge]
    USER --> MERGE1
    MERGE1 --> MERGE2[Merge]
    ENV --> MERGE2
    MERGE2 --> MERGE3[Merge]
    CLI --> MERGE3
    MERGE3 --> FINAL

    style DEFAULT fill:#e1e1ff
    style USER fill:#e1ffe1
    style ENV fill:#ffe1e1
    style CLI fill:#fff4e1
    style FINAL fill:#e1f5e1
```

**Priority (highest to lowest):**
1. CLI flags (most specific)
2. Environment variables
3. User config file
4. Default config file

**Example:**
```bash
# Default: cost refresh = 3 minutes
# User config: cost refresh = 5 minutes
# ENV: STATUSLINE_MODULE_COST_REFRESH=300000 (5 min)
# CLI: --refresh-cost=10m

# Result: 10 minutes (CLI wins)
```

---

## Memory Layout

```mermaid
graph TB
    subgraph "Node.js Process (~15MB)"
        HEAP[Heap]
        STACK[Stack]

        subgraph "Broker (~8MB)"
            CACHE[Cache Map<br/>~5MB<br/>1000 entries]
            INFLIGHT[In-Flight Map<br/>~100KB]
            SESSIONS[Session Registry<br/>~500KB]
        end

        subgraph "Modules (~2MB)"
            M1[Context Module<br/>~200KB]
            M2[Git Module<br/>~300KB]
            M3[Cost Module<br/>~500KB]
            M4[Model Module<br/>~200KB]
            M5[Time Module<br/>~50KB]
        end

        RENDERER[Renderer<br/>~500KB]
        VALIDATOR[Validator<br/>~300KB]
    end

    style CACHE fill:#ffe1e1
    style BROKER fill:#fff4e1
```

**Memory Target: <15MB per statusline process**

**Cache Entry Size Estimate:**
- Key: `"context:session-id-123"` = ~30 bytes
- Value: JSON data = ~500 bytes average
- Metadata: timestamps, counts = ~100 bytes
- **Total per entry: ~630 bytes**
- **1000 entries: ~630KB** (but JSON data can be larger, so ~5MB realistic)

**Optimization:**
- Use weak maps for automatic GC
- Serialize large objects only when needed
- Compress transcript data in cache

---

This completes the architectural diagram suite for statusline v2.
