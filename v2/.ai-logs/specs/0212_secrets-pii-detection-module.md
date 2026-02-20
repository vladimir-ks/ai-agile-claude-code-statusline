# Spec: Secrets & PII Detection Module

**Date**: 2026-02-12
**Status**: DRAFT
**Depends on**: Research report `reports/secrets-pii-detection-tools-research.md`

---

## Problem Statement

Current `SecretDetector` in production has:
- **11 regex patterns**, no severity system, no content validation
- **AWS Secret Key pattern** (`/[A-Za-z0-9/+=]{40}/`) matches ANY 40-char base64 string — ROOT CAUSE of false positives
- **No private key content validation** — matches regex discussion snippets
- **No PII detection** at all (emails, phones, SSN, credit cards)
- **Not reusable** — tightly coupled to transcript scanner extractor interface

Legacy `SecretsDetectorModule` has better patterns (20 total, severity system, private key validation) but is UNUSED.

**User requirement**: Separate, reusable module that can be embedded anywhere — statusline, mobile app, website, message cleaning pipeline.

---

## Architecture

```mermaid
graph TD
    subgraph "detection-engine/ (new module)"
        A[DetectionEngine] --> B[SecretRuleset]
        A --> C[PIIRuleset]
        A --> D[Validator]
        B --> E[Token Patterns<br>40+ rules]
        B --> F[Key Patterns<br>PEM/SSH]
        B --> G[Connection Strings<br>DB URLs]
        C --> H[Email/Phone/SSN]
        C --> I[Credit Card + Luhn]
        C --> J[Custom Patterns]
        D --> K[Entropy Check]
        D --> L[Content Validation]
        D --> M[Context Filtering]
    end

    subgraph "Consumers"
        N[Statusline<br>SecretDetector] --> A
        O[Future: Message<br>Sanitizer] --> A
        P[Future: WASM<br>Browser/Mobile] --> A
    end
```

### Design Principles

1. **Pure function** — `detect(text: string, config?: DetectionConfig): Finding[]`
2. **Zero dependencies** — No crypto, no fs, no network. Just regex + validation.
3. **Portable** — Works in Bun, Node, Deno, browser, WASM
4. **Configurable** — Enable/disable categories, set severity threshold, add allowlists
5. **<1ms** for typical chat message (~5KB)

---

## Module Structure

```
v2/src/lib/detection-engine/
  index.ts                    # Public API: detect(), DetectionEngine class
  types.ts                    # Finding, Rule, Config, Severity interfaces
  rulesets/
    secrets.ts                # Secret detection rules (tokens, keys, connections)
    pii.ts                    # PII detection rules (email, phone, SSN, CC)
    index.ts                  # Registry: getAllRules(), getByCategory()
  validators/
    entropy.ts                # Shannon entropy calculator
    luhn.ts                   # Luhn checksum for credit cards
    content.ts                # Private key content validator (base64 density)
    context.ts                # Context-aware filtering (code blocks, comments)
    index.ts                  # Validator registry
  allowlist.ts                # User-configurable allowlist (patterns to skip)
  utils.ts                    # Helpers: redact(), fingerprint()
```

---

## Data Model

```
interface Finding:
  type: string               # "github_token", "aws_key", "email", "ssn"
  category: "secret" | "pii"
  severity: "critical" | "high" | "medium" | "low"
  match: string              # Redacted: "ghp_...xyz7"
  offset: number             # Character offset in input
  length: number             # Match length
  confidence: number         # 0.0-1.0 (validators can adjust)
  rule: string               # Rule ID that matched
  context?: string           # Surrounding text (for debugging)

interface Rule:
  id: string                 # "github_pat_classic"
  category: "secret" | "pii"
  severity: Severity
  pattern: RegExp
  validator?: (match: string, context: string) => number  # Returns confidence 0-1
  description: string

interface DetectionConfig:
  categories?: ("secret" | "pii")[]     # Default: both
  minSeverity?: Severity                 # Default: "high"
  minConfidence?: number                 # Default: 0.7
  allowlist?: string[]                   # Regex patterns to skip
  maxFindings?: number                   # Default: 100 (cap for perf)
  includeContext?: boolean               # Include surrounding 40 chars
```

---

## Rules: Secrets (Layer 1 — In-Process)

### Critical: Exact Format Tokens (Confidence=1.0, zero false positives)

