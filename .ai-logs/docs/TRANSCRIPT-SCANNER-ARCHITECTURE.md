# Transcript Scanner Architecture - Visual Guide

**Date**: 2026-02-07
**Purpose**: Architectural diagrams for unified transcript scanning system

---

## Current Architecture (Fragmented)

```mermaid
graph TB
    A[Claude Code Invocation] -->|stdin JSON| B[display-only.ts]
    B -->|read| C[health/{sessionId}.json]
    C --> B
    B -->|stdout| D[Statusline Output]

    A -->|background| E[data-daemon.ts]
    E --> F[UnifiedDataBroker.gatherAll]

    F -->|Tier 2| G[TranscriptSource]
    F -->|Tier 2| H[SecretsSource]
    F -->|Tier 2| I[AuthSource]

    G -->|calls| J[IncrementalTranscriptScanner]
    J -->|read| K[transcript.jsonl]
    J -->|state| L[cooldowns/transcript.state]

    H -->|calls| M[GitLeaksScanner]
    M -->|read| K
    M -->|subprocess| N[gitleaks CLI]
    M -->|state| O[cooldowns/gitleaks.state]

    I -->|calls| P[TranscriptMonitor]
    P -->|read| K
    P -->|NO STATE| Q[Re-scans every time]

    style K fill:#f99
    style Q fill:#f99

    J --> R[LastMessage + Count]
    M --> S[Secrets Found]
    P --> T[Health Metrics]

    R --> U[SessionHealth]
    S --> U
    T --> U

    U --> C
```

**Problems**:
- 🔴 Transcript read 3 times independently
- 🔴 No coordination between scanners
- 🔴 TranscriptMonitor has no state (re-scans)
- 🔴 Gitleaks CLI subprocess overhead (100-500ms)

---

## Proposed Architecture (Unified)

```mermaid
graph TB
    A[Claude Code Invocation] -->|stdin JSON| B[display-only.ts]
    B -->|read| C[health/{sessionId}.json]
    C --> B
    B -->|stdout| D[Statusline Output]

    A -->|background| E[data-daemon.ts]
    E --> F[UnifiedDataBroker.gatherAll]

    F -->|Tier 2| G[NEW: TranscriptScannerSource]

    G -->|single call| H[UnifiedTranscriptScanner]

    H -->|1. Load state| I[scanners/{sessionId}.state]
    H -->|2. Check cache| J{Mtime/Size Changed?}

    J -->|NO| K[Return Cached Result]
    J -->|YES| L[IncrementalReader]

    L -->|read new bytes only| M[transcript.jsonl]

    L --> N[LineParser]
    N -->|parsed lines| O[Parallel Extractors]

    O --> P[LastMessageExtractor]
    O --> Q[SecretDetector Native]
    O --> R[CommandDetector NEW]
    O --> S[AuthChangeDetector NEW]

    P --> T[LastMessage]
    Q --> U[Secrets]
    R --> V[Commands]
    S --> W[Auth Changes]

    T --> X[Composite Result]
    U --> X
    V --> X
    W --> X

    X -->|update state| I
    X -->|cache 10s| Y[Memory Cache]
    X --> Z[SessionHealth]

    style H fill:#9f9
    style O fill:#9f9
    style M fill:#9f9

    Z --> C
```

**Benefits**:
- ✅ Single transcript read
- ✅ All extractors run on same parsed data
- ✅ Unified state management
- ✅ Native secret detection (no subprocess)
- ✅ New capabilities: command/auth detection

---

## Data Flow: Incremental Scanning

```mermaid
sequenceDiagram
    participant D as DataGatherer
    participant S as TranscriptScanner
    participant R as IncrementalReader
    participant F as transcript.jsonl
    participant ST as scanners/{id}.state

    D->>S: scan(sessionId, path)
    S->>ST: Load state
    ST-->>S: { lastOffset: 1000, lastMtime: T1 }

    S->>F: stat(path)
    F-->>S: { size: 1000, mtime: T1 }

    alt Cache Hit (no changes)
        S-->>D: Return cached result (0ms)
    else Cache Miss (new data)
        S->>R: read(path, fromOffset=1000)
        R->>F: readSync(fd, buffer, 0, newBytes, 1000)
        F-->>R: Buffer[100 bytes]
        R-->>S: { newBytes, newOffset: 1100 }

        S->>S: parse(newBytes)
        Note over S: Single JSONL parse

        par Parallel Extraction
            S->>S: LastMessageExtractor
            S->>S: SecretDetector
            S->>S: CommandDetector
            S->>S: AuthChangeDetector
        end

        S->>ST: Update state
        ST-->>S: Saved { lastOffset: 1100, mtime: T2 }

        S-->>D: Composite result (5-10ms)
    end
```

---

## Account Switch Detection Flow

