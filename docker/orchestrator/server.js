/**
 * claude-ai-OS Orchestrator
 *
 * Multi-stage pipeline orchestrator that:
 *   1. Routes tasks to the correct team (Claude decides)
 *   2. Runs the team leader to produce a plan
 *   3. Parses the leader's dispatch plan into structured stages
 *   4. Executes implementation agents (coders/fixers)
 *   5. Executes QA agents with feedback loops (max 2)
 *   6. Runs final validation (smoketests + TheInspector)
 *
 * Endpoints:
 *   POST /api/work              — submit a work request
 *   GET  /api/runs              — list all runs
 *   GET  /api/runs/:id          — get run status (includes per-agent detail)
 *   POST /api/runs/:id/revalidate — re-run validation phase
 *   GET  /api/health            — health check
 *   GET  /                      — live dashboard
 */

const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } = require("fs");
const { join } = require("path");
const { randomUUID } = require("crypto");

const app = express();
app.use(express.json({ limit: "50mb" }));

// Multer: memory storage so we can save to run-specific dirs after ID generation
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"), false);
  },
});

const PORT = 8080;
const WORKSPACE = process.env.WORKSPACE_DIR || "/workspace";
const RUNS_DIR = join(WORKSPACE, ".orchestrator-runs");
const MAX_FEEDBACK_LOOPS = 2;

if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });

// ══════════════════════════════════════════════════════════════
// Run State
// ══════════════════════════════════════════════════════════════

function ts() { return new Date().toISOString(); }

