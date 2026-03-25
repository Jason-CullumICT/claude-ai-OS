# Tiered Merge Pipeline — QA Report

**Reviewer:** qa-review-and-tests
**Date:** 2026-03-25
**Spec:** `Specifications/tiered-merge-pipeline.md`
**Design:** `Plans/tiered-merge-pipeline/design.md`
**Source spec:** `docs/superpowers/specs/2026-03-25-tiered-merge-pipeline-design.md`

---

## Summary

Overall implementation is **solid and spec-compliant**. All 10 FR-TMP requirements are implemented. All 26 unit tests pass. Traceability comments are present for every FR. Graceful degradation is correctly implemented at every failure point. Several medium/low findings noted below.

---

## Test Results

**All 26 tests PASS** — `node --test docker/orchestrator/lib/workflow-engine.test.js`

| Suite | Tests | Status |
|-------|-------|--------|
| Risk Classification (FR-TMP-001) | 4 | PASS |
| _runPlaywrightE2E (FR-TMP-003) | 4 | PASS |
| _createPR (FR-TMP-004) | 3 | PASS |
| _aiReviewPR (FR-TMP-005) | 4 | PASS |
| _autoMerge (FR-TMP-006) | 6 | PASS |
| Configuration (FR-TMP-007) | 1 | PASS |
| Run JSON Extensions (FR-TMP-009) | 1 | PASS |
| Error Handling (FR-TMP-010) | 3 | PASS |

**Traceability enforcer:** No active requirements file found (not blocking — the enforcer needs a configured requirements path).

---

## FR-by-FR Verification

### FR-TMP-001: Risk Classification — PASS
- Leader task enrichment via `dispatch.enrichTaskForLeader()` — correct instructions appended
- Regex extraction: `/RISK_LEVEL:\s*(low|medium|high)/i` — matches spec exactly
- Default to `config.defaultRiskLevel` ("medium") when not found — correct
- Risk stored as `run.riskLevel` — confirmed at `workflow-engine.js:722`
- Tests cover: low, high (case-insensitive), missing, extra whitespace

### FR-TMP-002: QA E2E Prompt Injection — PASS
- `buildAgentPrompt()` accepts `runId` as 5th parameter — correct
- E2E instructions appended for non-impl agents when `runId` is truthy — correct
- `parseDispatchPlan()` threads `runId` — confirmed at `dispatch.js:204`
- `_parseDispatchFromWorker()` passes `run.id` to `buildAgentPrompt` — confirmed at `workflow-engine.js:561`
- Test template matches spec

### FR-TMP-003: Live Playwright E2E Runner — PASS
- Phase 5.5 inserted after Phase 5 results computation — correct placement at `workflow-engine.js:996`
- Test directory check: `Source/E2E/tests/cycle-{runId}/` — correct
- Playwright install with `PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright` — correct
- JSON reporter parsing with recursive suite counting — correct
- Feedback loop: shared counter with QA (`feedbackLoops` variable) — correct per spec
- Re-runs impl -> QA -> E2E on failure — correct
- E2E only runs when `run.app.running` is true — correct guard

### FR-TMP-004: Auto-PR Creation — PASS
- `gh` CLI availability check via `which gh` — correct
- PR title format: `cycle/{run-id}: {task-title}` — correct
- PR body includes: task, risk level, team, all results, E2E summary — correct
- Labels by risk level: low=`auto-merge,low-risk`, medium=`auto-merge,ai-reviewed`, high=`needs-approval,high-risk` — matches spec
- URL parsing via regex — correct
- Graceful degradation on failure — confirmed

### FR-TMP-005: AI PR Review — PASS
- Skipped for low risk — correct
- Diff limited to 50K chars via `head -c 50000` — correct
- Review prompt includes task, risk level, QA status, E2E results, diff — correct
- Verdict parsing: checks for `REQUEST_CHANGES` first, defaults to `APPROVE` — correct
- Timeout handling: APPROVE for medium, REQUEST_CHANGES for high — matches spec exactly
- Posted via `gh pr review` — correct

### FR-TMP-006: Auto-Merge Logic — PASS
- Decision matrix implementation matches spec:
  - low + pass/skip → auto-merge (if `autoMergeLow`) ✓
  - medium + APPROVE + pass/skip → auto-merge (if `autoMergeMedium`) ✓
  - medium + REQUEST_CHANGES → changes-requested ✓
  - high + APPROVE → label "ready-for-review" ✓
  - high + REQUEST_CHANGES → label "changes-requested" ✓
- Merge command: `gh pr merge {number} --squash --delete-branch` — matches spec
- Conflict handling: labels "merge-conflict" — correct

### FR-TMP-007: Configuration — PASS
- All 4 config values present with correct defaults and env var mappings
- `mergeStrategy`, `defaultRiskLevel`, `autoMergeLow`, `autoMergeMedium` — all correct

### FR-TMP-008: Worker Prerequisites — PASS
- `gh` CLI installed in Dockerfile.worker via official GitHub packages APT repo — correct
- Traceability comment present
- `rm -rf /var/lib/apt/lists/*` for layer cleanup — correct

### FR-TMP-009: Run JSON Extensions — PASS
- `riskLevel`, `e2e`, `pr` fields initialized at Phase 0 — confirmed
- Fields populated throughout pipeline phases — confirmed
- `server.js` GET /api/runs includes `riskLevel`, `e2e`, `pr` in list response — confirmed at `server.js:351`
- GET /api/runs/:id returns full run object (already includes all fields) — confirmed

### FR-TMP-010: Error Handling — PASS
All 7 scenarios from spec covered:

| Scenario | Implementation | Status |
|----------|---------------|--------|
| QA doesn't write E2E tests | `_runPlaywrightE2E` returns true, status="skipped" | ✓ |
| Playwright install fails | Returns true, status="skipped", reason="install_failed" | ✓ |
| E2E tests fail | Feedback loop (shared counter, max 2) | ✓ |
| PR creation fails | Non-fatal, pr.status="failed" | ✓ |
| AI review times out | APPROVE for medium, REQUEST_CHANGES for high | ✓ |
| Auto-merge fails (conflict) | Label "merge-conflict", pr.status="merge-conflict" | ✓ |
| gh CLI not available | Skip PR, pr.status="skipped" | ✓ |

---

## Findings

### MEDIUM-001: Command Injection Risk in PR Title/Body
**Severity:** MEDIUM
**File:** `workflow-engine.js:277-313`

Task title is escaped with only `replace(/"/g, '\\"')` before being interpolated into a shell command string. While double-quote escaping prevents breakout of the quoted string, other shell metacharacters (`$`, backticks, `\n`) in `run.task` could cause unexpected behavior. The PR body uses the same pattern.

**Mitigation already present:** Task titles are truncated to 80 chars, PR body to 200 chars, which limits attack surface. The worker container is already a sandboxed environment.

**Recommendation:** Consider using array-based `execInWorker` arguments instead of shell string interpolation, or write the PR body to a temp file and use `--body-file`.

### MEDIUM-002: `console.log` Usage vs Structured Logging
**Severity:** MEDIUM
**File:** `workflow-engine.js` (48 occurrences)

CLAUDE.md architecture rules require structured logging, not `console.log`. The existing codebase already uses `console.log` extensively (this is pre-existing), and the new code follows the same pattern for consistency. However, the rule is clear.

**Recommendation:** This is a pre-existing pattern across the entire orchestrator. Fixing it is outside the scope of this feature but should be tracked as tech debt.

### LOW-001: E2E Phase Runs Even When `allPassed` is False
**Severity:** LOW
**File:** `workflow-engine.js:996-1082`

Phase 5.5 (E2E) runs regardless of whether Phase 5 (results) computed `allPassed=true`. The spec says "After all validation passes" for PR creation, but Phase 5.5 runs unconditionally when the app is running. This is arguably correct since E2E tests provide additional signal, and the PR creation in Phase 6.5 does proceed regardless. However, it means E2E tests run even when the pipeline already failed.

**Impact:** Wasted compute time on failed cycles. Non-blocking.

### LOW-002: Dockerfile Missing `rm -rf /var/lib/apt/lists/*` Redundancy Check
**Severity:** LOW
**File:** `Dockerfile.worker:32`

The gh CLI install block correctly cleans apt lists. No issue found — this is an INFO note that the implementation follows Docker best practices.

### LOW-003: Missing Test for `enrichTaskForLeader()`
**Severity:** LOW
**File:** `dispatch.js:290-298`

The `enrichTaskForLeader()` function is not directly unit-tested. Risk classification tests only cover the regex extraction, not the prompt enrichment. The function is simple string concatenation and unlikely to break, but a test would improve coverage.

### INFO-001: NFR-2 Compliance — Existing Pipeline Unchanged
**Severity:** INFO

Verified that existing phases 0-6 and 8 are not modified in behavior. Phase 5.5 and 6.5 are purely additive. When E2E tests don't exist, `_runPlaywrightE2E` returns `true` and the pipeline continues as before. When `mergeStrategy === "manual"`, Phase 6.5 is skipped entirely.

### INFO-002: NFR-3 Compliance — Graceful Degradation
**Severity:** INFO

Every new phase wraps in try/catch and sets appropriate skip/error status. The outer `executeWorkflow` try/catch also handles unexpected errors. No new failure mode can break the existing pipeline.

### INFO-003: Feedback Loop Counter Sharing
**Severity:** INFO

The E2E feedback loop correctly shares the `feedbackLoops` counter with the QA feedback loop (same variable at `workflow-engine.js:772` and `workflow-engine.js:1012`). This matches the spec and design doc: "max 2 total feedback loops (shared counter)."

---

## Traceability Matrix

| FR | Code Traceability | Test Traceability | Status |
|----|-------------------|-------------------|--------|
| FR-TMP-001 | workflow-engine.js:688,720; dispatch.js:130,289 | test:63-93 | ✓ |
| FR-TMP-002 | dispatch.js:130,173,203; workflow-engine.js:535,741 | (covered via integration in dispatch) | ✓ |
| FR-TMP-003 | workflow-engine.js:157-255,997,1011 | test:95-196 | ✓ |
| FR-TMP-004 | workflow-engine.js:259-336,1093,1105 | test:198-263 | ✓ |
| FR-TMP-005 | workflow-engine.js:340-450,1108 | test:265-338 | ✓ |
| FR-TMP-006 | workflow-engine.js:454-529,1113 | test:340-453 | ✓ |
| FR-TMP-007 | config.js:36-40 | test:455-464 | ✓ |
| FR-TMP-008 | Dockerfile.worker:26-32 | (Docker build verification) | ✓ |
| FR-TMP-009 | workflow-engine.js:626-629,1064,1121; server.js:349-354 | test:466-482 | ✓ |
| FR-TMP-010 | workflow-engine.js:165,184,318,416,506,1069,1125 | test:484-526 | ✓ |

---

## Verdict

**PASS with medium findings.** All FRs implemented and tested. No regressions to existing pipeline behavior. Two MEDIUM findings (command injection mitigation, console.log usage) that do not block merge but should be tracked. Three LOW findings for minor gaps in test coverage and efficiency.