| ID | Pattern | Type |
|----|---------|------|
| `github_pat_classic` | `ghp_[A-Za-z0-9_]{36,}` | GitHub PAT |
| `github_pat_fine` | `github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9]{59}` | GitHub Fine-Grained |
| `github_oauth` | `gho_[a-zA-Z0-9]{36}` | GitHub OAuth |
| `gitlab_pat` | `glpat-[a-zA-Z0-9_-]{20,}` | GitLab PAT |
| `aws_access_key` | `(AKIA\|ASIA\|AROA\|AIDA)[A-Z0-9]{16}` | AWS Access Key |
| `stripe_live` | `sk_live_[A-Za-z0-9]{24,}` | Stripe Live Key |
| `slack_token` | `xox[baprs]-[A-Za-z0-9-]{10,}` | Slack Token |
| `google_api` | `AIza[0-9A-Za-z_-]{35}` | Google API Key |
| `sendgrid` | `SG\.[a-zA-Z0-9_-]{22}\.[a-zA-Z0-9_-]{43}` | SendGrid Key |
| `anthropic_key` | `sk-ant-[a-zA-Z0-9_-]{20,}` | Anthropic API Key |
| `openai_key` | `sk-[a-zA-Z0-9]{20,}` | OpenAI API Key |
| `discord_token` | `[MN][A-Za-z\d]{23,}\.\w{6}\.\w{27}` | Discord Token |
| `jwt` | `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | JWT |

### High: Structured Patterns (Confidence varies, need validation)

| ID | Pattern | Validator |
|----|---------|-----------|
| `private_key_pem` | `-----BEGIN.*PRIVATE KEY-----...-----END` | content validator: >80% base64, >200 chars, capped 4KB |
| `db_connection_postgres` | `postgres(ql)?://user:pass@host` | URI parse check |
| `db_connection_mongodb` | `mongodb(+srv)?://user:pass@host` | URI parse check |
| `db_connection_mysql` | `mysql://user:pass@host` | URI parse check |
| `db_connection_redis` | `redis://user:pass@host` | URI parse check |
| `azure_connection` | `DefaultEndpointsProtocol=...AccountKey=` | Key part base64 check |
| `twilio_key` | `SK[a-f0-9]{32}` | Entropy check >3.5 |

### Medium: Context-Dependent (Need assignment context)

| ID | Pattern | Context Required |
|----|---------|-----------------|
| `password_assign` | `password\s*[=:]\s*"[^"]{8,}"` | Not in comment/docs |
| `secret_assign` | `secret\s*[=:]\s*"[^"]{8,}"` | Not in comment/docs |
| `api_key_assign` | `api[_-]?key\s*[=:]\s*"[^"]{8,}"` | Not in comment/docs |

### REMOVED (vs current production)

| Pattern | Why Removed |
|---------|-------------|
| `[A-Za-z0-9/+=]{40}` (AWS Secret Key) | Matches ANY 40-char base64 string. Zero precision. |
| Generic `api_key=...` without quotes | Matches variable names in code |
| `sk_test_...` (Stripe test) | Test keys, not production secrets |

---

## Rules: PII (Layer 1 — In-Process)

| ID | Pattern | Validator | Severity |
|----|---------|-----------|----------|
| `email` | RFC 5322 simplified | TLD check against known list | medium |
| `phone_us` | `\d{3}[-.]?\d{3}[-.]?\d{4}` | Context: near "phone", "tel", "call", "mobile" | low |
| `phone_intl` | `\+\d{1,3}[-.\s]?\d{4,14}` | Length 7-15 digits | low |
| `ssn` | `\d{3}-\d{2}-\d{4}` | Area not 000/666/900-999, group not 00, serial not 0000 | critical |
| `credit_card` | `\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}` | **Luhn checksum** | critical |
| `ip_address` | `\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}` | Not 127.x, 0.x, 255.x, 192.168.x, 10.x, 172.16-31.x | low |

---

## Validators

### Entropy Validator
- Shannon entropy on match string
- Threshold: >4.0 for 20+ char strings = likely random/secret
- Below threshold: downgrade confidence by 0.3

### Content Validator (Private Keys)
- Extract between BEGIN/END markers
- Count base64 chars `[A-Za-z0-9+/=]`
- Require >80% base64 density AND >200 total chars
- Cap at 4KB to prevent regex runaway

### Luhn Validator (Credit Cards)
- Standard Luhn-10 checksum
- Reject if all same digit
- Reject if sequential (1234567890123456)

