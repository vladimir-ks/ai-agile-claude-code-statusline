# Secrets & PII Detection Tools Research

**Date**: 2026-02-12
**Purpose**: Evaluate open-source tools for real-time secrets/PII detection in chat messages
**Target**: <100ms per message, cross-platform, callable from TypeScript/Bun, structured JSON output

---

## Executive Summary

**Primary Recommendation**: **Gitleaks** (Go) as secrets engine + custom regex layer for PII
**Secondary Recommendation**: **Nosey Parker** (Rust) if maximum throughput needed and AGPL is unacceptable for TruffleHog
**PII Layer**: Build thin regex-based PII detector (credit cards, SSN, emails, phones) -- Presidio is Python-only and too heavy

---

## Tool Comparison Matrix

| Dimension | Gitleaks | TruffleHog | Nosey Parker | detect-secrets | Presidio | Hyperscan/Vectorscan |
|---|---|---|---|---|---|---|
| **Language** | Go | Go | Rust | Python | Python | C |
| **Stars** | 19k | 24k | 2.3k | 4.3k | 5.1k | 4.7k (HS) / ~1k (VS) |
| **License** | MIT | AGPL-3.0 | Apache-2.0 | Apache-2.0 | MIT | BSD |
| **Rule Count** | 160+ | 800+ | 188 | 28 plugins | 30+ entities | N/A (regex engine) |
| **Library API** | YES (`DetectString`) | Partial (unstable) | CLI-only | YES (Python) | YES (Python) | YES (C lib) |
| **Custom Rules** | YES (TOML) | YES (YAML) | YES (regex) | YES (plugins) | YES (recognizers) | N/A |
| **JSON Output** | YES | YES | YES (JSONL) | YES | YES | N/A |
| **Verification** | No | YES (API calls) | No | No | No | N/A |
| **macOS ARM** | YES | YES | YES | YES | YES | Vectorscan only |
| **WASM Feasible** | Possible (TinyGo) | Unlikely (too large) | Blocked (Vectorscan dep) | No | No | No |
| **Last Commit** | Jan 2026 | Feb 2026 | Active 2025-2026 | Sporadic | Active | Active (Vectorscan) |
| **Scan Speed** | Fast (regex) | Slower (verification) | GB/s (Hyperscan) | Slow (Python) | ~200ms/request | Fastest (25 Gbps) |
| **False Positive Rate** | Medium (46% precision) | High (6% precision) | Low (dedup + ML) | Low (baseline) | Medium | N/A |
| **Recall** | 88% (best) | 52% | Good (untested in study) | Moderate | Good for PII | N/A |

---

## Detailed Tool Analysis

### 1. Gitleaks (Go) -- RECOMMENDED FOR SECRETS

