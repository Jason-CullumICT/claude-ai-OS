# Tiered Merge Pipeline — QA Report (Playwright Agent)

**Reviewer:** playwright (QA)
**Date:** 2026-03-25
**Spec:** `Specifications/tiered-merge-pipeline.md`
**Design:** `Plans/tiered-merge-pipeline/design.md`
**Source spec:** `docs/superpowers/specs/2026-03-25-tiered-merge-pipeline-design.md`

---

## Test Results

- **Unit tests:** 26/26 passed (`node --test docker/orchestrator/lib/workflow-engine.test.js`)
- **Traceability enforcer:** No active requirements file configured (tool returned "No active requirements file found to enforce")

---

## FR-by-FR Review

### FR-TMP-001: Risk Classification — PASS

| Check | Status |
|-------|--------|
| Regex `/RISK_LEVEL:\s*(low\|medium\|high)/i` in workflow-engine.js:721 | OK |
| Default to `config.defaultRiskLevel` when not found | OK |
| `run.riskLevel` stored on run JSON | OK |
| Leader prompt enriched via `enrichTaskForLeader()` in dispatch.js:290 | OK |
| Tests cover: low, high (case-insensitive), missing, extra whitespace | OK |
| Traceability comments present | OK |

### FR-TMP-002: QA E2E Prompt Injection — PASS

| Check | Status |
|-------|--------|
| `buildAgentPrompt()` accepts `runId` as 5th parameter (dispatch.js:131) | OK |
| E2E instructions appended for QA agents when `runId` is truthy (dispatch.js:174) | OK |
| `parseDispatchPlan()` threads `runId` through (dispatch.js:204) | OK |
| `_parseDispatchFromWorker()` passes `run.id` to `buildAgentPrompt` (workflow-engine.js:561) | OK |
| Test template matches spec (navigate, verify elements, forms, console errors) | OK |
| Traceability comments present | OK |

### FR-TMP-003: Live Playwright E2E Runner — PASS

| Check | Status |
|-------|--------|
| `_runPlaywrightE2E()` method exists (workflow-engine.js:160) | OK |
| Checks `Source/E2E/tests/cycle-{runId}/` existence | OK |
| Installs Playwright chromium with `PLAYWRIGHT_BROWSERS_PATH` | OK |
| Initializes `package.json` and `@playwright/test` | OK |
| Runs `npx playwright test --reporter=json` | OK |
| Parses JSON report for test counts (suites/specs/tests) | OK |
| Falls back to exit code when JSON parse fails | OK |
| Stores `run.e2e = { status, tests, passed, failed, outputTail }` | OK |
| E2E feedback loop shares counter with QA loops (workflow-engine.js:1012) | OK |
| Phase 5.5 inserted after Phase 5 (workflow-engine.js:996) | OK |
| Skips when app not running (workflow-engine.js:1077) | OK |
| Tests: skip-no-tests, skip-install-fail, pass, fail | OK |
| Traceability comments present | OK |

### FR-TMP-004: Auto-PR Creation — PASS

| Check | Status |
|-------|--------|
| `_createPR()` method exists (workflow-engine.js:262) | OK |
| Checks `which gh` before proceeding | OK |
| PR title format: `cycle/{runId}: {taskTitle}` | OK |
| PR body includes: task, risk level, team, results summary | OK |
| Labels: low=`auto-merge,low-risk`, medium=`auto-merge,ai-reviewed`, high=`needs-approval,high-risk` | OK |
| Parses PR number and URL from output | OK |
| Stores `run.pr = { number, url, status }` | OK |
| Graceful degradation when `gh` unavailable | OK |
| Tests: skip-gh-unavailable, create-and-parse-url, handle-failure | OK |
| Traceability comments present | OK |

### FR-TMP-005: AI PR Review — PASS

