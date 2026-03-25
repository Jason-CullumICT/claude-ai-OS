# Tiered Merge Pipeline — Traceability Report

**Reporter:** traceability-reporter
**Team:** TheATeam
**Date:** 2026-03-25
**Specification:** `Specifications/tiered-merge-pipeline.md`
**Design:** `Plans/tiered-merge-pipeline/design.md`

---

## Summary

- **All 26 tests pass** (0 failures)
- **10/10 FRs have source-level traceability comments**
- **8/10 FRs have dedicated test coverage** (FR-TMP-002 and FR-TMP-008 lack dedicated tests)
- **3 findings** requiring attention (1 MEDIUM, 2 LOW)

---

## FR Traceability Matrix

| FR | Description | Source `// Verifies:` | Test `// Verifies:` | Status |
|----|-------------|----------------------|---------------------|--------|
| FR-TMP-001 | Risk Classification | workflow-engine.js:688,720; dispatch.js:130,289 | test.js:63 (4 tests) | PASS |
| FR-TMP-002 | QA E2E Prompt Injection | dispatch.js:130,173,203; workflow-engine.js:535,741 | **None** | PARTIAL |
| FR-TMP-003 | Playwright E2E Runner | workflow-engine.js:157,175,192,200,997,1011 | test.js:95 (4 tests) | PASS |
| FR-TMP-004 | Auto-PR Creation | workflow-engine.js:259,276,301,1093 | test.js:198 (3 tests) | PASS |
| FR-TMP-005 | AI PR Review | workflow-engine.js:340,345,373,411,435 | test.js:265 (4 tests) | PASS |
| FR-TMP-006 | Auto-Merge Logic | workflow-engine.js:454,467,1093 | test.js:340 (6 tests) | PASS |
| FR-TMP-007 | Configuration | config.js:36 | test.js:455 (1 test) | PASS |
| FR-TMP-008 | Worker Prerequisites | Dockerfile.worker:26 | **None** (infrastructure) | PASS |
| FR-TMP-009 | Run JSON Extensions | workflow-engine.js:209,326,626,1064,1121; server.js:349 | test.js:466 (1 test) | PASS |
| FR-TMP-010 | Error Handling | workflow-engine.js:165,184,264,318,416,506,1069,1125 | test.js:484 (3 tests) | PASS |

---

## Test Results

```
node --test docker/orchestrator/lib/workflow-engine.test.js

# tests 26
# suites 8
# pass 26
# fail 0
# cancelled 0
# skipped 0
# duration_ms 979ms
```

### Test Suite Breakdown

| Suite | FR | Tests | Result |
|-------|-----|-------|--------|
| Risk Classification | FR-TMP-001 | 4 | PASS |
| _runPlaywrightE2E | FR-TMP-003 | 4 | PASS |
| _createPR | FR-TMP-004 | 3 | PASS |
| _aiReviewPR | FR-TMP-005 | 4 | PASS |
| _autoMerge | FR-TMP-006 | 6 | PASS |
| Configuration | FR-TMP-007 | 1 | PASS |
| Run JSON Extensions | FR-TMP-009 | 1 | PASS |
| Error Handling | FR-TMP-010 | 3 | PASS |

---

## Findings

### MEDIUM-001: FR-TMP-002 lacks dedicated test coverage

**Severity:** MEDIUM
**File:** `docker/orchestrator/lib/dispatch.js:131-196`
**FR:** FR-TMP-002 (QA E2E Prompt Injection)

The `buildAgentPrompt()` function's E2E test generation injection (lines 173-193) and `runId` parameter threading (line 131, 204) have source-level traceability comments but **no dedicated unit tests** verifying:
1. That QA agents receive E2E test generation instructions when `runId` is provided
2. That implementation agents do NOT receive E2E instructions
3. That `runId` is correctly threaded through `parseDispatchPlan()`
4. That the `enrichTaskForLeader()` function appends risk classification instructions

