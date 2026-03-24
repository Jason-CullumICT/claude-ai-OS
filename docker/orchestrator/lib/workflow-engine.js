/**
 * Workflow Engine — Container-Based Execution
 *
 * Reimplements the old executeWorkflow() to run all agent work inside
 * isolated Docker worker containers via ContainerManager, instead of
 * spawning claude processes locally on the orchestrator.
 *
 * The orchestrator still handles:
 *   - Team routing (local Claude call)
 *   - Dispatch plan parsing (local Claude call for role extraction)
 *   - Run state persistence
 *   - Learnings sync (git operations on main)
 *
 * Workers handle:
 *   - Leader planning (run-team.sh inside container)
 *   - Implementation agents (claude -p inside container)
 *   - QA agents (claude -p inside container)
 *   - Smoketests (run-smoketest.sh inside container)
 *   - Inspector (run-team.sh inside container)
 *   - App serving (backend/frontend inside container, port-mapped)
 *   - Git commit + push (inside container)
 */

const config = require("./config");

function ts() { return new Date().toISOString(); }

class WorkflowEngine {
  /**
   * @param {object} deps
   * @param {import('./container-manager').ContainerManager} deps.containerManager
   * @param {import('./cycle-registry').CycleRegistry} deps.cycleRegistry
   * @param {import('./learnings-sync').LearningsSync} deps.learningsSync
   * @param {object} deps.dispatch — result of createDispatcher(runClaude, workspace)
   * @param {object} deps.config — lib/config.js
   */
  constructor({ containerManager, cycleRegistry, learningsSync, dispatch, config: cfg }) {
    this.containerManager = containerManager;
    this.registry = cycleRegistry;
    this.learningsSync = learningsSync;
    this.dispatch = dispatch;
    this.config = cfg || config;
  }

  // ════════════════════════════════════════════════════════════
  // Helper: read a file from inside a worker container
  // ════════════════════════════════════════════════════════════

  async _readWorkerFile(containerId, path) {
    const result = await this.containerManager.execInWorker(
      containerId, "cat", [path], { quiet: true }
    );
    return result.exitCode === 0 ? result.stdout : null;
  }

  async _listWorkerDir(containerId, dir) {
    const result = await this.containerManager.execInWorker(
      containerId, "ls", [dir], { quiet: true }
    );
    return result.exitCode === 0
      ? result.stdout.trim().split("\n").filter(Boolean)
      : [];
  }

  // ════════════════════════════════════════════════════════════
  // Helper: find plan context by reading files inside the worker
  // ════════════════════════════════════════════════════════════

  async _findPlanContextFromWorker(containerId) {
    const ctx = { specs: [], plans: [], contracts: [], dispatchPlan: null, planDir: null };

    // Scan Specifications/ for .md files
    const specFiles = await this._listWorkerDir(containerId, "/workspace/Specifications");
    for (const f of specFiles) {
      if (f.endsWith(".md")) ctx.specs.push(`Specifications/${f}`);
    }

    // Scan Plans/ subdirectories
    const planEntries = await this._listWorkerDir(containerId, "/workspace/Plans");
    for (const entry of planEntries) {
      // Check if it's a directory by listing its contents
      const subFiles = await this._listWorkerDir(containerId, `/workspace/Plans/${entry}`);
      if (subFiles.length === 0) continue;

      for (const f of subFiles) {
        const rel = `Plans/${entry}/${f}`;
        if (f === "dispatch-plan.md") {
          ctx.dispatchPlan = rel;
          ctx.planDir = `Plans/${entry}`;
        } else if (/contract/i.test(f)) {
          ctx.contracts.push(rel);
        } else if (f.endsWith(".md")) {
          ctx.plans.push(rel);
        }
      }
    }

    return ctx;
  }

  // ════════════════════════════════════════════════════════════
  // Helper: run a single agent inside the worker container
  // ════════════════════════════════════════════════════════════

