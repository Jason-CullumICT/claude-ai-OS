# Tiered Merge Pipeline — Dispatch Plan

Traces to: `Plans/tiered-merge-pipeline/design.md`
Specification: `Specifications/tiered-merge-pipeline.md`
Source spec: `docs/superpowers/specs/2026-03-25-tiered-merge-pipeline-design.md`

---

## Risk Classification

**RISK_LEVEL: high**

Rationale: Architecture change to core workflow engine, new pipeline phases, cross-cutting modifications to orchestrator, Dockerfile, dispatch, and config. Affects >6 files in the orchestrator module.

---

## Stage 1: Implementation (parallel)

### **backend-coder-1** — Workflow Engine + Config

**Module scope:** `docker/orchestrator/lib/workflow-engine.js`, `docker/orchestrator/lib/config.js`

**Assigned FRs:**
- FR-TMP-001 (Risk Classification) — Size: M
- FR-TMP-003 (Playwright E2E Runner) — Size: L
- FR-TMP-004 (Auto-PR Creation) — Size: M
- FR-TMP-005 (AI PR Review) — Size: M
- FR-TMP-006 (Auto-Merge Logic) — Size: M
- FR-TMP-007 (Configuration) — Size: S
- FR-TMP-009 (Run JSON Extensions) — Size: S
- FR-TMP-010 (Error Handling) — Size: M

**Total points:** 2+4+2+2+2+1+1+2 = 16 (XL assignment)

**Implementation instructions:**

1. **config.js** — Add these config values:
   ```javascript
   mergeStrategy: process.env.MERGE_STRATEGY || "tiered",
   defaultRiskLevel: process.env.DEFAULT_RISK_LEVEL || "medium",
   autoMergeLow: process.env.AUTO_MERGE_LOW !== "false",
   autoMergeMedium: process.env.AUTO_MERGE_MEDIUM !== "false",
   ```

2. **workflow-engine.js** — Risk extraction after Phase 1 (after line ~319):
   ```javascript
   // Extract risk level from leader output
   const riskMatch = leaderResult.stdout.match(/RISK_LEVEL:\s*(low|medium|high)/i);
   run.riskLevel = riskMatch ? riskMatch[1].toLowerCase() : this.config.defaultRiskLevel;
   console.log(`[${run.id}] Risk level: ${run.riskLevel}`);
   ```

3. **workflow-engine.js** — New method `_runPlaywrightE2E(containerId, run, saveRunFn)`:
   - Check if `Source/E2E/tests/cycle-${run.id}/` exists in worker
   - If not: `run.e2e = { status: "skipped" }`, return true
   - Install Playwright: `PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright npx playwright install chromium`
   - If install fails: `run.e2e = { status: "skipped", reason: "install_failed" }`, return true
   - Initialize package.json if needed: `cd /workspace/Source/E2E && npm init -y && npm install @playwright/test`
   - Run: `cd /workspace/Source/E2E && PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright npx playwright test tests/cycle-${run.id}/ --reporter=json`
   - Parse JSON output for test counts
   - Set `run.e2e = { status, tests, passed, failed, outputTail }`
   - Return pass/fail boolean

4. **workflow-engine.js** — Insert Phase 5.5 after Phase 5 (results computation, ~line 600):
   - Call `_runPlaywrightE2E()`
   - If E2E fails and feedback loops remaining: re-run implementation with E2E output, re-run QA, re-run E2E
   - Update `run.results.e2e` field

5. **workflow-engine.js** — New method `_createPR(containerId, run, saveRunFn)`:
   - Check `which gh` in worker, skip if not found
   - Build PR title: `cycle/${run.id}: ${run.task.slice(0, 80)}`
   - Build PR body with results summary
   - Determine labels from risk level
   - Execute `gh pr create ...` in worker
   - Parse PR number and URL from stdout
   - Set `run.pr = { number, url, status: "open" }`

6. **workflow-engine.js** — New method `_aiReviewPR(containerId, run, saveRunFn)`:
   - Skip if `run.riskLevel === "low"`
   - Get diff: `git diff master...cycle/${run.id}` in worker
   - Build review prompt with diff (truncated to 50K chars), task, QA reports, E2E results
   - Run Claude in worker: `claude -p "..." --allowedTools "Bash,Read,Glob,Grep" --output-format text`
   - Parse output for APPROVE/REQUEST_CHANGES
   - Post review via `gh pr review`
   - Set `run.pr.aiReview` and `run.pr.aiReviewComment`

7. **workflow-engine.js** — New method `_autoMerge(containerId, run, saveRunFn)`:
   - Apply decision matrix from FR-TMP-006
   - If auto-merge: `gh pr merge ${run.pr.number} --squash --delete-branch`
   - Handle merge conflicts: label PR, set status
   - Set `run.pr.status` accordingly

8. **workflow-engine.js** — Insert Phase 6.5 after Phase 6 (commit+push):
   - Call `_createPR()` (only if `config.mergeStrategy !== "manual"`)
   - Call `_aiReviewPR()` (only for medium/high risk)
   - Call `_autoMerge()` (apply decision matrix)

9. **Error handling** — Every new method wraps in try/catch with graceful degradation per FR-TMP-010.

### **backend-coder-2** — Dispatch + Dockerfile + Server API