```mermaid
sequenceDiagram
    participant U as User
    participant C as Claude Code
    participant T as TranscriptScanner
    participant A as AuthSource
    participant L as SessionLockManager
    participant N as NotificationManager
    participant SL as Statusline

    U->>C: /login (switch account)
    C->>C: Write to transcript.jsonl
    Note over C: { type: "text", text: "/login", sender: "human" }

    C->>C: Execute login
    C->>C: Write result to transcript
    Note over C: { type: "command_result", command: "login", success: true }

    C->>SL: Next invocation (~100ms)
    SL->>T: scan(sessionId, transcript)
    T->>T: AuthChangeDetector.extract()
    T-->>A: authChanges: [{ type: "login_success", timestamp: T }]

    A->>L: Read session lock
    L-->>A: { locked_email: "old@example.com", locked_at: T1 }

    A->>A: Check timestamp
    Note over A: login_success.timestamp > locked_at?

    alt Login after lock
        A->>A: Re-detect account
        Note over A: KeychainResolver + HotSwapQuotaReader
        A-->>A: newEmail: "new@example.com"

        A->>L: Update lock
        Note over L: locked_email: "new@example.com"<br/>locked_at: NOW

        A->>N: register('account_switch', ...)
        N->>N: Write notifications.json

        A-->>SL: authProfile: "new@example.com"

        SL->>SL: Fetch quota for new@example.com
        SL->>SL: Format with notification
        SL->>U: Display: 💡 Switched to new@example.com
    else No login or before lock
        A-->>SL: Use locked_email from lock
    end
```

---

## Session Account Locking Flow

```mermaid
stateDiagram-v2
    [*] --> Uninitialized: Session starts

    Uninitialized --> DetectAccount: First invocation
    DetectAccount --> CreateLock: Account detected
    CreateLock --> Locked: Write lock file

    Locked --> Locked: Normal invocations<br/>(use locked_email)

    Locked --> LoginDetected: /login command found
    LoginDetected --> VerifyChange: Re-detect account

    VerifyChange --> UpdateLock: Email changed
    VerifyChange --> Locked: Same email (no change)

    UpdateLock --> Locked: Update lock file

    note right of CreateLock
        lock = {
          sessionId,
          locked_email: "user@example.com",
          locked_at: timestamp,
          configDir,
          keychainService
        }
    end note

    note right of UpdateLock
        Notification registered:
        "Switched to new@example.com"
    end note
```

---

## Extractor Plugin Architecture

```mermaid
classDiagram
    class DataExtractor~T~ {
        <<interface>>
        +id: string
        +shouldCache: boolean
        +cacheTTL?: number
        +extract(lines) T
    }

    class LastMessageExtractor {
        +id = "last_message"
        +extract(lines) MessageInfo
        -countMessages(lines) number
    }

    class SecretDetector {
        +id = "secrets"
        +extract(lines) string[]
        -PATTERNS: RegExp[]
        -validatePrivateKey(match) boolean
    }

    class CommandDetector {
        +id = "commands"
        +extract(lines) Command[]
        -COMMANDS: string[]
    }

    class AuthChangeDetector {
        +id = "auth_changes"
        +extract(lines) AuthChange[]
        -detectLogin(line) boolean
        -detectSwap(line) boolean
    }

    class TranscriptScanner {
        -extractors: Map~string, DataExtractor~
        -stateManager: StateManager
        -resultCache: ResultCache
        +register(extractor) void
        +scan(sessionId, path) ScanResult
        -runExtractors(lines) ExtractedData
    }

    DataExtractor <|-- LastMessageExtractor
    DataExtractor <|-- SecretDetector
    DataExtractor <|-- CommandDetector
    DataExtractor <|-- AuthChangeDetector

    TranscriptScanner o-- DataExtractor : uses many
```

**Benefits**:
- Add new extractors without modifying core
- Each extractor independently testable
- Future extensions easy (analytics, custom patterns)

---

## Performance: 40 Concurrent Sessions

```mermaid
graph LR
    A[40 Sessions] --> B{Shared Cache?}

    B -->|Current: NO| C[Independent Scans]
    C --> D[Session 1: 100ms]
    C --> E[Session 2: 100ms]
    C --> F[...]
    C --> G[Session 40: 100ms]
    G --> H[Total: 4000ms]

    B -->|Proposed: YES| I[Shared Memory Cache]
    I --> J{Same Transcript?}

    J -->|YES| K[Cache Hit: 1ms]
    J -->|NO| L[First Parse: 100ms]

    K --> M[Sessions 1-40]
    L --> M

    M --> N[Total: 400ms<br/>10x speedup]

    style H fill:#f99
    style N fill:#9f9
```

**Scenario**: 40 tmux panes, same project
- **Current**: Each session scans independently = 4000ms total
- **Unified**: First session parses (100ms), rest cache hit (1ms) = 139ms total
- **Improvement**: 29x faster

