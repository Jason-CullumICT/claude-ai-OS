# Tiered Merge Pipeline — Functional Requirements

Traces to: `docs/superpowers/specs/2026-03-25-tiered-merge-pipeline-design.md`

## Overview

The tiered merge pipeline extends the existing workflow engine to add: risk classification, Playwright E2E test generation, live E2E test execution as a merge gate, auto-PR creation, AI PR review, and risk-tiered auto-merge.

**Phase 1 scope** (this implementation): Risk classification, E2E test generation, Playwright runner, auto-PR, AI review, auto-merge logic.

**Phase 2 scope** (follow-up): Post-merge Chrome validation, auto-revert, bug ticket creation, dashboard PR status.

---

## Functional Requirements

### FR-TMP-001: Risk Classification

The team leader classifies each cycle's risk level during planning.

| Level | Criteria | Merge behavior |
|-------|----------|----------------|
| low | Bug fix, config change, < 3 files | Playwright pass -> auto-merge |
| medium | New feature, new page/endpoint, 3-20 files | Playwright pass + AI review -> auto-merge |
| high | Architecture change, DB schema, auth/security, > 20 files | Playwright pass + AI review -> PR, wait for human |

- Risk level is stored as `run.riskLevel` ("low" / "medium" / "high")
- Default: "medium" if not classified
- Parsing: orchestrator extracts from leader output via `/RISK_LEVEL:\s*(low|medium|high)/i`

### FR-TMP-002: Playwright E2E Test Generation (QA Phase)

QA agents write Playwright E2E test files during the QA phase.

- Test location: `Source/E2E/tests/cycle-{run-id}/`
- Tests use `@playwright/test` and target `http://localhost:5173`
- Coverage: navigate to pages, verify UI elements, fill forms, submit, verify response, check no console errors
- QA agent dispatch prompts include E2E test generation instructions
- Template provided in agent prompt (see design spec Section 1)

### FR-TMP-003: Live Playwright E2E Runner (New Pipeline Phase)

After QA completes and the app is running, a new phase runs generated Playwright tests.

- Execution: `npx playwright test tests/cycle-{run-id}/ --reporter=json` inside worker
- Playwright browsers cached at `PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright`
- Chromium installed on first use: `npx playwright install chromium`
- Pass/fail determines cycle E2E status
- On failure: enters feedback loop (re-run coders with test output, then re-run QA + E2E, max 2 loops)
- Results stored as `run.e2e = { status, tests, passed, failed, outputTail }`

### FR-TMP-004: Auto-PR Creation

After all validation passes, the orchestrator creates a GitHub PR.

- Uses `gh pr create` inside the worker container
- Title: `cycle/{run-id}: {task-title}`
- Body: summary, test counts, QA status, inspector grade, risk level, E2E count
- Base: `master`, Head: `cycle/{run-id}`
- Labels: low=`auto-merge,low-risk`, medium=`auto-merge,ai-reviewed`, high=`needs-approval,high-risk`
- Results stored as `run.pr = { number, url, status }`
- Graceful degradation: if `gh` CLI unavailable, skip PR creation, log warning

### FR-TMP-005: AI PR Review

For medium and high risk cycles, a Claude agent reviews the PR diff.

- Input: `git diff master...cycle/{run-id}`, task description, QA reports, E2E results
- Review criteria: code matches task, security, architecture patterns, bugs, test coverage
- Output: `gh pr review` with APPROVE or REQUEST_CHANGES
- For low risk: skipped
- Timeout handling: default to APPROVE for medium, keep PR open for high
- Results stored as `run.pr.aiReview` and `run.pr.aiReviewComment`

### FR-TMP-006: Auto-Merge Logic

After PR creation + AI review, apply risk-tiered merge strategy.

| Risk | E2E | AI Review | Action |
|------|-----|-----------|--------|
| low | pass | skipped | Auto-merge immediately |
| medium | pass | APPROVE | Auto-merge |
| medium | pass | REQUEST_CHANGES | Keep PR open, notify user |
| high | pass | APPROVE | Keep PR open, label "ready-for-review" |
| high | pass | REQUEST_CHANGES | Keep PR open, label "changes-requested" |

- Auto-merge command: `gh pr merge {pr-number} --squash --delete-branch`
- Conflict handling: keep PR open, label "merge-conflict"
- Results stored as `run.pr.status` (merged/open/changes-requested/merge-conflict)

### FR-TMP-007: Configuration

New environment variables for the orchestrator:

```
MERGE_STRATEGY=tiered          # tiered | manual | auto
DEFAULT_RISK_LEVEL=medium      # low | medium | high
AUTO_MERGE_LOW=true            # auto-merge low risk cycles
AUTO_MERGE_MEDIUM=true         # auto-merge medium risk (after AI review)
```

### FR-TMP-008: Worker Container Prerequisites

- `gh` CLI installed in worker Docker image (Dockerfile.worker)
- Playwright installable on demand (npx playwright install chromium)
- `GITHUB_TOKEN` already passed to workers via env

### FR-TMP-009: Run JSON Extensions

New fields on the run JSON:

```json
{
  "riskLevel": "medium",
  "e2e": { "status": "passed", "tests": 5, "passed": 5, "failed": 0, "outputTail": "..." },
  "pr": { "number": 42, "url": "...", "status": "merged", "aiReview": "APPROVE", "aiReviewComment": "..." }
}
```

### FR-TMP-010: Error Handling

| Scenario | Response |
|----------|----------|
| QA agent doesn't write E2E tests | Skip E2E phase, log warning, proceed |
| Playwright install fails | Skip E2E, log warning, proceed |
| E2E tests fail | Feedback loop (max 2) |
| PR creation fails | Log error, skip merge, cycle stays complete |
| AI review times out | Default APPROVE for medium, keep open for high |
| Auto-merge fails (conflict) | Keep PR open, label "merge-conflict" |
| gh CLI not available | Skip PR creation, log warning |

---

## Non-Functional Requirements

- **NFR-1**: E2E phase adds no more than 5 minutes to pipeline (excluding Playwright install)
- **NFR-2**: All new phases are additive — existing pipeline behavior unchanged when E2E tests don't exist
- **NFR-3**: Graceful degradation at every step — no new failure mode should break the existing pipeline
