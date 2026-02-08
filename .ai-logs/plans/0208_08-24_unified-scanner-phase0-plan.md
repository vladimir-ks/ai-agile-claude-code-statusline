# Phase 0: Unified Transcript Scanner - Comprehensive Planning

**Date**: 2026-02-08 08:24
**Methodology**: SDD → BDD → TDD → Implementation
**Status**: PHASE 0 - PLANNING ONLY

---

## Halt & Replan Notice

**Previous work (Task #91)**: Core module created WITHOUT proper specs/tests first ❌
**Action**: Archive existing work, restart with proper methodology ✅

---

## Phase 0 Objectives

1. **Specifications-Driven Development (SDD)**
   - Write complete technical specs
   - Define all interfaces, behaviors, edge cases
   - Document architecture decisions

2. **Behavior-Driven Development (BDD)**
   - Write .feature files for all user scenarios
   - Define acceptance criteria
   - Map behaviors to tests

3. **Test-Driven Development (TDD)**
   - Write tests BEFORE implementation
   - Red → Green → Refactor cycle
   - 100% coverage target

4. **Context Management**
   - Minimize context switching between tasks
   - Arrange work in logical dependency order
   - Provide comprehensive briefings for parallel work

---

## Work Breakdown Structure

### Stream A: Specifications (Sequential - Foundation)
1. Technical specification (complete API, interfaces)
2. Behavior specification (.feature files)
3. Architecture decision records (ADRs)
4. Migration strategy from existing code

### Stream B: Test Infrastructure (After Stream A)
1. Test harness setup
2. Mock data generators
3. Test utilities
4. Performance benchmarking framework

### Stream C: Implementation (After Streams A+B)
1. Core module (with TDD)
2. Extractors (with TDD)
3. Integration (with BDD)
4. Migration (with validation)

---

## Detailed Task Plan (Logical Order)

### Phase 0.1: Exploration & Documentation (TODAY - 2-3 hours)

**Goal**: Understand what exists, what to reuse, what to archive

**Tasks**:
1. **Inventory existing code** (30min)
   - IncrementalTranscriptScanner: What works? What to port?
   - GitLeaksScanner: Reuse or replace?
   - TranscriptMonitor: Archive or integrate?
   - Document: What's reusable, what's deprecated

2. **Map data dependencies** (30min)
   - What data flows into transcript scanning?
   - What consumes scan results?
   - Integration points with existing system

3. **Identify gaps** (30min)
   - What functionality is missing in current code?
   - What new features needed (account switch detection)?
   - What edge cases not handled?

4. **Create reuse/archive matrix** (30min)
   - Reuse: Algorithms, patterns, tests
   - Archive: Obsolete modules, old state files
   - Replace: Inefficient implementations

**Deliverable**: `0208_08-24_code-inventory-matrix.md`

---

### Phase 0.2: Specifications-Driven Development (TODAY - 3-4 hours)

**Goal**: Complete technical specs BEFORE any code

**Tasks**:
1. **API Specification** (1h)
   - File: `_refs/specs/0208_08-25_unified-scanner-api-spec.md`
   - All public interfaces
   - Method signatures
   - Type definitions
   - Error handling
   - Performance contracts

2. **Behavior Specification** (1h)
   - File: `_refs/specs/0208_08-25_unified-scanner-behaviors.feature`
   - Gherkin scenarios for all use cases
   - Given/When/Then format
   - Edge cases as scenarios
   - Performance scenarios

3. **Data Model Specification** (30min)
   - File: `_refs/specs/0208_08-25_scanner-data-model.md`
   - State file schema (version 2)
   - Cache structure
   - Result format
   - Migration schema

4. **Architecture Decision Records** (1h)
   - File: `_refs/adrs/0208_08-25_adr-001-incremental-reading.md`
   - File: `_refs/adrs/0208_08-25_adr-002-pluggable-extractors.md`
   - File: `_refs/adrs/0208_08-25_adr-003-state-management.md`
   - Rationale, alternatives, consequences

**Deliverables**:
- Complete API spec
- Complete .feature file
- Data model spec
- 3 ADRs

---

### Phase 0.3: Test-Driven Development Setup (TOMORROW - 2-3 hours)

**Goal**: Test infrastructure ready BEFORE implementation

**Tasks**:
1. **Test harness** (1h)
   - File: `v2/tests/transcript-scanner/test-harness.ts`
   - Mock transcript generators
   - Fixture data
   - Helper utilities

2. **Test specs (BEFORE implementation)** (2h)
   - File: `v2/tests/transcript-scanner/incremental-reader.test.ts` (RED)
   - File: `v2/tests/transcript-scanner/line-parser.test.ts` (RED)
   - File: `v2/tests/transcript-scanner/state-manager.test.ts` (RED)
   - File: `v2/tests/transcript-scanner/extractors/*.test.ts` (RED)
   - All tests written, all FAILING (no implementation yet)

**Deliverables**:
- Test harness complete
- All test files written (RED state)
- 0% passing (expected - no impl yet)

---

### Phase 0.4: Pseudocode Structure (TOMORROW - 1-2 hours)

**Goal**: Create file structure with pseudocode placeholders

**Tasks**:
1. **Create directory structure**
   ```
   v2/src/lib/transcript-scanner/
   ├── core/
   │   ├── incremental-reader.ts       (10 lines pseudocode)
   │   ├── line-parser.ts              (10 lines pseudocode)
   │   ├── state-manager.ts            (10 lines pseudocode)
   │   └── result-cache.ts             (10 lines pseudocode)
   ├── extractors/
   │   ├── base-extractor.ts           (10 lines pseudocode)
   │   ├── last-message-extractor.ts   (10 lines pseudocode)
   │   ├── secret-detector.ts          (10 lines pseudocode)
   │   ├── command-detector.ts         (10 lines pseudocode)
   │   └── auth-change-detector.ts     (10 lines pseudocode)
   ├── types.ts                        (interface declarations)
   └── index.ts                        (exports)
   ```

2. **Pseudocode only** (no real implementation)
   - Class signatures
   - Method signatures
   - TODO comments with algorithm steps
   - Type stubs

**Deliverables**:
- Complete file structure
- All files with 10-20 lines pseudocode
- No real implementation yet

---

## Archive Strategy for Existing Work

### Files Created in Task #91 (To Archive)

```
v2/src/lib/unified-transcript-scanner.ts          → ARCHIVE
v2/src/lib/transcript-scanner/types.ts            → KEEP (refine with specs)
v2/src/lib/transcript-scanner/incremental-reader.ts → ARCHIVE (rewrite with TDD)
v2/src/lib/transcript-scanner/line-parser.ts      → ARCHIVE (rewrite with TDD)
v2/src/lib/transcript-scanner/state-manager.ts    → ARCHIVE (rewrite with TDD)
v2/src/lib/transcript-scanner/result-cache.ts     → ARCHIVE (rewrite with TDD)
```

**Archive location**: `v2/archive/2026-02-08_task91-premature/`

**Rationale**: Code written without specs/tests violates TDD. Extract good ideas, rewrite properly.

---

## Reuse Matrix (From Existing Code)

### FROM: IncrementalTranscriptScanner (REUSE ALGORITHMS)

**File**: `v2/src/lib/incremental-transcript-scanner.ts`

**What to Reuse**:
- ✅ Offset tracking logic (lines 80-95)
- ✅ Message counting algorithm (lines 120-145)
- ✅ Last message extraction (backward scan, lines 150-180)
- ✅ State file format (adapt to new schema)

**What to Archive**:
- ❌ Direct file I/O (replace with abstracted IncrementalReader)
- ❌ Mixed concerns (health + message extraction)

**Port Strategy**: Extract pure algorithms, write tests first, then port

---

### FROM: GitLeaksScanner (PARTIALLY REUSE)

**File**: `v2/src/lib/gitleaks-scanner.ts`

**What to Reuse**:
- ✅ Secret patterns (lines 45-60) - adapt to native regex
- ✅ Cooldown logic (lines 68-76) - generalize
- ✅ State tracking (lines 80-95) - merge into unified state

**What to Replace**:
- ❌ CLI subprocess call (lines 100-140) - replace with native regex
- ❌ Separate state file - merge into unified scanner state

**Port Strategy**: Native regex detector, CLI as optional fallback

---

### FROM: TranscriptMonitor (ARCHIVE - REPLACE)

**File**: `v2/src/lib/transcript-monitor.ts`

**What to Reuse**:
- ✅ Health metrics calculation (lines 50-80)
- ✅ Age formatting logic (lines 90-110)

**What to Archive**:
- ❌ Entire module (no state, re-scans every time)
- ❌ Estimation logic (inaccurate)

**Port Strategy**: Extract health calculation, integrate into scanner

---

## Parallelization Strategy

### Work Streams (Can Run in Parallel)

**After Phase 0.2 (Specs Complete)**:

**Stream 1: Core Module** (Agent A)
- IncrementalReader (TDD)
- LineParser (TDD)
- StateManager (TDD)
- ResultCache (TDD)

**Stream 2: Extractors** (Agent B)
- LastMessageExtractor (TDD)
- SecretDetector (TDD)
- CommandDetector (TDD)
- AuthChangeDetector (TDD)

**Stream 3: Integration** (Agent C)
- UnifiedTranscriptScanner orchestrator
- Extractor registration
- Pipeline coordination

**Context Handoff**: Each agent receives:
- Complete API spec
- Complete .feature file
- Relevant ADRs
- Test harness
- Mock data

---

## Quality Gates

### Phase 0 Complete When:
- [ ] Code inventory matrix complete
- [ ] API specification complete (all interfaces documented)
- [ ] .feature file complete (all scenarios defined)
- [ ] Data model spec complete
- [ ] 3 ADRs written
- [ ] Test harness ready
- [ ] All test files written (RED state)
- [ ] Directory structure created with pseudocode
- [ ] Archive plan documented
- [ ] Reuse matrix documented
- [ ] Parallel work briefings written

### Implementation Phase Start Criteria:
- [ ] All Phase 0 tasks complete
- [ ] Specs reviewed and approved
- [ ] Tests written (RED)
- [ ] No ambiguity in requirements
- [ ] Clear definition of done

---

## Timeline

**TODAY (Phase 0.1-0.2)**:
- 08:30-09:00: Code inventory
- 09:00-10:00: API spec
- 10:00-11:00: Behavior spec (.feature)
- 11:00-11:30: Data model
- 11:30-12:30: ADRs

**TOMORROW (Phase 0.3-0.4)**:
- Morning: Test harness + test specs (RED)
- Afternoon: Pseudocode structure

**DAY 3+**: Implementation with TDD (RED → GREEN → REFACTOR)

---

## Next Immediate Action

**NOW**: Start Phase 0.1 - Code Inventory

**Task**: Explore existing codebase, create reuse/archive matrix

**Output**: `0208_08-24_code-inventory-matrix.md`

**After**: Continue with Phase 0.2 (API spec)

---

This plan ensures:
✅ No duplicate functionality
✅ Reuse proven algorithms
✅ Archive obsolete code
✅ Specs before code
✅ Tests before implementation
✅ Logical task ordering
✅ Parallel work when possible
✅ Quality over speed
