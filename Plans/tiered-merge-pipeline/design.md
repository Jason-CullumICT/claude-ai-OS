# Tiered Merge Pipeline — Design Document

Traces to: `Specifications/tiered-merge-pipeline.md`
Source spec: `docs/superpowers/specs/2026-03-25-tiered-merge-pipeline-design.md`

## Architecture Overview

The implementation modifies the orchestrator's workflow engine to insert new phases after the existing Phase 5 (results) and Phase 6 (commit+push). No existing phases change behavior — all additions are additive with graceful degradation.

### Modified Pipeline Flow

```
Phase 0:   Spawn worker container (existing)
Phase 1:   Team leader planning (existing) + RISK_LEVEL classification (NEW)
Phase 2:   Parse dispatch plan (existing) + extract riskLevel (NEW)
Phase 3:   Execute stages with feedback loops (existing)
Phase 3.5: Start app (existing)
Phase 4:   Validation — smoketest + inspector (existing)
Phase 5:   Compute results (existing)
Phase 5.5: Run Playwright E2E tests against live app (NEW) // FR-TMP-003
Phase 6:   Commit + push cycle branch (existing)
Phase 6.5: Create PR + AI review + auto-merge decision (NEW) // FR-TMP-004, 005, 006
Phase 8:   Sync learnings (existing)
```

## Component Design

### 1. Risk Classification (FR-TMP-001)

**Location:** `docker/orchestrator/lib/workflow-engine.js` — after Phase 1 (leader output parsing)

**Logic:**
```javascript
// Extract risk level from leader output
const riskMatch = leaderOutput.match(/RISK_LEVEL:\s*(low|medium|high)/i);
run.riskLevel = riskMatch ? riskMatch[1].toLowerCase() : config.defaultRiskLevel;
```

**Leader prompt change:** The `run-team.sh` script or leader prompt template needs an addition instructing the leader to classify risk. This is done in the dispatch module's task enrichment.

### 2. QA Agent E2E Prompt Injection (FR-TMP-002)

**Location:** `docker/orchestrator/lib/dispatch.js` — `buildAgentPrompt()` function

**Logic:** For QA-type agents, append E2E test generation instructions to the prompt:

```javascript
if (!isImpl) {
  // Existing QA rules...
  p += `\n\nE2E Test Generation (MANDATORY):
Write Playwright E2E test files at Source/E2E/tests/cycle-${runId}/ that verify
the feature works in a real browser. Tests must run against http://localhost:5173.
Use @playwright/test. Each test navigates to a page, interacts with UI elements,
and asserts expected outcomes. The tests will run against the live app as a merge gate.
...template...`;
}
```

**Note:** `buildAgentPrompt` needs access to `runId`. Currently it doesn't receive it — must be threaded through from the workflow engine.

### 3. Playwright E2E Runner — Phase 5.5 (FR-TMP-003)

**Location:** `docker/orchestrator/lib/workflow-engine.js` — new method `_runPlaywrightE2E()`

**Flow:**
1. Check if `Source/E2E/tests/cycle-{runId}/` exists in worker (ls)
2. If no tests exist: log warning, set `run.e2e = { status: "skipped" }`, continue
3. Install Playwright chromium if not cached:
   ```bash
   PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright npx playwright install chromium
   ```
4. Run tests:
   ```bash
   cd /workspace/Source/E2E && npx playwright test tests/cycle-{runId}/ --reporter=json
   ```
5. Parse JSON output for pass/fail counts
6. Store results on `run.e2e`
7. If failed: enter feedback loop (re-run coders with E2E output, re-run QA, re-run E2E)

**E2E Feedback Loop:**
- Uses the same feedback loop pattern as the existing QA feedback loop
- Max 2 total feedback loops (shared counter with QA loops)
- Feeds Playwright test output as context to implementation agents

### 4. Auto-PR Creation — Phase 6.5a (FR-TMP-004)

**Location:** `docker/orchestrator/lib/workflow-engine.js` — new method `_createPR()`

