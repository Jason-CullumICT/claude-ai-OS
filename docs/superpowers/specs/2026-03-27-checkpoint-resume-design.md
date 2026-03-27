# Checkpoint Resume — Design Specification

## Problem

When a pipeline run fails (timeout, validation failure, PR creation error), retrying re-runs the entire pipeline from scratch — leader planning, dispatch parsing, implementation, QA, everything. This wastes significant tokens and wall-clock time on phases that already completed successfully.

A failed run that got through implementation (the most expensive phase) and failed at validation currently costs the same to retry as a fresh run. The volume is reused (code survives), but every Claude agent invocation re-runs.

## Goals

1. Retries skip phases that already completed successfully, resuming from the first failed or incomplete phase
2. Each phase is cheaply re-validated before skipping (shell commands, not Claude calls) to catch volume corruption or stale state
3. Users can explicitly choose a resume point via the API
4. A human-readable progress file is written to the plan directory as phases complete
5. The run JSON remains the authoritative record; the progress file is a convenience view

## Non-Goals

- Refactoring the workflow engine into a phase-runner abstraction (future work)
- Partial re-runs of a single phase (e.g. re-running one of three parallel coders)
- Progress file driving the skip logic (it's read-only output, not input)

## Pipeline Phase Order

The canonical phase order for all progress tracking and resume logic:

```
Phase 1:    Leader planning
Phase 2:    Dispatch parsing
Phase 3:    Implementation (parallel coders/fixers)
Phase 3.5:  App start
Phase 3.6:  QA (can test against live app)
Phase 4:    Validation (smoketest + inspector in parallel)
Phase 5.5:  E2E (Playwright against live app)
Phase 6:    Commit + push
Phase 6.5:  PR creation + AI review + auto-merge
Phase 8:    Learnings sync
```

## Design

### 1. Retry Endpoint Changes

**File:** `docker/orchestrator/server.js` — `POST /api/runs/:id/retry`

Current behavior creates a new run with empty `phases: {}` and `results: {}`. Change to carry forward state from the original run:

```javascript
const run = {
  id: `run-${Date.now()}-${randomUUID().slice(0, 8)}`,
  status: "resuming",
  task: originalRun.task,
  planFile: originalRun.planFile,
  repo: originalRun.repo,
  repoBranch: originalRun.repoBranch,
  team: originalRun.team,               // reuse — don't re-route
  teamReason: `Resumed from ${originalRun.id}`,
  attachments: originalRun.attachments || [],
  ports: null,
  branch: originalRun.branch,           // reuse cycle branch
  results: { ...originalRun.results },   // carry forward
  phases: { ...originalRun.phases },     // carry forward
  feedbackLoops: originalRun.feedbackLoops || 0,
  resumedFrom: originalRun.id,
  resumePoint: req.body.resumeFrom || null,  // explicit override or null for auto
  reuseVolume: `workspace-${originalRun.id}`,
  createdAt: ts(),
  updatedAt: ts(),
};
```

The `resumeFrom` body parameter accepts phase names: `"leader"`, `"dispatch"`, `"implementation"`, `"app"`, `"qa"`, `"validation"`, `"e2e"`, `"commit"`, `"pr"`, `"learnings"`.

When `resumeFrom` is provided, all phases before that point are treated as passed (no re-validation). All phases from that point forward re-run.

When `resumeFrom` is null (default), each phase is cheaply re-validated before deciding to skip.

### 2. Checkpoint Skip Logic in WorkflowEngine

**File:** `docker/orchestrator/lib/workflow-engine.js` — `executeWorkflow()`

At the top of the method, detect resume mode:

```javascript
const isResume = !!run.resumedFrom;
const resumePoint = run.resumePoint;
```

Add a helper method to the class:

```javascript
_shouldSkipPhase(run, phaseName, phaseKey) {
  if (!run.resumedFrom) return false;

  // Explicit resume point: skip everything before it
  if (run.resumePoint) {
    const phaseOrder = [
      "leader", "dispatch", "implementation", "app",
      "qa", "validation", "e2e", "commit", "pr", "learnings"
    ];
    const resumeIdx = phaseOrder.indexOf(run.resumePoint);
    const currentIdx = phaseOrder.indexOf(phaseName);
    if (currentIdx < resumeIdx) return true;
    return false;  // at or past resume point — execute
  }

  // Auto mode: check if phase previously passed
  // Phase keys may be exact (e.g. "leader") or dynamic (e.g. "stage_0_implementation")
  // For dynamic keys, scan all phases matching the name pattern
  if (phaseKey && run.phases[phaseKey]) {
    const phase = run.phases[phaseKey];
    return phase.status === "passed" || phase.status === "skipped";
  }
  // Scan for dynamic stage keys matching phaseName
  const matchingKeys = Object.keys(run.phases).filter(k =>
    k.includes(phaseName) && !k.startsWith("feedback_")
  );
  return matchingKeys.length > 0 && matchingKeys.every(k =>
    run.phases[k].status === "passed" || run.phases[k].status === "skipped"
  );
}
```

Each phase block gets a skip gate with a cheap validation check:

#### Phase 1: Leader

```javascript
if (this._shouldSkipPhase(run, "leader", "leader")) {
  const planExists = await this._readWorkerFile(containerId, `/workspace/${run.planFile || "Plans"}`);
  if (planExists !== null) {
    console.log(`[${run.id}] RESUME: Skipping leader (already passed)`);
    // continue to Phase 2
  } else {
    console.log(`[${run.id}] RESUME: Leader output lost — re-running`);
    // fall through to execute
  }
}
```

#### Phase 2: Dispatch

```javascript
if (this._shouldSkipPhase(run, "dispatch", "dispatch")) {
  if (run.phases.dispatch?.plan?.stages?.length > 0) {
    console.log(`[${run.id}] RESUME: Skipping dispatch (${run.phases.dispatch.plan.stages.length} stages cached)`);
    dispatchPlan = run.phases.dispatch.plan;
    // continue to Phase 3
  }
}
```

#### Phase 3: Implementation

```javascript
if (this._shouldSkipPhase(run, "implementation", stageKey)) {
  // Cheap validation: verify code files exist in the volume
  const codeCheck = await this.containerManager.execInWorker(
    containerId, "bash", ["-c",
      "cd /workspace && git diff --name-only HEAD~5..HEAD 2>/dev/null | head -20"
    ], { label: "resume-impl-check", quiet: true }
  );
  if (codeCheck.stdout.trim()) {
    console.log(`[${run.id}] RESUME: Skipping implementation (code changes present)`);
    // continue to next phase
  }
}
```

#### Phase 3.5: App Start

Never skip — always re-run. It's stateless and instant.

#### Phase 3.6: QA

```javascript
if (this._shouldSkipPhase(run, "qa", stageKey)) {
  // Skip only if implementation was also skipped (no new code to review)
  if (!implReRan) {
    console.log(`[${run.id}] RESUME: Skipping QA (impl unchanged)`);
    // continue to validation
  }
}
```

If implementation was re-run, QA must also re-run regardless of prior status.

#### Phase 4: Validation

```javascript
if (this._shouldSkipPhase(run, "validation", "smoketest")) {
  if (!implReRan && !qaReRan) {
    console.log(`[${run.id}] RESUME: Skipping validation (no upstream changes)`);
    // continue to E2E
  }
}
```

#### Phase 5.5: E2E

```javascript
if (this._shouldSkipPhase(run, "e2e", "e2e")) {
  if (run.e2e?.status === "passed") {
    console.log(`[${run.id}] RESUME: Skipping E2E (already passed)`);
    // continue to commit
  }
}
```

#### Phase 6+: Commit, PR, Learnings

These always re-run on resume — they're cheap and their success depends on external state (remote branch, GitHub API) that may have changed.

### 3. Cascade Rule

When any phase re-runs, all downstream phases must also re-run. Track this with a simple boolean:

```javascript
let mustReRunFrom = null;  // set to phase name when a skip-check fails

// In each phase's skip gate:
if (mustReRunFrom) {
  // upstream was re-run — don't skip this phase
}
```

This ensures that if implementation is re-run, QA/validation/E2E/commit all re-run too.

### 4. Progress Artifact

**File:** `docker/orchestrator/lib/workflow-engine.js` — new helper method

```javascript
async _writeProgress(containerId, run) {
  if (!run.planFile) return;  // no plan directory — skip

  const planDir = run.planFile.replace(/\/[^/]+$/, '');  // e.g. "Plans/pipeline-optimisations"
  const phases = [
    { name: "leader", key: "leader", label: "Leader planning" },
    { name: "dispatch", key: "dispatch", label: "Dispatch parsing" },
    // implementation + QA stages are dynamic — read from run.phases
    { name: "app", key: null, label: "App start" },
    { name: "validation", key: "smoketest", label: "Validation (smoketest + inspector)" },
    { name: "e2e", key: "e2e", label: "E2E" },
    { name: "commit", key: null, label: "Commit + push" },
    { name: "pr", key: "prMerge", label: "PR creation + merge" },
    { name: "learnings", key: null, label: "Learnings sync" },
  ];

  let lines = [
    `# Pipeline Progress: ${run.id}`,
    "",
    `**Task:** ${run.task.slice(0, 200)}`,
    `**Team:** ${run.team} | **Risk:** ${run.riskLevel} | **Branch:** ${run.branch}`,
    `**Started:** ${run.createdAt} | **Updated:** ${run.updatedAt}`,
  ];

  if (run.resumedFrom) {
    lines.push(`**Resumed from:** ${run.resumedFrom}`);
  }

  lines.push("", "## Phases", "");

  // Build phase lines from run.phases, including dynamic impl/QA stages
  for (const [key, phase] of Object.entries(run.phases)) {
    const status = phase.status;
    const duration = phase.startedAt && phase.completedAt
      ? Math.round((new Date(phase.completedAt) - new Date(phase.startedAt)) / 1000)
      : null;
    const durationStr = duration ? ` (${duration}s)` : "";
    const skipped = status === "skipped";
    const passed = status === "passed";
    const failed = status === "failed";
    const running = status === "running";

    if (passed) {
      lines.push(`- [x] ${phase.stageName || key}${durationStr}`);
    } else if (skipped) {
      lines.push(`- [x] ~~${phase.stageName || key}~~ (skipped${phase.reason ? ": " + phase.reason : ""})`);
    } else if (failed) {
      lines.push(`- [ ] ${phase.stageName || key} (FAILED${durationStr})`);
    } else if (running) {
      lines.push(`- [ ] ${phase.stageName || key} (running...)`);
    } else {
      lines.push(`- [ ] ${phase.stageName || key}`);
    }
  }

  const content = lines.join("\\n");
  await this.containerManager.execInWorker(
    containerId, "bash",
    ["-c", `cat > /workspace/${planDir}/progress.md << 'PROGRESS_EOF'\n${content}\nPROGRESS_EOF`],
    { label: "write-progress", quiet: true }
  );
}
```

Called at the end of every phase block — both on execute and skip paths.

### 5. API Ergonomics

The retry endpoint response includes resume info:

```json
{
  "id": "run-...",
  "status": "resuming",
  "resumedFrom": "run-original-id",
  "resumePoint": "validation",
  "skippedPhases": ["leader", "dispatch", "implementation", "app", "qa"],
  "message": "Resuming from validation — 5 phases skipped"
}
```

### 6. Dashboard Visibility

The existing dashboard at `GET /` should show resumed runs with a "RESUMED" badge and list which phases were skipped. This is a display-only change to the HTML template in `server.js`.

## Files Changed

| File | Change |
|------|--------|
| `docker/orchestrator/server.js` | Retry endpoint carries forward phases/results, accepts `resumeFrom` |
| `docker/orchestrator/lib/workflow-engine.js` | `_shouldSkipPhase()`, `_writeProgress()`, skip gates in every phase block |

## Files Not Changed

| File | Reason |
|------|--------|
| Team role `.md` files | No agent behavior changes |
| `docker-compose.yml` | No infrastructure changes |
| `lib/container-manager.js` | Volume reuse already works |

## Testing

- Retry a failed run that passed implementation — verify leader/dispatch/impl are skipped
- Retry with `resumeFrom=validation` — verify everything before validation is skipped
- Retry with a corrupted volume (delete a file) — verify cheap validation detects it and re-runs from that point
- Verify `progress.md` is written after each phase and reflects correct state
- Verify cascade: if implementation re-runs, QA/validation/E2E also re-run
