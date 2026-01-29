# Multi-Source Data Validation Architecture

**Status**: 🔍 Design Phase
**Date**: 2026-01-29
**Priority**: P2 (Reliability)

---

## Problem Statement

### The Issue

Statusline aggregates data from **multiple sources** that may disagree:

| Data Point | Sources | Potential Conflicts |
|------------|---------|---------------------|
| Model | JSON stdin, Transcript, settings.json | Different models across sources |
| Context tokens | JSON stdin, Transcript | Token count mismatches |
| Session cost | ccusage, Transcript metadata | Cost calculation differences |
| Weekly usage | ccusage weekly, ccusage blocks (sum) | Aggregation errors |
| Git branch | git status, .git/HEAD | Branch name mismatches |
| Timestamps | System clock, File mtimes | Clock skew issues |

### The Risk

**Without validation**:
- ❌ Display incorrect model ("Haiku" when actually using "Opus")
- ❌ Show wrong token counts (off by 10k+)
- ❌ Report inaccurate costs (billing discrepancies)
- ❌ User makes decisions based on bad data

**With validation**:
- ✅ Detect conflicts, log warnings
- ✅ Use most reliable source
- ✅ Show confidence indicators (🔴 when low confidence)
- ✅ Track validation metrics (identify flaky sources)

---

## Architecture Overview

```
┌─────────────────────────────────────────────────┐
│  Data Sources (Multiple per Data Point)        │
│                                                  │
│  Primary:   JSON stdin, ccusage, git status    │
│  Secondary: Transcript, settings.json, .git/   │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│  Validation Pipeline                            │
│                                                  │
│  1. Fetch primary source (fast path)           │
│  2. Fetch secondary sources (background)        │
│  3. Compare sources (validator rules)           │
│  4. Calculate confidence (0-100)                │
│  5. Select best source (or primary if high conf)│
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│  ValidationResult                               │
│                                                  │
│  - valid: boolean                               │
│  - confidence: 0-100                            │
│  - warnings: string[]                           │
│  - errors: string[]                             │
│  - recommendedSource: DataSource                │
│  - metadata: { agreement%, latency, ... }      │
└─────────────────┬───────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────┐
│  Decision: Use Primary or Fallback             │
│                                                  │
│  if confidence >= 70%: use primary             │
│  else: use recommended (secondary)             │
│                                                  │
│  if confidence < 50%: show 🔴 staleness        │
└─────────────────────────────────────────────────┘
```

---

## Validation Rules Matrix

### 1. Model Validation

| Primary | Secondary | Rule | Action |
|---------|-----------|------|--------|
| JSON stdin | Transcript | Exact match | ✅ confidence=100% |
| JSON stdin | Transcript | Mismatch | ⚠️ Warn, use primary, confidence=70% |
| JSON stdin | settings.json | Mismatch | ℹ️ Expected (settings is default), confidence=90% |
| Transcript | settings.json | No JSON | Use transcript if <1h old, else settings |
| None | settings.json | No data | Use settings (fallback), confidence=50% |

**Validation Logic**:
```typescript
validateModel(primary, secondary) {
  if (primary === secondary) {
    return { confidence: 100, warnings: [] };
  }

  if (primary && secondary && primary !== secondary) {
    return {
      confidence: 70,
      warnings: [`Model mismatch: primary=${primary}, secondary=${secondary}`]
    };
  }

  return { confidence: 50, warnings: ['Limited model data sources'] };
}
```

---

### 2. Context Token Validation

| Condition | Rule | Action |
|-----------|------|--------|
| JSON ≈ Transcript (±10%) | Normal | ✅ confidence=100% |
| JSON vs Transcript >10% diff | Warning | ⚠️ Warn, use JSON, confidence=60% |
| JSON vs Transcript >50% diff | Error | ❌ Error, use JSON, confidence=30%, show 🔴 |
| Only JSON available | Acceptable | ✅ Use JSON, confidence=80% |
| Neither available | Fail | ❌ Use default (0), confidence=0%, show 🔴 |

**Validation Logic**:
```typescript
validateContextTokens(jsonTokens, transcriptTokens) {
  if (!jsonTokens && !transcriptTokens) {
    return { confidence: 0, errors: ['No token data available'] };
  }

  if (!transcriptTokens) {
    return { confidence: 80, warnings: ['Single source only'] };
  }

  const diff = Math.abs(jsonTokens - transcriptTokens);
  const pctDiff = (diff / jsonTokens) * 100;

  if (pctDiff <= 10) {
    return { confidence: 100, warnings: [] };
  } else if (pctDiff <= 50) {
    return {
      confidence: 60,
      warnings: [`Token mismatch ${pctDiff.toFixed(0)}%: JSON=${jsonTokens}, Transcript=${transcriptTokens}`]
    };
  } else {
    return {
      confidence: 30,
      errors: [`Large token mismatch ${pctDiff.toFixed(0)}%`],
      showStaleIndicator: true
    };
  }
}
```