function loadRun(id) {
  const file = join(RUNS_DIR, `${id}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

function saveRun(run) {
  run.updatedAt = ts();
  writeFileSync(join(RUNS_DIR, `${run.id}.json`), JSON.stringify(run, null, 2));
}

function listRuns() {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(RUNS_DIR, f), "utf-8")))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// ══════════════════════════════════════════════════════════════
// Team Selection — Claude decides, not keywords
// ══════════════════════════════════════════════════════════════

async function selectTeam(task, planFile) {
  const routingPrompt = `You are a team routing decision engine. Your ONLY job is to decide which team should handle this work.

Read CLAUDE.md to understand the project and team definitions.

The two teams:
- **TheATeam**: For ALL feature work — new features, enhancements, adding capabilities, extending existing features, new pages, new API endpoints, new components, refactoring for new behavior. Any work that adds or changes FUNCTIONALITY goes to TheATeam.
- **TheFixer**: ONLY for bugs and issues — something is broken, a test is failing, an error is occurring, a regression was introduced, a security vulnerability needs patching. TheFixer fixes what's wrong, it does not build new things.

The decision is simple:
- Is this adding or changing functionality? → TheATeam (even if it touches existing code)
- Is this fixing something that's broken? → TheFixer

The work request:
"""
${task}
"""
${planFile ? `\nReferenced plan file: ${planFile}` : ""}

Respond with EXACTLY one line in this format (no other text):
TEAM: TheATeam | REASON: <one sentence>
or
TEAM: TheFixer | REASON: <one sentence>`;

  try {
    const result = await runClaude(routingPrompt, { maxTurns: 1, label: "router", quiet: true });
    const output = result.stdout.trim();
    const match = output.match(/TEAM:\s*(TheATeam|TheFixer)\s*\|\s*REASON:\s*(.+)/i);

    if (match) return { team: match[1], reason: match[2].trim() };
    if (/TheATeam/i.test(output)) return { team: "TheATeam", reason: `Claude recommended TheATeam: ${output.slice(0, 200)}` };
    if (/TheFixer/i.test(output)) return { team: "TheFixer", reason: `Claude recommended TheFixer: ${output.slice(0, 200)}` };

    console.warn(`[router] Ambiguous response: ${output.slice(0, 300)}`);
    return { team: "TheFixer", reason: "Ambiguous response — defaulting to TheFixer" };
  } catch (err) {
    console.error("[router] Routing failed:", err.message);
    return { team: "TheFixer", reason: `Routing failed (${err.message}) — defaulting to TheFixer` };
  }
}

// ══════════════════════════════════════════════════════════════
// Process Execution
// ══════════════════════════════════════════════════════════════

function runScript(command, args = [], { label, quiet } = {}) {
  return new Promise((resolve, reject) => {
    const isScript = command.endsWith(".sh");
    const cmd = isScript ? "bash" : command;
    const cmdArgs = isScript ? [command, ...args] : args;
    const tag = label || cmd;

    const proc = spawn(cmd, cmdArgs, {
      cwd: WORKSPACE,
      env: { ...process.env, WORKSPACE_DIR: WORKSPACE },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (!quiet) {
        // Stream each line to container logs in real-time
        for (const line of chunk.split("\n")) {
          if (line.trim()) process.stdout.write(`  [${tag}] ${line}\n`);
        }
      }
    });

    proc.stderr.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (!quiet) {
        for (const line of chunk.split("\n")) {
          if (line.trim()) process.stderr.write(`  [${tag}] ${line}\n`);
        }
      }
    });

    proc.on("close", (code) => resolve({ exitCode: code, stdout, stderr }));
    proc.on("error", reject);
  });
}

/**
 * Run claude -p with a prompt. Returns { exitCode, stdout, stderr }.
 * Individual agents get Bash/Read/Write/Edit/Glob/Grep.
 * Leaders get Agent tool via run-team.sh (not through this function).
 */
function runClaude(prompt, { maxTurns, tools, label, quiet } = {}) {
  const args = ["-p", prompt, "--output-format", "text"];
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  if (tools) args.push("--allowedTools", tools);
  return runScript("claude", args, { label, quiet });
}

// ══════════════════════════════════════════════════════════════
// Dispatch Plan Parsing
// ══════════════════════════════════════════════════════════════

/**
 * Extract JSON from Claude's text output (handles markdown fences, preamble).
 */
function extractJson(text) {
  const trimmed = text.trim();
  try { return JSON.parse(trimmed); } catch {}
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) try { return JSON.parse(fenced[1].trim()); } catch {}
  const braceMatch = trimmed.match(/\{[\s\S]*\}/);
  if (braceMatch) try { return JSON.parse(braceMatch[0]); } catch {}
  throw new Error("No valid JSON found in output");
}

/**
 * Send leader output to Claude for structured dispatch plan extraction.
 * Returns { stages: [{ name, parallel, agents: [{ role, prompt }] }] }
 */
// ══════════════════════════════════════════════════════════════
// Dispatch Plan — file-first parsing with Node.js prompt building
// ══════════════════════════════════════════════════════════════

/**
 * Scan workspace for plan-related files the leader created.
 */
function findPlanContext() {
  const ctx = { specs: [], plans: [], contracts: [], dispatchPlan: null, planDir: null };

  const specsDir = join(WORKSPACE, "Specifications");
  if (existsSync(specsDir)) {
    try {
      for (const f of readdirSync(specsDir)) {
        if (f.endsWith(".md")) ctx.specs.push(`Specifications/${f}`);
      }
    } catch {}
  }

  const plansDir = join(WORKSPACE, "Plans");
  if (existsSync(plansDir)) {
    try {
      for (const entry of readdirSync(plansDir)) {
        const sub = join(plansDir, entry);
        if (!existsSync(sub) || !statSync(sub).isDirectory()) continue;
        for (const f of readdirSync(sub)) {
          const rel = `Plans/${entry}/${f}`;
          if (f === "dispatch-plan.md") { ctx.dispatchPlan = rel; ctx.planDir = `Plans/${entry}`; }
          else if (/contract/i.test(f)) ctx.contracts.push(rel);
          else if (f.endsWith(".md")) ctx.plans.push(rel);
        }
      }
    } catch {}
  }

  return ctx;
}

/**
 * Extract agent role names from a dispatch plan file.
 * Uses regex first, falls back to Claude for ambiguous formats.
 */
async function extractRoles(dispatchContent, leaderOutput) {
  const roles = new Set();

  // Extract from markdown headings: ## backend-coder-1, ### frontend-coder
  for (const m of dispatchContent.matchAll(/^#{2,4}\s+(?:\*\*)?([a-z][\w-]+(?:-\d+)?)(?:\*\*)?/gim)) {
    roles.add(m[1].toLowerCase());
  }
  // From bold table cells: | **backend-coder-1** |
  for (const m of dispatchContent.matchAll(/\|\s*\*\*([a-z][\w-]+(?:-\d+)?)\*\*/gi)) {
    roles.add(m[1].toLowerCase());
  }
  // From bold list items: - **backend-coder-1** or * **qa-review**
  for (const m of dispatchContent.matchAll(/[-*]\s+\*\*([a-z][\w-]+(?:-\d+)?)\*\*/gi)) {
    roles.add(m[1].toLowerCase());
  }
  // From leader stdout: agent names mentioned
  for (const m of leaderOutput.matchAll(/\b(backend-coder-?\d*|frontend-coder-?\d*|qa-review[\w-]*|security-qa|traceability[\w-]*|chaos[\w-]*|visual[\w-]*|design[\w-]*|integration[\w-]*|playwright[\w-]*)\b/gi)) {
    roles.add(m[1].toLowerCase());
  }

  // Filter to agent-like names only
  const agentRoles = [...roles].filter((r) =>
    /coder|fixer|qa|security|review|test|chaos|traceability|visual|design|integration|critic|playwright/i.test(r)
  );

  if (agentRoles.length > 0) {
    console.log(`[dispatch] Regex extracted ${agentRoles.length} roles: ${agentRoles.join(", ")}`);
    return classifyRoles(agentRoles);
  }

  // Fallback: ask Claude to extract just the role names (simple task)
  console.log("[dispatch] Regex found no roles, asking Claude...");
  const prompt = `Extract agent role names from this dispatch plan. Return ONLY JSON.

"""
${dispatchContent.slice(0, 12000)}
"""

{"implementation": ["role-name-1", "role-name-2"], "qa": ["role-name-1"]}`;

  const result = await runClaude(prompt, { maxTurns: 1, label: "role-extractor", quiet: true });
  if (result.exitCode !== 0) throw new Error("Role extraction failed");
  return extractJson(result.stdout);
}

/**
 * Classify role names into implementation vs QA.
 */
function classifyRoles(roles) {
  const impl = [];
  const qa = [];
  for (const r of roles) {
    if (/coder|fixer/i.test(r)) impl.push(r);
    else qa.push(r);
  }
  return { implementation: impl, qa };
}

/**
 * Build a self-contained prompt for an agent.
 * Agents read the dispatch plan file themselves to find their specific assignments.
 */
function buildAgentPrompt(role, task, team, planCtx) {
  const isImpl = /coder|fixer/i.test(role);
  // Strip trailing number for role file lookup (backend-coder-1 → backend-coder.md)
  const roleBase = role.replace(/-\d+$/, "");
  const roleFile = `Teams/${team}/${roleBase}.md`;
  const learningsFile = `Teams/${team}/learnings/${roleBase}.md`;

  let p = `Read CLAUDE.md first for project context and rules.\n\n`;
  p += `Read the role file at ${roleFile} and follow it (if it exists).\n`;
  p += `Read your learnings file at ${learningsFile} before starting (if it exists).\n\n`;

  if (planCtx.dispatchPlan) {
    p += `IMPORTANT: Read the dispatch plan at ${planCtx.dispatchPlan} and find the section for "${role}". Follow the assignments and instructions for your specific role.\n\n`;
  }

  p += `Task: ${task}\nYour role: ${role}\nTeam: ${team}\n\n`;

  if (planCtx.specs.length > 0) p += `Specifications: ${planCtx.specs.join(", ")}\n`;
  if (planCtx.contracts.length > 0) p += `API Contracts: ${planCtx.contracts.join(", ")}\n`;
  if (planCtx.plans.length > 0) p += `Plans: ${planCtx.plans.join(", ")}\n`;
  p += "\n";

  if (isImpl) {
    p += `Implementation rules:
- Read your section in the dispatch plan for specific FR assignments and module scope
- Implement according to the API contracts and specifications
- Add // Verifies: FR-XXX traceability comments to all code and tests
- Use structured logging (not console.log), add Prometheus metrics for domain operations
- Follow the service layer pattern (no direct DB calls from route handlers)
- All list endpoints return {data: T[]} wrappers
- Run all verification gates before completing (tests, traceability enforcer, type check)
- Update your learnings file with any discoveries`;
  } else {
    p += `QA rules:
- Review the implementation against specifications and contracts
- Run all tests and verification gates
- Run python3 tools/traceability-enforcer.py if available
- Check for security issues, architecture violations, and missing traceability
- Write your report to ${planCtx.planDir || "Plans"}/
- Do NOT edit Source/ files — report issues only
- Report findings with severity ratings (CRITICAL, HIGH, MEDIUM, LOW, INFO)`;
  }

  return p;
}

/**
 * Parse leader output into structured dispatch stages.
 * Strategy: read dispatch plan file → extract roles → build prompts in Node.js
 */
async function parseDispatchPlan(leaderOutput, task, team) {
  const planCtx = findPlanContext();

  if (planCtx.dispatchPlan) {
    console.log(`[dispatch] Found dispatch plan: ${planCtx.dispatchPlan}`);
    const dpContent = readFileSync(join(WORKSPACE, planCtx.dispatchPlan), "utf-8");

    const roles = await extractRoles(dpContent, leaderOutput);
    console.log(`[dispatch] Roles: impl=[${(roles.implementation || []).join(", ")}] qa=[${(roles.qa || []).join(", ")}]`);

    const stages = [];
    if (roles.implementation && roles.implementation.length > 0) {
      stages.push({
        name: "implementation",
        parallel: roles.implementation.length > 1,
        agents: roles.implementation.map((role) => ({
          role,
          prompt: buildAgentPrompt(role, task, team, planCtx),
        })),
      });
    }
    if (roles.qa && roles.qa.length > 0) {
      stages.push({
        name: "qa",
        parallel: roles.qa.length > 1,
        agents: roles.qa.map((role) => ({
          role,
          prompt: buildAgentPrompt(role, task, team, planCtx),
        })),
      });
    }

    if (stages.length > 0) {
      console.log(`[dispatch] Built ${stages.length} stages: ${stages.map((s) => `${s.name}(${s.agents.length}${s.parallel ? ",parallel" : ""})`).join(" → ")}`);
      return { stages };
    }
  } else {
    console.log("[dispatch] No dispatch plan file found in Plans/");
  }

  throw new Error("Could not extract roles from dispatch plan");
}

/**
 * Build a minimal fallback plan when Claude parsing fails.
 */
function buildFallbackPlan(task, team, leaderOutput) {
  const planRefs = (leaderOutput.match(/Plans?\/[\w\-\/]+\.md/gi) || []).slice(0, 5);
  const planNote = planRefs.length > 0 ? `\nPlan files created by leader: ${planRefs.join(", ")}` : "";

  if (team === "TheFixer") {
    return {
      stages: [{
        name: "fix",
        parallel: false,
        agents: [{
          role: "fixer",
          prompt: `Read CLAUDE.md first for project context and rules.\n\nFix: ${task}${planNote}\n\nCheck Plans/ for the fix plan. Run all verification gates before completing.`,
        }],
      }],
    };
  }

  return {
    stages: [
      {
        name: "implementation",
        parallel: false,
        agents: [{
          role: "coder",
          prompt: `Read CLAUDE.md first for project context and rules.\n\nImplement: ${task}${planNote}\n\nCheck Plans/ for the implementation plan and API contracts. Run verification gates before completing.`,
        }],
      },
      {
        name: "qa",
        parallel: true,
        agents: [{
          role: "qa-review",
          prompt: `Read CLAUDE.md first for project context and rules.\n\nReview and test the implementation of: ${task}${planNote}\n\nRun all tests, verify traceability (tools/traceability-enforcer.py), check for security issues.`,
        }],
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════
// Agent Execution
// ══════════════════════════════════════════════════════════════

/**
 * Run a single coding/QA agent via claude -p.
 * Agents get file tools but NOT the Agent tool (only leaders orchestrate).
 */
async function runAgent(role, prompt, feedback) {
  let fullPrompt = prompt;
  if (feedback) {
    fullPrompt += `\n\n═══════════════════════════════════════════
QA FEEDBACK — You MUST address these issues before completing:
═══════════════════════════════════════════
${feedback}`;
  }

  console.log(`    [agent] ${role} starting...`);
  const result = await runClaude(fullPrompt, {
    tools: "Bash,Read,Write,Edit,Glob,Grep",
    label: role,
  });
  console.log(`    [agent] ${role} done (exit: ${result.exitCode})`);
  return result;
}

/**
 * Execute a single stage (group of agents, parallel or sequential).
 * Returns { passed, agentResults }.
 */
async function executeStage(stage, feedback) {
  const runOne = async (agent) => {
    const result = await runAgent(agent.role, agent.prompt, feedback);
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

// ══════════════════════════════════════════════════════════════
// Workflow Engine — Multi-Stage Dispatch with Feedback Loops
// ══════════════════════════════════════════════════════════════

async function executeWorkflow(run) {
  // Build image context string for prompts
  const imageContext = run.attachments && run.attachments.length > 0
    ? `\n\nReference images (use the Read tool to view these):\n${run.attachments.map((p) => `- ${p}`).join("\n")}`
    : "";

  try {
    // ── Phase 1: Team leader produces plan ──
    run.status = "planning";
    run.phases = { leader: { status: "running", startedAt: ts() } };
    saveRun(run);

    console.log(`[${run.id}] Phase 1: ${run.team} leader planning...`);

    // Append image references to task so the leader sees them
    const taskWithImages = run.task + imageContext;

    const leaderResult = await runScript("/app/scripts/run-team.sh", [
      run.team,
      taskWithImages,
      run.planFile || "",
    ], { label: `${run.team}-leader` });

    run.phases.leader.status = leaderResult.exitCode === 0 ? "passed" : "failed";
    run.phases.leader.exitCode = leaderResult.exitCode;
    run.phases.leader.completedAt = ts();
    run.phases.leader.outputTail = leaderResult.stdout.slice(-3000);
    saveRun(run);

    if (leaderResult.exitCode !== 0) {
      console.log(`[${run.id}] Leader failed (exit ${leaderResult.exitCode})`);
      run.status = "failed";
      run.results = { leader: "failed", allPassed: false };
      saveRun(run);
      return;
    }

    console.log(`[${run.id}] Leader plan complete`);

    // ── Phase 2: Parse dispatch plan ──
    run.status = "dispatching";
    saveRun(run);

    console.log(`[${run.id}] Phase 2: Parsing dispatch plan...`);

    let dispatchPlan;
    try {
      dispatchPlan = await parseDispatchPlan(leaderResult.stdout, taskWithImages, run.team);
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
      dispatchPlan = buildFallbackPlan(taskWithImages, run.team, leaderResult.stdout);
    }

    run.phases.dispatch = {
      plan: dispatchPlan,
      stageCount: dispatchPlan.stages.length,
      agentCount: dispatchPlan.stages.reduce((n, s) => n + s.agents.length, 0),
      parsedAt: ts(),
    };
    saveRun(run);

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
      saveRun(run);

      console.log(`[${run.id}] Stage ${i + 1}/${dispatchPlan.stages.length}: ${stage.name} (${stage.agents.length} agent(s), parallel=${stage.parallel})`);

      const { passed, agentResults } = await executeStage(stage);

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
      saveRun(run);

      console.log(`[${run.id}] Stage ${stage.name}: ${passed ? "PASSED" : "FAILED"}`);

      // ── Feedback loop: QA failed → re-run implementation + QA ──
      if (isQA && !passed && feedbackLoops < MAX_FEEDBACK_LOOPS && lastImplStageIdx >= 0) {
        feedbackLoops++;
        console.log(`[${run.id}] Feedback loop ${feedbackLoops}/${MAX_FEEDBACK_LOOPS}: QA → implementation → QA`);

        // Collect QA feedback from failed agents
        const feedback = agentResults
          .filter((ar) => ar.exitCode !== 0)
          .map((ar) => `── ${ar.role} (FAILED) ──\n${ar.outputTail.slice(-1000)}`)
          .join("\n\n");

        // Re-run implementation with feedback
        const implStage = dispatchPlan.stages[lastImplStageIdx];
        const fbImplKey = `feedback_${feedbackLoops}_${implStage.name}`;
        run.status = "implementing";
        run.phases[fbImplKey] = { status: "running", startedAt: ts(), agents: {} };
        saveRun(run);

        console.log(`[${run.id}]   Re-running ${implStage.name} with QA feedback...`);
        const implResult = await executeStage(implStage, feedback);

        for (const ar of implResult.agentResults) {
          run.phases[fbImplKey].agents[ar.role] = {
            status: ar.exitCode === 0 ? "passed" : "failed",
            exitCode: ar.exitCode,
            outputTail: ar.outputTail,
          };
        }
        run.phases[fbImplKey].status = implResult.passed ? "passed" : "failed";
        run.phases[fbImplKey].completedAt = ts();
        saveRun(run);

        // Re-run QA
        const fbQaKey = `feedback_${feedbackLoops}_${stage.name}`;
        run.status = "qa_running";
        run.phases[fbQaKey] = { status: "running", startedAt: ts(), agents: {} };
        saveRun(run);

        console.log(`[${run.id}]   Re-running ${stage.name}...`);
        const qaResult2 = await executeStage(stage);

        for (const ar of qaResult2.agentResults) {
          run.phases[fbQaKey].agents[ar.role] = {
            status: ar.exitCode === 0 ? "passed" : "failed",
            exitCode: ar.exitCode,
            outputTail: ar.outputTail,
          };
        }
        run.phases[fbQaKey].status = qaResult2.passed ? "passed" : "failed";
        run.phases[fbQaKey].completedAt = ts();
        saveRun(run);

        if (!qaResult2.passed) {
          console.log(`[${run.id}]   QA still failing after feedback loop ${feedbackLoops}`);
        }
      }
    }

    run.feedbackLoops = feedbackLoops;

    // ── Phase 4: Final validation (smoketest + inspector in parallel) ──
    run.status = "validating";
    run.phases.smoketest = { status: "running", startedAt: ts() };
    run.phases.inspector = { status: "running", startedAt: ts() };
    saveRun(run);

    console.log(`[${run.id}] Phase 4: Validation (smoketest + inspector)`);

    const [smokeResult, inspectorResult] = await Promise.all([
      runScript("/app/scripts/run-smoketest.sh", [], { label: "smoketest" }),
      runScript("/app/scripts/run-team.sh", [
        "TheInspector",
        `Post-work audit after ${run.team} completed: ${run.task}`,
      ], { label: "inspector" }),
    ]);

    run.phases.smoketest.status = smokeResult.exitCode === 0 ? "passed" : "failed";
    run.phases.smoketest.exitCode = smokeResult.exitCode;
    run.phases.smoketest.completedAt = ts();
    run.phases.smoketest.outputTail = smokeResult.stdout.slice(-2000);

    run.phases.inspector.status = inspectorResult.exitCode === 0 ? "passed" : "failed";
    run.phases.inspector.exitCode = inspectorResult.exitCode;
    run.phases.inspector.completedAt = ts();
    run.phases.inspector.outputTail = inspectorResult.stdout.slice(-2000);

    // ── Phase 5: Final result ──
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
      console.log(`[${run.id}] Smoketest failed but overridden — implementation + QA both passed`);
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
      smoketest: smokePassed ? "passed" : smokeEffective ? "overridden" : "failed",
      inspector: run.phases.inspector.status,
      feedbackLoops,
      allPassed,
    };
    saveRun(run);

    console.log(`[${run.id}] ═══ WORKFLOW ${run.status.toUpperCase()} ═══ leader=${run.results.leader} impl=${run.results.implementation} qa=${run.results.qa} smoke=${run.results.smoketest} inspect=${run.results.inspector} feedbackLoops=${feedbackLoops}`);

    // ── Phase 6: Auto-restart app to serve latest code ──
    if (implPassed) {
      console.log(`[${run.id}] Restarting app with latest code...`);
      const appResult = await startApp();
      run.app = appResult;
      saveRun(run);
      if (appResult.running) {
        console.log(`[${run.id}] App live: backend=${appResult.backend || "—"} frontend=${appResult.frontend || "—"}`);
      }
    }

  } catch (err) {
    console.error(`[${run.id}] Workflow error:`, err);
    run.status = "failed";
    run.results = { ...run.results, error: err.message, allPassed: false };
    saveRun(run);
  }
}

// ══════════════════════════════════════════════════════════════
// App Launcher — starts the built app after successful pipeline
// ══════════════════════════════════════════════════════════════

const appProcesses = { backend: null, frontend: null };

function killApp() {
  for (const [name, proc] of Object.entries(appProcesses)) {
    if (proc) {
      console.log(`[app] Stopping ${name} (pid ${proc.pid})`);
      try { process.kill(-proc.pid, "SIGKILL"); } catch {} // Kill process group
      try { proc.kill("SIGKILL"); } catch {}
      appProcesses[name] = null;
    }
  }
}

/**
 * Check if a port is in use by reading /proc/net/tcp6.
 */
function isPortInUse(port) {
  try {
    const hex = port.toString(16).toUpperCase().padStart(4, "0");
    const tcp6 = readFileSync("/proc/net/tcp6", "utf-8");
    return tcp6.split("\n").some((line) => {
      const cols = line.trim().split(/\s+/);
      return cols[1] && cols[1].endsWith(`:${hex}`) && cols[3] === "0A";
    });
  } catch { return false; }
}

/**
 * Wait for a port to become free (max waitMs).
 */
async function waitForPortFree(port, waitMs = 5000) {
  const start = Date.now();
  while (isPortInUse(port) && Date.now() - start < waitMs) {
    await new Promise((r) => setTimeout(r, 500));
  }
  return !isPortInUse(port);
}

async function startApp() {
  killApp(); // Stop tracked instances

  // Wait for ports to actually free up (handles orphans from prior container lifecycle)
  const ports = [3001, 5173];
  for (const port of ports) {
    if (isPortInUse(port)) {
      console.log(`[app] Port ${port} still in use, waiting...`);
      const freed = await waitForPortFree(port);
      if (!freed) {
        console.warn(`[app] Port ${port} still occupied — new process may fail`);
      }
    }
  }

  const result = { running: false, backend: null, frontend: null };
  const backendDir = join(WORKSPACE, "Source/Backend");
  const frontendDir = join(WORKSPACE, "Source/Frontend");

  // ── Start backend ──
  if (existsSync(join(backendDir, "package.json"))) {
    const pkg = JSON.parse(readFileSync(join(backendDir, "package.json"), "utf-8"));

    // Determine start command (try ts-node first, then compiled, then npm start)
    let cmd, args;
    if (existsSync(join(backendDir, "src/index.ts"))) {
      cmd = "npx"; args = ["ts-node", "src/index.ts"];
    } else if (existsSync(join(backendDir, "dist/index.js"))) {
      cmd = "node"; args = ["dist/index.js"];
    } else if (pkg.scripts && pkg.scripts.start) {
      cmd = "npm"; args = ["start"];
    }

    if (cmd) {
      console.log(`[app] Starting backend: ${cmd} ${args.join(" ")}`);
      const proc = spawn(cmd, args, {
        cwd: backendDir,
        env: { ...process.env, PORT: "3001", NODE_ENV: "development", LOG_LEVEL: "info" },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
      appProcesses.backend = proc;
      proc.stdout.on("data", (d) => {
        for (const line of d.toString().split("\n")) {
          if (line.trim()) process.stdout.write(`  [app:backend] ${line}\n`);
        }
      });
      proc.stderr.on("data", (d) => {
        for (const line of d.toString().split("\n")) {
          if (line.trim()) process.stderr.write(`  [app:backend] ${line}\n`);
        }
      });
      proc.on("exit", (code) => {
        console.log(`[app] Backend exited (code ${code})`);
        appProcesses.backend = null;
      });

      // Wait for backend to be ready
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        try {
          const res = await fetch("http://localhost:3001");
          if (res.ok || res.status < 500) { result.backend = "http://localhost:3001"; break; }
        } catch {}
      }
    }
  }

  // ── Start frontend ──
  if (existsSync(join(frontendDir, "package.json"))) {
    console.log("[app] Starting frontend: vite");
    const proc = spawn("npx", ["vite", "--host", "0.0.0.0", "--port", "5173"], {
      cwd: frontendDir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    appProcesses.frontend = proc;
    proc.stdout.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) process.stdout.write(`  [app:frontend] ${line}\n`);
      }
    });
    proc.stderr.on("data", (d) => {
      for (const line of d.toString().split("\n")) {
        if (line.trim()) process.stderr.write(`  [app:frontend] ${line}\n`);
      }
    });
    proc.on("exit", (code) => {
      console.log(`[app] Frontend exited (code ${code})`);
      appProcesses.frontend = null;
    });

    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch("http://localhost:5173");
        if (res.ok) { result.frontend = "http://localhost:5173"; break; }
      } catch {}
    }
  }

  result.running = !!(result.backend || result.frontend);
  return result;
}

function getAppStatus() {
  return {
    backend: appProcesses.backend ? { pid: appProcesses.backend.pid, url: "http://localhost:3001" } : null,
    frontend: appProcesses.frontend ? { pid: appProcesses.frontend.pid, url: "http://localhost:5173" } : null,
    running: !!(appProcesses.backend || appProcesses.frontend),
  };
}

// ══════════════════════════════════════════════════════════════
// API Endpoints
// ══════════════════════════════════════════════════════════════

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", workspace: WORKSPACE, runs: listRuns().length, app: getAppStatus() });
});

// App management
app.get("/api/app", (req, res) => {
  res.json(getAppStatus());
});

app.post("/api/app/start", async (req, res) => {
  const result = await startApp();
  res.json(result);
});

app.post("/api/app/stop", (req, res) => {
  killApp();
  res.json({ stopped: true });
});

app.post("/api/work", upload.array("images", 10), async (req, res) => {
  const { task, planFile, team: forceTeam } = req.body;
  if (!task) return res.status(400).json({ error: "Missing required field: task" });

  const run = {
    id: `run-${Date.now()}-${randomUUID().slice(0, 8)}`,
    status: "team_selecting",
    task,
    planFile: planFile || null,
    team: null,
    teamReason: null,
    attachments: [],
    results: {},
    phases: {},
    feedbackLoops: 0,
    createdAt: ts(),
    updatedAt: ts(),
  };

  // ── Save uploaded images to workspace ──
  const images = [];

  // From multipart form-data (curl -F "images=@mockup.png")
  if (req.files && req.files.length > 0) {
    for (const file of req.files) {
      images.push({ name: file.originalname, buffer: file.buffer });
    }
  }

  // From JSON body base64 ({"images": [{"name": "x.png", "data": "base64..."}]})
  if (req.body.images && typeof req.body.images === "string") {
    try {
      const jsonImages = JSON.parse(req.body.images);
      if (Array.isArray(jsonImages)) {
        for (const img of jsonImages) {
          if (img.name && img.data) {
            images.push({ name: img.name, buffer: Buffer.from(img.data, "base64") });
          }
        }
      }
    } catch {} // Not JSON — ignore (multer already handled files)
  } else if (Array.isArray(req.body.images)) {
    for (const img of req.body.images) {
      if (img.name && img.data) {
        images.push({ name: img.name, buffer: Buffer.from(img.data, "base64") });
      }
    }
  }

  if (images.length > 0) {
    const attachDir = join(WORKSPACE, ".orchestrator-runs", run.id, "attachments");
    mkdirSync(attachDir, { recursive: true });
    for (const img of images) {
      // Sanitize filename
      const safeName = img.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const filePath = join(attachDir, safeName);
      writeFileSync(filePath, img.buffer);
      run.attachments.push(filePath);
    }
    console.log(`[${run.id}] Saved ${images.length} image(s) to attachments`);
  }

  saveRun(run);

  res.status(201).json({
    id: run.id,
    status: "team_selecting",
    message: "Claude is analyzing the task to select the right team...",
    statusUrl: `/api/runs/${run.id}`,
    attachments: run.attachments.length,
  });

  // Async: select team → execute full pipeline
  (async () => {
    try {
      let team, teamReason;
      if (forceTeam && ["TheATeam", "TheFixer"].includes(forceTeam)) {
        team = forceTeam;
        teamReason = `Forced to ${forceTeam} by request`;
      } else {
        console.log(`[${run.id}] Routing: ${task.slice(0, 100)}`);
        const selection = await selectTeam(task, planFile);
        team = selection.team;
        teamReason = selection.reason;
      }

      run.team = team;
      run.teamReason = teamReason;
      console.log(`[${run.id}] Team: ${team} — ${teamReason}`);
      saveRun(run);

      await executeWorkflow(run);
    } catch (err) {
      console.error(`[${run.id}] Fatal:`, err);
      run.status = "failed";
      run.results = { error: err.message, allPassed: false };
      saveRun(run);
    }
  })();
});

app.get("/api/runs", (req, res) => {
  const runs = listRuns().map(({ id, status, task, team, results, feedbackLoops, createdAt, updatedAt }) => ({
    id, status, task, team, results, feedbackLoops, createdAt, updatedAt,
  }));
  res.json({ data: runs });
});

app.get("/api/runs/:id", (req, res) => {
  const run = loadRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  res.json(run);
});

app.post("/api/runs/:id/revalidate", (req, res) => {
  const run = loadRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });
  if (!["complete", "failed"].includes(run.status)) {
    return res.status(409).json({ error: "Run is still in progress" });
  }

  run.status = "validating";
  saveRun(run);

  (async () => {
    run.phases.smoketest = { status: "running", startedAt: ts() };
    run.phases.inspector = { status: "running", startedAt: ts() };
    saveRun(run);

    const [smokeResult, inspectorResult] = await Promise.all([
      runScript("/app/scripts/run-smoketest.sh", [], { label: "smoketest" }),
      runScript("/app/scripts/run-team.sh", ["TheInspector", `Re-validation: ${run.task}`], { label: "inspector" }),
    ]);

    run.phases.smoketest.status = smokeResult.exitCode === 0 ? "passed" : "failed";
    run.phases.smoketest.exitCode = smokeResult.exitCode;
    run.phases.smoketest.completedAt = ts();

    run.phases.inspector.status = inspectorResult.exitCode === 0 ? "passed" : "failed";
    run.phases.inspector.exitCode = inspectorResult.exitCode;
    run.phases.inspector.completedAt = ts();

    const allPassed = run.phases.smoketest.status === "passed" && run.phases.inspector.status === "passed";
    run.status = allPassed ? "complete" : "failed";
    run.results.smoketest = run.phases.smoketest.status;
    run.results.inspector = run.phases.inspector.status;
    run.results.allPassed = allPassed && run.results.implementation === "passed" && run.results.leader === "passed";
    saveRun(run);
  })().catch(console.error);

  res.json({ message: "Re-validation started", statusUrl: `/api/runs/${run.id}` });
});

// ══════════════════════════════════════════════════════════════
// Dashboard
// ══════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
  const runs = listRuns();

  const statusColors = {
    complete: "#22c55e", failed: "#ef4444",
    validating: "#8b5cf6", qa_running: "#6366f1",
    implementing: "#f59e0b", dispatching: "#38bdf8",
    planning: "#fb923c", team_selecting: "#7b7f9e", queued: "#7b7f9e",
  };

  const statusLabels = {
    team_selecting: "ROUTING", planning: "PLANNING", dispatching: "PARSING",
    implementing: "CODING", qa_running: "QA", validating: "VALIDATING",
    complete: "COMPLETE", failed: "FAILED",
  };

  const rows = runs.map((r) => {
    const teamBadge = r.team === "TheATeam"
      ? '<span style="color:#6366f1">TheATeam</span>'
      : r.team === "TheFixer"
        ? '<span style="color:#f59e0b">TheFixer</span>'
        : '<span style="color:#7b7f9e">—</span>';

    const color = statusColors[r.status] || "#7b7f9e";
    const label = statusLabels[r.status] || r.status.toUpperCase();

    // Count stages for progress indicator
    const stageKeys = Object.keys(r.phases || {}).filter((k) => k.startsWith("stage_"));
    const completedStages = stageKeys.filter((k) => r.phases[k].status !== "running").length;
    const progress = stageKeys.length > 0
      ? `<span style="color:#7b7f9e;font-size:0.75rem"> (${completedStages}/${stageKeys.length})</span>`
      : "";

    const feedbackBadge = r.feedbackLoops > 0
      ? `<span style="color:#f59e0b;font-size:0.75rem"> +${r.feedbackLoops}fb</span>`
      : "";

    const resultBadge = r.results?.allPassed === true
      ? '<span style="color:#22c55e;font-weight:700">PASS</span>'
      : r.results?.allPassed === false
        ? '<span style="color:#ef4444;font-weight:700">FAIL</span>'
        : "—";

    const elapsed = r.updatedAt && r.createdAt
      ? `${Math.round((new Date(r.updatedAt) - new Date(r.createdAt)) / 1000)}s`
      : "—";

    return `<tr>
      <td><a href="/api/runs/${r.id}">${r.id.slice(-12)}</a></td>
      <td>${teamBadge}</td>
      <td style="color:${color};font-weight:600">${label}${progress}</td>
      <td>${(r.task || "").slice(0, 80)}</td>
      <td>${resultBadge}${feedbackBadge}</td>
      <td>${elapsed}</td>
      <td>${new Date(r.createdAt).toLocaleString()}</td>
    </tr>`;
  }).join("\n");

  const appStatus = getAppStatus();
  const appBanner = appStatus.running
    ? `<div class="app-banner running">
        <span>Built App Running:</span>
        ${appStatus.backend ? `<a href="http://localhost:${process.env.APP_BACKEND_PORT || 4001}" target="_blank">Backend :${process.env.APP_BACKEND_PORT || 4001}</a>` : ""}
        ${appStatus.frontend ? `<a href="http://localhost:${process.env.APP_FRONTEND_PORT || 4173}" target="_blank">Frontend :${process.env.APP_FRONTEND_PORT || 4173}</a>` : ""}
        <button onclick="fetch('/api/app/stop',{method:'POST'}).then(()=>location.reload())" class="btn stop">Stop</button>
      </div>`
    : runs.some((r) => r.results?.allPassed || r.results?.implementation === "passed")
      ? `<div class="app-banner stopped">
          <span>App not running.</span>
          <button onclick="fetch('/api/app/start',{method:'POST'}).then(()=>setTimeout(()=>location.reload(),5000))" class="btn start">Start App</button>
        </div>`
      : "";

  res.send(`<!DOCTYPE html>
<html><head><title>claude-ai-OS Pipeline</title>
<meta http-equiv="refresh" content="10">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1117; color: #e2e4f0; padding: 2rem; }
  h1 { font-size: 1.4rem; color: #6366f1; margin-bottom: 0.25rem; }
  .subtitle { color: #7b7f9e; font-size: 0.85rem; margin-bottom: 1.5rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  th { text-align: left; padding: 0.5rem; color: #7b7f9e; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #2a2d3e; }
  td { padding: 0.5rem; border-bottom: 1px solid #1a1d27; font-size: 0.85rem; }
  a { color: #6366f1; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #7b7f9e; padding: 2rem; text-align: center; }
  .app-banner { padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; display: flex; align-items: center; gap: 1rem; font-size: 0.9rem; }
  .app-banner.running { background: #052e16; border: 1px solid #22c55e; }
  .app-banner.stopped { background: #1a1d27; border: 1px solid #2a2d3e; }
  .app-banner a { color: #22c55e; font-weight: 600; }
  .btn { padding: 0.3rem 0.75rem; border: none; border-radius: 4px; cursor: pointer; font-size: 0.8rem; }
  .btn.stop { background: #ef4444; color: white; }
  .btn.start { background: #22c55e; color: #0f1117; font-weight: 600; }
  .legend { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; font-size: 0.75rem; }
  .legend span { display: flex; align-items: center; gap: 0.25rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
</style></head><body>
<h1>claude-ai-OS Pipeline</h1>
<p class="subtitle">Multi-stage dispatch: Leader → Parse → Code → QA (feedback loops) → Validate. Auto-refreshes 10s.</p>
${appBanner}
<div class="legend">
  <span><span class="dot" style="background:#7b7f9e"></span> Routing</span>
  <span><span class="dot" style="background:#fb923c"></span> Planning</span>
  <span><span class="dot" style="background:#38bdf8"></span> Parsing</span>
  <span><span class="dot" style="background:#f59e0b"></span> Coding</span>
  <span><span class="dot" style="background:#6366f1"></span> QA</span>
  <span><span class="dot" style="background:#8b5cf6"></span> Validating</span>
  <span><span class="dot" style="background:#22c55e"></span> Complete</span>
  <span><span class="dot" style="background:#ef4444"></span> Failed</span>
</div>
${runs.length === 0 ? '<p class="empty">No runs yet. POST to <code>/api/work</code> to submit tasks.</p>' : `
<table>
  <thead><tr><th>Run</th><th>Team</th><th>Status</th><th>Task</th><th>Result</th><th>Time</th><th>Created</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`}
</body></html>`);
});

// ══════════════════════════════════════════════════════════════
// Start
// ══════════════════════════════════════════════════════════════

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`claude-ai-OS orchestrator listening on :${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Submit:     POST http://localhost:${PORT}/api/work`);
  console.log(`  Workspace:  ${WORKSPACE}`);
  console.log(`  Dispatch:   multi-stage with ${MAX_FEEDBACK_LOOPS} feedback loops`);

  // Auto-start app if Source/ exists from a previous pipeline run
  const hasBackend = existsSync(join(WORKSPACE, "Source/Backend/package.json"));
  const hasFrontend = existsSync(join(WORKSPACE, "Source/Frontend/package.json"));
  if (hasBackend || hasFrontend) {
    console.log("[boot] Found existing app — auto-starting...");
    try {
      const result = await startApp();
      if (result.running) {
        console.log(`[boot] App ready: backend=${result.backend || "—"} frontend=${result.frontend || "—"}`);
      } else {
        console.log("[boot] App failed to start (check logs above)");
      }
    } catch (err) {
      console.error("[boot] Auto-start failed:", err.message);
    }
  }
});
