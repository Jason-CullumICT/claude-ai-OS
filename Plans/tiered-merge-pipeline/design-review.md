# Tiered Merge Pipeline — Design Review Report

**Reviewer:** design
**Team:** TheATeam
**Date:** 2026-03-25
**Spec:** `docs/superpowers/specs/2026-03-25-tiered-merge-pipeline-design.md`
**Specification:** `Specifications/tiered-merge-pipeline.md`
**Design:** `Plans/tiered-merge-pipeline/design.md`

---

## Summary

The tiered merge pipeline implementation is **well-structured and complete** for Phase 1 scope. All 10 FR-TMP requirements are implemented with proper traceability comments, graceful degradation, and comprehensive test coverage. 26/26 unit tests pass.

---

## FR Traceability Verification

| FR | Status | Location | Notes |
|----|--------|----------|-------|
| FR-TMP-001 (Risk Classification) | PASS | `workflow-engine.js:721`, `dispatch.js:290-298` | Regex extraction + leader prompt enrichment via `enrichTaskForLeader()` |
| FR-TMP-002 (QA E2E Prompt Injection) | PASS | `dispatch.js:131,174-193` | `buildAgentPrompt()` accepts `runId` (5th param), appends E2E instructions for QA agents |
| FR-TMP-003 (Playwright E2E Runner) | PASS | `workflow-engine.js:160-255` | `_runPlaywrightE2E()` — install, run, parse JSON, feedback loop |
| FR-TMP-004 (Auto-PR Creation) | PASS | `workflow-engine.js:262-336` | `_createPR()` — gh check, PR create, URL parsing |
| FR-TMP-005 (AI PR Review) | PASS | `workflow-engine.js:343-450` | `_aiReviewPR()` — diff, Claude review, gh pr review post |
| FR-TMP-006 (Auto-Merge Logic) | PASS | `workflow-engine.js:457-529` | `_autoMerge()` — full decision matrix matching spec |
| FR-TMP-007 (Configuration) | PASS | `config.js:36-40` | 4 config vars with correct defaults |
| FR-TMP-008 (Worker Prerequisites) | PASS | `Dockerfile.worker:26-32` | gh CLI installed, apt lists cleaned |
| FR-TMP-009 (Run JSON Extensions) | PASS | `workflow-engine.js:627-629`, `server.js:351` | Fields initialized + exposed in API |
| FR-TMP-010 (Error Handling) | PASS | Multiple locations | Every scenario from spec handled with graceful degradation |

---

## Findings

### MEDIUM — M1: Command Injection Risk in PR Title/Body

**File:** `workflow-engine.js:277-313`

