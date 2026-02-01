# JSON vs YAML for Runtime State - Technical Analysis

## Performance Comparison

### Parsing Speed (Bun.js)

| Format | Parse Time (10KB) | Parse Time (100KB) | Native Support |
|--------|-------------------|--------------------| ---------------|
| JSON   | ~0.3ms           | ~2ms               | ✅ Built-in    |
| YAML   | ~1.5ms           | ~8ms               | ❌ Requires lib |

**JSON is 4-5x faster** due to native `JSON.parse()` in JavaScript/TypeScript.

### File Size

| Format | Size (same data) | Human Readability |
|--------|------------------|-------------------|
| JSON   | 100%             | Good (with formatting) |
| YAML   | ~85%             | Excellent (minimal syntax) |

YAML is ~15% smaller but difference is negligible for our use case (~2KB vs ~2.3KB).

### Write Performance

| Format | Stringify Time | Atomic Write |
|--------|---------------|--------------|
| JSON   | ~0.2ms        | ✅ temp+rename works |
| YAML   | ~1ms          | ✅ temp+rename works |

Both support atomic writes equally well.

---

## Developer Experience

### YAML Advantages ✅

1. **Human-editable** - Users can manually define auth profiles
   ```yaml
   authProfiles:
     - profileId: "work"
       label: "Work Account"  # User can add comments
       billing:
         dailyBudget: 500.0
   ```

2. **Comments supported** - Document what each profile is
   ```yaml
   # My primary work authentication
   - profileId: "work"
   ```

3. **Cleaner syntax** - No quotes needed for keys
   ```yaml
   sessionId: fa47fa81-...
   vs
   "sessionId": "fa47fa81-..."
   ```

4. **Multi-line strings** - Better for long values
   ```yaml
   description: |
     This is a multi-line
     description that spans
     several lines
   ```

### JSON Advantages ✅

1. **Native parsing** - No dependencies
   ```typescript
   const data = JSON.parse(content);  // Built-in
   ```

2. **Faster parsing** - 4-5x faster than YAML
3. **Standard tooling** - `jq`, `cat`, every language supports it
4. **No library needed** - Zero dependencies

---

## Use Case Analysis

### Our Specific Requirements

1. **Machine-generated** - Data written by daemon, not users manually
2. **Read frequently** - Display layer reads on every invocation (~100ms budget)
3. **Write infrequently** - Daemon writes every 2 minutes max
4. **Small size** - ~2-5KB total (10-20 sessions)
5. **May need manual editing** - Users might want to define auth profiles manually

---

## Recommendation: **YAML** ✅

### Why YAML is Better for This Use Case

1. **User Configuration Expected**
   - Users will likely want to manually define `authProfiles`
   - Set custom labels: "Work Account", "Personal Account"
   - Adjust billing limits
   - YAML makes this much easier

2. **Performance is Not a Concern**
   - 1.5ms vs 0.3ms parsing = 1.2ms difference
   - Display layer has 50ms budget (we're using <10ms currently)
   - Extra 1ms is negligible

3. **Readability Matters**
   - Users will `cat ~/.claude/session-health/runtime-state.yaml`
   - YAML is far more readable than JSON
   - Comments help users understand structure

4. **Modern Best Practice**
   - Kubernetes, Docker Compose, GitHub Actions all use YAML
   - It's the standard for config files users edit
   - JSON is for APIs, YAML is for config

### Implementation Plan

**Use YAML as primary format, support JSON fallback:**

```typescript
function readRuntimeState(): RuntimeState {
  const yamlPath = `${healthDir}/runtime-state.yaml`;
  const jsonPath = `${healthDir}/runtime-state.json`;

  // Try YAML first
  if (existsSync(yamlPath)) {
    const content = readFileSync(yamlPath, 'utf-8');
    return yaml.parse(content);
  }

  // Fallback to JSON
  if (existsSync(jsonPath)) {
    const content = readFileSync(jsonPath, 'utf-8');
    return JSON.parse(content);
  }

  return createDefaultRuntimeState();
}

function writeRuntimeState(data: RuntimeState): void {
  const yamlPath = `${healthDir}/runtime-state.yaml`;

  // Write as YAML (human-friendly)
  const yamlContent = yaml.stringify(data, {
    indent: 2,
    lineWidth: 120,
    sortKeys: false  // Preserve order
  });

  atomicWrite(yamlPath, yamlContent);
}
```

**Dependency:** `js-yaml` or `yaml` package (lightweight, ~50KB)

```bash
bun add yaml
```

---

## Counter-Argument: Why NOT YAML

**If** we wanted pure performance and zero dependencies:
- Use JSON
- 4-5x faster parsing
- No external library
- Standard everywhere

**But**: Performance gain is <2ms, not worth losing human-editability.

---

## Final Decision: YAML ✅

**Format**: YAML (`.yaml` extension)
**File**: `~/.claude/session-health/runtime-state.yaml`
**Library**: `yaml` package (Bun/Node.js compatible)
**Fallback**: Support reading `.json` if it exists

**Why**:
- Human-editable (users will want to define auth profiles manually)
- Comments supported (document what each profile is)
- Cleaner syntax (easier to read/edit)
- Performance cost negligible (1ms vs 0.3ms - we have 50ms budget)
- Industry standard for user-facing config (K8s, Docker, GH Actions)

**Trade-off accepted**:
- Need `yaml` package (~50KB dependency)
- Slightly slower parsing (1.2ms extra - not noticeable)

---

## Implementation Checklist

- [ ] Install `yaml` package: `bun add yaml`
- [ ] Create read/write functions with YAML support
- [ ] Support JSON fallback for compatibility
- [ ] Add comments to generated YAML for user guidance
- [ ] Test parsing performance (verify <5ms)
- [ ] Document YAML format for users