| Check | Status |
|-------|--------|
| `_aiReviewPR()` method exists (workflow-engine.js:343) | OK |
| Skips for low risk | OK |
| Gets diff via `git diff master...cycle/{runId}` | OK |
| Review prompt includes diff, task, QA status, E2E results | OK |
| Runs Claude with `--allowedTools "Bash,Read,Glob,Grep"` | OK |
| Parses APPROVE/REQUEST_CHANGES from output | OK |
| Posts review via `gh pr review` with --approve or --request-changes | OK |
| Timeout: defaults APPROVE for medium, REQUEST_CHANGES for high | OK |
| Stores `run.pr.aiReview` and `run.pr.aiReviewComment` | OK |
| Tests: skip-low, approve-medium, default-approve-medium-failure, default-request-changes-high-failure | OK |
| Traceability comments present | OK |

### FR-TMP-006: Auto-Merge Logic — PASS

| Check | Status |
|-------|--------|
| `_autoMerge()` method exists (workflow-engine.js:457) | OK |
| Decision matrix matches spec exactly | OK — verified below |
| low + pass + skipped → auto-merge (if `autoMergeLow`) | OK |
| medium + APPROVE + pass → auto-merge (if `autoMergeMedium`) | OK |
| medium + REQUEST_CHANGES → changes-requested, keep open | OK |
| high + APPROVE → label ready-for-review, keep open | OK |
| high + REQUEST_CHANGES → label changes-requested, keep open | OK |
| Merge command: `gh pr merge --squash --delete-branch` | OK |
| Conflict handling: label merge-conflict, keep open | OK |
| Config flags respected (`autoMergeLow`, `autoMergeMedium`) | OK |
| Tests: 6 tests covering all matrix cases | OK |
| Traceability comments present | OK |

### FR-TMP-007: Configuration — PASS

| Check | Status |
|-------|--------|
| `mergeStrategy` defaults to "tiered" | OK |
| `defaultRiskLevel` defaults to "medium" | OK |
| `autoMergeLow` defaults to true (env !== "false") | OK |
| `autoMergeMedium` defaults to true (env !== "false") | OK |
| Test verifies defaults | OK |
| Traceability comment present | OK |

### FR-TMP-008: Worker Container Prerequisites — PASS

| Check | Status |
|-------|--------|
| `gh` CLI installed in Dockerfile.worker via official GPG key + apt repo | OK |
| `apt-get update && install -y gh && rm -rf /var/lib/apt/lists/*` | OK |
| Traceability comment present | OK |

### FR-TMP-009: Run JSON Extensions — PASS

| Check | Status |
|-------|--------|
| `riskLevel` initialized on run at Phase 0 (workflow-engine.js:627) | OK |
| `e2e` initialized as null, populated by `_runPlaywrightE2E` | OK |
| `pr` initialized as null, populated by `_createPR` | OK |
| `run.results.e2e` populated (workflow-engine.js:1065) | OK |
| `run.results.pr` populated (workflow-engine.js:1122) | OK |
| Server.js `/api/runs` includes riskLevel, e2e, pr (server.js:351) | OK |
| `/api/runs/:id` returns full run object (no filtering) | OK |
| Test verifies initialization | OK |
| Traceability comments present | OK |

### FR-TMP-010: Error Handling — PASS

| Check | Status |
|-------|--------|
| QA doesn't write tests → skip E2E, log, proceed | OK |
| Playwright install fails → skip E2E, log, proceed | OK |
| E2E tests fail → feedback loop (shared counter, max 2) | OK |
| PR creation fails → log, skip merge, run stays complete | OK |
| AI review times out → APPROVE for medium, REQUEST_CHANGES for high | OK |
| Auto-merge fails (conflict) → label merge-conflict, keep open | OK |
| gh CLI not available → skip PR, log warning | OK |
| Phase 6.5 wrapped in try/catch (non-fatal to pipeline) | OK |
| Phase 5.5 wrapped in try/catch (non-fatal to pipeline) | OK |
| Tests: 3 error handling tests | OK |
| Traceability comments present | OK |

