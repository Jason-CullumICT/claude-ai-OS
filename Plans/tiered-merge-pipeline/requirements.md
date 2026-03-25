# Requirements: Tiered Merge Pipeline

## FR-TMP-001 [backend] [M]
**Risk classification extraction**
- Team leader planning output includes `RISK_LEVEL: low|medium|high`
- Orchestrator extracts risk level via regex `/RISK_LEVEL:\s*(low|medium|high)/i`
- Default to config.defaultRiskLevel ("medium") if not found
- Stored on run JSON as `run.riskLevel`
- AC: Risk level is extracted from leader output and stored on run
- AC: Missing risk level defaults to "medium"

## FR-TMP-002 [backend] [M]
**QA agent E2E test generation prompt**
- QA agent dispatch prompts are augmented with Playwright E2E test generation instructions
- Tests written to `Source/E2E/tests/cycle-{run-id}/` inside the worker
- Template uses `@playwright/test`, targets `http://localhost:5173`
- AC: QA agents receive E2E generation instructions in their dispatch prompt
- AC: Generated tests use the correct directory path with run ID

## FR-TMP-003 [backend] [L]
**Playwright E2E runner phase (Phase 5.5)**
- New phase after Phase 5 (results) runs Playwright tests inside the worker container
- Installs chromium on first use: `PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright npx playwright install chromium`
- Executes: `npx playwright test tests/cycle-{run-id}/ --reporter=json`
- Parses JSON output for pass/fail counts
- Stores results on run JSON as `run.e2e = { status, tests, passed, failed, outputTail }`
- On failure: triggers feedback loop (re-run coders + QA + E2E, max 2 loops)
- Gracefully skips if no E2E tests found or Playwright install fails
- AC: E2E tests run against live app in worker container
- AC: Results stored on run JSON with pass/fail counts
- AC: Failure triggers feedback loop up to max iterations
- AC: Missing tests or install failure logs warning and continues

## FR-TMP-004 [backend] [L]
**Auto-PR creation via gh CLI**
- After commit+push (Phase 6), creates GitHub PR from cycle branch to master
- PR title format: `cycle/{run-id}: {task-title}`
- PR body includes: summary, test count, QA status, inspector grade, risk level, E2E count
- PR labels based on risk: low→`auto-merge,low-risk`, medium→`auto-merge,ai-reviewed`, high→`needs-approval,high-risk`
- Stores on run JSON as `run.pr = { number, url, status }`
- Gracefully skips if gh CLI not available or PR creation fails
- AC: PR is created with correct title, body, labels
- AC: PR metadata stored on run JSON
- AC: Missing gh CLI logs warning and continues

## FR-TMP-005 [backend] [L]
**AI PR review agent**
- For medium and high risk, runs a Claude review agent via `claude -p` in the worker
- Review context: git diff, task description, QA reports, E2E results
- Review criteria: code matches task, security concerns, architecture patterns, bugs, test coverage
- Output parsed for APPROVE or REQUEST_CHANGES
- Posts review on PR via `gh pr review`
- Stores on run JSON as `run.pr.aiReview` and `run.pr.aiReviewComment`
- Skipped for low risk
- Timeout defaults to APPROVE for medium, keeps open for high
- AC: AI review runs for medium and high risk
- AC: Review is posted as a GitHub PR review
- AC: Review verdict stored on run JSON

## FR-TMP-006 [backend] [M]
**Auto-merge decision logic**
- After PR creation + optional AI review, applies merge decision based on risk matrix:
  - low + E2E pass → auto-merge (squash, delete branch)
  - medium + E2E pass + AI APPROVE → auto-merge
  - medium + E2E pass + AI REQUEST_CHANGES → keep PR open, notify
  - high + AI APPROVE → keep PR open, label "ready-for-review"
  - high + AI REQUEST_CHANGES → keep PR open, label "changes-requested"
- Auto-merge via `gh pr merge {number} --squash --delete-branch`
- Merge conflict → keep PR open, label "merge-conflict"
- Configurable via AUTO_MERGE_LOW and AUTO_MERGE_MEDIUM env vars
- AC: Low risk auto-merges when E2E passes
- AC: Medium risk auto-merges when E2E + AI review passes
- AC: High risk never auto-merges
- AC: Merge conflicts are handled gracefully with labeling

## FR-TMP-007 [backend] [S]
**Merge pipeline configuration**
- New env vars in config.js: MERGE_STRATEGY, DEFAULT_RISK_LEVEL, AUTO_MERGE_LOW, AUTO_MERGE_MEDIUM
- MERGE_STRATEGY values: "tiered" (default), "manual" (skip all merge logic), "auto" (always merge)
- When MERGE_STRATEGY=manual, all new phases are skipped
- AC: Config values read from environment with sensible defaults
- AC: MERGE_STRATEGY=manual disables all new phases

## FR-TMP-008 [backend] [S]
**Worker image: gh CLI installation**
- Add `gh` (GitHub CLI) to Dockerfile.worker
- Auth via existing GITHUB_TOKEN env var passed to workers
- AC: gh CLI is available in worker containers
- AC: gh auth works via GITHUB_TOKEN

## FR-TMP-009 [backend] [M]
**Run JSON schema extension**
- Run object initialized with new fields: riskLevel (null), e2e (null), pr (null)
- Fields populated during respective phases
- Dashboard HTML updated to show risk badge, E2E results, PR link/status
- AC: New fields present on run JSON from creation
- AC: Dashboard renders risk, E2E, and PR information

## FR-TMP-010 [backend] [S]
**Playwright E2E infrastructure setup**
- Create `Source/E2E/playwright.config.ts` with base configuration
- Target: http://localhost:5173
- Reporter: json
- Browser: chromium only
- Test directory: `tests/`
- AC: Playwright config exists and targets the correct URL
- AC: Config uses chromium browser and JSON reporter

## Complexity Summary

| FR | Weight | Points |
|----|--------|--------|
| FR-TMP-001 | M | 2 |
| FR-TMP-002 | M | 2 |
| FR-TMP-003 | L | 4 |
| FR-TMP-004 | L | 4 |
| FR-TMP-005 | L | 4 |
| FR-TMP-006 | M | 2 |
| FR-TMP-007 | S | 1 |
| FR-TMP-008 | S | 1 |
| FR-TMP-009 | M | 2 |
| FR-TMP-010 | S | 1 |
| **Total** | | **23** |

All FRs are `[backend]` — this is an orchestrator/infrastructure feature with no frontend-coder work.
