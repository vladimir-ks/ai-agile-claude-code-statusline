# Statusline v2 - Testing

**Framework**: Bun Test (built-in, fast, zero-config)
**Coverage Target**: >95% line coverage, 100% branch coverage for critical paths
**Philosophy**: Quality over quantity - tests should validate logic, not mocks

---

## Test Structure

```
tests/
├── unit/                     # Unit tests (isolated modules)
│   ├── context-module.test.ts
│   ├── cost-module.test.ts
│   ├── data-broker.test.ts
│   └── ...
├── integration/              # Integration tests (cross-module)
│   ├── session-isolation.test.ts
│   ├── fetch-deduplication.test.ts
│   └── cache-eviction.test.ts
├── e2e/                      # End-to-end tests
│   ├── parallel-sessions.test.ts
│   └── stability.test.ts
├── test-helpers.ts           # Shared utilities
└── README.md                 # This file
```

---

## Running Tests

### All Tests
```bash
cd v2
bun test
```

### Specific Test File
```bash
bun test tests/unit/context-module.test.ts
```

### Watch Mode (re-run on changes)
```bash
bun test --watch
```

### Coverage Report
```bash
bun test --coverage
```

---

## Test Categories

### Unit Tests (Fast, Isolated)
**Purpose**: Test individual module logic in isolation
**Speed**: <1ms per test
**Mocking**: Minimal (only external dependencies like ccusage, git)

**What We Test**:
- Data parsing (JSON, ccusage output)
- Calculations (percentages, token counts)
- Validation rules (range checks, type checks)
- Formatting (display strings, numbers)
- Edge cases (zero, negative, overflow)

**Example**:
```typescript
test('Context calculation: 78k tokens = 50% toward compact', () => {
  const result = calculateContext({
    windowSize: 200000,
    currentInput: 50000,
    cacheRead: 28000
  });

  expect(result.percentageUsedCompact).toBe(50); // 78k / 156k = 50%
});
```

---

### Integration Tests (Medium, Cross-Module)
**Purpose**: Test modules working together
**Speed**: 10-100ms per test
**Mocking**: External I/O only (filesystem, network)

**What We Test**:
- Data flow: JSON → Broker → Module → Renderer
- Cache coordination: Multiple modules sharing cache
- Session isolation: 15 sessions, no cross-contamination
- Validation pipeline: Primary + secondary sources
- Failover: Primary fails → secondary used

**Example**:
```typescript
test('Session isolation: Each session gets correct data', async () => {
  const broker = new DataBroker();

  // Register 2 sessions
  broker.registerSession('session1', '~/.claude');
  broker.registerSession('session2', '~/.claude-work');

  // Fetch data for both
  const data1 = await broker.getData('context', 'session1');
  const data2 = await broker.getData('context', 'session2');

  // Should be different (session-specific)
  expect(data1.sessionId).toBe('session1');
  expect(data2.sessionId).toBe('session2');
  expect(data1).not.toEqual(data2);
});
```

---

### E2E Tests (Slow, Full System)
**Purpose**: Test entire system end-to-end
**Speed**: 1-10 seconds per test
**Mocking**: None (uses real environment)

**What We Test**:
- Parallel sessions: 15 Claude Code instances simultaneously
- Stability: 1-hour continuous operation
- Memory leaks: Heap growth over time
- Performance: Cold start, hot path latency
- Real-world scenarios: Typical user workflows

**Example**:
```typescript
test('Parallel sessions: 15 instances, <150MB total memory', async () => {
  const sessions = [];

  // Start 15 sessions
  for (let i = 0; i < 15; i++) {
    sessions.push(startSession(`session-${i}`));
  }

  await Promise.all(sessions);

  // Measure total memory
  const totalMemory = getMemoryUsage();
  expect(totalMemory).toBeLessThan(150); // <150MB target
});
```

---

## Test Quality Standards