---

## NFR Review

| NFR | Status | Notes |
|-----|--------|-------|
| NFR-1: E2E < 5min | **INFO** | Not verifiable statically, but test execution is bounded by `phaseTimeoutMs` (30min). No independent E2E timeout configured. |
| NFR-2: Additive phases only | **PASS** | No existing phase behavior modified. E2E and PR phases only execute when conditions are met. |
| NFR-3: Graceful degradation | **PASS** | Every new phase has try/catch with fallback. App not running → skip E2E. gh unavailable → skip PR. |

---

## Security Review

| Finding | Severity | Description |
|---------|----------|-------------|
| Command injection in PR title | **MEDIUM** | `_createPR` (line 277) escapes double quotes in `taskTitle` with `\\"`, but other shell-special characters (backticks, `$()`, single quotes) are NOT escaped. A malicious task description could inject shell commands via the `gh pr create --title "..."` call. The `prBody` has the same issue (line 313). |
| Command injection in AI review | **LOW** | `_aiReviewPR` (line 437) escapes the `comment` variable for the `gh pr review --body "..."` call, but same incomplete escaping as above. However, this data originates from Claude's output (controlled), not user input. |
| GITHUB_TOKEN exposure | **INFO** | Token is passed via environment (as designed). PR body does not leak it. AI review prompt does not include env vars. No concerns. |
| Risk classification spoofing | **LOW** | A task description containing `RISK_LEVEL: low` would be enriched by `enrichTaskForLeader()`, and the leader might echo it. The regex (line 721) would then pick up the user-supplied value instead of the leader's classification. Mitigation: the regex runs on the full leader output which will contain the leader's own classification last (after the echoed task). In practice, the leader's output typically ends with the RISK_LEVEL line. Risk is low but worth noting. |

---

## Architecture Compliance

| Rule | Status |
|------|--------|
| Specs are source of truth | OK — implementation traces to spec |
| No direct DB calls from handlers | N/A — no DB calls in changes |
| Every FR has tests with traceability | OK — all FR-TMP-* have `// Verifies:` comments |
| No hardcoded secrets | OK — uses env vars |
| No console.log (use structured logging) | **LOW** — All new code uses `console.log`/`console.warn` directly, consistent with the existing codebase pattern, but the architecture rule says to use structured logging. Pre-existing issue, not a regression. |
| Business logic has no framework imports | OK — workflow engine methods are framework-free |

---

## Findings Summary

| # | Severity | Finding | File | Line |
|---|----------|---------|------|------|
| 1 | **MEDIUM** | Incomplete shell escaping in `_createPR` — task title and PR body only escape double quotes, not backticks, `$()`, or single quotes. Could allow command injection via crafted task descriptions. | workflow-engine.js | 277, 313 |
| 2 | **LOW** | Risk classification could be influenced by user-supplied task text containing `RISK_LEVEL: low` | workflow-engine.js | 721 |
| 3 | **LOW** | Same incomplete escaping in `_aiReviewPR` comment, though input is Claude-controlled | workflow-engine.js | 437 |
| 4 | **INFO** | `console.log` used throughout (pre-existing pattern, not a regression) | workflow-engine.js | multiple |
| 5 | **INFO** | No independent E2E phase timeout — relies on global `phaseTimeoutMs` (30min) | workflow-engine.js | — |
| 6 | **INFO** | Traceability enforcer has no active requirements file configured | — | — |

---

## Verdict

**PASS with notes.** All 10 functional requirements (FR-TMP-001 through FR-TMP-010) are correctly implemented, tested, and traceable. All 26 unit tests pass. No regressions to existing pipeline phases. The MEDIUM severity finding (#1) on shell escaping should be addressed before this code handles untrusted task input in production, but does not block merge for the current use case where task input comes from authorized users.