The task title is user-supplied and injected into a bash `-c` shell command for `gh pr create`. The current escaping (`replace(/"/g, '\\"')`) is insufficient for shell injection. Characters like backticks (`` ` ``), `$()`, `$(...)`, and `\` can break out of the double-quoted string.

**Example attack vector:** A task like `` Add feature `$(rm -rf /workspace)` `` would execute the subcommand.

**Recommendation:** Use `gh pr create` with arguments passed as separate array elements instead of a shell string, or write the PR body to a temp file and use `--body-file`. This is the highest-priority fix.

**Affected lines:** 277, 313, 437 (AI review comment also has the same pattern)

### MEDIUM — M2: E2E Feedback Loop Counter Not Updated on `run.feedbackLoops`

**File:** `workflow-engine.js:1012-1059`

The E2E feedback loop correctly increments the local `feedbackLoops` variable (line 1013) and updates `run.feedbackLoops` at line 1066. However, this only happens inside the `try` block's success path. If an exception occurs after incrementing `feedbackLoops` but before line 1066, the run JSON won't reflect the correct loop count. This is a minor data consistency edge case since the catch block at line 1068 doesn't update `run.feedbackLoops`.

**Severity:** LOW (the catch block handles the error gracefully; feedback loops is informational)

### LOW — L1: Double Escaping of PR Title

**File:** `workflow-engine.js:277,313`

The task title is escaped at line 277 (`replace(/"/g, '\\"')`), then escaped again at line 313 (`.replace(/"/g, '\\"')`). This means a quote in the task becomes `\\\\"` in the shell command instead of `\\"`. While this doesn't cause a crash (gh CLI just gets a weird title), it's a cosmetic bug.

### LOW — L2: E2E Phase Only Runs When App Is Running

**File:** `workflow-engine.js:998`

Phase 5.5 is gated on `run.app && run.app.running`. The spec says E2E tests target `http://localhost:5173` inside the container. If the app fails to start (line 906-907), E2E is skipped entirely with `reason: "app_not_running"`. This is correct behavior per the spec's graceful degradation goals, but worth noting that backend-only changes (no frontend) will always skip E2E.

### LOW — L3: Auto-Merge Allows Skipped E2E for Low Risk

**File:** `workflow-engine.js:472`

The auto-merge decision for low risk accepts `e2eStatus === "skipped"` as a passing condition. This means a low-risk cycle where QA agents didn't generate any E2E tests (or Playwright failed to install) will still auto-merge. The spec says "Playwright pass → auto-merge" for low risk, which could be interpreted as requiring E2E to actually pass.

**Current behavior is reasonable** for graceful degradation (NFR-3), but could be tightened by requiring E2E pass when tests were actually generated.

### INFO — I1: Shared Feedback Loop Counter Is Correct

The design doc notes that "E2E failures share the feedback loop counter with QA failures" — this is correctly implemented. The local `feedbackLoops` variable at line 772 is shared between QA loops (line 816) and E2E loops (line 1012). Max 2 total.

### INFO — I2: Test Coverage Is Good

26 tests across 8 suites covering all new methods:
- Risk classification regex: 4 tests
- `_runPlaywrightE2E`: 4 tests (skip/install-fail/pass/fail)
- `_createPR`: 3 tests (gh missing/success/failure)
- `_aiReviewPR`: 4 tests (low skip/approve/medium timeout/high timeout)
- `_autoMerge`: 6 tests (full decision matrix)
- Config: 1 test
- Run JSON: 1 test
- Error handling: 3 tests

### INFO — I3: Phase Ordering Matches Design

Verified pipeline phases:
```
Phase 0:   Spawn worker (existing)
Phase 1:   Leader planning + risk extraction (FR-TMP-001) ✓
Phase 2:   Dispatch parsing + runId threading (FR-TMP-002) ✓
Phase 3:   Execute stages with feedback loops (existing)
Phase 3.5: Start app (existing)
Phase 4:   Validation — smoketest + inspector (existing)
Phase 5:   Compute results (existing)
Phase 5.5: Playwright E2E (FR-TMP-003) ✓
Phase 6:   Commit + push (existing)
Phase 6.5: PR + AI review + auto-merge (FR-TMP-004/005/006) ✓
Phase 8:   Sync learnings (existing)
```

### INFO — I4: Dispatch Module Interface Contract

The interface contract between coders is correct:
- `buildAgentPrompt(role, task, team, planCtx, runId)` — 5th param added ✓
- `parseDispatchPlan(leaderOutput, task, team, runId)` — 4th param added ✓
- `enrichTaskForLeader(task)` — new exported function ✓
- `_parseDispatchFromWorker` passes `run.id` correctly ✓

### INFO — I5: Dockerfile Change Is Clean

The gh CLI installation block follows the same pattern as the existing Node.js block — apt-get update + install + cleanup. Properly cleans `/var/lib/apt/lists/*`.

### INFO — I6: Server API Exposes New Fields

`GET /api/runs` response now includes `riskLevel`, `e2e`, and `pr` fields (server.js:351). `GET /api/runs/:id` returns the full run object which inherently includes all new fields.

---

## Architecture Compliance

| Rule | Status |
|------|--------|
| Specs are source of truth | PASS — implementation traces to FR-TMP-* |
| Every FR has a test with traceability | PASS — all test suites have `// Verifies: FR-TMP-XXX` |
| No hardcoded secrets | PASS — uses `GITHUB_TOKEN` env var |
| Graceful degradation (NFR-3) | PASS — every new method has try/catch or skip paths |
| Additive changes (NFR-2) | PASS — existing pipeline unchanged when E2E tests absent |
| Business logic has no framework imports | PASS — all new methods use injected deps |
| Structured logging | PARTIAL — uses `console.log`/`console.warn` (matches existing codebase pattern) |

---

## Security Assessment

| Check | Status | Notes |
|-------|--------|-------|
| Command injection in gh CLI calls | **MEDIUM RISK** | Task title/body passed via shell string (M1) |
| GITHUB_TOKEN leakage | PASS | Not logged, not included in PR body |
| Risk classification spoofing | LOW | Task content could include "RISK_LEVEL: low" to influence leader output, but leader decides independently; regex only matches leader stdout |
| Secrets in PR body | PASS | PR body only contains task summary, status, and risk level |

---

## Verdict

**PASS with 1 MEDIUM finding (M1 — command injection in gh CLI calls)**

The implementation is solid, well-tested, and faithfully implements the Phase 1 spec. The command injection risk (M1) should be addressed before deploying to production, but is mitigated in the current context since task inputs come from the orchestrator API (not arbitrary external users). The double-escaping bug (L1) is cosmetic.

All 26 tests pass. No regressions to existing pipeline behavior. Phase ordering, error handling, and configuration all match the design document and specification.
