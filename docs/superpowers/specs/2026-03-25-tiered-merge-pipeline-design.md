# Tiered Merge Pipeline — Design Specification

## Problem

The current pipeline builds code and runs static/dynamic QA, but has no path from
"cycle complete" to "merged to main." Users must manually test in the browser,
manually review branches, and manually merge. This creates a bottleneck that blocks
parallel cycle throughput and allows incomplete work to ship (as seen with the cycles
dashboard cycle that passed QA but didn't actually build the requested UI).

## Goals

1. **QA agents generate Playwright E2E tests** during the QA phase that verify the
   actual feature works in a browser
2. **Live E2E tests run against the running app** as a hard gate before any merge
3. **Risk-tiered merge strategy** — low risk auto-merges, medium gets AI review +
   auto-merge, high risk requires human approval
4. **Auto-PR creation** with AI-driven code review on every cycle
5. **Post-merge Chrome validation** with auto-revert on failure

## Risk Classification

The team leader or inspector classifies each cycle's risk level based on scope.

| Level | Criteria | Examples | Merge behavior |
|-------|----------|----------|----------------|
| **low** | Bug fix, config change, text update, < 3 files changed | "Fix typo in dashboard", "Update env var" | Playwright pass → auto-merge |
| **medium** | New feature, new page, new API endpoint, 3-20 files | "Add image upload", "New dashboard page" | Playwright pass + AI review pass → auto-merge |
| **high** | Architecture change, DB schema change, auth/security, > 20 files, cross-cutting refactor | "Change DB engine", "Add authentication", "Rewrite state management" | Playwright pass + AI review → create PR, WAIT for human approval |

Risk is stored on the run JSON as `run.riskLevel` ("low" / "medium" / "high").
Default: "medium" if not classified.

## Pipeline Changes

### Current flow:
```
Leader → Dispatch → Code → App starts → QA (static/dynamic) → Smoketest → Inspector → Done
```

### New flow:
```
Leader → Dispatch → Code → App starts → QA (writes E2E tests) →
  Smoketest → Inspector → Playwright E2E → Risk check →
  [low]    Auto-merge
  [medium] AI PR review → Auto-merge
  [high]   AI PR review → Create PR → Wait for human approval
  → Post-merge Chrome smoke (auto-revert on failure)
```

## Components

### 1. Playwright Test Generation (QA Phase)

During the QA phase, QA agents already review the implementation. The change: they
also write Playwright test files that verify the feature works in a real browser.

**Where tests are written:** `Source/E2E/tests/cycle-{run-id}/` inside the worker.

**What tests cover:**
- Navigate to each new/modified page
- Verify key UI elements are present (headings, forms, buttons)
- Fill out forms, submit, verify response
- Click through the primary user flow for the feature
- Verify no console errors during navigation

**Test template provided to QA agents:**
```typescript
import { test, expect } from '@playwright/test';

test.describe('Feature: {feature-name}', () => {
  test('should render the main page', async ({ page }) => {
    await page.goto('http://localhost:5173/{route}');
    await expect(page.getByRole('heading', { name: '{heading}' })).toBeVisible();
  });

  test('should complete the primary flow', async ({ page }) => {
    // Navigate, fill form, submit, verify
  });
});
```

**Agent prompt addition:** The QA agent dispatch prompt includes:
"Write Playwright E2E test files at Source/E2E/tests/cycle-{run-id}/ that verify
the feature works in a real browser. Tests must run against http://localhost:5173.
Use @playwright/test. Each test navigates to a page, interacts with UI elements,
and asserts expected outcomes. The tests will run against the live app as a merge gate."

### 2. Live Playwright E2E Runner (New Pipeline Phase)

After QA completes and the app is running (Phase 3.5), a new phase runs the
generated Playwright tests against the worker's live app.

**Execution:** Inside the worker container:
```bash
cd /workspace/Source/E2E
npx playwright install chromium
npx playwright test tests/cycle-{run-id}/ --reporter=json --output=test-results/
```

**Pass/fail:** If any E2E test fails, the cycle is marked as failed. The feedback
loop re-runs the implementation agents with the Playwright test output as context,
then re-runs QA + E2E. Max 2 feedback loops (same as current).

**Port mapping:** Tests target `http://localhost:5173` inside the container (the
Vite dev server). This is the same port the app runs on inside every worker.

**Playwright installation:** The worker image does NOT include Playwright browsers
(200MB+). Install chromium on first use and cache in the worker volume:
```bash
PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright npx playwright install chromium
```

### 3. Risk Classifier

Risk level is determined by the team leader during the planning phase.

**Leader prompt addition:**
"Classify this task's risk level for merge strategy:
- low: bug fix, < 3 files, no schema changes
- medium: new feature, new pages/endpoints, 3-20 files
- high: architecture change, schema migration, auth/security, > 20 files

Include in your output: RISK_LEVEL: low|medium|high"

**Parsing:** The orchestrator extracts risk level from leader output using regex:
`/RISK_LEVEL:\s*(low|medium|high)/i`. Default: "medium".

Stored on run JSON: `run.riskLevel = "medium"`

### 4. Auto-PR Creation

After all validation passes, the orchestrator creates a GitHub PR from the cycle
branch.

**Implementation:** Using `gh` CLI inside the worker container (or git push +
GitHub API from orchestrator):
```bash
gh pr create \
  --title "cycle/{run-id}: {task-title}" \
  --body "## Summary\n{task}\n\n## Results\n- Tests: {test-count} passed\n- QA: {qa-status}\n- Inspector: {grade}\n- Risk: {risk-level}\n- E2E: {e2e-count} tests passed\n\n## Cycle\n- Branch: cycle/{run-id}\n- Ports: {backend}/{frontend}\n- Run: {run-id}" \
  --base master \
  --head "cycle/{run-id}"
```

**PR labels:** Based on risk level:
- low: `auto-merge`, `low-risk`
- medium: `auto-merge`, `ai-reviewed`
- high: `needs-approval`, `high-risk`

### 5. AI PR Review

For medium and high risk, a Claude agent reviews the PR diff and comments.

**Implementation:** The orchestrator runs a review agent via `claude -p` with:
- The full git diff (`git diff master...cycle/{run-id}`)
- The task description
- The QA reports
- The E2E test results

**Review criteria:**
- Does the code match the task description?
- Are there security concerns?
- Does it follow the project's architecture patterns?
- Are there any obvious bugs or regressions?
- Is test coverage adequate?

**Output:** The agent posts a review comment on the PR via `gh pr review`:
- APPROVE: "AI review passed — code matches spec, no concerns"
- REQUEST_CHANGES: "Issues found: {list}" (blocks auto-merge)

### 6. Auto-Merge Logic

After PR creation + AI review:

| Risk | E2E | AI Review | Action |
|------|-----|-----------|--------|
| low | pass | skipped | Auto-merge immediately |
| medium | pass | APPROVE | Auto-merge |
| medium | pass | REQUEST_CHANGES | Keep PR open, notify user |
| high | pass | APPROVE | Keep PR open, label "ready-for-review" |
| high | pass | REQUEST_CHANGES | Keep PR open, label "changes-requested" |

**Auto-merge command:**
```bash
gh pr merge {pr-number} --squash --delete-branch
```

### 7. Post-Merge Chrome Validation

After merge to master, run a quick Chrome smoke test against the main app.

**For the feature portal (container-test):** The portal service auto-restarts
and picks up the merged code. The orchestrator then:
1. Waits 10 seconds for the portal to restart
2. Navigates Chrome to the portal URL
3. Runs a quick check: pages load, no console errors, key elements present
4. If failure: auto-revert the merge commit and create a bug ticket

**Implementation:** Use the existing Chrome MCP tools (claude-in-chrome) or
a Playwright test suite targeting the portal.

**Auto-revert:**
```bash
git revert HEAD --no-edit
git push origin master
```

Plus create a bug report in the portal:
```bash
curl -X POST http://portal:3001/api/bugs -H "Content-Type: application/json" \
  -d '{"title": "Auto-revert: {task}", "description": "Post-merge validation failed...", "severity": "critical"}'
```

### 8. Workflow Engine Changes

The executeWorkflow method in `lib/workflow-engine.js` adds these phases after
the current Phase 5 (results):

```
Phase 5:   Compute results
Phase 5.5: Run Playwright E2E tests against live app (NEW)
Phase 6:   Commit + push cycle branch
Phase 6.5: Create PR + AI review + auto-merge decision (NEW)
Phase 7:   Sync learnings to main
Phase 7.5: Post-merge Chrome validation (NEW, only on merge)
```

### 9. New Run JSON Fields

```json
{
  "riskLevel": "medium",
  "e2e": {
    "status": "passed",
    "tests": 5,
    "passed": 5,
    "failed": 0,
    "outputTail": "..."
  },
  "pr": {
    "number": 42,
    "url": "https://github.com/org/repo/pull/42",
    "status": "merged",
    "aiReview": "APPROVE",
    "aiReviewComment": "Code matches spec..."
  },
  "postMerge": {
    "status": "passed",
    "reverted": false
  }
}
```

### 10. Dashboard Updates

The orchestrator dashboard shows:
- E2E test results per cycle (pass/fail count)
- PR link and status (merged/open/changes-requested)
- Risk badge (low/medium/high with color)
- Post-merge validation status

### 11. Prerequisites

**Playwright in worker containers:** Workers need Playwright installed. Since we
can't bake browsers into the image (too large), install on first E2E run:
```bash
npx playwright install chromium
```
Cache in the worker volume so subsequent runs in the same cycle don't re-download.

**gh CLI in worker containers:** Needed for PR creation and merge. Add to
Dockerfile.worker:
```dockerfile
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh
```

Auth via `GITHUB_TOKEN` which is already passed to workers.

### 12. Error Handling

| Scenario | Response |
|----------|----------|
| QA agent doesn't write E2E tests | Skip E2E phase, log warning, proceed with existing gates |
| Playwright install fails | Skip E2E, log warning, proceed |
| E2E tests fail | Feedback loop: re-run coders with test output, max 2 loops |
| PR creation fails | Log error, skip merge, cycle stays complete with branch |
| AI review times out | Default to APPROVE for medium, keep PR open for high |
| Auto-merge fails (conflict) | Keep PR open, label "merge-conflict", notify user |
| Post-merge validation fails | Auto-revert, create bug ticket, notify user |
| gh CLI not available | Skip PR creation, log warning |

### 13. Configuration

New environment variables:
```
MERGE_STRATEGY=tiered          # tiered | manual | auto
DEFAULT_RISK_LEVEL=medium      # low | medium | high
AUTO_MERGE_LOW=true            # auto-merge low risk cycles
AUTO_MERGE_MEDIUM=true         # auto-merge medium risk (after AI review)
POST_MERGE_VALIDATION=true     # run Chrome validation after merge
POST_MERGE_AUTO_REVERT=true    # auto-revert on validation failure
```

### 14. Migration

This is additive — no existing behavior changes. The new phases are inserted
between existing phases. If E2E tests don't exist, the pipeline continues as
before. If gh CLI isn't available, PRs aren't created but the code is still
pushed to the branch.

**Phase 1 (this implementation):**
- Risk classification in leader prompt
- E2E test generation prompt in QA agents
- Playwright E2E runner phase
- Auto-PR creation via gh CLI
- AI PR review agent

**Phase 2 (follow-up):**
- Post-merge Chrome validation
- Auto-revert on failure
- Bug ticket creation on revert
- Dashboard PR status integration

**Phase 3 (production):**
- Webhook integration (GitHub → orchestrator callback on merge)
- Branch protection rules automation
- Review assignment based on risk + code owners