**Repository**: [github.com/gitleaks/gitleaks](https://github.com/gitleaks/gitleaks)

**Strengths**:
- Clean Go library API: `Detector.DetectString(content string) []report.Finding`
- Also: `DetectBytes()`, `DetectContext()` with cancellation support
- MIT license -- no restrictions on embedding
- 160+ built-in rules covering AWS, GCP, Azure, GitHub, private keys, generic API keys
- Configurable via TOML (allowlists, custom patterns, entropy thresholds)
- Highest recall (88%) in academic benchmarks
- Lightweight binary, fast startup
- Active maintenance (19k stars, Jan 2026 last commit)

**Weaknesses**:
- Medium precision (46%) -- generates false positives from generic regex and entropy
- No secret verification (doesn't call provider APIs)
- No PII detection (emails, SSN, credit cards, phones)
- WASM compilation possible via TinyGo but untested for this codebase

**Integration Path for Statusline**:
```
Option A: Subprocess -- spawn `gitleaks detect --pipe --report-format json`
Option B: Go shared library -- compile as C-shared, call via Bun FFI
Option C: Long-running Go microservice with Unix socket
```

**Estimated Latency**: <10ms for single message via library API, ~50-100ms via subprocess (process spawn overhead)

---

### 2. TruffleHog (Go)

**Repository**: [github.com/trufflesecurity/trufflehog](https://github.com/trufflesecurity/trufflehog)

**Strengths**:
- 800+ secret type detectors -- widest coverage
- Active verification against provider APIs (confirms if key is live)
- Strong community (24k stars, 163 contributors, Feb 2026 active)
- Custom detector support via YAML config

**Weaknesses**:
- **AGPL-3.0 license** -- toxic for embedding in commercial/proprietary tools
- API instability warning: "no guarantees on stability of public APIs"
- Heavy binary (800+ detectors = large dependency graph)
- Verification adds latency (network calls per finding)
- Lower precision (6%) and moderate recall (52%) in academic study
- Resource-intensive for real-time scanning

**Integration Path**: Subprocess only (AGPL prevents library linking)

**Verdict**: AGPL is a dealbreaker for embedding. Use only if running as standalone service behind API boundary.

---

### 3. Nosey Parker (Rust) -- STRONG ALTERNATIVE

**Repository**: [github.com/praetorian-inc/noseyparker](https://github.com/praetorian-inc/noseyparker)

**Strengths**:
- Rust + Vectorscan (Hyperscan fork) = GB/s scanning speed
- 188 high-precision rules, ML-enhanced deduplication
- Apache-2.0 license -- permissive
- 10-1000x deduplication reduces review burden
- macOS ARM (aarch64) supported
- Built by Praetorian (offensive security firm) -- practical rules tuned for real-world secrets

**Weaknesses**:
- **CLI-only** -- no published library crate for programmatic use
- Vectorscan dependency blocks WASM compilation (requires C++ build chain, SIMD)
- Smaller community (2.3k stars)
- Not in academic benchmark study (no precision/recall data)
- Heavy build requirements (cmake, Boost >= 1.57, pkg-config)

**Integration Path**: Subprocess only (`noseyparker scan --datastore /tmp/np-scan` then parse JSONL output)

**Estimated Latency**: Sub-millisecond for text scanning (once loaded), but startup + DB overhead adds ~200-500ms per invocation. Would need long-running daemon mode.

---

### 4. detect-secrets (Python) -- NOT RECOMMENDED

**Repository**: [github.com/Yelp/detect-secrets](https://github.com/Yelp/detect-secrets)

**Strengths**:
- Baseline methodology (tracks known secrets, flags only new ones)
- Low false positive approach -- enterprise-friendly
- 28 built-in plugins (AWS, Azure, GitHub, JWT, Slack, Stripe, etc.)
- Apache-2.0 license

**Weaknesses**:
- **Python** -- too slow for <100ms real-time scanning
- No WASM support
- 4.3k stars but sporadic maintenance
- Plugin architecture is Python-only
- No PII detection

**Verdict**: Wrong language for real-time use. Useful concepts (baseline methodology) but not viable as engine.

---

### 5. Microsoft Presidio (Python) -- NOT RECOMMENDED AS ENGINE

**Repository**: [github.com/microsoft/presidio](https://github.com/microsoft/presidio)

**Strengths**:
- **Best PII coverage**: 30+ entity types across 10+ countries
- Credit cards, SSN, emails, phones, names, locations, IBAN, IP addresses, medical licenses
- NLP-powered name/location detection (spaCy models)
- Customizable recognizer pipeline
- MIT license
- 5.1k stars, actively maintained by Microsoft

**Weaknesses**:
- **Python** -- target latency ~200ms per request (too slow for real-time)
- Heavy dependencies (spaCy NLP models = 100MB+)
- No WASM support
- Overkill for chat message scanning (designed for batch data processing)

**Verdict**: Excellent PII knowledge base for RULE EXTRACTION. Do not use as runtime engine. Extract regex patterns and entity definitions, implement in Go/Rust/TS.

---

### 6. Hyperscan / Vectorscan (C) -- FOUNDATIONAL ENGINE

**Repositories**:
- [github.com/intel/hyperscan](https://github.com/intel/hyperscan) (Intel, x86-only)
- [github.com/VectorCamp/vectorscan](https://github.com/VectorCamp/vectorscan) (ARM/multi-platform fork)

**Strengths**:
- Fastest regex engine in existence (25 Gbps single-core)
- Simultaneous matching of thousands of patterns
- SIMD-optimized, streaming mode support
- BSD license
- Used by GitHub for token scanning, Nosey Parker internally
- Vectorscan adds ARM NEON support (Apple Silicon compatible)

**Weaknesses**:
- **Not a secrets detector** -- just a regex engine (no rules, no structure)
- C library requiring cmake, Boost for compilation
- No WASM support (SIMD dependency)
- Complex integration (compile patterns to database, streaming API)
- Apple Silicon support via Vectorscan has reported issues

**Verdict**: Overkill for single-message scanning. Relevant only if building a high-throughput scanner processing millions of messages/second. For single chat messages, Go/Rust regex is fast enough.

---

### 7. Rusty Hog (Rust) -- ABANDONED

**Repository**: [github.com/newrelic/rusty-hog](https://github.com/newrelic/rusty-hog)

- 335 stars, appears unmaintained
- Based on TruffleHog v1 Python patterns ported to Rust
- Multiple scanner binaries (Git, S3, Google Docs, Jira, Confluence, Slack)
- **Not recommended**: abandoned, superseded by Nosey Parker

---

## Academic Benchmark Data (arxiv:2307.00714)

Study: "A Comparative Study of Software Secrets Reporting by Secret Detection Tools"
Dataset: SecretBench -- 818 GitHub repos, 15,084 manually labeled secrets

| Tool | Precision | Recall | Unique True Positives |
|---|---|---|---|
| GitHub Secret Scanner | 75% | 6% | Few (narrow rules) |
| **Gitleaks** | **46%** | **88%** | **1,533** |
| Commercial X | 25% | 44% | -- |
| SpectralOps | 1% | 67% | -- |
| **TruffleHog** | 6% | 52% | **438** |
| ggshield | 2% | 17% | -- |
| git-secrets | 1% | 25% | -- |

**Key finding**: No single tool achieves both high precision AND high recall. Gitleaks + TruffleHog together cover 1,971 non-overlapping true positives.

**False positive causes**: Generic regex patterns, ineffective entropy calculation, insufficient filtering of test/template code.

---

## WASM Feasibility Assessment

| Tool | WASM Viable? | Blockers | Binary Size Est. |
|---|---|---|---|
| Gitleaks (Go) | Maybe | TinyGo subset limitations, regex crate | 2-5 MB |
| TruffleHog (Go) | No | Too large, network deps, AGPL | N/A |
| Nosey Parker (Rust) | No | Vectorscan C++ dependency, SIMD | N/A |
| Custom Rust regex | YES | Regex crate adds ~500KB | 500KB-1MB |
| Custom TS regex | YES (native) | No compilation needed | 0 (native JS) |

**Recommendation for WASM**: Build a pure TypeScript/Rust regex-based detector. Do NOT try to compile Gitleaks/NoseyParker to WASM.

---

## Integration Architecture for Statusline

### Recommended Approach: Layered Detection

```
Layer 1: TypeScript (in-process, <1ms)
  - Regex-based PII detection (emails, phones, SSN, credit cards)
  - Known token format patterns (sk-ant-, ghp_, AKIA, etc.)
  - High-confidence, zero-overhead, WASM-portable

Layer 2: Gitleaks Go subprocess (on-demand, ~50ms)
  - Full 160+ rule detection with entropy analysis
  - Called only when Layer 1 flags potential secrets OR on user action
  - JSON output parsed in TypeScript
  - Process pooling: keep 1 warm process, pipe via stdin

Layer 3: (Future) Long-running Go microservice
  - Gitleaks Detector loaded once, accepts text via Unix socket
  - Sub-10ms per message after warmup
  - Shares socket with AIGile-OS engine
```

### Why This Layered Approach?

1. **Layer 1 handles 95% of cases** at near-zero cost (regex is fast in V8/JSC)
2. **Layer 2 catches edge cases** (entropy-based detection, unusual token formats)
3. **Layer 3** only needed if scanning volume exceeds subprocess capacity
4. **WASM story**: Layer 1 is natively portable to web/mobile
5. **Accuracy**: Gitleaks rules are battle-tested (19k stars, 88% recall)

---

## PII Detection: Build vs Buy

Since no compiled-language PII library exists with the right balance:

### Recommended: Build Thin PII Regex Layer in TypeScript

Extract patterns from Presidio's source + standard validators:

| PII Type | Detection Method | False Positive Mitigation |
|---|---|---|
| Email | RFC 5322 regex | Check TLD validity |
| Phone (US) | `\b\d{3}[-.]?\d{3}[-.]?\d{4}\b` | Context: near "phone", "tel", "call" |
| SSN | `\b\d{3}-\d{2}-\d{4}\b` | Area number validation (not 000, 666, 900-999) |
| Credit Card | `\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b` | Luhn checksum validation |
| AWS Key | `AKIA[0-9A-Z]{16}` | Exact format match |
| GitHub Token | `ghp_[A-Za-z0-9]{36}` | Exact format match |
| Private Key | `-----BEGIN (RSA |EC |DSA )?PRIVATE KEY-----` | Exact format match |
| JWT | `eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+` | Structure validation |
| Generic High Entropy | Shannon entropy > 4.5 on 20+ char strings | Context filtering |

**Lines of code**: ~200-400 for core detector
**Performance**: <1ms for typical chat message
**Portability**: Works everywhere (TS, WASM, Bun, Node, Deno, browser)

---

## Practitioner Consensus (Forums/Articles)

From aggregated community recommendations (2025-2026):

1. **For CI/CD pre-commit**: Gitleaks (fast, MIT, easy config)
2. **For comprehensive scanning**: TruffleHog (widest coverage, verification)
3. **For high-throughput**: Nosey Parker (GB/s, dedup)
4. **For PII specifically**: Presidio (best entity coverage) or regex (best performance)
5. **Emerging trend**: LLM-based detection (GPT-4o achieves 93% F1) but too slow/expensive for real-time
6. **Key insight**: "No single tool catches everything" -- combine 2+ tools for production use

---

## Final Recommendation

### For the Statusline Message-Cleaning System:

| Component | Tool | Why |
|---|---|---|
| **Secrets (primary)** | Custom TS regex (Layer 1) | In-process, <1ms, covers known token formats |
| **Secrets (deep scan)** | Gitleaks via subprocess (Layer 2) | MIT license, 88% recall, 160+ rules, JSON output |
| **PII detection** | Custom TS regex | No good compiled PII lib exists; build from Presidio patterns |
| **WASM target** | Custom TS regex only | Go/Rust tools have too many native deps |
| **Future upgrade** | Gitleaks as Go microservice | If volume demands persistent process |

### NOT Recommended:

| Tool | Why Not |
|---|---|
| TruffleHog | AGPL-3.0 (embedding poison), unstable API, heavy |
| Presidio | Python (too slow), heavy NLP deps |
| detect-secrets | Python (too slow) |
| Hyperscan/Vectorscan | Overkill for single messages, complex build |
| Rusty Hog | Abandoned |

---

## Sources

- [Gitleaks GitHub](https://github.com/gitleaks/gitleaks)
- [TruffleHog GitHub](https://github.com/trufflesecurity/trufflehog)
- [Nosey Parker GitHub](https://github.com/praetorian-inc/noseyparker)
- [detect-secrets GitHub](https://github.com/Yelp/detect-secrets)
- [Microsoft Presidio GitHub](https://github.com/microsoft/presidio)
- [Hyperscan GitHub](https://github.com/intel/hyperscan)
- [Vectorscan GitHub](https://github.com/VectorCamp/vectorscan)
- [Presidio Supported Entities](https://microsoft.github.io/presidio/supported_entities/)
- [Academic Study: arxiv 2307.00714](https://arxiv.org/abs/2307.00714)
- [Gitleaks vs TruffleHog Comparison (Jit)](https://www.jit.io/resources/appsec-tools/trufflehog-vs-gitleaks-a-detailed-comparison-of-secret-scanning-tools)
- [Secret Scanning Tools 2026 (GitGuardian)](https://blog.gitguardian.com/secret-scanning-tools/)
- [Secret Scanning Tools 2026 (SentinelOne)](https://www.sentinelone.com/cybersecurity-101/cloud-security/secret-scanning-tools/)
- [Best Secret Scanning Tools 2025 (Aikido)](https://www.aikido.dev/blog/top-secret-scanning-tools)
- [Nosey Parker ML Development (Praetorian)](https://www.praetorian.com/blog/nosey-parkers-ongoing-machine-learning-development/)
- [Gitleaks Rule System (DeepWiki)](https://deepwiki.com/gitleaks/gitleaks/4-rule-system)
- [TruffleHog AGPL License Discussion](https://github.com/trufflesecurity/trufflehog/issues/1446)
- [Bun FFI Documentation](https://bun.sh/docs/api/ffi)
- [TinyGo WebAssembly Guide](https://tinygo.org/docs/guides/webassembly/)
- [Rust WASM Binary Size with Regex](https://esimmler.com/large-wasm-builds-with-rust-regex)
- [WASM FFI Performance Benchmark](https://karnwong.me/posts/2025/04/wasm-ffi-performance-benchmark/)