### Context Validator
- Skip matches inside markdown code fences (``` blocks)
- Skip matches in URLs (already visible, not leaked)
- Skip matches near "example", "test", "sample", "placeholder", "dummy"
- Downgrade confidence by 0.5 if in code block

---

## Public API

```
// Simple one-shot detection
detect(text: string, config?: DetectionConfig): Finding[]

// Reusable engine (pre-compiled rules, better for repeated calls)
class DetectionEngine:
  constructor(config?: DetectionConfig)
  detect(text: string): Finding[]
  addRule(rule: Rule): void
  setAllowlist(patterns: string[]): void

  // Convenience
  detectSecrets(text: string): Finding[]   # category=secret only
  detectPII(text: string): Finding[]       # category=pii only
  hasFindings(text: string): boolean       # Fast boolean check
  redactAll(text: string): string          # Replace findings with [REDACTED]
```

---

## Integration with Existing Codebase

### Phase 1: Replace Production SecretDetector (Immediate)

```mermaid
graph LR
    A[secrets-source.ts] --> B[UnifiedTranscriptScanner]
    B --> C["SecretDetector (current)"]
    C -. "REPLACE" .-> D["detection-engine/"]
```

**Change**: `SecretDetector.extract()` becomes a thin adapter:
- Converts `ParsedLine[]` → `string` (already has `stringifyData`)
- Calls `engine.detectSecrets(text)`
- Maps `Finding[]` → `Secret[]` (existing interface)

No changes to `secrets-source.ts`, `UnifiedTranscriptScanner`, or health data flow.

### Phase 2: Add PII Detection to Statusline

- New source descriptor: `pii-source.ts` (Tier 2, same as secrets)
- Or extend `secrets-source.ts` to also call `engine.detectPII()`
- New alert field: `health.alerts.piiDetected`, `health.alerts.piiTypes`
- Display: `🛡️ PII:email,phone` or similar

### Phase 3: Message Sanitizer (Future)

- `engine.redactAll(text)` for cleaning messages before send
- Used by mobile app, website, any message pipeline
- WASM build of detection-engine for browser

---

## Test Strategy

### Unit Tests (`detection-engine/`)

```
tests/detection-engine/
  rules/
    secrets.test.ts           # Every secret pattern: true positive + false positive
    pii.test.ts               # Every PII pattern: true positive + false positive
  validators/
    entropy.test.ts           # Entropy calculation edge cases
    luhn.test.ts              # Credit card validation
    content.test.ts           # Private key content validation
    context.test.ts           # Code block detection, example text
  engine.test.ts              # Full engine: config, allowlist, multi-rule
  integration.test.ts         # End-to-end: real transcript excerpts
  false-positives.test.ts     # DEDICATED: known false positive scenarios
  performance.test.ts         # <1ms for 5KB, <10ms for 50KB
```

### False Positive Test Cases (CRITICAL)

Must include:
- Base64-encoded UUIDs (40 chars) — MUST NOT match as "AWS Secret Key"
- Git commit SHAs (40 hex chars) — MUST NOT match
- npm package hashes — MUST NOT match
- Code discussion mentioning `-----BEGIN RSA PRIVATE KEY-----` without actual key content
- Regex patterns containing token prefixes (e.g., pattern: `/ghp_\w+/`)
- Test/example keys (e.g., `AKIAIOSFODNN7EXAMPLE`)
- Variable names like `api_key_validator`, `access_token_refresh`
- URLs containing base64 params
- Markdown code blocks containing real-looking but example secrets
- File paths containing "secret" or "key" in name

### True Positive Test Cases

Must include:
- Real format tokens for each provider (GitHub, AWS, Stripe, Slack, etc.)
- Private keys with real base64 content (>200 chars)
- Database connection strings with credentials
- JWT tokens with valid structure
- Credit cards passing Luhn (use well-known test numbers)
- SSN with valid area codes
- Emails with valid TLDs
- Phone numbers in context ("call me at 555-123-4567")

---

## Performance Budget

| Input Size | Target | Notes |
|------------|--------|-------|
| 1KB (chat message) | <0.5ms | Typical single message |
| 5KB (paragraph) | <1ms | Layer 1 target |
| 50KB (transcript page) | <10ms | Incremental scan chunk |
| 500KB (full transcript) | <100ms | Full rescan (rare) |

**Strategy**: Pre-compile all regex patterns in constructor. Engine instance is reusable.

---

## Migration Path

### Step 0: Create module directory + types + empty test stubs
### Step 1: Implement rules (secrets + PII) with tests
### Step 2: Implement validators with tests
### Step 3: Implement engine with tests
### Step 4: Integration test with real transcript samples
### Step 5: Wire into SecretDetector as adapter
### Step 6: Run full test suite — expect all 1626 existing tests pass
### Step 7: Add PII to statusline (Phase 2)

---

## Immediate Fix (Parallel — Task #153)

While building the new module, fix production NOW:
1. **Remove AWS Secret Key pattern** (line 47-51 in `secret-detector.ts`)
2. **Add private key content validation** (from legacy module lines 146-158)
3. **Add severity field** to `SecretPattern` interface
4. **Skip `medium` severity** in `extract()` loop

This is a 20-line change that eliminates the most egregious false positives immediately.

---

## Rejected Alternatives

| Alternative | Why Rejected |
|-------------|-------------|
| Gitleaks subprocess (Layer 2) | Adds external dep, 50-100ms latency, not portable to WASM. Revisit only if Layer 1 recall is insufficient. |
| TruffleHog | AGPL license — embedding poison |
| Nosey Parker | CLI-only, Vectorscan dep blocks WASM, heavy build chain |
| Presidio | Python, 200ms/req, 100MB+ spaCy models. Extracting PATTERNS only. |
| Hyperscan/Vectorscan | Overkill for single messages. Relevant at >1M msg/sec. |

---

## Success Criteria

1. **Zero false positives** for the AWS Secret Key scenario (current bug)
2. **All 13 critical secret types** detected with confidence >0.9
3. **Private keys** only flagged when real base64 content present
4. **PII detection** for email, phone, SSN, credit card
5. **<1ms** for typical chat message
6. **100% existing test suite** passes after integration
7. **Reusable** — importable as `import { detect } from './detection-engine'`
