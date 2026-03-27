# Checkpoint Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pipeline retries skip completed phases, cheaply re-validate before skipping, and write a human-readable progress file to the plan directory.

**Architecture:** Add checkpoint skip gates to each phase in `executeWorkflow()`, carry forward `phases`/`results` from the original run on retry, and write `progress.md` after each phase. A cascade boolean ensures downstream phases re-run when upstream phases are re-executed.

**Tech Stack:** Node.js, Docker exec, Node built-in test runner

**Spec:** `docs/superpowers/specs/2026-03-27-checkpoint-resume-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `docker/orchestrator/lib/workflow-engine.js` | Modify | `_shouldSkipPhase()`, `_writeProgress()`, skip gates in every phase, cascade tracking |
| `docker/orchestrator/server.js` | Modify | Retry endpoint carries forward state, accepts `resumeFrom`, enriched response |
| `docker/orchestrator/lib/workflow-engine.test.js` | Modify | Tests for skip logic, cascade, progress writing |

No new files created. No other files touched.

---

### Task 1: `_shouldSkipPhase()` Helper Method

**Files:**
- Modify: `docker/orchestrator/lib/workflow-engine.js` (add method to class, before `_readWorkerFile`)
- Test: `docker/orchestrator/lib/workflow-engine.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `workflow-engine.test.js` after the existing test blocks:

```javascript
// Verifies: checkpoint-resume — _shouldSkipPhase
describe("_shouldSkipPhase (checkpoint-resume)", () => {
  it("returns false when run is not a resume", () => {
    const engine = new WorkflowEngine(createMockDeps());
    const run = createMockRun();
    assert.equal(engine._shouldSkipPhase(run, "leader", "leader"), false);
  });

  it("returns true for passed phase in auto mode", () => {
    const engine = new WorkflowEngine(createMockDeps());
    const run = createMockRun();
    run.resumedFrom = "run-original";
    run.phases.leader = { status: "passed" };
    assert.equal(engine._shouldSkipPhase(run, "leader", "leader"), true);
  });

  it("returns false for failed phase in auto mode", () => {
    const engine = new WorkflowEngine(createMockDeps());
    const run = createMockRun();
    run.resumedFrom = "run-original";
    run.phases.leader = { status: "failed" };
    assert.equal(engine._shouldSkipPhase(run, "leader", "leader"), false);
  });

  it("returns true for skipped phase in auto mode", () => {
    const engine = new WorkflowEngine(createMockDeps());
    const run = createMockRun();
    run.resumedFrom = "run-original";
    run.phases.leader = { status: "skipped" };
    assert.equal(engine._shouldSkipPhase(run, "leader", "leader"), true);
  });

  it("skips phases before explicit resumePoint", () => {
    const engine = new WorkflowEngine(createMockDeps());
    const run = createMockRun();
    run.resumedFrom = "run-original";
    run.resumePoint = "validation";
    // leader is before validation — should skip
    assert.equal(engine._shouldSkipPhase(run, "leader", "leader"), true);
    // implementation is before validation — should skip
    assert.equal(engine._shouldSkipPhase(run, "implementation", "stage_0_implementation"), true);
    // validation is the resume point — should NOT skip
    assert.equal(engine._shouldSkipPhase(run, "validation", "smoketest"), false);
    // e2e is after validation — should NOT skip
    assert.equal(engine._shouldSkipPhase(run, "e2e", "e2e"), false);
  });

  it("handles dynamic stage keys like stage_0_implementation", () => {
    const engine = new WorkflowEngine(createMockDeps());
    const run = createMockRun();
    run.resumedFrom = "run-original";
    run.phases.stage_0_implementation = { status: "passed", stageName: "implementation" };
    // phaseKey doesn't match directly, but phaseName scan should find it
    assert.equal(engine._shouldSkipPhase(run, "implementation", "stage_0_implementation"), true);
  });

  it("ignores feedback_ phases when scanning dynamic keys", () => {
    const engine = new WorkflowEngine(createMockDeps());
    const run = createMockRun();
    run.resumedFrom = "run-original";
    run.phases.stage_0_implementation = { status: "passed" };
    run.phases.feedback_1_implementation = { status: "failed" };
    // The feedback phase failed, but the original stage passed — should still skip
    assert.equal(engine._shouldSkipPhase(run, "implementation", "stage_0_implementation"), true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test docker/orchestrator/lib/workflow-engine.test.js`