---

### 3. Cost Validation

| Condition | Rule | Action |
|-----------|------|--------|
| ccusage ≈ Transcript estimate (±$1) | Normal | ✅ confidence=100% |
| ccusage vs Transcript >$5 diff | Warning | ⚠️ Warn, use ccusage, confidence=80% |
| ccusage only | Acceptable | ✅ Use ccusage, confidence=90% |
| Neither available | Fail | ❌ Use default ($0), confidence=0% |

**Validation Logic**:
```typescript
validateCost(ccusageCost, transcriptCost) {
  if (!ccusageCost) {
    return { confidence: 0, errors: ['No cost data'] };
  }

  if (!transcriptCost) {
    return { confidence: 90, warnings: ['Single source (ccusage)'] };
  }

  const diff = Math.abs(ccusageCost - transcriptCost);

  if (diff <= 1.0) {
    return { confidence: 100, warnings: [] };
  } else if (diff <= 5.0) {
    return {
      confidence: 80,
      warnings: [`Cost mismatch $${diff.toFixed(2)}: ccusage=$${ccusageCost}, transcript=$${transcriptCost}`]
    };
  } else {
    return {
      confidence: 60,
      warnings: [`Large cost mismatch $${diff.toFixed(2)}`]
    };
  }
}
```

---

### 4. Weekly Usage Validation

| Condition | Rule | Action |
|-----------|------|--------|
| weekly === sum(blocks) | Consistent | ✅ confidence=100% |
| weekly ≠ sum(blocks) | Error | ❌ Error, use weekly (authoritative), confidence=70% |

**Validation Logic**:
```typescript
validateWeeklyUsage(weeklyTotal, blocksSum) {
  const diff = Math.abs(weeklyTotal - blocksSum);
  const pctDiff = (diff / weeklyTotal) * 100;

  if (pctDiff <= 5) {
    return { confidence: 100, warnings: [] };
  } else {
    return {
      confidence: 70,
      errors: [`Weekly usage mismatch: weekly=$${weeklyTotal}, blocks=$${blocksSum}`]
    };
  }
}
```

---

### 5. Git Branch Validation

| Condition | Rule | Action |
|-----------|------|--------|
| git status === .git/HEAD | Consistent | ✅ confidence=100% |
| git status ≠ .git/HEAD | Error | ❌ Error, use git status, confidence=80% |
| Only git status | Acceptable | ✅ Use git status, confidence=95% |

---

### 6. Timestamp Validation (Clock Skew)

| Condition | Rule | Action |
|-----------|------|--------|
| System clock ≈ File mtime (±5min) | Normal | ✅ confidence=100% |
| Clock skew >5min | Warning | ⚠️ Warn about clock skew, confidence=70% |
| Clock skew >1hour | Error | ❌ Error, time may be unreliable, show 🔴 |

---

## Implementation Design

### Core Types

```typescript
// validation-engine.ts

interface DataSource<T> {
  name: string;          // 'json_stdin' | 'transcript' | 'settings.json' | ...
  fetch: () => Promise<T>;
  priority: number;      // 1=primary, 2=secondary, 3=tertiary
  ttl: number;          // How long data is considered fresh (ms)
}

interface ValidationRule<T> {
  name: string;
  validate: (primary: T, secondary: T[]) => ValidationResult;
}

interface ValidationResult {
  valid: boolean;
  confidence: number;    // 0-100
  warnings: string[];
  errors: string[];
  recommendedSource: string;  // Which source to use
  metadata: {
    sourceAgreement: number;   // % of sources that agree
    validationLatency: number; // Time to validate (ms)
    staleness: number;         // Age of oldest source (ms)
  };
}

interface ValidationMetrics {
  successRate: number;         // % of validations that passed
  sourceAgreementRate: number; // % of times sources agree
  avgValidationLatency: number;
  falsePositiveRate: number;   // % of warnings that were incorrect
}
```

---

### Validator Classes

