# Design: Tiered Merge Pipeline

## Architecture Overview

The tiered merge pipeline extends the existing workflow engine with three new phases inserted between the current phases. All new logic lives in the orchestrator (`docker/orchestrator/`), with minimal changes to the worker image (adding `gh` CLI).

```
EXISTING:                          NEW ADDITIONS:
Phase 0:  Spawn worker             (unchanged)
Phase 1:  Team leader planning     + extracts RISK_LEVEL from output
Phase 2:  Parse dispatch plan      + stores riskLevel on run JSON
Phase 3:  Execute stages           + QA agent prompts include E2E test generation
Phase 3.5: Start app               (unchanged)
Phase 4:  Validation               (unchanged)
Phase 5:  Compute results          (unchanged)
Phase 5.5: Playwright E2E runner   [NEW] — runs generated tests against live app
Phase 6:  Commit + push            (unchanged)
Phase 6.5: PR + AI review + merge  [NEW] — create PR, review, auto-merge decision
Phase 7:  Sync learnings           (unchanged)
```

## Key Design Decisions

### 1. Risk Classification: Leader Output Parsing (not separate agent)

**Decision:** Extract risk level from team leader's planning output via regex.
**Rationale:** Adding a separate classification agent adds latency and cost. The leader already analyzes scope during planning — adding a `RISK_LEVEL: X` directive to the leader prompt is lightweight and accurate enough.
**Regex:** `/RISK_LEVEL:\s*(low|medium|high)/i` — default to "medium" if not found.

### 2. E2E Test Generation: QA Agent Prompt Augmentation (not separate generator)

**Decision:** Augment existing QA agent prompts to also write Playwright tests.
**Rationale:** QA agents already understand the feature scope and review the implementation. Generating E2E tests is a natural extension of their review work. A separate E2E generator agent would need to re-learn the same context.
**Output location:** `Source/E2E/tests/cycle-{run-id}/` within the worker container.

### 3. Playwright Execution: Inside Worker Container

**Decision:** Run Playwright tests inside the same worker container where the app runs.
**Rationale:** The app is already running on localhost:5173 inside the worker. Running tests in the same container avoids networking complexity. Chromium is installed on first use and cached in the worker volume.
**Trade-off:** First run in a container is slower (~30s for chromium install). Subsequent runs in the same cycle are fast.

### 4. PR Creation: gh CLI in Worker (not GitHub API from orchestrator)

**Decision:** Use `gh` CLI inside the worker container for PR creation and merge.
**Rationale:** The worker already has `GITHUB_TOKEN` and the branch checked out. Using `gh` CLI is simpler than making HTTP calls from the orchestrator. The orchestrator can exec into the container to run `gh` commands.
**Prerequisite:** Add `gh` CLI to Dockerfile.worker.

### 5. AI Review: Claude via `claude -p` (not separate MCP tool)

**Decision:** Run AI review as a claude CLI call inside the worker container.
**Rationale:** Workers already have `claude` CLI installed. The review agent gets the git diff, task description, and QA reports as context. Output is parsed for APPROVE/REQUEST_CHANGES.

### 6. Auto-Merge: Orchestrator Decision, Worker Execution

**Decision:** The orchestrator makes the merge decision based on risk + review status, then executes via container exec.
**Rationale:** Centralized decision logic in the orchestrator is easier to audit and configure. The merge itself runs inside the worker where `gh` CLI is available.

### 7. New Module: `lib/merge-pipeline.js`

**Decision:** Create a new module for all merge-related logic rather than adding to workflow-engine.js.
**Rationale:** The workflow engine is already 662 lines. Merge logic (E2E runner, PR creation, AI review, merge decision) is a cohesive unit that deserves its own module. The workflow engine calls into it at the appropriate phases.

## API / Interface Changes

### New Run JSON Fields

Added to the run object in `server.js` initialization (line ~244):

```javascript
riskLevel: null,        // "low" | "medium" | "high" — set during Phase 1
e2e: null,              // { status, tests, passed, failed, outputTail }
pr: null,               // { number, url, status, aiReview, aiReviewComment }
```

### New Config Environment Variables

Added to `lib/config.js`:

```javascript
mergeStrategy:        process.env.MERGE_STRATEGY || 'tiered',
defaultRiskLevel:     process.env.DEFAULT_RISK_LEVEL || 'medium',
autoMergeLow:         process.env.AUTO_MERGE_LOW !== 'false',
autoMergeMedium:      process.env.AUTO_MERGE_MEDIUM !== 'false',
```

### New Module: `lib/merge-pipeline.js`

Exports:
- `runPlaywrightE2E(containerManager, containerId, runId)` → `{ status, tests, passed, failed, outputTail }`
- `createPR(containerManager, containerId, run)` → `{ number, url }`
- `runAIReview(containerManager, containerId, run)` → `{ verdict, comment }`
- `executeMergeDecision(containerManager, containerId, run, config)` → `{ action, status }`

### Modified Files

| File | Change |
|------|--------|
| `docker/orchestrator/lib/workflow-engine.js` | Add Phase 5.5 (E2E) and Phase 6.5 (PR/review/merge) |
| `docker/orchestrator/lib/config.js` | Add merge strategy env vars |
| `docker/orchestrator/server.js` | Initialize new run JSON fields, update dashboard HTML |
| `docker/orchestrator/lib/dispatch.js` | Augment QA agent prompts with E2E test generation instructions |
| `docker/Dockerfile.worker` | Add `gh` CLI installation |
| `docker/orchestrator/lib/merge-pipeline.js` | [NEW] All merge pipeline logic |

### QA Agent Prompt Augmentation

In `lib/dispatch.js`, when building QA agent prompts, append:

```
Additionally, write Playwright E2E test files at Source/E2E/tests/cycle-{run-id}/ that
verify the feature works in a real browser. Tests must run against http://localhost:5173.
Use @playwright/test. Each test navigates to a page, interacts with UI elements, and
asserts expected outcomes.
```

## Error Handling Strategy

All new phases are designed to be gracefully skippable:
- E2E tests not found → skip Phase 5.5, log warning
- Playwright install fails → skip Phase 5.5, log warning
- E2E fails → feedback loop (max 2, same as existing)
- PR creation fails → skip merge, cycle still marked complete with branch
- AI review timeout → default APPROVE for medium, keep open for high
- Auto-merge conflict → keep PR open, label "merge-conflict"
- gh CLI missing → skip PR creation entirely

## Diagram

```
                    ┌─────────────────────┐
                    │  Phase 5: Results   │
                    └────────┬────────────┘
                             │
                    ┌────────▼────────────┐
                    │ Phase 5.5: E2E Run  │──── fail ──→ feedback loop (max 2)
                    └────────┬────────────┘
                             │ pass
                    ┌────────▼────────────┐
                    │ Phase 6: Commit/Push│
                    └────────┬────────────┘
                             │
                    ┌────────▼────────────┐
                    │ Phase 6.5: PR+Merge │
                    │                     │
                    │  ┌─────────────┐    │
                    │  │ Create PR   │    │
                    │  └──────┬──────┘    │
                    │         │           │
                    │  ┌──────▼──────┐    │
                    │  │ Risk check  │    │
                    │  └──┬───┬───┬──┘    │
                    │  low│ med│ high│     │
                    │     │   │    │      │
                    │  merge│ AI  │ AI    │
                    │     │review│review  │
                    │     │   │    │      │
                    │     │merge│ wait    │
                    └─────┴───┴───┴──────┘
                             │
                    ┌────────▼────────────┐
                    │ Phase 7: Learnings  │
                    └─────────────────────┘
```