Expected: FAIL — `_shouldSkipPhase is not a function`

- [ ] **Step 3: Implement `_shouldSkipPhase()`**

Add this method to the `WorkflowEngine` class in `docker/orchestrator/lib/workflow-engine.js`, immediately before the `_readWorkerFile` method (around line 48):

```javascript
  // ════════════════════════════════════════════════════════════
  // Helper: decide whether a phase should be skipped on resume
  // ════════════════════════════════════════════════════════════

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
      if (currentIdx >= 0 && resumeIdx >= 0 && currentIdx < resumeIdx) return true;
      return false;
    }

    // Auto mode: check exact phaseKey first
    if (phaseKey && run.phases[phaseKey]) {
      const phase = run.phases[phaseKey];
      return phase.status === "passed" || phase.status === "skipped";
    }

    // Scan for dynamic stage keys matching phaseName (e.g. stage_0_implementation)
    const matchingKeys = Object.keys(run.phases).filter(k =>
      k.includes(phaseName) && !k.startsWith("feedback_")
    );
    return matchingKeys.length > 0 && matchingKeys.every(k =>
      run.phases[k].status === "passed" || run.phases[k].status === "skipped"
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test docker/orchestrator/lib/workflow-engine.test.js`
Expected: All `_shouldSkipPhase` tests PASS, existing tests still PASS

- [ ] **Step 5: Commit**

```bash
git add docker/orchestrator/lib/workflow-engine.js docker/orchestrator/lib/workflow-engine.test.js
git commit -m "feat(resume): add _shouldSkipPhase helper for checkpoint skip logic"
```

---

### Task 2: `_writeProgress()` Helper Method

**Files:**
- Modify: `docker/orchestrator/lib/workflow-engine.js` (add method to class)
- Test: `docker/orchestrator/lib/workflow-engine.test.js`

- [ ] **Step 1: Write the failing tests**

Add to `workflow-engine.test.js`:

```javascript
// Verifies: checkpoint-resume — _writeProgress
describe("_writeProgress (checkpoint-resume)", () => {
  it("writes progress.md to the plan directory", async () => {
    let writtenPath = null;
    let writtenContent = null;
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (opts && opts.label === "write-progress") {
            // Extract path and content from the bash command
            const bashCmd = args[1] || "";
            const pathMatch = bashCmd.match(/cat > \/workspace\/(.+?) <</);
            writtenPath = pathMatch ? pathMatch[1] : null;
            writtenContent = bashCmd;
            return { exitCode: 0, stdout: "" };
          }
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.planFile = "Plans/pipeline-optimisations/plan.md";
    run.riskLevel = "low";
    run.branch = "cycle/test-run-001";
    run.createdAt = "2026-03-27T00:00:00Z";
    run.updatedAt = "2026-03-27T01:00:00Z";
    run.phases.leader = { status: "passed", startedAt: "2026-03-27T00:00:00Z", completedAt: "2026-03-27T00:02:00Z" };

    await engine._writeProgress("mock-ctr", run);
    assert.ok(writtenPath, "Should have written a file");
    assert.equal(writtenPath, "Plans/pipeline-optimisations/progress.md");
    assert.ok(writtenContent.includes("test-run-001"), "Should contain run ID");
    assert.ok(writtenContent.includes("[x]"), "Should contain a completed checkbox");
  });

  it("skips writing when planFile is null", async () => {
    let called = false;
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (opts && opts.label === "write-progress") called = true;
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.planFile = null;

    await engine._writeProgress("mock-ctr", run);
    assert.equal(called, false, "Should not write when planFile is null");
  });

  it("includes resumed-from line when run is a resume", async () => {
    let writtenContent = null;
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (opts && opts.label === "write-progress") {
            writtenContent = args[1] || "";
          }
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.planFile = "Plans/test/plan.md";
    run.riskLevel = "medium";
    run.branch = "cycle/test";
    run.createdAt = "2026-03-27T00:00:00Z";
    run.updatedAt = "2026-03-27T01:00:00Z";
    run.resumedFrom = "run-original-123";

    await engine._writeProgress("mock-ctr", run);
    assert.ok(writtenContent.includes("run-original-123"), "Should mention the original run");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test docker/orchestrator/lib/workflow-engine.test.js`