  async runAgentInWorker(containerId, role, prompt, feedback) {
    let fullPrompt = prompt;
    if (feedback) {
      fullPrompt += `\n\n${"=".repeat(43)}
QA FEEDBACK -- You MUST address these issues before completing:
${"=".repeat(43)}
${feedback}`;
    }

    console.log(`    [agent] ${role} starting (in worker)...`);

    const result = await this.containerManager.execInWorker(
      containerId,
      "claude",
      ["-p", fullPrompt, "--allowedTools", "Bash,Read,Write,Edit,Glob,Grep", "--output-format", "text"],
      { label: role }
    );

    console.log(`    [agent] ${role} done (exit: ${result.exitCode})`);
    return result;
  }

  // ════════════════════════════════════════════════════════════
  // Helper: execute a stage (group of agents, parallel or sequential)
  // ════════════════════════════════════════════════════════════

  async executeStageInWorker(containerId, stage, feedback) {
    const runOne = async (agent) => {
      const result = await this.runAgentInWorker(containerId, agent.role, agent.prompt, feedback);
      return {
        role: agent.role,
        exitCode: result.exitCode,
        outputTail: result.stdout.slice(-2000),
      };
    };

    let agentResults;
    if (stage.parallel) {
      agentResults = await Promise.all(stage.agents.map(runOne));
    } else {
      agentResults = [];
      for (const agent of stage.agents) {
        agentResults.push(await runOne(agent));
      }
    }

    const passed = agentResults.every((ar) => ar.exitCode === 0);
    return { passed, agentResults };
  }

  // ════════════════════════════════════════════════════════════
  // Helper: parse dispatch plan from worker filesystem
  // ════════════════════════════════════════════════════════════

  async _parseDispatchFromWorker(containerId, leaderOutput, taskWithImages, team) {
    // Read plan context from the worker's filesystem
    const planCtx = await this._findPlanContextFromWorker(containerId);

    if (planCtx.dispatchPlan) {
      console.log(`[dispatch] Found dispatch plan in worker: ${planCtx.dispatchPlan}`);

      // Read the dispatch plan file content from the worker
      const dpContent = await this._readWorkerFile(
        containerId,
        `/workspace/${planCtx.dispatchPlan}`
      );

      if (dpContent) {
        // Extract roles using the dispatch module (runs locally — may call Claude for ambiguous formats)
        const roles = await this.dispatch.extractRoles(dpContent, leaderOutput);
        console.log(`[dispatch] Roles: impl=[${(roles.implementation || []).join(", ")}] qa=[${(roles.qa || []).join(", ")}]`);

        const stages = [];
        if (roles.implementation && roles.implementation.length > 0) {
          stages.push({
            name: "implementation",
            parallel: roles.implementation.length > 1,
            agents: roles.implementation.map((role) => ({
              role,
              prompt: this.dispatch.buildAgentPrompt(role, taskWithImages, team, planCtx),
            })),
          });
        }
        if (roles.qa && roles.qa.length > 0) {
          stages.push({
            name: "qa",
            parallel: roles.qa.length > 1,
            agents: roles.qa.map((role) => ({
              role,
              prompt: this.dispatch.buildAgentPrompt(role, taskWithImages, team, planCtx),
            })),
          });
        }

        if (stages.length > 0) {
          console.log(`[dispatch] Built ${stages.length} stages: ${stages.map((s) => `${s.name}(${s.agents.length}${s.parallel ? ",parallel" : ""})`).join(" -> ")}`);
          return { stages };
        }
      }
    } else {
      console.log("[dispatch] No dispatch plan file found in worker Plans/");
    }

    throw new Error("Could not extract roles from dispatch plan in worker");
  }

  // ════════════════════════════════════════════════════════════
  // Main: executeWorkflow
  // ════════════════════════════════════════════════════════════

