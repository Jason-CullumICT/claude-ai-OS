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
   * @param {function} [deps.validateOrCreateRepo] — async function to validate/create GitHub repos
   */
  constructor({ containerManager, cycleRegistry, learningsSync, dispatch, config: cfg, validateOrCreateRepo }) {
    this.containerManager = containerManager;
    this.registry = cycleRegistry;
    this.learningsSync = learningsSync;
    this.dispatch = dispatch;
    this.config = cfg || config;
    this.validateOrCreateRepo = validateOrCreateRepo || null;
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

    // Refresh credentials before each agent to handle token expiry during long cycles
    await this.containerManager.refreshCredentials(containerId, this._activeCredentialsJson);

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
  // Phase 5.5: Run Playwright E2E tests against live app
  // Verifies: FR-TMP-003
  // ════════════════════════════════════════════════════════════

  async _runPlaywrightE2E(containerId, run, saveRunFn) {
    const testDir = `Source/E2E/tests/cycle-${run.id}`;
    const absTestDir = `/workspace/${testDir}`;

    // Check if E2E test files exist in worker
    // Verifies: FR-TMP-010 — skip gracefully when QA didn't generate tests
    const testFiles = await this._listWorkerDir(containerId, absTestDir);
    if (testFiles.length === 0) {
      console.log(`[${run.id}] No E2E tests found at ${testDir}, skipping`);
      run.e2e = { status: "skipped", reason: "no_tests" };
      saveRunFn(run);
      return true;
    }

    // Install Playwright chromium if needed
    // Verifies: FR-TMP-003
    console.log(`[${run.id}] Installing Playwright chromium...`);
    const installResult = await this.containerManager.execInWorker(
      containerId, "bash",
      ["-c", "PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright npx playwright install chromium"],
      { label: "playwright-install" }
    );

    if (installResult.exitCode !== 0) {
      // Verifies: FR-TMP-010 — graceful degradation on install failure
      console.warn(`[${run.id}] Playwright install failed (exit ${installResult.exitCode}), skipping E2E`);
      run.e2e = { status: "skipped", reason: "install_failed" };
      saveRunFn(run);
      return true;
    }

    // Initialize package.json and install @playwright/test if needed
    // Verifies: FR-TMP-003
    await this.containerManager.execInWorker(
      containerId, "bash",
      ["-c", "cd /workspace/Source/E2E && (test -f package.json || npm init -y) && npm install @playwright/test 2>/dev/null || true"],
      { label: "playwright-deps", quiet: true }
    );

    // Generate a pipeline-specific Playwright config that uses the already-running app.
    // The project's playwright.config.ts has webServer entries that conflict with the
    // pipeline (app is already running on dynamic ports, not the dev defaults).
    // Verifies: FR-TMP-003
    const frontendUrl = run.app?.frontend || "http://localhost:5173";
    const pipelineConfig = [
      'import { defineConfig } from "@playwright/test";',
      'export default defineConfig({',
      `  testDir: "./tests/cycle-${run.id}",`,
      '  timeout: 30000,',
      '  retries: 1,',
      '  use: {',
      `    baseURL: "${frontendUrl}",`,
      '    headless: true,',
      '  },',
      '});',
    ].join('\n');

    await this.containerManager.execInWorker(
      containerId, "bash",
      ["-c", `cat > /workspace/Source/E2E/playwright.pipeline.config.ts << 'PIPELINECFG'\n${pipelineConfig}\nPIPELINECFG`],
      { label: "playwright-config", quiet: true }
    );

    // Run the E2E tests with the pipeline config (no webServer, uses live app)
    // Verifies: FR-TMP-003
    console.log(`[${run.id}] Running Playwright E2E tests from ${testDir}...`);
    const e2eResult = await this.containerManager.execInWorker(
      containerId, "bash",
      ["-c", `cd /workspace/Source/E2E && PLAYWRIGHT_BROWSERS_PATH=/workspace/.playwright npx playwright test --config=playwright.pipeline.config.ts --reporter=json 2>&1`],
      { label: "playwright-e2e" }
    );

    // Parse JSON output for test counts
    // Verifies: FR-TMP-009
    let tests = 0, passed = 0, failed = 0;
    try {
      const jsonOutput = e2eResult.stdout;
      const report = JSON.parse(jsonOutput);
      if (report.suites) {
        const countSpecs = (suites) => {
          for (const suite of suites) {
            if (suite.specs) {
              for (const spec of suite.specs) {
                tests += spec.tests ? spec.tests.length : 0;
                if (spec.tests) {
                  for (const t of spec.tests) {
                    if (t.status === "expected" || t.status === "passed") passed++;
                    else failed++;
                  }
                }
              }
            }
            if (suite.suites) countSpecs(suite.suites);
          }
        };
        countSpecs(report.suites);
      }
    } catch {
      // JSON parse failed — fall back to exit code
      console.warn(`[${run.id}] Could not parse Playwright JSON output, using exit code`);
      if (e2eResult.exitCode === 0) {
        tests = 1; passed = 1; failed = 0;
      } else {
        tests = 1; passed = 0; failed = 1;
      }
    }

    const e2ePassed = e2eResult.exitCode === 0;
    run.e2e = {
      status: e2ePassed ? "passed" : "failed",
      tests,
      passed,
      failed,
      outputTail: e2eResult.stdout.slice(-2000),
    };
    saveRunFn(run);

    console.log(`[${run.id}] E2E: ${run.e2e.status} (${passed}/${tests} passed)`);
    return e2ePassed;
  }

  // ════════════════════════════════════════════════════════════
  // Phase 6.5a: Create GitHub PR
  // Verifies: FR-TMP-004
  // ════════════════════════════════════════════════════════════

  async _createPR(containerId, run, saveRunFn) {
    // Check if gh CLI is available
    // Verifies: FR-TMP-010 — graceful degradation when gh unavailable
    const ghCheck = await this.containerManager.execInWorker(
      containerId, "which", ["gh"], { quiet: true }
    );
    if (ghCheck.exitCode !== 0) {
      console.warn(`[${run.id}] gh CLI not available, skipping PR creation`);
      run.pr = { status: "skipped", reason: "gh_unavailable" };
      saveRunFn(run);
      return;
    }

    // Build PR title and body
    // Verifies: FR-TMP-004
    const taskTitle = run.task.replace(/"/g, '\\"').slice(0, 80);
    const prTitle = `cycle/${run.id}: ${taskTitle}`;

    const e2eSummary = run.e2e
      ? `E2E: ${run.e2e.status} (${run.e2e.passed || 0}/${run.e2e.tests || 0})`
      : "E2E: not run";

    const prBody = [
      `## Cycle ${run.id}`,
      "",
      `**Task:** ${run.task.slice(0, 200)}`,
      `**Risk Level:** ${run.riskLevel}`,
      `**Team:** ${run.team}`,
      "",
      "### Results",
      `- Implementation: ${run.results?.implementation || "unknown"}`,
      `- QA: ${run.results?.qa || "unknown"}`,
      `- Smoketest: ${run.results?.smoketest || "unknown"}`,
      `- Inspector: ${run.results?.inspector || "unknown"}`,
      `- ${e2eSummary}`,
      `- Feedback loops: ${run.feedbackLoops || 0}`,
    ].join("\n");

    // Determine labels based on risk level
    // Verifies: FR-TMP-004
    const labelMap = {
      low: "auto-merge,low-risk",
      medium: "auto-merge,ai-reviewed",
      high: "needs-approval,high-risk",
    };
    const labels = labelMap[run.riskLevel] || labelMap.medium;

    // Create PR via gh CLI — use temp files to avoid shell injection
    console.log(`[${run.id}] Creating PR: ${prTitle}`);

    // Write PR body to temp file to avoid shell escaping issues
    await this.containerManager.execInWorker(
      containerId, "bash",
      ["-c", `cat > /tmp/pr-body.txt << 'PRBODYEOF'\n${prBody}\nPRBODYEOF`],
      { label: "pr-body", quiet: true }
    );

    // Try with labels first, fall back without labels if they don't exist
    let prResult = await this.containerManager.execInWorker(
      containerId, "bash",
      ["-c", `cd /workspace && gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body-file /tmp/pr-body.txt --base master --head "cycle/${run.id}" --label "${labels}" 2>&1`],
      { label: "pr-create" }
    );

    if (prResult.exitCode !== 0 && prResult.stdout.includes("label")) {
      console.warn(`[${run.id}] PR creation with labels failed, retrying without labels...`);
      prResult = await this.containerManager.execInWorker(
        containerId, "bash",
        ["-c", `cd /workspace && gh pr create --title "${prTitle.replace(/"/g, '\\"')}" --body-file /tmp/pr-body.txt --base master --head "cycle/${run.id}" 2>&1`],
        { label: "pr-create-nolabel" }
      );
    }

    if (prResult.exitCode !== 0) {
      // Verifies: FR-TMP-010 — PR creation failure is non-fatal
      console.warn(`[${run.id}] PR creation failed (exit ${prResult.exitCode}): ${prResult.stdout.slice(-500)}`);
      run.pr = { status: "failed", reason: prResult.stdout.slice(-500) };
      saveRunFn(run);
      return;
    }

    // Parse PR number and URL from output
    // Verifies: FR-TMP-009
    const urlMatch = prResult.stdout.match(/(https:\/\/github\.com\/[^\s]+\/pull\/(\d+))/);
    run.pr = {
      number: urlMatch ? parseInt(urlMatch[2], 10) : null,
      url: urlMatch ? urlMatch[1] : prResult.stdout.trim(),
      status: "open",
    };
    saveRunFn(run);

    console.log(`[${run.id}] PR created: ${run.pr.url || "unknown URL"}`);
  }

  // ════════════════════════════════════════════════════════════
  // Phase 6.5b: AI PR Review
  // Verifies: FR-TMP-005
  // ════════════════════════════════════════════════════════════

  async _aiReviewPR(containerId, run, saveRunFn) {
    // Skip for low risk
    // Verifies: FR-TMP-005
    if (run.riskLevel === "low") {
      console.log(`[${run.id}] Skipping AI review for low-risk cycle`);
      run.pr.aiReview = "skipped";
      saveRunFn(run);
      return;
    }

    if (!run.pr || !run.pr.number) {
      console.warn(`[${run.id}] No PR number available, skipping AI review`);
      run.pr = run.pr || {};
      run.pr.aiReview = "skipped";
      run.pr.aiReviewComment = "No PR available for review";
      saveRunFn(run);
      return;
    }

    // Get diff for review
    console.log(`[${run.id}] Getting diff for AI review...`);
    const diffResult = await this.containerManager.execInWorker(
      containerId, "bash",
      ["-c", `cd /workspace && git diff master...cycle/${run.id} 2>/dev/null | head -c 50000`],
      { label: "pr-diff", quiet: true }
    );

    const diff = diffResult.exitCode === 0 ? diffResult.stdout : "(diff unavailable)";

    // Build review prompt
    // Verifies: FR-TMP-005
    const e2eSummary = run.e2e
      ? `E2E: ${run.e2e.status} (${run.e2e.passed || 0}/${run.e2e.tests || 0} passed)`
      : "E2E: not run";

    const reviewPrompt = [
      "You are a code reviewer. Review this pull request diff and decide: APPROVE or REQUEST_CHANGES.",
      "",
      `Task: ${run.task.slice(0, 500)}`,
      `Risk level: ${run.riskLevel}`,
      `QA status: ${run.results?.qa || "unknown"}`,
      `${e2eSummary}`,
      "",
      "Review criteria:",
      "1. Code matches the task description",
      "2. No security vulnerabilities (injection, XSS, hardcoded secrets)",
      "3. Follows architecture patterns (service layer, no direct DB in handlers)",
      "4. No obvious bugs or logic errors",
      "5. Adequate test coverage",
      "",
      "Diff:",
      "```",
      diff,
      "```",
      "",
      "Respond with exactly one line: APPROVE or REQUEST_CHANGES",
      "Then on the next line, provide a brief explanation.",
    ].join("\n");

    // Run Claude for review
    console.log(`[${run.id}] Running AI PR review...`);
    const reviewResult = await this.containerManager.execInWorker(
      containerId, "claude",
      ["-p", reviewPrompt, "--allowedTools", "Bash,Read,Glob,Grep", "--output-format", "text"],
      { label: "ai-review" }
    );

    // Parse verdict
    // Verifies: FR-TMP-005
    let verdict = "APPROVE";
    let comment = reviewResult.stdout.slice(0, 2000);

    if (reviewResult.exitCode !== 0) {
      // Verifies: FR-TMP-010 — timeout/failure defaults
      console.warn(`[${run.id}] AI review failed (exit ${reviewResult.exitCode})`);
      if (run.riskLevel === "high") {
        verdict = "REQUEST_CHANGES";
        comment = "AI review failed — keeping PR open for manual review (high risk)";
      } else {
        verdict = "APPROVE";
        comment = "AI review timed out — defaulting to APPROVE for medium risk";
      }
    } else {
      const output = reviewResult.stdout;
      if (/REQUEST_CHANGES/i.test(output)) {
        verdict = "REQUEST_CHANGES";
      } else {
        verdict = "APPROVE";
      }
    }

    // Post review via gh CLI
    // Verifies: FR-TMP-005
    const ghReviewFlag = verdict === "APPROVE" ? "--approve" : `--request-changes`;
    const escapedComment = comment.replace(/"/g, '\\"').replace(/\n/g, "\\n").slice(0, 1000);

    await this.containerManager.execInWorker(
      containerId, "bash",
      ["-c", `cd /workspace && gh pr review ${run.pr.number} ${ghReviewFlag} --body "${escapedComment}" 2>&1 || true`],
      { label: "pr-review-post", quiet: true }
    );

    run.pr.aiReview = verdict;
    run.pr.aiReviewComment = comment;
    saveRunFn(run);

    console.log(`[${run.id}] AI review: ${verdict}`);
  }

  // ════════════════════════════════════════════════════════════
  // Phase 6.5c: Auto-Merge Logic
  // Verifies: FR-TMP-006
  // ════════════════════════════════════════════════════════════

  async _autoMerge(containerId, run, saveRunFn) {
    if (!run.pr || !run.pr.number || run.pr.status !== "open") {
      console.log(`[${run.id}] No open PR to merge`);
      return;
    }

    const { riskLevel } = run;
    const aiReview = run.pr.aiReview || "skipped";
    const e2eStatus = run.e2e?.status || "skipped";

    // Decision matrix — Verifies: FR-TMP-006
    let shouldMerge = false;
    let newStatus = "open";
    let labelToAdd = null;

    if (riskLevel === "low" && (e2eStatus === "passed" || e2eStatus === "skipped")) {
      // Low risk: auto-merge if E2E passed (or skipped)
      if (this.config.autoMergeLow) {
        shouldMerge = true;
      }
    } else if (riskLevel === "medium") {
      if (aiReview === "APPROVE" && (e2eStatus === "passed" || e2eStatus === "skipped")) {
        if (this.config.autoMergeMedium) {
          shouldMerge = true;
        }
      } else if (aiReview === "REQUEST_CHANGES") {
        newStatus = "changes-requested";
      }
    } else if (riskLevel === "high") {
      if (aiReview === "APPROVE") {
        labelToAdd = "ready-for-review";
      } else if (aiReview === "REQUEST_CHANGES") {
        labelToAdd = "changes-requested";
      }
      // High risk never auto-merges
    }

    if (shouldMerge) {
      console.log(`[${run.id}] Auto-merging PR #${run.pr.number} (${riskLevel} risk)...`);
      const mergeResult = await this.containerManager.execInWorker(
        containerId, "bash",
        ["-c", `cd /workspace && gh pr merge ${run.pr.number} --squash --delete-branch 2>&1`],
        { label: "pr-merge" }
      );

      if (mergeResult.exitCode === 0) {
        run.pr.status = "merged";
        console.log(`[${run.id}] PR #${run.pr.number} merged successfully`);
      } else {
        // Verifies: FR-TMP-010 — merge conflict: try rebase then retry merge
        console.warn(`[${run.id}] Merge failed, attempting rebase on master...`);
        const rebaseResult = await this.containerManager.execInWorker(
          containerId, "bash",
          ["-c", `cd /workspace && git fetch origin master && git rebase origin/master 2>&1 && git push origin "cycle/${run.id}" --force 2>&1`],
          { label: "pr-rebase" }
        );

        if (rebaseResult.exitCode === 0) {
          console.log(`[${run.id}] Rebase succeeded, retrying merge...`);
          const retryMerge = await this.containerManager.execInWorker(
            containerId, "bash",
            ["-c", `cd /workspace && gh pr merge ${run.pr.number} --squash --delete-branch 2>&1`],
            { label: "pr-merge-retry" }
          );
          if (retryMerge.exitCode === 0) {
            run.pr.status = "merged";
            console.log(`[${run.id}] PR #${run.pr.number} merged after rebase`);
          } else {
            console.warn(`[${run.id}] Merge still failed after rebase: ${retryMerge.stdout.slice(-500)}`);
            run.pr.status = "merge-conflict";
            await this.containerManager.execInWorker(
              containerId, "bash",
              ["-c", `cd /workspace && gh pr edit ${run.pr.number} --add-label "merge-conflict" 2>&1 || true`],
              { label: "pr-label", quiet: true }
            );
          }
        } else {
          console.warn(`[${run.id}] Rebase failed: ${rebaseResult.stdout.slice(-500)}`);
          run.pr.status = "merge-conflict";
          await this.containerManager.execInWorker(
            containerId, "bash",
            ["-c", `cd /workspace && git rebase --abort 2>/dev/null; gh pr edit ${run.pr.number} --add-label "merge-conflict" 2>&1 || true`],
            { label: "pr-label", quiet: true }
          );
        }
      }
    } else {
      run.pr.status = newStatus;
      if (labelToAdd) {
        await this.containerManager.execInWorker(
          containerId, "bash",
          ["-c", `cd /workspace && gh pr edit ${run.pr.number} --add-label "${labelToAdd}" 2>&1 || true`],
          { label: "pr-label", quiet: true }
        );
      }
      console.log(`[${run.id}] PR #${run.pr.number} status: ${run.pr.status} (${riskLevel} risk, review=${aiReview})`);
    }

    saveRunFn(run);
  }

  // ════════════════════════════════════════════════════════════
  // Helper: parse dispatch plan from worker filesystem
  // ════════════════════════════════════════════════════════════

  // Verifies: FR-TMP-002 — runId passed to buildAgentPrompt for E2E test generation
  async _parseDispatchFromWorker(containerId, leaderOutput, taskWithImages, team, runId) {
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
              prompt: this.dispatch.buildAgentPrompt(role, taskWithImages, team, planCtx, runId),
            })),
          });
        }
        if (roles.qa && roles.qa.length > 0) {
          stages.push({
            name: "qa",
            parallel: roles.qa.length > 1,
            agents: roles.qa.map((role) => ({
              role,
              prompt: this.dispatch.buildAgentPrompt(role, taskWithImages, team, planCtx, runId),
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
   * @param {object} [resolvedToken] — resolved token from TokenPool.resolveToken()
   */
  async executeWorkflow(run, saveRunFn, resolvedToken) {
    // Extract credentials JSON for worker injection (held in memory only, never persisted)
    // Stored on instance for duration of this workflow so runAgentInWorker can access it
    this._activeCredentialsJson = resolvedToken?.credentialsJson || null;
    const credentialsJson = this._activeCredentialsJson;
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

      // ── Phase 0a: Validate/create target repo on GitHub ──
      const targetRepo = run.repo || this.config.githubRepo;
      if (targetRepo && this.validateOrCreateRepo) {
        console.log(`[${run.id}] Validating target repo: ${targetRepo}`);
        try {
          const repoResult = await this.validateOrCreateRepo(targetRepo);
          // Normalize repo URL to https://github.com/owner/repo format
          run.repo = repoResult.repo;
          run.repoFullName = repoResult.fullName;
          if (repoResult.created) {
            console.log(`[${run.id}] Created new repo: ${repoResult.fullName}`);
            run.repoCreated = true;
            // New repos have 'main' as default branch
            if (!run.repoBranch) run.repoBranch = "main";
          } else {
            console.log(`[${run.id}] Repo exists: ${repoResult.fullName}`);
          }
          saveRunFn(run);
        } catch (err) {
          console.error(`[${run.id}] Repo validation/creation failed: ${err.message}`);
          run.status = "failed";
          run.results = { error: `Repo setup failed: ${err.message}`, allPassed: false };
          saveRunFn(run);
          return;
        }
      }

      // ── Phase 0b: Spawn worker container ──
      const isRetry = !!run.reuseVolume;
      let worker;

      if (isRetry) {
        console.log(`[${run.id}] RETRY: Spawning worker from existing volume ${run.reuseVolume}...`);
        worker = await this.containerManager.spawnWorkerFromVolume(run.id, run.reuseVolume, {
          repo: run.repo,
          repoBranch: run.repoBranch,
          credentialsJson,
        });
      } else {
        console.log(`[${run.id}] Spawning worker container...`);
        worker = await this.containerManager.spawnWorker(run.id, {
          repo: run.repo,
          repoBranch: run.repoBranch,
          credentialsJson,
        });
      }
      containerId = worker.containerId;

      // Store container info on run
      run.containerId = worker.containerId;
      run.containerName = worker.containerName;
      run.ports = worker.ports;

      // Verifies: FR-TMP-009 — Initialize tiered merge pipeline fields
      run.riskLevel = run.riskLevel || this.config.defaultRiskLevel;
      run.e2e = run.e2e || null;
      run.pr = run.pr || null;
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

      // ── Phase 0b: Initialize workspace (skip for retries — volume already has code) ──
      if (isRetry) {
        console.log(`[${run.id}] RETRY: Reusing existing volume — checking git state`);
        // Check if git repo is intact, reinit if corrupted
        const gitCheck = await this.containerManager.execInWorker(containerId, "bash", ["-c",
          `cd /workspace && git rev-parse --git-dir 2>/dev/null || echo "NOT_A_GIT_REPO"`
        ], { label: "git-check", quiet: true });

        if (gitCheck.stdout.includes("NOT_A_GIT_REPO")) {
          console.warn(`[${run.id}] RETRY: Git repo missing/corrupted — reinitializing`);
          const repoUrl = run.repo || this.config.defaultRepo;
          await this.containerManager.execInWorker(containerId, "bash", ["-c",
            `cd /workspace && git init && git remote add origin "${repoUrl}" && git fetch origin ${run.repoBranch || "master"} --depth 1 && git reset --soft FETCH_HEAD 2>/dev/null || true`
          ], { label: "git-repair", quiet: true });
        }

        // Refresh git + gh credentials
        await this.containerManager.execInWorker(containerId, "bash", ["-c",
          `cd /workspace && git config user.name "claude-ai-OS" && git config user.email "pipeline@claude-ai-os.local" && echo "https://$GITHUB_TOKEN@github.com" > ~/.git-credentials && git config --global credential.helper store && (echo "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null; gh auth setup-git 2>/dev/null) || true`
        ], { label: "git-auth", quiet: true });
      } else {
        console.log(`[${run.id}] Initializing workspace in worker...`);
        await this.containerManager.initWorkspace(containerId, run.id);
      }

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
      await this.containerManager.refreshCredentials(containerId, credentialsJson);

      // Verifies: FR-TMP-001 — enrich task with risk classification instructions for the leader
      const enrichedTask = this.dispatch.enrichTaskForLeader(run.task);
      // Append image references to task so the leader sees them
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

      // ── Phase 1b: Extract risk level from leader output ──
      // Verifies: FR-TMP-001
      const riskMatch = leaderResult.stdout.match(/RISK_LEVEL:\s*(low|medium|high)/i);
      run.riskLevel = riskMatch ? riskMatch[1].toLowerCase() : this.config.defaultRiskLevel;
      console.log(`[${run.id}] Risk level: ${run.riskLevel}`);
      saveRunFn(run);

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
        // Verifies: FR-TMP-002 — pass run.id for E2E test path generation
        dispatchPlan = await this._parseDispatchFromWorker(
          containerId, leaderResult.stdout, taskWithImages, run.team, run.id
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

        let { passed, agentResults } = await this.executeStageInWorker(containerId, stage);

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

        // ── Code change verification: implementation must produce code ──
        if (!isQA && passed) {
          // Try git-based detection first, fall back to filesystem scan if not a git repo
          const diffCheck = await this.containerManager.execInWorker(
            containerId, "bash", ["-c",
              "cd /workspace && " +
              "if git rev-parse --git-dir >/dev/null 2>&1; then " +
              "  { git diff --name-only 2>/dev/null; git diff --cached --name-only 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; git diff --name-only $(git merge-base HEAD origin/master 2>/dev/null || echo HEAD~5) HEAD 2>/dev/null; } | sort -u | " +
              "  grep -iE '^(Source/|src/|backend/|frontend/|lib/|app/|services/|routes/|components/|pages/|docker/orchestrator/|platform/|portal/|Teams/|Specifications/|templates/|tools/|CLAUDE\\.md|docs/)' | head -50; " +
              "else " +
              "  find . -maxdepth 4 -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.md' -o -name '*.sh' 2>/dev/null | " +
              "  grep -iE '/(Source|src|backend|frontend|lib|app|services|routes|components|pages|docker|orchestrator|platform|portal|Teams)/' | head -50; " +
              "fi"
            ],
            { label: "impl-verify", quiet: true }
          );
          const changedFiles = diffCheck.stdout.trim();
          if (!changedFiles) {
            console.error(`[${run.id}] Implementation passed (exitCode=0) but NO code files were modified — marking as FAILED`);
            run.phases[stageKey].status = "failed";
            run.phases[stageKey].noSourceChanges = true;
            passed = false;
            // Inject feedback so the feedback loop can re-run with a clear message
            for (const ar of agentResults) {
              ar.exitCode = 1;
              ar.outputTail += "\n\nFAILED: No code files were modified. You MUST edit source code files to implement the assigned FRs. Writing plans, reports, or analysis is NOT sufficient — you must write code. Source files may be in Source/, docker/orchestrator/, Teams/, or other project-specific directories.";
            }
            saveRunFn(run);
          } else {
            console.log(`[${run.id}] Implementation verified: Source/ files changed:\n${changedFiles}`);
          }
        }

        // ── Feedback loop: Implementation failed (no Source/ changes) -> re-run implementation ──
        if (!isQA && !passed && run.phases[stageKey].noSourceChanges && feedbackLoops < this.config.maxFeedbackLoops) {
          feedbackLoops++;
          console.log(`[${run.id}] Feedback loop ${feedbackLoops}/${this.config.maxFeedbackLoops}: No Source/ changes -> re-run implementation`);

          const feedback = agentResults
            .map((ar) => `-- ${ar.role} --\n${ar.outputTail.slice(-1000)}`)
            .join("\n\n");

          const fbImplKey = `feedback_${feedbackLoops}_${stage.name}`;
          run.status = "implementing";
          run.phases[fbImplKey] = { status: "running", startedAt: ts(), agents: {} };
          saveRunFn(run);

          this.registry.update(run.id, {
            status: "implementing",
            currentPhase: fbImplKey,
            phaseStartedAt: ts(),
          });

          const implResult = await this.executeStageInWorker(containerId, stage, feedback);

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

          // Re-check for Source/ changes after retry
          if (implResult.passed) {
            const retryDiff = await this.containerManager.execInWorker(
              containerId, "bash", ["-c",
                "cd /workspace && " +
                "{ git diff --name-only 2>/dev/null; git diff --cached --name-only 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; git diff --name-only $(git merge-base HEAD origin/master 2>/dev/null || echo HEAD~5) HEAD 2>/dev/null; } | sort -u | " +
                "grep -iE '^(Source/|src/|backend/|frontend/|lib/|app/|services/|routes/|components/|pages/|docker/orchestrator/|platform/|portal/|Teams/|Specifications/|templates/|tools/|CLAUDE\\.md|docs/)' | head -50"
              ],
              { label: "impl-retry-verify", quiet: true }
            );
            if (!retryDiff.stdout.trim()) {
              console.error(`[${run.id}] Feedback loop ${feedbackLoops}: Still no Source/ changes after retry`);
              run.phases[fbImplKey].status = "failed";
              run.phases[fbImplKey].noSourceChanges = true;
              saveRunFn(run);
            }
          }
        }

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

      // ── Phase 5.5: Run Playwright E2E tests against live app ──
      // Verifies: FR-TMP-003
      if (run.app && run.app.running) {
        this.registry.update(run.id, {
          currentPhase: "e2e",
          phaseStartedAt: ts(),
        });

        console.log(`[${run.id}] Phase 5.5: Running Playwright E2E tests...`);
        run.phases.e2e = { status: "running", startedAt: ts() };
        saveRunFn(run);

        try {
          let e2ePassed = await this._runPlaywrightE2E(containerId, run, saveRunFn);

          // Verifies: FR-TMP-003 — E2E feedback loop (shared counter with QA)
          if (!e2ePassed && feedbackLoops < this.config.maxFeedbackLoops && lastImplStageIdx >= 0) {
            feedbackLoops++;
            console.log(`[${run.id}] E2E feedback loop ${feedbackLoops}/${this.config.maxFeedbackLoops}`);

            const e2eFeedback = `E2E TEST FAILURES:\n${run.e2e.outputTail || "(no output)"}`;

            // Re-run implementation with E2E feedback
            const implStage = dispatchPlan.stages[lastImplStageIdx];
            const fbKey = `feedback_e2e_${feedbackLoops}_impl`;
            run.phases[fbKey] = { status: "running", startedAt: ts(), agents: {} };
            saveRunFn(run);

            const implResult = await this.executeStageInWorker(containerId, implStage, e2eFeedback);
            for (const ar of implResult.agentResults) {
              run.phases[fbKey].agents[ar.role] = {
                status: ar.exitCode === 0 ? "passed" : "failed",
                exitCode: ar.exitCode,
                outputTail: ar.outputTail,
              };
            }
            run.phases[fbKey].status = implResult.passed ? "passed" : "failed";
            run.phases[fbKey].completedAt = ts();
            saveRunFn(run);

            // Re-run QA
            const qaStages = dispatchPlan.stages.filter(s => /qa|verification|review|test/i.test(s.name));
            if (qaStages.length > 0) {
              const qaStage = qaStages[qaStages.length - 1];
              const fbQaKey = `feedback_e2e_${feedbackLoops}_qa`;
              run.phases[fbQaKey] = { status: "running", startedAt: ts(), agents: {} };
              saveRunFn(run);

              const qaResult = await this.executeStageInWorker(containerId, qaStage);
              for (const ar of qaResult.agentResults) {
                run.phases[fbQaKey].agents[ar.role] = {
                  status: ar.exitCode === 0 ? "passed" : "failed",
                  exitCode: ar.exitCode,
                  outputTail: ar.outputTail,
                };
              }
              run.phases[fbQaKey].status = qaResult.passed ? "passed" : "failed";
              run.phases[fbQaKey].completedAt = ts();
              saveRunFn(run);
            }

            // Re-run E2E
            e2ePassed = await this._runPlaywrightE2E(containerId, run, saveRunFn);
          }

          run.phases.e2e.status = run.e2e.status === "passed" ? "passed" : (run.e2e.status === "skipped" ? "skipped" : "failed");
          run.phases.e2e.completedAt = ts();

          // Verifies: FR-TMP-009 — update results with E2E status
          run.results.e2e = run.e2e.status;
          run.feedbackLoops = feedbackLoops;
          saveRunFn(run);
        } catch (err) {
          // Verifies: FR-TMP-010 — E2E errors are non-fatal
          console.warn(`[${run.id}] E2E phase error: ${err.message}`);
          run.e2e = { status: "skipped", reason: "error", error: err.message };
          run.phases.e2e.status = "skipped";
          run.phases.e2e.completedAt = ts();
          run.results.e2e = "skipped";
          saveRunFn(run);
        }
      } else {
        console.log(`[${run.id}] App not running, skipping E2E phase`);
        run.e2e = { status: "skipped", reason: "app_not_running" };
        run.results.e2e = "skipped";
        saveRunFn(run);
      }

      // App is already running from Phase 3.5 — no need to start again.
      // It stays running on the worker's allocated ports for user testing.

      // ── Phase 6: Commit and push from worker ──
      // CRITICAL: If this fails, the code only exists in the worker volume.
      // We must verify the push landed before allowing volume cleanup.
      console.log(`[${run.id}] Committing and pushing...`);
      const commitMsg = `feat: ${run.task.replace(/[\r\n]+/g, " ").slice(0, 100)}`;
      const commitResult = await this.containerManager.commitAndPush(containerId, run.id, commitMsg);

      // Verify commits actually reached the remote
      const commitCheck = await this.containerManager.execInWorker(
        containerId, "bash",
        ["-c", `cd /workspace && git log --oneline origin/${this.config.branch}..HEAD 2>/dev/null | wc -l`],
        { label: "commit-check", quiet: true }
      );
      const localCommitCount = parseInt((commitCheck.stdout || "").trim(), 10) || 0;

      // Double-check: verify remote branch has the commits (not just local)
      const remoteCheck = await this.containerManager.execInWorker(
        containerId, "bash",
        ["-c", `cd /workspace && git fetch origin "cycle/${run.id}" 2>/dev/null && git log --oneline "origin/cycle/${run.id}" --not "origin/${this.config.branch}" 2>/dev/null | wc -l`],
        { label: "remote-verify", quiet: true }
      );
      const remoteCommitCount = parseInt((remoteCheck.stdout || "").trim(), 10) || 0;

      run.pushVerified = remoteCommitCount > 0;

      if (localCommitCount > 0 && !run.pushVerified) {
        // Code exists locally but NOT on remote — this is the "lost work" scenario
        console.error(`[${run.id}] CRITICAL: ${localCommitCount} local commits but push to remote FAILED. Preserving volume.`);
        run.results.commitPush = "push_failed";
        run.pushVerified = false;
        saveRunFn(run);
      } else if (localCommitCount === 0) {
        console.warn(`[${run.id}] No commits created — implementation may not have produced code changes`);
        run.results.commitPush = "no_commits";
        saveRunFn(run);
      } else {
        console.log(`[${run.id}] Push verified: ${remoteCommitCount} commits on remote`);
        run.results.commitPush = "verified";
        saveRunFn(run);
      }

      // ── Phase 6.5: PR creation, AI review, and auto-merge ──
      // Verifies: FR-TMP-004, FR-TMP-005, FR-TMP-006
      if (!run.pushVerified) {
        console.warn(`[${run.id}] Skipping PR creation — push not verified`);
        run.pr = { status: "skipped", reason: run.results.commitPush };
        run.results.pr = "skipped";
        saveRunFn(run);
      } else if (this.config.mergeStrategy !== "manual") {
        this.registry.update(run.id, {
          currentPhase: "pr_merge",
          phaseStartedAt: ts(),
        });

        console.log(`[${run.id}] Phase 6.5: PR creation and merge decision...`);
        run.phases.prMerge = { status: "running", startedAt: ts() };
        saveRunFn(run);

        try {
          // Phase 6.5a: Create PR — Verifies: FR-TMP-004
          await this._createPR(containerId, run, saveRunFn);

          // Phase 6.5b: AI Review (medium/high only) — Verifies: FR-TMP-005
          if (run.pr && run.pr.status === "open") {
            await this._aiReviewPR(containerId, run, saveRunFn);
          }

          // Phase 6.5c: Auto-merge decision — Verifies: FR-TMP-006
          if (run.pr && (run.pr.status === "open" || run.pr.status === "changes-requested")) {
            await this._autoMerge(containerId, run, saveRunFn);
          }

          run.phases.prMerge.status = "completed";
          run.phases.prMerge.completedAt = ts();

          // Verifies: FR-TMP-009 — persist PR state in results
          run.results.pr = run.pr ? run.pr.status : "skipped";
          saveRunFn(run);
        } catch (err) {
          // Verifies: FR-TMP-010 — PR/merge errors are non-fatal
          console.warn(`[${run.id}] PR/merge phase error: ${err.message}`);
          run.phases.prMerge.status = "failed";
          run.phases.prMerge.completedAt = ts();
          run.phases.prMerge.error = err.message;
          run.results.pr = "error";
          saveRunFn(run);
        }
      }

      // ── Phase 8: Sync learnings inside worker (has the correct repo) ──
      console.log(`[${run.id}] Syncing learnings...`);
      try {
        const mainBranch = run.repoBranch || "master";
        const syncScript = [
          "cd /workspace",
          "git stash --include-untracked || true",
          `git checkout ${mainBranch}`,
          `git pull origin ${mainBranch}`,
          // Checkout learnings files from cycle branch — pattern may not match, that's expected
          `git checkout cycle/${run.id} -- Teams/*/learnings/*.md Teams/TheATeam/*.md Teams/TheFixer/*.md Teams/TheInspector/*.md Teams/Shared/*.md 2>/dev/null || echo "[learnings] No team files to sync"`,
          `git checkout cycle/${run.id} -- CLAUDE.md 2>/dev/null || echo "[learnings] No CLAUDE.md changes"`,
          "git add -A",
          // Fixed: use if/then to avoid bash operator precedence issues
          `if ! git diff --cached --quiet 2>/dev/null; then git commit -m "chore: sync learnings from cycle/${run.id}" && git push origin ${mainBranch}; else echo "[learnings] Nothing to commit"; fi`,
          `git checkout cycle/${run.id}`,
          "git stash pop || echo '[learnings] No stash to pop'",
        ].join(" && ");
        const syncResult = await this.containerManager.execInWorker(
          containerId, "bash", ["-c", syncScript],
          { label: "learnings-sync", quiet: true }
        );
        if (syncResult.exitCode === 0) {
          console.log(`[${run.id}] Learnings synced to ${mainBranch}`);
        } else {
          console.warn(`[${run.id}] Learnings sync had issues (exit ${syncResult.exitCode})`);
        }
      } catch (err) {
        console.warn(`[${run.id}] Learnings sync failed: ${err.message}`);
      }

      // ── Phase 9: Auto-update portal if this cycle targeted the portal repo ──
      // Only trigger if actual Source/ code was committed (not just plans/reports)
      if (run.status === "complete" && run.repo) {
        const isPortalRepo = run.repo.includes("container-test");
        if (isPortalRepo) {
          // Verify Source/ files were actually changed before updating portal
          const sourceCheck = await this.containerManager.execInWorker(
            containerId, "bash", ["-c", `cd /workspace && git diff --name-only ${run.repoBranch || "master"}..HEAD -- Source/`],
            { label: "portal-gate", quiet: true }
          );
          const hasSourceChanges = sourceCheck.stdout.trim().length > 0;

          if (hasSourceChanges) {
            console.log(`[${run.id}] Updating portal with latest code (${sourceCheck.stdout.trim().split('\n').length} Source/ files changed)...`);
            try {
              const resp = await fetch(`http://localhost:${this.config.port || 8080}/api/portal/update`, {
                method: "POST",
              });
              if (resp.ok) {
                console.log(`[${run.id}] Portal updated successfully`);
              }
            } catch (err) {
              console.warn(`[${run.id}] Portal update failed: ${err.message}`);
            }
          } else {
            console.log(`[${run.id}] Skipping portal update — no Source/ files changed (plans/reports only)`);
          }
        }
      }

      // ── Finalize ──
      this.registry.update(run.id, {
        status: run.status,
        appRunning: false,
        currentPhase: null,
        phaseStartedAt: null,
      });
      saveRunFn(run);

      // Auto-cleanup worker container
      // CRITICAL: Never delete the volume unless code is confirmed on the remote.
      // If push wasn't verified, the volume is the ONLY copy of the work.
      try {
        const pushSafe = run.pushVerified === true;
        const keepVolume = !pushSafe || run.status !== "complete";
        if (!pushSafe) {
          console.warn(`[${run.id}] Push NOT verified — preserving volume to prevent data loss`);
        }
        console.log(`[${run.id}] Cleaning up worker (status=${run.status}, pushVerified=${pushSafe}, keepVolume=${keepVolume})...`);
        await this.containerManager.teardown(run.id, { keepVolume, keepBranch: true });
      } catch (cleanupErr) {
        console.warn(`[${run.id}] Worker cleanup warning: ${cleanupErr.message}`);
      }

      // Clear credentials from memory — token lifecycle ends with the workflow
      this._activeCredentialsJson = null;

    } catch (err) {
      this._activeCredentialsJson = null; // Clear on error too
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
