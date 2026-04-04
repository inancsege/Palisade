# Roadmap: Palisade

## Overview

Palisade v0.1 established a working prompt injection detection proxy with a regex pattern engine, HTTP proxy, and CLI. This milestone hardens Tier 1: first closing active security bypass vectors, then building test infrastructure, hardening the detection pipeline against known evasion techniques, and finally proving everything works through comprehensive test coverage. The ordering is deliberate -- fixing broken behavior before testing it means writing tests once, not rewriting them.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [ ] **Phase 1: Critical Security Fixes** - Close active bypass vectors and fix silent error swallowing
- [ ] **Phase 2: Test Infrastructure and Operational Fixes** - Build shared test helpers, linting safety net, and fix operational gaps
- [ ] **Phase 3: Normalizer Hardening** - Add evasion-resistant preprocessing to defeat encoding and character substitution bypasses
- [ ] **Phase 4: Scoring, Thresholds, and ReDoS Safety** - Fix scoring formula, make thresholds configurable, add input limits, and audit all regex patterns for ReDoS
- [ ] **Phase 5: Pattern Corpus Tests** - Fixture-driven tests for all five pattern categories with mustMatch and mustNotMatch cases
- [ ] **Phase 6: Pattern Safety and Regression Tests** - ReDoS timing tests and false positive regression suite with real-world benign content
- [ ] **Phase 7: Pipeline Integration Tests** - End-to-end pipeline tests covering extract-to-verdict, scan-to-log, streaming, errors, and concurrency
- [ ] **Phase 8: CLI Tests and Coverage Gate** - Test all CLI commands and enforce code coverage thresholds

## Phase Details

### Phase 1: Critical Security Fixes
**Goal**: The proxy fails closed on every code path -- no request silently bypasses detection, no error is silently swallowed
**Depends on**: Nothing (first phase)
**Requirements**: SECF-01, SECF-02, SECF-03, SECF-04
**Success Criteria** (what must be TRUE):
  1. A POST request with Content-Type application/json but an unparseable body receives HTTP 403 (not silently forwarded to upstream)
  2. Pattern matches carry their per-pattern weight field through to threat score computation, producing different scores for high-weight vs low-weight pattern matches
  3. Errors during streaming response handling are logged via pino (not swallowed by empty catch blocks)
  4. Errors in async event logging (setImmediate callbacks) are caught and logged via pino (not silently lost)
**Plans**: 2 plans

Plans:
- [x] 01-01-PLAN.md -- Fail-closed JSON parsing and error visibility (SECF-01, SECF-03, SECF-04)
- [x] 01-02-PLAN.md -- Pattern weight propagation to scoring (SECF-02)

### Phase 2: Test Infrastructure and Operational Fixes
**Goal**: Shared test helpers and linting rules exist so that all subsequent test phases start from a solid foundation, and remaining operational gaps are closed
**Depends on**: Phase 1
**Requirements**: TEST-01, TEST-02, TEST-03, SECF-05, SECF-06
**Success Criteria** (what must be TRUE):
  1. Test helper functions exist for building Anthropic and OpenAI request bodies, asserting blocked/allowed/warned verdicts, and running a configurable mock upstream server
  2. ESLint flat config with redos-detector and security plugins is installed and catches unsafe regex patterns and security anti-patterns in source code
  3. Running vitest with coverage flag produces a coverage report via @vitest/coverage-v8
  4. Starting the proxy with tier2.enabled or canary.enabled in the policy YAML logs a warning that these features are unimplemented
  5. Upstream fetch requests use AbortController with a configurable timeout (default 300s) instead of hanging indefinitely
**Plans**: 2 plans

Plans:
- [x] 02-01-PLAN.md -- Shared test helpers, ESLint flat config, and coverage tooling (TEST-01, TEST-02, TEST-03)
- [x] 02-02-PLAN.md -- Unimplemented feature warnings and upstream fetch timeout (SECF-05, SECF-06)

### Phase 3: Normalizer Hardening
**Goal**: The text normalizer defeats known evasion techniques so that regex patterns match injection content regardless of character encoding tricks
**Depends on**: Phase 1
**Requirements**: DETH-01, DETH-02, DETH-05, DETH-06
**Success Criteria** (what must be TRUE):
  1. Text containing zero-width Unicode characters (U+200B, U+200C, U+200D, U+FEFF) between injection keywords still triggers pattern matches after normalization
  2. Leet speak substitutions (h3ll0, @dmin, 1gnore, etc.) are normalized to ASCII equivalents before pattern matching
  3. Injection content hidden inside markdown formatting (headers, bold, links, code blocks) is detected after markdown stripping
  4. Cyrillic and Greek homoglyph characters that visually resemble ASCII letters are normalized to their ASCII equivalents before pattern matching
**Plans**: 2 plans

Plans:
- [ ] 03-01-PLAN.md -- Zero-width stripping, homoglyph normalization, markdown stripping in normalize() (DETH-01, DETH-05, DETH-06)
- [ ] 03-02-PLAN.md -- Leet speak variant decoder and Tier1Engine integration (DETH-02)

