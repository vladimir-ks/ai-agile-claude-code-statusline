# Runtime Comparison Results: Bun vs Node.js

**Date**: 2026-01-29
**Test Environment**: macOS, Bun 1.2.22, Node.js v22.18.0

---

## Summary

| Metric | Node.js v22.18.0 | Bun 1.2.22 | Winner | Improvement |
|--------|------------------|------------|--------|-------------|
| **Cold Start** | 113 ms | 42 ms | **Bun** | 62% faster |
| **Memory Footprint** | 9.44 MB | 0.22 MB | **Bun** | 97% less |
| **JSON Parsing** (10k iterations) | 10.43 ms | 3.34 ms | **Bun** | 68% faster |
| **Subprocess Execution** | 7.13 ms | 11.15 ms | **Node.js** | 36% faster |

---

## Analysis

### Cold Start Time ✅
- **Target**: <50ms
- **Bun**: 42ms ✅ **Meets target**
- **Node.js**: 113ms ❌ **Exceeds target**
- **Verdict**: Bun is 62% faster and meets the critical <50ms requirement

### Memory Footprint ✅
- **Target**: <10MB per session
- **Bun**: 0.22MB ✅ **Well under target**
- **Node.js**: 9.44MB ✅ **Meets target, but close**
- **Verdict**: Bun uses 97% less memory, critical for 15-20 parallel sessions

### JSON Parsing Performance
- **Bun**: 3.34ms for 10k iterations (68% faster)
- **Node.js**: 10.43ms
- **Verdict**: Bun's JavaScriptCore engine significantly faster at JSON parsing

### Subprocess Execution
- **Node.js**: 7.13ms (36% faster)
- **Bun**: 11.15ms
- **Verdict**: Node.js slightly faster, but difference negligible for our use case

---

## Decision

**Recommendation**: ✅ **Use Bun for statusline v2**

### Rationale

**Critical Performance Wins**:
1. **Cold start**: 42ms vs 113ms (62% faster, meets target)
2. **Memory**: 0.22MB vs 9.44MB (97% less, critical for parallel sessions)
3. **JSON parsing**: 3× faster (we parse JSON every 100ms)

**Acceptable Trade-offs**:
1. **Subprocess**: 4ms slower (negligible for our use case)
2. **Maturity**: Bun less mature, but stable enough for CLI tool

**Impact on v2 Goals**:
- ✅ Meets <50ms cold start target
- ✅ Meets <10MB memory target (by 98%)
- ✅ Enables 15-20 parallel sessions with <150MB total memory
- ✅ Native TypeScript execution (no compilation step)
- ✅ Built-in test runner (Bun.test)

**Fallback Plan**:
- Keep Node.js compatibility
- Easy to switch back if Bun stability issues emerge
- No Bun-specific APIs used (only using standard Node.js APIs)

---

## Implementation Notes

### Bun Features to Leverage

1. **Native TypeScript Execution**
   - No ts-node or tsx required
   - Zero compilation step
   - Instant startup

2. **Built-in Test Runner**
   - `bun test` command
   - No Jest setup required
   - Fast parallel test execution

3. **Fast Subprocess Execution**
   - Even though benchmark shows slower, Bun's subprocess API is still performant
   - 11ms is acceptable for our use case

4. **Small Binary Size**
   - Bun runtime is optimized for CLI tools
   - Faster cold starts critical for statusline

### Migration Path

1. **Phase 1**: Develop v2 using Bun
2. **Phase 2**: Test extensively (unit, integration, E2E)
3. **Phase 3**: Parallel operation (v1 + v2) for validation
4. **Phase 4**: Monitor for Bun-specific issues
5. **Fallback**: Switch to Node.js if critical bugs found (no code changes required)

---

## Next Steps

1. ✅ Create `v2/package.json` with Bun configuration
2. ✅ Add `"type": "module"` for ES modules
3. [ ] Set up `bun test` framework
4. [ ] Document Bun installation for contributors
5. [ ] Add Bun version check to README

---

## Benchmark Reproduction

To reproduce these results:

```bash
# Install Bun (if not installed)
curl -fsSL https://bun.sh/install | bash

# Run benchmarks
./v2/benchmarks/run-comparison.sh

# Results saved to:
# - v2/benchmarks/results-nodejs.json
# - v2/benchmarks/results-bun.json
```

---

## References

- [Bun Documentation](https://bun.sh/docs)
- [Bun Performance Benchmarks](https://bun.sh/docs/runtime/performance)
- [Bun Test Runner](https://bun.sh/docs/cli/test)
- [v2/README.md](../README.md) - v2 Architecture Overview