---

## State File Schema Evolution

```mermaid
graph LR
    A[V1: Separate Files] --> B[V2: Unified State]

    subgraph V1 Current
        C[cooldowns/<br/>transcript.state]
        D[cooldowns/<br/>gitleaks.state]
        E[No state for<br/>TranscriptMonitor]
    end

    subgraph V2 Unified
        F[scanners/<br/>{sessionId}.state]
        F --> G[version: 2]
        F --> H[lastOffset: 1000]
        F --> I[lastMtime: T]
        F --> J[extractorData]
        J --> K[lastMessage: ...]
        J --> L[secrets: ...]
        J --> M[commands: ...]
        J --> N[authChanges: ...]
    end

    A --> C
    A --> D
    A --> E

    B --> F

    style E fill:#f99
    style F fill:#9f9
```

---

## Notification Display Timeline

```mermaid
gantt
    title Account Switch Notification Lifecycle
    dateFormat X
    axisFormat %Lms

    section User Action
    User runs /login : milestone, 0, 0

    section Transcript Write
    Command written : 50, 100
    Result written : 100, 150

    section Next Invocation
    Statusline invoked : milestone, 200, 200

    section Daemon Processing
    TranscriptScanner.scan : 200, 210
    AuthChangeDetector : 210, 215
    SessionLock update : 215, 220
    Notification register : 220, 225

    section Display
    Notification shown : 225, 30225
    Notification hidden : 30225, 330225
    Notification shown : 330225, 360225

    section Cycles
    30s show, 5min hide : crit, 225, 360225
```

**Timeline**:
- T+0ms: User runs /login
- T+100ms: Command written to transcript
- T+200ms: Next statusline invocation
- T+225ms: Notification registered and shown
- T+30s: Notification hidden (5min)
- T+5min30s: Notification shown again (30s)
- Repeats until dismissed or 24h expiry

---

## Memory Usage Comparison

```mermaid
graph TB
    subgraph Current Fragmented
        A1[Session 1] -->|8MB| B1[IncrementalScanner<br/>state + cache]
        A1 -->|5MB| C1[GitLeaksScanner<br/>state + CLI output]
        A1 -->|2MB| D1[TranscriptMonitor<br/>no state]
        B1 --> E1[Total: 15MB/session]
        C1 --> E1
        D1 --> E1
    end

    subgraph Proposed Unified
        A2[Session 1] -->|5MB| B2[TranscriptScanner<br/>unified state]
        B2 --> E2[Total: 5MB/session]
    end

    E1 --> F[40 sessions:<br/>600MB]
    E2 --> G[40 sessions:<br/>200MB]

    style F fill:#f99
    style G fill:#9f9
```

**Improvement**: 3x memory reduction per session

---

## Implementation Phases

```mermaid
graph LR
    A[Phase 0:<br/>Specification] --> B[Phase 1:<br/>Core Module]
    B --> C[Phase 2:<br/>Extractors]
    C --> D[Phase 3:<br/>Integration]
    D --> E[Phase 4:<br/>Migration]
    E --> F[Phase 5:<br/>Deprecation]

    B --> B1[TranscriptScanner<br/>IncrementalReader<br/>LineParser<br/>StateManager]

    C --> C1[LastMessageExtractor<br/>SecretDetector<br/>CommandDetector<br/>AuthChangeDetector]

    D --> D1[TranscriptScannerSource<br/>Auth-source integration<br/>Notification registration]

    E --> E1[Replace IncrementalScanner<br/>Replace GitLeaksScanner<br/>Replace TranscriptMonitor]

    F --> F1[Remove old modules<br/>Clean up state files<br/>Update docs]

    style A fill:#ff9
    style B fill:#9f9
    style C fill:#fff
    style D fill:#fff
    style E fill:#fff
    style F fill:#ccc
```

**Current Status**: Phase 0 (Specification) ✅ Complete

---

## Testing Strategy Pyramid

```mermaid
graph TB
    A[E2E Tests<br/>5 tests] --> B[Integration Tests<br/>20 tests]
    B --> C[Unit Tests<br/>100 tests]

    subgraph E2E
        A1[Full account switch flow]
        A2[40 concurrent sessions]
        A3[Large transcript 10MB]
    end

    subgraph Integration
        B1[Scanner → Extractors → State]
        B2[Auth detection → Lock update]
        B3[Notification registration]
    end

    subgraph Unit
        C1[IncrementalReader cache hits]
        C2[LineParser JSONL parsing]
        C3[Each extractor independently]
        C4[State persistence]
    end

    style C fill:#9f9
    style B fill:#ff9
    style A fill:#f99
```

---

This visual guide provides complete architectural understanding for implementing the unified transcript scanning system with account switch detection and ultra-efficient performance for 40+ concurrent sessions.