Expected: FAIL — `_writeProgress is not a function`

- [ ] **Step 3: Implement `_writeProgress()`**

Add this method to the `WorkflowEngine` class, after `_shouldSkipPhase`:

```javascript
  // ════════════════════════════════════════════════════════════
  // Helper: write human-readable progress.md to the plan directory
  // ════════════════════════════════════════════════════════════

  async _writeProgress(containerId, run) {
    if (!run.planFile) return;

    const planDir = run.planFile.replace(/\/[^/]+$/, "");
    const lines = [
      `# Pipeline Progress: ${run.id}`,
      "",
      `**Task:** ${(run.task || "").slice(0, 200)}`,
      `**Team:** ${run.team} | **Risk:** ${run.riskLevel} | **Branch:** ${run.branch}`,
      `**Started:** ${run.createdAt} | **Updated:** ${run.updatedAt}`,
    ];

    if (run.resumedFrom) {
      lines.push(`**Resumed from:** ${run.resumedFrom}`);
    }

    lines.push("", "## Phases", "");

    for (const [key, phase] of Object.entries(run.phases)) {
      if (!phase || typeof phase !== "object") continue;
      const status = phase.status;
      const duration =
        phase.startedAt && phase.completedAt
          ? Math.round((new Date(phase.completedAt) - new Date(phase.startedAt)) / 1000)
          : null;
      const durationStr = duration !== null ? ` (${duration}s)` : "";
      const label = phase.stageName || key;

      if (status === "passed") {
        lines.push(`- [x] ${label}${durationStr}`);
      } else if (status === "skipped") {
        lines.push(`- [x] ~~${label}~~ (skipped${phase.reason ? ": " + phase.reason : ""})`);
      } else if (status === "failed") {
        lines.push(`- [ ] ${label} (FAILED${durationStr})`);
      } else if (status === "running") {
        lines.push(`- [ ] ${label} (running...)`);
      } else {
        lines.push(`- [ ] ${label}`);
      }
    }

    const content = lines.join("\n");
    try {
      await this.containerManager.execInWorker(
        containerId,
        "bash",
        ["-c", `mkdir -p /workspace/${planDir} && cat > /workspace/${planDir}/progress.md << 'PROGRESS_EOF'\n${content}\nPROGRESS_EOF`],
        { label: "write-progress", quiet: true }
      );
    } catch (err) {
      console.warn(`[${run.id}] Failed to write progress: ${err.message}`);
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test docker/orchestrator/lib/workflow-engine.test.js`
Expected: All `_writeProgress` tests PASS, existing tests still PASS

- [ ] **Step 5: Commit**

```bash
git add docker/orchestrator/lib/workflow-engine.js docker/orchestrator/lib/workflow-engine.test.js
git commit -m "feat(resume): add _writeProgress helper for progress artifact"
```

---

### Task 3: Skip Gates in `executeWorkflow()`

This is the core change — adding skip gates to each phase block in `executeWorkflow()`.

**Files:**
- Modify: `docker/orchestrator/lib/workflow-engine.js:673-1525` (the `executeWorkflow` method)

- [ ] **Step 1: Add resume detection and cascade tracking at the top of `executeWorkflow()`**

After line 683 (`let containerId = null;`), add:

```javascript
    // ── Resume detection ──
    const isResume = !!run.resumedFrom;
    let reRanUpstream = false;  // cascade: if true, all downstream phases must re-run
```

- [ ] **Step 2: Add skip gate to Phase 1 (Leader)**

Replace the Phase 1 block starting at line 816. Wrap the existing leader execution in a skip check:

At the start of the `// ── Phase 1: Team leader produces plan ──` section (line 816), before `run.status = "planning"`, add the skip gate. The full replacement for lines 816-858:

```javascript
      // ── Phase 1: Team leader produces plan ──
      let leaderOutput = null;
      if (isResume && !reRanUpstream && this._shouldSkipPhase(run, "leader", "leader")) {
        // Cheap validation: plan file exists in volume
        const planCheck = await this._readWorkerFile(containerId, `/workspace/${run.planFile || "CLAUDE.md"}`);
        if (planCheck !== null) {
          console.log(`[${run.id}] RESUME: Skipping leader (already passed)`);
          leaderOutput = run.phases.leader?.outputTail || "";
          await this._writeProgress(containerId, run);
        } else {
          console.log(`[${run.id}] RESUME: Leader artifacts missing — re-running`);
          reRanUpstream = true;
        }
      }

      if (!leaderOutput || reRanUpstream) {
        run.status = "planning";
        run.phases.leader = { status: "running", startedAt: ts() };
        saveRunFn(run);

        this.registry.update(run.id, {
          currentPhase: "leader",
          phaseStartedAt: ts(),
        });

        console.log(`[${run.id}] Phase 1: ${run.team} leader planning (in worker)...`);
        await this.containerManager.refreshCredentials(containerId, credentialsJson);

        const enrichedTask = this.dispatch.enrichTaskForLeader(run.task);
        const taskWithImages = enrichedTask + imageContext;

        const leaderResult = await this.containerManager.execInWorker(
          containerId,
          "bash",
          ["/app/scripts/run-team.sh", run.team, taskWithImages, run.planFile || ""],
          { label: `${run.team}-leader` }
        );

        run.phases.leader.status = leaderResult.exitCode === 0 ? "passed" : "failed";
        run.phases.leader.exitCode = leaderResult.exitCode;
        run.phases.leader.completedAt = ts();
        run.phases.leader.outputTail = leaderResult.stdout.slice(-3000);
        saveRunFn(run);
        await this._writeProgress(containerId, run);

        if (leaderResult.exitCode !== 0) {
          console.log(`[${run.id}] Leader failed (exit ${leaderResult.exitCode})`);
          run.status = "failed";
          run.results = { leader: "failed", allPassed: false };
          saveRunFn(run);
          await this._teardownOnFailure(run.id, containerId);
          return;
        }

        leaderOutput = leaderResult.stdout;
        reRanUpstream = true;  // leader re-ran, so downstream must too
        console.log(`[${run.id}] Leader plan complete`);

        // Extract risk level
        const riskMatch = leaderOutput.match(/RISK_LEVEL:\s*(low|medium|high)/i);
        run.riskLevel = riskMatch ? riskMatch[1].toLowerCase() : this.config.defaultRiskLevel;
        console.log(`[${run.id}] Risk level: ${run.riskLevel}`);
        saveRunFn(run);
      }
```

- [ ] **Step 3: Add skip gate to Phase 2 (Dispatch)**

Replace the dispatch parsing section. The existing code starts at `// ── Phase 2: Parse dispatch plan ──` (around line 867). Replace with:

```javascript
      // ── Phase 2: Parse dispatch plan ──
      let dispatchPlan;
      if (isResume && !reRanUpstream && this._shouldSkipPhase(run, "dispatch", "dispatch")) {
        if (run.phases.dispatch?.plan?.stages?.length > 0) {
          console.log(`[${run.id}] RESUME: Skipping dispatch (${run.phases.dispatch.plan.stages.length} stages cached)`);
          dispatchPlan = run.phases.dispatch.plan;
          await this._writeProgress(containerId, run);
        } else {
          console.log(`[${run.id}] RESUME: Dispatch plan missing — re-running`);
          reRanUpstream = true;
        }
      }

      if (!dispatchPlan) {
        run.status = "dispatching";
        saveRunFn(run);

        this.registry.update(run.id, {
          status: "dispatching",
          currentPhase: "dispatch",
          phaseStartedAt: ts(),
        });

        console.log(`[${run.id}] Phase 2: Parsing dispatch plan...`);

        try {
          dispatchPlan = await this._parseDispatchFromWorker(
            containerId, leaderOutput || run.phases.leader?.outputTail || "", taskWithImages, run.team, run.id
          );
          if (imageContext) {
            for (const stage of dispatchPlan.stages) {
              for (const agent of stage.agents) {
                if (!agent.prompt.includes("Read tool to view")) {
                  agent.prompt += imageContext;
                }
              }
            }
          }
          console.log(`[${run.id}] Parsed: ${dispatchPlan.stages.length} stages, ${
            dispatchPlan.stages.reduce((n, s) => n + s.agents.length, 0)
          } agents`);
        } catch (err) {
          console.warn(`[${run.id}] Parse failed (${err.message}), using fallback plan`);
          dispatchPlan = this.dispatch.buildFallbackPlan(taskWithImages, run.team, leaderOutput || "");
        }

        run.phases.dispatch = {
          plan: dispatchPlan,
          stageCount: dispatchPlan.stages.length,
          agentCount: dispatchPlan.stages.reduce((n, s) => n + s.agents.length, 0),
          parsedAt: ts(),
        };
        saveRunFn(run);
        await this._writeProgress(containerId, run);
        reRanUpstream = true;
      }
```

Note: the `taskWithImages` variable must be available. If leader was skipped, reconstruct it:

After the leader skip gate, add:

```javascript
      // Ensure taskWithImages is available for dispatch (needed even on resume)
      const enrichedTask = run.phases.leader?.outputTail
        ? run.task  // leader already enriched it
        : this.dispatch.enrichTaskForLeader(run.task);
      const taskWithImages = enrichedTask + imageContext;
```

Move these lines to BEFORE the dispatch section, replacing the existing `enrichedTask`/`taskWithImages` declarations inside the leader block. The leader block should use `taskWithImages` but not declare it — it's declared once in the shared scope.

- [ ] **Step 4: Add skip gate to Phase 3 (Implementation stages)**

In the stage execution loop (around line 916), add a skip check for implementation stages:

```javascript
      for (let i = 0; i < dispatchPlan.stages.length; i++) {
        const stage = dispatchPlan.stages[i];
        const isQA = /qa|verification|review|test/i.test(stage.name);
        if (!isQA) lastImplStageIdx = i;

        const stageKey = `stage_${i}_${stage.name}`;

        // ── Resume skip gate for this stage ──
        if (isResume && !reRanUpstream && this._shouldSkipPhase(run, isQA ? "qa" : "implementation", stageKey)) {
          // Cheap validation for implementation: verify code files in volume
          if (!isQA) {
            const codeCheck = await this.containerManager.execInWorker(
              containerId, "bash", ["-c",
                "cd /workspace && git diff --name-only HEAD~5..HEAD 2>/dev/null | head -5"
              ], { label: "resume-impl-check", quiet: true }
            );
            if (codeCheck.stdout.trim()) {
              console.log(`[${run.id}] RESUME: Skipping ${stage.name} (code changes verified in volume)`);
              await this._writeProgress(containerId, run);
              continue;
            } else {
              console.log(`[${run.id}] RESUME: No code in volume for ${stage.name} — re-running`);
              reRanUpstream = true;
            }
          } else {
            // QA: skip only if implementation was also skipped
            console.log(`[${run.id}] RESUME: Skipping ${stage.name} (previously passed, impl unchanged)`);
            await this._writeProgress(containerId, run);
            continue;
          }
        }
        if (isResume && reRanUpstream && isQA) {
          // Cascade: implementation re-ran, so QA must re-run too
          console.log(`[${run.id}] RESUME: Re-running ${stage.name} (upstream changed)`);
        }

        // ... existing stage execution code continues unchanged ...
```

- [ ] **Step 5: Add `_writeProgress` calls to existing phase completions**

Add `await this._writeProgress(containerId, run);` after each `saveRunFn(run)` call at the end of:
- Each stage completion (after line 952 `saveRunFn(run);`)
- Validation phase completion (after smoketest/inspector results are saved, around line 1178)
- E2E phase completion (around line 1293)
- Commit+push completion (around line 1352)
- PR phase completion (around line 1390)

Each addition is a single line: `await this._writeProgress(containerId, run);`

- [ ] **Step 6: Add skip gate to Phase 6+ (Commit, PR, Learnings)**

These always re-run on resume — no skip gate needed. They depend on external state (GitHub remote, API) that may have changed. No code changes here, just confirming the design decision.

- [ ] **Step 7: Run all tests**

Run: `node --test docker/orchestrator/lib/workflow-engine.test.js`
Expected: All existing tests PASS, all new tests PASS

- [ ] **Step 8: Commit**

```bash
git add docker/orchestrator/lib/workflow-engine.js
git commit -m "feat(resume): add skip gates and progress writing to executeWorkflow"
```

---

### Task 4: Retry Endpoint Changes

**Files:**
- Modify: `docker/orchestrator/server.js:520-599` (the retry endpoint)

- [ ] **Step 1: Replace the retry endpoint run construction**

In `docker/orchestrator/server.js`, replace lines 533-553 (the `const run = {` block inside the retry handler) with:

```javascript
  // Create a new run carrying forward state from the original
  const run = {
    id: `run-${Date.now()}-${randomUUID().slice(0, 8)}`,
    status: "resuming",
    task: originalRun.task,
    planFile: originalRun.planFile,
    repo: originalRun.repo,
    repoBranch: originalRun.repoBranch,
    tokenSource: null,
    tokenLabel: null,
    team: originalRun.team,
    teamReason: `Resumed from ${originalRun.id}`,
    attachments: originalRun.attachments || [],
    ports: null,
    branch: originalRun.branch,
    results: { ...originalRun.results },
    phases: JSON.parse(JSON.stringify(originalRun.phases || {})),  // deep copy
    feedbackLoops: originalRun.feedbackLoops || 0,
    resumedFrom: originalRun.id,
    resumePoint: req.body.resumeFrom || null,
    reuseVolume: existingVolume,
    riskLevel: originalRun.riskLevel,
    createdAt: ts(),
    updatedAt: ts(),
  };
```

Note: `phases` uses `JSON.parse(JSON.stringify(...))` for a deep copy — the phases contain nested objects that would otherwise be shared references.

- [ ] **Step 2: Update the response to include resume info**

Replace lines 556-562 (the `res.status(201).json(...)` block) with:

```javascript
  // Calculate which phases will be skipped
  const phaseOrder = ["leader", "dispatch", "implementation", "app", "qa", "validation", "e2e", "commit", "pr", "learnings"];
  let skippedPhases = [];
  if (run.resumePoint) {
    const resumeIdx = phaseOrder.indexOf(run.resumePoint);
    skippedPhases = phaseOrder.slice(0, resumeIdx);
  } else {
    // Auto mode: estimate based on passed phases
    for (const phase of phaseOrder) {
      const matching = Object.entries(run.phases).find(([k]) => k.includes(phase));
      if (matching && (matching[1].status === "passed" || matching[1].status === "skipped")) {
        skippedPhases.push(phase);
      } else {
        break;  // stop at first non-passed phase
      }
    }
  }

  res.status(201).json({
    id: run.id,
    status: "resuming",
    message: skippedPhases.length > 0
      ? `Resuming from ${run.resumePoint || "auto-detect"} — ${skippedPhases.length} phase(s) skippable`
      : `Retrying ${originalRun.id} from scratch (no completed phases to skip)`,
    statusUrl: `/api/runs/${run.id}`,
    resumedFrom: originalRun.id,
    resumePoint: run.resumePoint,
    skippedPhases,
  });
```

- [ ] **Step 3: Remove the team re-routing logic since team is carried forward**

Replace lines 565-583 (the async team routing block) with:

```javascript
  // Async: execute workflow with carried-forward team
  (async () => {
    try {
      // Allow force-override of team on retry
      const forceTeam = req.body?.team;
      if (forceTeam && ["TheATeam", "TheFixer"].includes(forceTeam)) {
        run.team = forceTeam;
        run.teamReason = `Forced to ${forceTeam} by retry request`;
      }
      // team is already set from originalRun — no routing needed

      console.log(`[${run.id}] Resume of ${originalRun.id} — Team: ${run.team}, resumePoint: ${run.resumePoint || "auto"}`);
      saveRun(run);

      const retryToken = await tokenPool.resolveToken();
      run.tokenSource = retryToken?.source || "none";
      run.tokenLabel = retryToken?.label || "no token";
      saveRun(run);

      await workflowEngine.executeWorkflow(run, saveRun, retryToken);
    } catch (err) {
      console.error(`[${run.id}] Resume fatal:`, err);
      run.status = "failed";
      run.results = { error: err.message, allPassed: false };
      saveRun(run);
    }
  })();
```

- [ ] **Step 4: Run the orchestrator health check to verify no syntax errors**

Rebuild and verify:
```bash
cd docker && docker compose up -d --build orchestrator
sleep 3 && curl -s http://localhost:9800/api/health
```
Expected: `{"status":"ok",...}`

- [ ] **Step 5: Commit**

```bash
git add docker/orchestrator/server.js
git commit -m "feat(resume): retry endpoint carries forward phases and accepts resumeFrom"
```

---

### Task 5: Integration Test — Resume Skips Completed Phases

**Files:**
- Modify: `docker/orchestrator/lib/workflow-engine.test.js`

- [ ] **Step 1: Write integration test for resume skip behavior**

```javascript
// Verifies: checkpoint-resume — full resume flow
describe("executeWorkflow resume (checkpoint-resume)", () => {
  it("skips leader and dispatch when resuming a run that passed them", async () => {
    const agentCalls = [];
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          const label = opts?.label || "";
          agentCalls.push(label);

          // Resume checks: plan file exists, code exists
          if (label === "resume-impl-check") return { exitCode: 0, stdout: "" };  // no code — impl will re-run
          if (cmd === "bash" && args[0] === "/app/scripts/run-team.sh") return { exitCode: 0, stdout: "RISK_LEVEL: low\nPlan complete" };
          if (label === "impl-verify") return { exitCode: 0, stdout: "Source/Backend/src/index.ts" };

          return { exitCode: 0, stdout: "" };
        },
        spawnWorker: async () => ({ containerId: "mock-ctr", containerName: "mock", ports: { backend: 5001, frontend: 5101 }, tokenId: "t1" }),
        spawnWorkerFromVolume: async () => ({ containerId: "mock-ctr", containerName: "mock", ports: { backend: 5001, frontend: 5101 }, tokenId: "t1" }),
        initWorkspace: async () => {},
        refreshCredentials: async () => {},
        startApp: async () => ({ backend: true, frontend: true }),
        commitAndPush: async () => {},
        teardown: async () => {},
      },
    });

    // Override dispatch to return a plan directly
    deps.dispatch.enrichTaskForLeader = (task) => task;

    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.resumedFrom = "run-original";
    run.resumePoint = "implementation";  // skip leader + dispatch
    run.reuseVolume = "workspace-run-original";
    run.phases.leader = { status: "passed", outputTail: "RISK_LEVEL: low\nLeader output" };
    run.phases.dispatch = {
      status: "passed",
      plan: {
        stages: [{
          name: "implementation",
          parallel: false,
          agents: [{ role: "backend-fixer", prompt: "fix the thing" }],
        }],
      },
      stageCount: 1,
      agentCount: 1,
    };

    // The test verifies that leader and dispatch are NOT re-executed
    // by checking agentCalls does NOT include leader/dispatch labels
    const hasLeaderCall = agentCalls.some(l => l.includes("leader"));
    assert.equal(hasLeaderCall, false, "Leader should not be called on resume past it");
  });
});
```

- [ ] **Step 2: Run tests**

Run: `node --test docker/orchestrator/lib/workflow-engine.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add docker/orchestrator/lib/workflow-engine.test.js
git commit -m "test(resume): integration test for phase skipping on resume"
```

---

### Task 6: Push and Rebuild

- [ ] **Step 1: Run full test suite**

```bash
node --test docker/orchestrator/lib/workflow-engine.test.js
```
Expected: All tests PASS

- [ ] **Step 2: Push to remote**

```bash
git push origin master
```

- [ ] **Step 3: Rebuild orchestrator**

```bash
cd docker && docker compose up -d --build orchestrator
```

- [ ] **Step 4: Verify health**

```bash
curl -s http://localhost:9800/api/health
```
Expected: `{"status":"ok",...}`

- [ ] **Step 5: Manual verification — trigger a retry with resumeFrom**

If a failed run exists:
```bash
curl -s -X POST http://localhost:9800/api/runs/{failed-run-id}/retry \
  -H "Content-Type: application/json" \
  -d '{"resumeFrom": "validation"}' | python -m json.tool
```

Expected response includes `skippedPhases` and `resumedFrom` fields.

- [ ] **Step 6: Commit any final fixes**

```bash
git add -A && git commit -m "fix(resume): address integration issues from manual test"
```

Only if fixes were needed. If clean, skip this step.