### ✅ Good Tests
- **Test behavior, not implementation**: Focus on what the module does, not how
- **Clear test names**: `test('Context calculation: 78k tokens = 50% toward compact')`
- **Meaningful assertions**: Check actual values, not just "not null"
- **Edge cases covered**: Zero, negative, overflow, missing data
- **Minimal mocking**: Only mock external dependencies (filesystem, network)
- **Fast**: Unit tests <1ms, integration <100ms

### ❌ Bad Tests
- **Testing mocks**: `expect(mockFn).toHaveBeenCalled()` (tests the mock, not logic)
- **Vague names**: `test('it works')` (what works?)
- **Weak assertions**: `expect(result).toBeTruthy()` (too generic)
- **No edge cases**: Only tests happy path
- **Over-mocked**: Mocks internal functions (tests implementation, not behavior)
- **Slow**: Long timeouts, waiting for external services

---

## Current Test Results

### Coverage (as of 2026-01-29)

| Module | Unit Tests | Coverage | Status |
|--------|-----------|----------|--------|
| context-module | 22 tests | ~90% | ✅ Complete |
| cost-module | 18 tests | ~85% | ✅ Complete |
| data-broker | 0 tests | 0% | 🔄 Pending |
| git-module | 0 tests | 0% | 🔄 Pending |
| model-module | 0 tests | 0% | 🔄 Pending |
| renderer | 0 tests | 0% | 🔄 Pending |

**Total**: 40 tests, 0 failures, ~15ms runtime

---

## Test Helpers

Located in `tests/test-helpers.ts`:

- `mockContextInput()` - Generate mock JSON input
- `mockCcusageOutput()` - Generate mock ccusage data
- `mockGitStatus()` - Generate mock git status
- `assertAlmostEqual()` - Float comparison with tolerance
- `measurePerformance()` - Measure function execution time
- `retry()` - Retry flaky tests
- `getMemoryUsage()` - Measure heap usage

---

## Adding New Tests

### 1. Create Test File
```bash
touch tests/unit/my-module.test.ts
```

### 2. Write Test Structure
```typescript
import { describe, test, expect } from 'bun:test';

describe('MyModule - Feature Name', () => {
  test('Happy path: normal input', () => {
    // Arrange
    const input = { ... };

    // Act
    const result = myFunction(input);

    // Assert
    expect(result).toBe(expectedValue);
  });

  test('Edge case: zero input', () => {
    // Test edge case
  });

  test('Error case: invalid input', () => {
    // Test error handling
  });
});
```

### 3. Run Tests
```bash
bun test tests/unit/my-module.test.ts
```

### 4. Verify Coverage
```bash
bun test --coverage
```

---

## Debugging Tests

### Enable Debug Output
```bash
DEBUG=1 bun test
```

### Run Single Test
```bash
bun test -t "Context calculation: 78k tokens"
```

### Inspect Test Failure
```bash
bun test --bail  # Stop on first failure
```

---

## Performance Benchmarks

Target performance (per test):
- **Unit tests**: <1ms
- **Integration tests**: <100ms
- **E2E tests**: <10s

If tests exceed targets:
- Profile with `bun test --profile`
- Reduce unnecessary operations
- Mock expensive I/O

---

## Next Steps

1. [ ] Add unit tests for remaining modules (git, model, time, project)
2. [ ] Add integration tests (session isolation, cache coordination)
3. [ ] Add E2E tests (parallel sessions, stability)
4. [ ] Add memory leak tests (heap growth detection)
5. [ ] Add performance tests (cold start, hot path)
6. [ ] Configure CI/CD to run tests on push
7. [ ] Add test coverage reporting (codecov, coveralls)

---

## References

- [Bun Test Documentation](https://bun.sh/docs/cli/test)
- [Test Plan](../docs/ARCHITECTURE.md#testing-strategy)
- [Phase 7 Checklist](/Users/vmks/.claude/plans/shimmying-meandering-shell.md#phase-7-testing-strategy)