```typescript
// validators/model-validator.ts

export class ModelValidator implements Validator<string> {
  validate(primary: DataPoint<string>, secondary: DataPoint<string>[]): ValidationResult {
    // Implementation from validation logic above
  }
}

// validators/context-validator.ts

export class ContextValidator implements Validator<number> {
  validate(primary: DataPoint<number>, secondary: DataPoint<number>[]): ValidationResult {
    // Implementation from validation logic above
  }
}

// validators/cost-validator.ts

export class CostValidator implements Validator<number> {
  validate(primary: DataPoint<number>, secondary: DataPoint<number>[]): ValidationResult {
    // Implementation from validation logic above
  }
}

// validators/timestamp-validator.ts

export class TimestampValidator implements Validator<Date> {
  validate(primary: DataPoint<Date>, secondary: DataPoint<Date>[]): ValidationResult {
    // Check for clock skew
  }
}

// validators/git-validator.ts

export class GitValidator implements Validator<string> {
  validate(primary: DataPoint<string>, secondary: DataPoint<string>[]): ValidationResult {
    // Compare git status vs .git/HEAD
  }
}
```

---

### Validation Engine

```typescript
// validation-engine.ts

export class ValidationEngine {
  private validators: Map<string, Validator<any>> = new Map();
  private metrics: Map<string, ValidationMetrics> = new Map();

  registerValidator(dataType: string, validator: Validator<any>) {
    this.validators.set(dataType, validator);
  }

  async validate<T>(
    dataType: string,
    primary: DataPoint<T>,
    secondary: DataPoint<T>[]
  ): Promise<ValidationResult> {
    const validator = this.validators.get(dataType);
    if (!validator) {
      throw new Error(`No validator registered for ${dataType}`);
    }

    const startTime = performance.now();
    const result = await validator.validate(primary, secondary);
    const latency = performance.now() - startTime;

    // Update metrics
    this.updateMetrics(dataType, result, latency);

    return result;
  }

  private updateMetrics(dataType: string, result: ValidationResult, latency: number) {
    if (!this.metrics.has(dataType)) {
      this.metrics.set(dataType, {
        successRate: 0,
        sourceAgreementRate: 0,
        avgValidationLatency: 0,
        falsePositiveRate: 0
      });
    }

    const metrics = this.metrics.get(dataType)!;

    // Update rolling averages
    metrics.avgValidationLatency = (metrics.avgValidationLatency * 0.9) + (latency * 0.1);
    metrics.successRate = (metrics.successRate * 0.9) + ((result.valid ? 100 : 0) * 0.1);
    metrics.sourceAgreementRate = (metrics.sourceAgreementRate * 0.9) +
      (result.metadata.sourceAgreement * 0.1);
  }

  getMetrics(dataType: string): ValidationMetrics | null {
    return this.metrics.get(dataType) || null;
  }

  getOverallHealth(): {
    avgSuccessRate: number;
    avgLatency: number;
    worstPerformer: string | null;
  } {
    const allMetrics = Array.from(this.metrics.entries());

    if (allMetrics.length === 0) {
      return { avgSuccessRate: 100, avgLatency: 0, worstPerformer: null };
    }

    const avgSuccessRate = allMetrics.reduce((sum, [_, m]) => sum + m.successRate, 0) / allMetrics.length;
    const avgLatency = allMetrics.reduce((sum, [_, m]) => sum + m.avgValidationLatency, 0) / allMetrics.length;

    const worst = allMetrics.reduce((min, [name, metrics]) => {
      return metrics.successRate < (min?.metrics.successRate || 100)
        ? { name, metrics }
        : min;
    }, null as { name: string; metrics: ValidationMetrics } | null);

    return {
      avgSuccessRate,
      avgLatency,
      worstPerformer: worst?.name || null
    };
  }
}
```

---

## Integration with Data Broker

### Modified Data Flow

```typescript
// data-broker.ts (modified)

class DataBroker {
  private validationEngine: ValidationEngine;

  async getData<T>(
    moduleId: string,
    sessionId: string,
    options?: { validateSources?: boolean }
  ): Promise<{
    data: T;
    staleness: number;
    fromCache: boolean;
    validationResult?: ValidationResult;
  }> {
    const module = this.modules.get(moduleId);

    // Fetch primary source
    const primaryData = await module.fetch(sessionId);

    // Validate if requested (default: true for critical modules)
    let validationResult: ValidationResult | undefined;

    if (options?.validateSources !== false && module.hasSecondary) {
      // Fetch secondary sources in background (don't block)
      const secondaryPromises = module.secondarySources.map(s => s.fetch(sessionId));

      // Wait for secondary sources with timeout (don't block too long)
      const secondaryData = await Promise.race([
        Promise.all(secondaryPromises),
        new Promise<null[]>((resolve) => setTimeout(() => resolve([]), 500)) // 500ms timeout
      ]);

      // Validate
      if (secondaryData && secondaryData.some(d => d !== null)) {
        validationResult = await this.validationEngine.validate(
          moduleId,
          { value: primaryData, source: 'primary' },
          secondaryData.filter(d => d !== null).map((d, i) => ({
            value: d,
            source: module.secondarySources[i].name
          }))
        );

        // Use recommended source if confidence low
        if (validationResult.confidence < 70) {
          // Log warning
          this.emit('validation:low-confidence', {
            moduleId,
            sessionId,
            confidence: validationResult.confidence,
            warnings: validationResult.warnings
          });

          // Show staleness indicator if very low confidence
          if (validationResult.confidence < 50) {
            this.emit('validation:stale-data', { moduleId, sessionId });
          }
        }
      }
    }

    return {
      data: primaryData,
      staleness: 0,
      fromCache: false,
      validationResult
    };
  }
}
```