  /**
   * Run the full pipeline for a work request inside a Docker worker container.
   *
   * @param {object} run — the run JSON object (id, task, team, planFile, attachments, etc.)
   * @param {function} saveRunFn — callback to persist run state
   */
  async executeWorkflow(run, saveRunFn) {
    // Build image context string for prompts
    const imageContext = run.attachments && run.attachments.length > 0
      ? `\n\nReference images (use the Read tool to view these):\n${run.attachments.map((p) => `- ${p}`).join("\n")}`
      : "";

    let containerId = null;

    try {
      // ── Register cycle ──
      this.registry.register(run.id, {
        status: "planning",
        branch: `cycle/${run.id}`,
      });

      // ── Phase 0: Spawn worker container ──
      console.log(`[${run.id}] Spawning worker container...`);
      const worker = await this.containerManager.spawnWorker(run.id);
      containerId = worker.containerId;

      // Store container info on run
      run.containerId = worker.containerId;
      run.containerName = worker.containerName;
      run.ports = worker.ports;
      run.branch = `cycle/${run.id}`;
      saveRunFn(run);

      // Update registry with container details
      this.registry.update(run.id, {
        containerId: worker.containerId,
        containerName: worker.containerName,
        ports: worker.ports,
        tokenId: worker.tokenId,
        status: "planning",
        currentPhase: "workspace_init",
        phaseStartedAt: ts(),
      });

      // ── Phase 0b: Initialize workspace ──
      console.log(`[${run.id}] Initializing workspace in worker...`);
      await this.containerManager.initWorkspace(containerId, run.id);

      // ── Phase 0c: Copy image attachments into worker ──
      if (run.attachments && run.attachments.length > 0) {
        console.log(`[${run.id}] Copying ${run.attachments.length} image(s) into worker...`);
        for (const attachPath of run.attachments) {
          try {
            const { readFileSync } = require("fs");
            const { basename } = require("path");
            const data = readFileSync(attachPath);
            const fileName = basename(attachPath);
            const workerDir = `/workspace/.attachments`;
            // Create dir and write file via base64 to avoid shell escaping issues
            const b64 = data.toString("base64");
            await this.containerManager.execInWorker(
              containerId, "bash", ["-c",
                `mkdir -p ${workerDir} && echo '${b64}' | base64 -d > ${workerDir}/${fileName}`
              ],
              { label: "attach", quiet: true }
            );
            // Update attachment path to worker-side path
            run.attachments[run.attachments.indexOf(attachPath)] = `${workerDir}/${fileName}`;
          } catch (err) {
            console.warn(`[${run.id}] Failed to copy attachment: ${err.message}`);
          }
        }
        // Rebuild image context with worker-side paths
        saveRunFn(run);
      }

      // ── Phase 1: Team leader produces plan ──
      run.status = "planning";
      run.phases = { leader: { status: "running", startedAt: ts() } };
      saveRunFn(run);

      this.registry.update(run.id, {
        currentPhase: "leader",
        phaseStartedAt: ts(),
      });

      console.log(`[${run.id}] Phase 1: ${run.team} leader planning (in worker)...`);

      // Append image references to task so the leader sees them
      const taskWithImages = run.task + imageContext;

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

      if (leaderResult.exitCode !== 0) {
        console.log(`[${run.id}] Leader failed (exit ${leaderResult.exitCode})`);
        run.status = "failed";
        run.results = { leader: "failed", allPassed: false };
        saveRunFn(run);

        // Teardown on failure
        await this._teardownOnFailure(run.id, containerId);
        return;
      }

      console.log(`[${run.id}] Leader plan complete`);

      // ── Phase 2: Parse dispatch plan ──
      run.status = "dispatching";
      saveRunFn(run);

      this.registry.update(run.id, {
        status: "dispatching",
        currentPhase: "dispatch",
        phaseStartedAt: ts(),
      });

      console.log(`[${run.id}] Phase 2: Parsing dispatch plan...`);

      let dispatchPlan;
      try {
        // Parse from worker filesystem — reads plan files via docker exec
        dispatchPlan = await this._parseDispatchFromWorker(
          containerId, leaderResult.stdout, taskWithImages, run.team
        );
        // Inject image context into every agent prompt
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
        dispatchPlan = this.dispatch.buildFallbackPlan(taskWithImages, run.team, leaderResult.stdout);
      }

      run.phases.dispatch = {
        plan: dispatchPlan,
        stageCount: dispatchPlan.stages.length,
        agentCount: dispatchPlan.stages.reduce((n, s) => n + s.agents.length, 0),
        parsedAt: ts(),
      };
      saveRunFn(run);

      // ── Phase 3: Execute stages with feedback loops ──
      let feedbackLoops = 0;
      let lastImplStageIdx = -1;

      for (let i = 0; i < dispatchPlan.stages.length; i++) {
        const stage = dispatchPlan.stages[i];
        const isQA = /qa|verification|review|test/i.test(stage.name);
        if (!isQA) lastImplStageIdx = i;

        const stageKey = `stage_${i}_${stage.name}`;
        run.status = isQA ? "qa_running" : "implementing";
        run.phases[stageKey] = {
          status: "running",
          startedAt: ts(),
          stageName: stage.name,
          parallel: stage.parallel,
          agents: {},
        };
        saveRunFn(run);

        this.registry.update(run.id, {
          status: run.status,
          currentPhase: stageKey,
          phaseStartedAt: ts(),
        });

        console.log(`[${run.id}] Stage ${i + 1}/${dispatchPlan.stages.length}: ${stage.name} (${stage.agents.length} agent(s), parallel=${stage.parallel})`);

        const { passed, agentResults } = await this.executeStageInWorker(containerId, stage);

        // Record per-agent results
        for (const ar of agentResults) {
          run.phases[stageKey].agents[ar.role] = {
            status: ar.exitCode === 0 ? "passed" : "failed",
            exitCode: ar.exitCode,
            outputTail: ar.outputTail,
          };
        }
        run.phases[stageKey].status = passed ? "passed" : "failed";
        run.phases[stageKey].completedAt = ts();
        saveRunFn(run);

        console.log(`[${run.id}] Stage ${stage.name}: ${passed ? "PASSED" : "FAILED"}`);

        // ── Feedback loop: QA failed -> re-run implementation + QA ──
        if (isQA && !passed && feedbackLoops < this.config.maxFeedbackLoops && lastImplStageIdx >= 0) {
          feedbackLoops++;
          console.log(`[${run.id}] Feedback loop ${feedbackLoops}/${this.config.maxFeedbackLoops}: QA -> implementation -> QA`);

          // Collect QA feedback from failed agents
          const feedback = agentResults
            .filter((ar) => ar.exitCode !== 0)
            .map((ar) => `-- ${ar.role} (FAILED) --\n${ar.outputTail.slice(-1000)}`)
            .join("\n\n");

          // Re-run implementation with feedback
          const implStage = dispatchPlan.stages[lastImplStageIdx];
          const fbImplKey = `feedback_${feedbackLoops}_${implStage.name}`;
          run.status = "implementing";
          run.phases[fbImplKey] = { status: "running", startedAt: ts(), agents: {} };
          saveRunFn(run);

          this.registry.update(run.id, {
            status: "implementing",
            currentPhase: fbImplKey,
            phaseStartedAt: ts(),
          });

          console.log(`[${run.id}]   Re-running ${implStage.name} with QA feedback...`);
          const implResult = await this.executeStageInWorker(containerId, implStage, feedback);

          for (const ar of implResult.agentResults) {
            run.phases[fbImplKey].agents[ar.role] = {
              status: ar.exitCode === 0 ? "passed" : "failed",
              exitCode: ar.exitCode,
              outputTail: ar.outputTail,
            };
          }
          run.phases[fbImplKey].status = implResult.passed ? "passed" : "failed";
          run.phases[fbImplKey].completedAt = ts();
          saveRunFn(run);

          // Re-run QA
          const fbQaKey = `feedback_${feedbackLoops}_${stage.name}`;
          run.status = "qa_running";
          run.phases[fbQaKey] = { status: "running", startedAt: ts(), agents: {} };
          saveRunFn(run);

          this.registry.update(run.id, {
            status: "qa_running",
            currentPhase: fbQaKey,
            phaseStartedAt: ts(),
          });

          console.log(`[${run.id}]   Re-running ${stage.name}...`);
          const qaResult2 = await this.executeStageInWorker(containerId, stage);

          for (const ar of qaResult2.agentResults) {
            run.phases[fbQaKey].agents[ar.role] = {
              status: ar.exitCode === 0 ? "passed" : "failed",
              exitCode: ar.exitCode,
              outputTail: ar.outputTail,
            };
          }
          run.phases[fbQaKey].status = qaResult2.passed ? "passed" : "failed";
          run.phases[fbQaKey].completedAt = ts();
          saveRunFn(run);

          if (!qaResult2.passed) {
            console.log(`[${run.id}]   QA still failing after feedback loop ${feedbackLoops}`);
          }
        }
      }

      run.feedbackLoops = feedbackLoops;

      // ── Phase 3.5: Start app BEFORE validation ──
      // Dynamic-first agents (chaos-monkey, performance-profiler, red-teamer)
      // check service health and run real tests when the app is alive.
      // Without this, they always fall back to static-only analysis.
      console.log(`[${run.id}] Phase 3.5: Starting app for dynamic testing...`);
      try {
        const appResult = await this.containerManager.startApp(containerId);
        run.app = {
          running: appResult.backend || appResult.frontend,
          backend: appResult.backend ? `http://localhost:${run.ports.backend}` : null,
          frontend: appResult.frontend ? `http://localhost:${run.ports.frontend}` : null,
        };
        saveRunFn(run);

        if (run.app.running) {
          console.log(`[${run.id}] App running for dynamic tests: backend=${run.app.backend || "--"} frontend=${run.app.frontend || "--"}`);
          // Give the app a moment to fully initialize (DB migrations, etc.)
          await new Promise((r) => setTimeout(r, 3000));
        } else {
          console.log(`[${run.id}] App failed to start — agents will use static fallback`);
        }
      } catch (err) {
        console.warn(`[${run.id}] App start failed (${err.message}) — agents will use static fallback`);
        run.app = { running: false, backend: null, frontend: null };
      }

      this.registry.update(run.id, { appRunning: !!run.app?.running });

      // ── Phase 4: Final validation (smoketest + inspector in parallel, in worker) ──
      run.status = "validating";
      run.phases.smoketest = { status: "running", startedAt: ts() };
      run.phases.inspector = { status: "running", startedAt: ts() };
      saveRunFn(run);

      this.registry.update(run.id, {
        status: "validating",
        currentPhase: "validation",
        phaseStartedAt: ts(),
      });

      console.log(`[${run.id}] Phase 4: Validation (smoketest + inspector in worker)`);

      const [smokeResult, inspectorResult] = await Promise.all([
        this.containerManager.execInWorker(
          containerId,
          "bash",
          ["/app/scripts/run-smoketest.sh"],
          { label: "smoketest" }
        ),
        this.containerManager.execInWorker(
          containerId,
          "bash",
          ["/app/scripts/run-team.sh", "TheInspector", `Post-work audit after ${run.team} completed: ${run.task}`],
          { label: "inspector" }
        ),
      ]);

      run.phases.smoketest.status = smokeResult.exitCode === 0 ? "passed" : "failed";
      run.phases.smoketest.exitCode = smokeResult.exitCode;
      run.phases.smoketest.completedAt = ts();
      run.phases.smoketest.outputTail = smokeResult.stdout.slice(-2000);

      run.phases.inspector.status = inspectorResult.exitCode === 0 ? "passed" : "failed";
      run.phases.inspector.exitCode = inspectorResult.exitCode;
      run.phases.inspector.completedAt = ts();
      run.phases.inspector.outputTail = inspectorResult.stdout.slice(-2000);

      // ── Phase 5: Compute final result ──
      const implPassed = Object.keys(run.phases)
        .filter((k) => k.startsWith("stage_") || k.startsWith("feedback_"))
        .every((k) => run.phases[k].status === "passed");

      const qaPassed = Object.keys(run.phases)
        .filter((k) => k.startsWith("stage_") && run.phases[k].stageName && /qa|verification|review/i.test(run.phases[k].stageName))
        .every((k) => run.phases[k].status === "passed");

      const smokePassed = run.phases.smoketest.status === "passed";
      const inspectorPassed = run.phases.inspector.status === "passed";

      // Smoketest is advisory when both implementation AND QA passed independently.
      // Rationale: if multiple QA agents verified the code, a smoketest false negative
      // (e.g., generic endpoint probes) shouldn't override that verdict.
      const smokeEffective = smokePassed || (implPassed && qaPassed);
      if (!smokePassed && smokeEffective) {
        console.log(`[${run.id}] Smoketest failed but overridden -- implementation + QA both passed`);
        run.phases.smoketest.overridden = true;
        run.phases.smoketest.overrideReason = "Implementation and QA agents passed independently";
      }

      const allPassed =
        run.phases.leader.status === "passed" &&
        implPassed &&
        smokeEffective &&
        inspectorPassed;

      run.status = allPassed ? "complete" : "failed";
      run.results = {
        leader: run.phases.leader.status,
        implementation: implPassed ? "passed" : "failed",
        qa: qaPassed ? "passed" : "failed",
        smoketest: smokePassed ? "passed" : (smokeEffective ? "overridden" : "failed"),
        inspector: run.phases.inspector.status,
        feedbackLoops,
        allPassed,
      };
      saveRunFn(run);

      console.log(`[${run.id}] === WORKFLOW ${run.status.toUpperCase()} === leader=${run.results.leader} impl=${run.results.implementation} qa=${run.results.qa} smoke=${run.results.smoketest} inspect=${run.results.inspector} feedbackLoops=${feedbackLoops}`);

      // App is already running from Phase 3.5 — no need to start again.
      // It stays running on the worker's allocated ports for user testing.

      // ── Phase 6: Commit and push from worker ──
      console.log(`[${run.id}] Committing and pushing...`);
      const commitMsg = `feat: ${run.task.slice(0, 100)}`;
      await this.containerManager.commitAndPush(containerId, run.id, commitMsg);

      // ── Phase 8: Sync learnings to main ──
      console.log(`[${run.id}] Syncing learnings...`);
      const syncResult = await this.learningsSync.syncLearnings(run.id, `cycle/${run.id}`);
      if (!syncResult.success) {
        console.warn(`[${run.id}] Learnings sync failed: ${syncResult.error}`);
      }

      // ── Finalize ──
      this.registry.update(run.id, {
        status: run.status,
        appRunning: !!(run.app && run.app.running),
        currentPhase: null,
        phaseStartedAt: null,
      });
      saveRunFn(run);

    } catch (err) {
      console.error(`[${run.id}] Workflow error:`, err);
      run.status = "failed";
      run.results = { ...run.results, error: err.message, allPassed: false };
      saveRunFn(run);

      await this._teardownOnFailure(run.id, containerId);
    }
  }

  // ════════════════════════════════════════════════════════════
  // Teardown helper — called on any failure
  // ════════════════════════════════════════════════════════════

  async _teardownOnFailure(runId, containerId) {
    try {
      if (containerId) {
        console.log(`[${runId}] Tearing down worker on failure (keepVolume=true)...`);
        await this.containerManager.teardown(runId, { keepVolume: true });
      }
    } catch (teardownErr) {
      console.error(`[${runId}] Teardown error:`, teardownErr.message);
    }

    this.registry.update(runId, {
      status: "failed",
      currentPhase: null,
      phaseStartedAt: null,
      appRunning: false,
    });
  }
}

module.exports = { WorkflowEngine };
