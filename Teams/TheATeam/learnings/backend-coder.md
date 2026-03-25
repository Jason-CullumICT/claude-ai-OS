# Backend Coder Learnings

## 2026-03-25: Tiered Merge Pipeline (backend-coder-2)

### dispatch.js patterns
- `buildAgentPrompt()` signature: `(role, task, team, planCtx, runId)` — runId is the 5th param, added for FR-TMP-002
- `parseDispatchPlan()` signature: `(leaderOutput, task, team, runId)` — runId is the 4th param
- QA agents (non-impl roles) get E2E test generation instructions when runId is present
- `enrichTaskForLeader()` appends risk classification instructions to the task before leader planning

### workflow-engine.js integration
- `_parseDispatchFromWorker()` accepts `runId` as 5th param, passes it through to `buildAgentPrompt()`
- The leader task is enriched via `dispatch.enrichTaskForLeader()` before being passed to `run-team.sh`
- Backend-coder-1 owns workflow-engine.js and config.js — coordinate on interface changes

### Dockerfile.worker
- gh CLI installed via apt from GitHub's official package repo
- Placed before Claude Code install to keep layer caching efficient
- Auth handled via GITHUB_TOKEN env var already passed to workers

### server.js
- `GET /api/runs` list endpoint destructures and re-maps fields — must add new fields explicitly
- `GET /api/runs/:id` returns full run object — new fields included automatically

## 2026-03-25: Tiered Merge Pipeline (backend-coder-1)

### workflow-engine.js — new phases and methods
- Phase 1b: Risk extraction uses `/RISK_LEVEL:\s*(low|medium|high)/i` regex on leaderResult.stdout
- Phase 5.5: `_runPlaywrightE2E()` — runs Playwright E2E tests in worker, gracefully skips on any failure
- Phase 6.5: `_createPR()`, `_aiReviewPR()`, `_autoMerge()` — full PR lifecycle
- E2E feedback loop shares counter with QA feedback loop (max 2 total per run)
- All new methods wrap in try/catch with graceful degradation — pipeline never breaks from new code
- Playwright JSON output parser walks `report.suites[].specs[].tests[]` recursively

### config.js — new tiered merge config
- `mergeStrategy`, `defaultRiskLevel`, `autoMergeLow`, `autoMergeMedium`
- `AUTO_MERGE_LOW` and `AUTO_MERGE_MEDIUM` use `!== "false"` pattern (default true)

### Testing patterns
- Node built-in test runner (`node --test`) works well for this project — no test framework needed
- Mock `containerManager.execInWorker()` with label-based routing (opts.label) for targeted mock responses
- All 26 tests pass covering FR-TMP-001, 003, 004, 005, 006, 007, 009, 010

### Interface contract with backend-coder-2
- `_parseDispatchFromWorker()` now passes `run.id` to dispatch calls per the 5th param contract
- `enrichTaskForLeader()` is called by coder-2's dispatch.js changes — workflow engine passes raw task