---

## Monitoring & Alerting

### Metrics to Track

1. **Validation Success Rate** (target: >95%)
   - % of validations that pass without warnings

2. **Source Agreement Rate** (target: >90%)
   - % of times primary and secondary sources agree

3. **Validation Latency** (target: <500ms)
   - Time to fetch secondary sources and validate

4. **False Positive Rate** (target: <5%)
   - % of warnings that were incorrect (requires manual review)

5. **Confidence Distribution**
   - Histogram of confidence scores (0-100)

### Alert Thresholds

```yaml
alerts:
  - name: Low validation success rate
    condition: successRate < 95% over 1 hour
    severity: warning
    action: Log to Sentry

  - name: High source disagreement
    condition: agreementRate < 80% over 1 hour
    severity: error
    action: Log to Sentry, notify team

  - name: Slow validation
    condition: avgLatency > 1000ms
    severity: warning
    action: Log to Sentry

  - name: Critical module failing
    condition: moduleId=context AND successRate < 50%
    severity: critical
    action: Show 🔴, notify team, fallback to safe defaults
```

---

## Testing Strategy

### Unit Tests

```typescript
describe('ModelValidator', () => {
  test('Exact match: confidence=100%', () => {
    const result = validator.validate(
      { value: 'Sonnet', source: 'json' },
      [{ value: 'Sonnet', source: 'transcript' }]
    );

    expect(result.confidence).toBe(100);
    expect(result.warnings).toHaveLength(0);
  });

  test('Mismatch: confidence=70%, warning logged', () => {
    const result = validator.validate(
      { value: 'Sonnet', source: 'json' },
      [{ value: 'Haiku', source: 'transcript' }]
    );

    expect(result.confidence).toBe(70);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('mismatch');
  });
});
```

### Integration Tests

```typescript
describe('Validation Pipeline', () => {
  test('End-to-end: JSON + Transcript validation', async () => {
    const broker = new DataBroker();
    broker.registerValidator('context', new ContextValidator());

    // Fetch with validation
    const result = await broker.getData('context', 'session1', {
      validateSources: true
    });

    expect(result.validationResult).toBeDefined();
    expect(result.validationResult!.confidence).toBeGreaterThan(70);
  });
});
```

---

## Performance Considerations

### Optimization 1: Background Validation

Don't block primary data fetch waiting for secondary sources:

```typescript
// Fetch primary (fast)
const primaryData = await module.fetch(sessionId);

// Return immediately if no validation requested
if (!shouldValidate) {
  return { data: primaryData };
}

// Fetch secondary in background (don't await)
const secondaryPromise = fetchSecondary();

// Return primary, validation happens async
return {
  data: primaryData,
  validationPromise: secondaryPromise.then(validate)
};
```

### Optimization 2: Validation Throttling

Don't validate every fetch (expensive for frequent calls):

```typescript
// Only validate every N fetches or every M seconds
if (fetchCount % 10 === 0 || timeSinceLastValidation > 60000) {
  validateSources = true;
}
```

### Optimization 3: Smart Source Selection

Skip slow secondary sources if primary is high confidence:

```typescript
if (primarySource.historicalConfidence > 95) {
  // Skip expensive secondary checks
  return { data: primaryData, confidence: 95 };
}
```

---

## Next Steps

1. [ ] Implement ValidationEngine core class
2. [ ] Implement ModelValidator
3. [ ] Implement ContextValidator
4. [ ] Implement CostValidator
5. [ ] Add validation to DataBroker
6. [ ] Write unit tests for each validator
7. [ ] Write integration tests for validation pipeline
8. [ ] Add Sentry alerting for validation failures
9. [ ] Create validation metrics dashboard
10. [ ] Document validation results in statusline debug mode

---

## References

- [Plan: Phase 2](../../.claude/plans/shimmying-meandering-shell.md#phase-2-multi-source-data-validation)
- [DATA_SOURCES.md](../../DATA_SOURCES.md) - All data sources documented
- [Architecture](./ARCHITECTURE.md) - Overall v2 architecture