**Module scope:** `docker/orchestrator/lib/dispatch.js`, `docker/Dockerfile.worker`, `docker/orchestrator/server.js`

**Assigned FRs:**
- FR-TMP-002 (QA E2E Prompt Injection) — Size: M
- FR-TMP-008 (Worker Prerequisites / Dockerfile) — Size: S

**Total points:** 2+1 = 3 (S assignment)

**Implementation instructions:**

1. **dispatch.js** — Modify `buildAgentPrompt()` to accept `runId` parameter:
   - Add `runId` as 5th parameter: `buildAgentPrompt(role, task, team, planCtx, runId)`
   - For QA agents (not impl), append E2E test generation instructions:
     ```
     E2E Test Generation (MANDATORY):
     Write Playwright E2E test files at Source/E2E/tests/cycle-{runId}/ that verify
     the feature works in a real browser. Tests must run against http://localhost:5173.
     Use @playwright/test. Each test file should:
     1. Navigate to each new/modified page
     2. Verify key UI elements are present (headings, forms, buttons)
     3. Fill out forms, submit, verify response
     4. Click through the primary user flow for the feature
     5. Verify no console errors during navigation

     Test template:
     import { test, expect } from '@playwright/test';
     test.describe('Feature: {name}', () => {
       test('should render the main page', async ({ page }) => {
         await page.goto('http://localhost:5173/{route}');
         await expect(page.getByRole('heading', { name: '{heading}' })).toBeVisible();
       });
     });
     ```

2. **dispatch.js** — Update all callers of `buildAgentPrompt()`:
   - In `parseDispatchPlan()`: thread `runId` through (need to accept it as param)
   - In the workflow engine's `_parseDispatchFromWorker()`: pass `run.id` to dispatch calls
   - In `buildFallbackPlan()`: no change needed (fallback doesn't use buildAgentPrompt)

3. **dispatch.js** — Add risk classification instructions to the leader task enrichment:
   - In `buildAgentPrompt` or wherever the leader prompt is built, ensure the leader sees:
     ```
     Classify this task's risk level for merge strategy:
     - low: bug fix, < 3 files, no schema changes
     - medium: new feature, new pages/endpoints, 3-20 files
     - high: architecture change, schema migration, auth/security, > 20 files
     Include in your output: RISK_LEVEL: low|medium|high
     ```
   - Note: the leader prompt is built in `run-team.sh`, so this instruction should be added to the task text enrichment in the workflow engine before passing to the leader, OR in dispatch.js task processing.

4. **Dockerfile.worker** — Add gh CLI installation after the Node.js block:
   ```dockerfile
   # GitHub CLI (for PR creation and merge)
   RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
       && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
       && apt-get update && apt-get install -y gh \
       && rm -rf /var/lib/apt/lists/*
   ```

5. **server.js** — Ensure run API responses include new fields:
   - The `GET /api/runs/:id` endpoint already returns the full run object
   - Verify that `riskLevel`, `e2e`, and `pr` fields are not filtered out
   - If the response is filtered, add these fields to the response

---

## Stage 2: QA (parallel)

### **qa-review-and-tests**

Review the implementation against the specification and contracts. Verify:
- All FR-TMP-* requirements are implemented correctly
- Risk extraction regex works for all formats (uppercase, lowercase, with/without spaces)
- E2E phase gracefully degrades when tests/Playwright not available
- PR creation handles all error cases from FR-TMP-010
- Auto-merge decision matrix matches the spec exactly
- Config defaults are correct
- Dockerfile changes are valid
- No regressions to existing pipeline phases (Phase 0-6, 8)
- Run JSON fields are properly initialized and updated
- Feedback loop counter is shared correctly between QA and E2E phases

Write Playwright E2E test files at `Source/E2E/tests/cycle-{run-id}/` as specified in FR-TMP-002.

### **security-qa**

Review for:
- Command injection in `gh` CLI calls (task titles, PR bodies must be escaped)
- Secrets leakage in PR bodies or review comments
- GITHUB_TOKEN handling in worker containers
- Risk classification cannot be spoofed by task content to bypass review gates

### **traceability-reporter**

Verify all code changes have `// Verifies: FR-TMP-XXX` traceability comments.

### **chaos-tester**

Test adversarial scenarios:
- What if leader output contains multiple RISK_LEVEL lines?
- What if E2E tests exist but are malformed?
- What if `gh pr create` returns unexpected output?
- What if the merge fails mid-way?

---

## Coordination Notes

1. **backend-coder-1** and **backend-coder-2** both modify orchestrator files but in DIFFERENT files:
   - Coder-1: `workflow-engine.js`, `config.js`
   - Coder-2: `dispatch.js`, `Dockerfile.worker`, `server.js`
   - No file overlap, safe for parallel execution

2. **Interface contract between coders:**
   - Coder-2 adds `runId` param to `buildAgentPrompt()` and `parseDispatchPlan()`
   - Coder-1 must pass `run.id` when calling dispatch functions in `_parseDispatchFromWorker()`
   - Both must agree: `buildAgentPrompt(role, task, team, planCtx, runId)` — runId is the 5th parameter

3. **Testing the E2E phase**: The E2E runner phase in workflow-engine.js should be testable by mocking `containerManager.execInWorker()`. QA agents should write tests that verify the phase logic without requiring a running Docker container.