**Impact:** Regressions to QA prompt injection or leader task enrichment would not be caught by the test suite.

**Recommendation:** Add test cases for `buildAgentPrompt()` and `enrichTaskForLeader()` in a dispatch.test.js file.

---

### LOW-001: Auto-merge allows "skipped" E2E status

**Severity:** LOW
**File:** `docker/orchestrator/lib/workflow-engine.js:472,478`
**FR:** FR-TMP-006

The `_autoMerge` decision matrix treats `e2eStatus === "skipped"` the same as `"passed"` for auto-merge eligibility. The FR-TMP-006 spec table lists only "pass" as the E2E condition for auto-merge.

However, this is consistent with:
- FR-TMP-010: "QA agent doesn't write E2E tests -> Skip E2E phase, log warning, proceed"
- NFR-2: "All new phases are additive — existing pipeline behavior unchanged when E2E tests don't exist"

**Impact:** Low. This is a deliberate design choice for backward compatibility. Cycles without E2E tests will auto-merge without E2E validation, which matches the NFR intent. However, the FR-TMP-006 spec table should be updated to explicitly document the "skipped" case.

---

### LOW-002: Potential shell injection in PR title/body construction

**Severity:** LOW
**File:** `docker/orchestrator/lib/workflow-engine.js:277-313`
**FR:** FR-TMP-004

The `_createPR` method constructs shell commands with user-provided task text. While double-quote escaping is applied (`replace(/"/g, '\\\"')`), the escaping does not cover all shell metacharacters:
- Backticks (`` ` ``) could execute subcommands
- `$()` sequences could trigger command substitution
- `\n` within task titles is escaped but could interact with heredoc-like patterns

**Mitigation:** The task text originates from the `/api/work` POST body, which is controlled by the orchestrator operator (not untrusted users). The risk is low in practice but violates defense-in-depth principles.

**Recommendation:** Use `gh pr create` with `--title` and `--body` passed via stdin or environment variables instead of shell string interpolation to eliminate injection risk entirely.

---

## Architecture Compliance

| Rule | Status | Notes |
|------|--------|-------|
| Specs are source of truth | PASS | All FRs trace to Specifications/tiered-merge-pipeline.md |
| Every FR has `// Verifies:` | PASS | All 10 FRs have source-level comments |
| Every FR has test | PARTIAL | FR-TMP-002 missing tests, FR-TMP-008 N/A (infrastructure) |
| No hardcoded secrets | PASS | GITHUB_TOKEN read from env |
| Graceful degradation (NFR-3) | PASS | All new methods wrap in try/catch, skip gracefully |
| Additive changes (NFR-2) | PASS | Existing phases 0-6, 8 unchanged |
| Observability | INFO | Uses `console.log`/`console.warn` — consistent with existing codebase (no logger abstraction exists yet) |

---

## File Change Coverage

| File | Modified | Has Traceability | Has Tests |
|------|----------|-----------------|-----------|
| `docker/orchestrator/lib/workflow-engine.js` | Yes | Yes (32 comments) | Yes (22 tests) |
| `docker/orchestrator/lib/dispatch.js` | Yes | Yes (4 comments) | **No** |
| `docker/orchestrator/lib/config.js` | Yes | Yes (1 comment) | Yes (1 test) |
| `docker/Dockerfile.worker` | Yes | Yes (1 comment) | N/A |
| `docker/orchestrator/server.js` | Yes | Yes (1 comment) | No (minor change) |
| `docker/orchestrator/lib/workflow-engine.test.js` | New | Yes (8 suites) | — |

---

## Verdict

**PASS with 1 MEDIUM finding.** All FRs are implemented with source-level traceability. 26/26 tests pass. The MEDIUM finding (missing FR-TMP-002 tests) should be addressed before merge to ensure prompt injection logic is regression-tested. The two LOW findings are informational and do not block merge.