### Phase 4: Scoring, Thresholds, and ReDoS Safety
**Goal**: The scoring and threshold system is correct, configurable, and safe -- scores reflect pattern importance, thresholds come from policy, inputs are bounded, and no regex can hang the proxy
**Depends on**: Phase 1, Phase 3
**Requirements**: DETH-03, DETH-04, DETH-07, DETH-08
**Success Criteria** (what must be TRUE):
  1. Warn and block thresholds are read from policy YAML and changing them in the YAML changes verdict behavior without code changes
  2. Input text fields exceeding the configured length limit (default 10K chars) are truncated or rejected before scanning begins
  3. The scoring formula no longer decreases the overall score when additional low-confidence matches are added (the averaging quirk is eliminated)
  4. All 40+ regex patterns pass static ReDoS analysis via redos-detector with no catastrophic backtracking vulnerabilities identified
**Plans**: TBD

Plans:
- [ ] 04-01: TBD
- [ ] 04-02: TBD

### Phase 5: Pattern Corpus Tests
**Goal**: Every pattern category has comprehensive fixture-driven tests that prove detection accuracy for both malicious and benign inputs
**Depends on**: Phase 2, Phase 3, Phase 4
**Requirements**: PATT-01, PATT-02, PATT-03, PATT-04, PATT-05
**Success Criteria** (what must be TRUE):
  1. Role-markers pattern category has fixture-driven tests with mustMatch cases (injection payloads) and mustNotMatch cases (benign content)
  2. Override-phrases pattern category has fixture-driven tests with mustMatch and mustNotMatch cases
  3. Delimiter-escapes pattern category has fixture-driven tests with mustMatch and mustNotMatch cases
  4. Encoded-payloads pattern category has fixture-driven tests with mustMatch and mustNotMatch cases
  5. Exfiltration pattern category has fixture-driven tests with mustMatch and mustNotMatch cases
**Plans**: TBD

Plans:
- [ ] 05-01: TBD
- [ ] 05-02: TBD

### Phase 6: Pattern Safety and Regression Tests
**Goal**: Every regex pattern is proven safe against adversarial input and the detection engine is proven to not flag legitimate real-world content
**Depends on**: Phase 4, Phase 5
**Requirements**: PATT-06, PATT-07
**Success Criteria** (what must be TRUE):
  1. Every regex pattern has a timing test with adversarial input that completes in under 50ms (no catastrophic backtracking at runtime, not just static analysis)
  2. A false positive regression suite with real-world benign content (code snippets, documentation, security discussions, customer support conversations, prompt engineering content) passes with zero false detections
**Plans**: TBD

Plans:
- [ ] 06-01: TBD
- [ ] 06-02: TBD

### Phase 7: Pipeline Integration Tests
**Goal**: The full request lifecycle is validated end-to-end -- from HTTP request through detection to verdict and response, including streaming, errors, logging, and concurrent requests
**Depends on**: Phase 2, Phase 4
**Requirements**: PIPE-01, PIPE-02, PIPE-03, PIPE-04, PIPE-05
**Success Criteria** (what must be TRUE):
  1. Integration tests prove the extract-to-verdict pipeline produces correct verdicts for both Anthropic and OpenAI request formats
  2. Integration tests prove the scan-to-log pipeline writes detection events to the SQLite database
  3. Streaming response tests cover SSE pass-through, mid-stream failure handling, and text accumulation
  4. Error path tests verify malformed JSON returns 400, upstream timeout returns an appropriate error response, and oversized bodies are handled
  5. Concurrent requests are isolated from each other (one request's detection state does not leak into another)
**Plans**: TBD

Plans:
- [ ] 07-01: TBD
- [ ] 07-02: TBD

### Phase 8: CLI Tests and Coverage Gate
**Goal**: All CLI commands are tested and code coverage thresholds are enforced, completing the Tier 1 hardening milestone
**Depends on**: Phase 2, Phase 7
**Requirements**: CLIT-01, CLIT-02, CLIT-03, CLIT-04, COVR-01
**Success Criteria** (what must be TRUE):
  1. Scan command tests cover file scanning, directory walking, and output formatting
  2. Audit command tests cover duration parsing, event querying, and output
  3. Report command tests cover duration parsing, stats aggregation, and output
  4. Serve command tests cover server startup, config resolution, and graceful shutdown
  5. Code coverage thresholds are configured and enforced at 80%+ line coverage for src/
**Plans**: TBD

Plans:
- [ ] 08-01: TBD
- [ ] 08-02: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 1 -> 2 -> 3 -> 4 -> 5 -> 6 -> 7 -> 8

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Critical Security Fixes | 2/2 | Complete | 2026-04-04 |
| 2. Test Infrastructure and Operational Fixes | 0/2 | Planned | - |
| 3. Normalizer Hardening | 0/2 | Planned | - |
| 4. Scoring, Thresholds, and ReDoS Safety | 0/0 | Not started | - |
| 5. Pattern Corpus Tests | 0/0 | Not started | - |
| 6. Pattern Safety and Regression Tests | 0/0 | Not started | - |
| 7. Pipeline Integration Tests | 0/0 | Not started | - |
| 8. CLI Tests and Coverage Gate | 0/0 | Not started | - |
