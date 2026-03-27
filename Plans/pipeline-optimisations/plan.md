# Plan: Pipeline Optimisations

Traces to: `Plans/pipeline-optimisations/design.md`

All changes are to existing files. No new files except removing one.

## Phase 1: Model downgrades [backend-only] [S]

### 1a. Team routing — haiku
- **File:** `docker/orchestrator/server.js`
- **Change:** In `selectTeam()` (~line 135), add `--model haiku` to the `runClaude()` call
- **Verify:** Team routing still returns correct `TEAM: X | REASON: Y` format

### 1b. Traceability-reporter model declaration
- **File:** `Teams/TheATeam/README.md`
- **Change:** Update traceability-reporter model from `sonnet` to `haiku` in the role table
- **Note:** The actual model is set by the dispatch prompt builder — ensure `dispatch.js:buildAgentPrompt()` respects the model declared in the role file, or add `--model haiku` to the agent invocation

### 1c. Verify-reporter model declaration
- **File:** `Teams/TheFixer/README.md`
- **Change:** Update verify-reporter model from `sonnet` to `haiku` in the role table

## Phase 2: Conditional Inspector [backend-only] [M]

- **File:** `docker/orchestrator/lib/workflow-engine.js`
- **Location:** Phase 4 validation block (~line 1141-1168)
- **Change:** Wrap the Inspector invocation in a conditional:
  - `if (run.riskLevel === "low" && run.team === "TheFixer")` → skip Inspector, set `run.phases.inspector = { status: "skipped", reason: "low_risk_fixer" }`
  - Otherwise run Inspector as normal
- **Update:** Phase 5 result computation (~line 1180) must treat skipped inspector as passing: `const inspectorPassed = run.phases.inspector.status === "passed" || run.phases.inspector.status === "skipped"`
- **Verify:** Low-risk TheFixer cycles skip Inspector; TheATeam and high-risk cycles still run it

## Phase 3: Early commit before validation [backend-only] [M]

- **File:** `docker/orchestrator/lib/workflow-engine.js`
- **Location:** Between Phase 3.5 (app start) and Phase 4 (validation)
- **Change:** Insert a new Phase 3.9 block that:
  1. Calls `this.containerManager.commitAndPush(containerId, run.id, commitMsg)` with the same commit message pattern as Phase 6
  2. Runs the same remote verification check
  3. Sets `run.earlyPushVerified = true/false`
  4. Logs the result but does NOT fail the pipeline if push fails
- **Change Phase 6:** Convert the existing commit+push to an incremental push:
  1. Check if there are new changes since the early commit (validation artifacts, E2E results)
  2. If yes, commit and push again
  3. If no new changes, skip (early commit already pushed everything)
- **Verify:** Code reaches remote branch before validation starts; timeout during validation no longer loses work

## Phase 4: Scoped feedback loops [backend-only] [M]

- **File:** `docker/orchestrator/lib/workflow-engine.js`
- **Location:** QA feedback loop block (~line 1041-1108)
- **Change:** Add a `_detectFailedLayer(agentResults)` helper method that:
  1. Scans QA agent output for layer indicators: `[frontend]`, `[backend]`, `frontend-coder`, `backend-coder`, file paths containing `Frontend/` or `Backend/`
  2. Returns `"frontend"`, `"backend"`, `"both"`, or `"unknown"`
- **Change:** In the feedback loop, filter `implStage.agents` to only the matching layer:
  ```javascript
  const failedLayer = this._detectFailedLayer(agentResults);
  const scopedAgents = failedLayer === "unknown" || failedLayer === "both"
    ? implStage.agents  // fallback: re-run all
    : implStage.agents.filter(a => a.role.toLowerCase().includes(failedLayer));
  const scopedStage = { ...implStage, agents: scopedAgents.length > 0 ? scopedAgents : implStage.agents };
  ```
- **Verify:** When only frontend fails QA, only frontend-coder re-runs; when ambiguous, all re-run

## Phase 5: Remove dead LearningsSync [backend-only] [S]

- **File:** `docker/orchestrator/lib/learnings-sync.js` — DELETE this file
- **File:** `docker/orchestrator/server.js`
  - Remove `const { LearningsSync } = require("./lib/learnings-sync")`
  - Remove `const learningsSync = new LearningsSync()`
  - Remove any references to `learningsSync` variable
- **Note:** The actual learnings sync (in-worker bash script at workflow-engine.js:1406-1418) is NOT touched
- **Verify:** Orchestrator starts without errors; learnings still sync via in-worker script

## Phase 6: Playwright in worker image [backend-only] [S]

- **File:** `docker/Dockerfile.worker`
- **Change:** Add Playwright chromium install to the build:
  ```dockerfile
  RUN npx playwright install --with-deps chromium
  ```
- **File:** `docker/orchestrator/lib/workflow-engine.js`
- **Location:** `_runPlaywrightE2E()` (~line 179-194)
- **Change:** Before installing chromium, check if it's already present:
  ```javascript
  const chromiumCheck = await this.containerManager.execInWorker(
    containerId, "bash",
    ["-c", "PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright npx playwright install --dry-run chromium 2>&1 || npx playwright --version 2>/dev/null"],
    { label: "playwright-check", quiet: true }
  );
  // Skip install if chromium already available in the image
  if (chromiumCheck.exitCode !== 0 || !chromiumCheck.stdout.includes("chromium")) {
    // existing install logic
  }
  ```
- **Verify:** Worker image builds with chromium pre-installed; E2E phase skips redundant install