**Flow:**
1. Check if `gh` CLI is available in worker (`which gh`)
2. If not available: log warning, set `run.pr = { status: "skipped" }`, return
3. Create PR:
   ```bash
   gh pr create --title "cycle/{runId}: {taskTitle}" \
     --body "..." --base master --head "cycle/{runId}" \
     --label "{risk-labels}"
   ```
4. Parse PR number and URL from output
5. Store on `run.pr`

### 5. AI PR Review — Phase 6.5b (FR-TMP-005)

**Location:** `docker/orchestrator/lib/workflow-engine.js` — new method `_aiReviewPR()`

**Flow:**
1. Skip if risk is "low"
2. Get diff: `git diff master...cycle/{runId}`
3. Build review prompt with diff, task description, QA reports, E2E results
4. Run Claude agent inside worker: `claude -p "{review prompt}" --allowedTools "Bash,Read,Glob,Grep"`
5. Parse verdict: APPROVE or REQUEST_CHANGES
6. Post review: `gh pr review {pr-number} --approve` or `--request-changes --body "..."`
7. Store on `run.pr.aiReview`

### 6. Auto-Merge Logic — Phase 6.5c (FR-TMP-006)

**Location:** `docker/orchestrator/lib/workflow-engine.js` — new method `_autoMerge()`

**Flow:**
1. Decision matrix based on `run.riskLevel` and `run.pr.aiReview`
2. If auto-merge: `gh pr merge {pr-number} --squash --delete-branch`
3. If conflict: label PR "merge-conflict", set `run.pr.status = "merge-conflict"`
4. Store final status

### 7. Configuration (FR-TMP-007)

**Location:** `docker/orchestrator/lib/config.js`

Add:
```javascript
mergeStrategy: process.env.MERGE_STRATEGY || "tiered",
defaultRiskLevel: process.env.DEFAULT_RISK_LEVEL || "medium",
autoMergeLow: process.env.AUTO_MERGE_LOW !== "false",
autoMergeMedium: process.env.AUTO_MERGE_MEDIUM !== "false",
```

### 8. Dockerfile Changes (FR-TMP-008)

**Location:** `docker/Dockerfile.worker`

Add `gh` CLI installation:
```dockerfile
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*
```

## File Change Summary

| File | Change Type | FRs |
|------|------------|-----|
| `docker/orchestrator/lib/workflow-engine.js` | Major modification — add Phase 5.5, 6.5a/b/c, risk extraction, E2E feedback loop | FR-TMP-001, 003, 004, 005, 006, 009, 010 |
| `docker/orchestrator/lib/dispatch.js` | Modify `buildAgentPrompt()` — add E2E instructions to QA prompts, thread runId | FR-TMP-002 |
| `docker/orchestrator/lib/config.js` | Add merge strategy config vars | FR-TMP-007 |
| `docker/Dockerfile.worker` | Add gh CLI installation | FR-TMP-008 |
| `docker/orchestrator/server.js` | Add riskLevel, e2e, pr fields to run API responses (minor) | FR-TMP-009 |

## Complexity Estimate

| Component | Size | Rationale |
|-----------|------|-----------|
| workflow-engine.js modifications | XL | Core orchestration changes: 4 new methods, E2E feedback loop, risk extraction, phase ordering |
| dispatch.js modifications | S | Add E2E instructions to QA prompt, thread runId |
| config.js modifications | S | 4 new config values |
| Dockerfile.worker modifications | S | gh CLI install block |
| server.js modifications | S | Expose new run fields in API |

**Total backend points:** XL(8) + S(1) + S(1) + S(1) + S(1) = 12 points
**Scaling decision:** 12 points -> 2 backend coders

## Risk Considerations

1. **Playwright in worker containers**: Chromium install is ~200MB. Cached in worker volume but adds latency on first run per cycle. Mitigation: graceful skip if install fails.
2. **gh CLI auth**: Requires `GITHUB_TOKEN` with repo scope. Already passed to workers. Mitigation: check availability before attempting PR operations.
3. **Feedback loop complexity**: E2E failures share the feedback loop counter with QA failures. This means a cycle gets max 2 total retries, not 2 per gate. This is intentional to prevent runaway loops.
4. **Merge conflicts**: Auto-merge may fail if master has diverged. Mitigation: label PR and leave open.
