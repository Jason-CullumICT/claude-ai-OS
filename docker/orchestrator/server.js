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
 *   GET  /api/cycles            — list active cycles
 *   GET  /api/cycles/:id        — cycle detail
 *   POST /api/cycles/:id/stop   — stop a running cycle
 *   POST /api/cycles/:id/cleanup — remove volume + branch + container
 *   GET  /api/cycles/:id/logs   — SSE streaming container logs
 *   POST /api/worker-image/rebuild — rebuild worker Docker image
 *   GET  /api/health            — health check
 *   GET  /                      — live dashboard
 */

const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } = require("fs");
const { join } = require("path");
const { randomUUID } = require("crypto");

// ══════════════════════════════════════════════════════════════
// Lib Modules
// ══════════════════════════════════════════════════════════════

const config = require("./lib/config");
const { DockerClient } = require("./lib/docker-client");
const { PortAllocator } = require("./lib/port-allocator");
const { CycleRegistry } = require("./lib/cycle-registry");
const { TokenPool } = require("./lib/token-pool");
const { ContainerManager } = require("./lib/container-manager");
const { LearningsSync } = require("./lib/learnings-sync");
const { HealthMonitor } = require("./lib/health-monitor");
const { WorkflowEngine } = require("./lib/workflow-engine");
const { createDispatcher } = require("./lib/dispatch");

const dockerClient = new DockerClient();
const portAllocator = new PortAllocator();
const cycleRegistry = new CycleRegistry();
const tokenPool = new TokenPool();
const containerManager = new ContainerManager(dockerClient, portAllocator, tokenPool);
const learningsSync = new LearningsSync();
const healthMonitor = new HealthMonitor(dockerClient, cycleRegistry, portAllocator);

// ══════════════════════════════════════════════════════════════
// Express Setup
// ══════════════════════════════════════════════════════════════

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

const RUNS_DIR = join(config.workspace, ".orchestrator-runs");
if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });

// Workflow engine — initialized in app.listen after Docker init
let workflowEngine = null;
function setWorkflowEngine(engine) { workflowEngine = engine; }

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
      cwd: config.workspace,
      env: { ...process.env, WORKSPACE_DIR: config.workspace },
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
// Dispatch Plan Parsing (extracted to lib/dispatch.js)
// ══════════════════════════════════════════════════════════════

const dispatch = createDispatcher(runClaude, config.workspace);

// ══════════════════════════════════════════════════════════════
// API Endpoints
// ══════════════════════════════════════════════════════════════

// ── Health ──

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    workspace: config.workspace,
    runs: listRuns().length,
    docker: dockerClient ? dockerClient.available : false,
    cycles: cycleRegistry ? cycleRegistry.getStatus() : null,
    ports: portAllocator ? portAllocator.getStatus() : null,
    tokens: tokenPool ? tokenPool.getStatus() : null,
    diskPressure: healthMonitor ? healthMonitor.isDiskPressured() : false,
  });
});

// ── Work Submission ──

app.post("/api/work", upload.array("images", 10), async (req, res) => {
  if (!workflowEngine) {
    return res.status(503).json({ error: "Orchestrator not initialized — Docker not available" });
  }

  const { task, planFile, team: forceTeam, repo, repoBranch, claudeSessionToken, tokenLabel } = req.body;
  if (!task) return res.status(400).json({ error: "Missing required field: task" });

  // Resolve Claude session token using priority chain: per-request → host → env
  let resolvedToken = null;
  try {
    resolvedToken = await tokenPool.resolveToken(claudeSessionToken, tokenLabel);
  } catch (err) {
    console.error(`[${Date.now()}] Token resolution failed: ${err.message}`);
  }

  const run = {
    id: `run-${Date.now()}-${randomUUID().slice(0, 8)}`,
    status: "team_selecting",
    task,
    planFile: planFile || null,
    repo: repo || config.githubRepo,           // per-task repo override
    repoBranch: repoBranch || config.githubBranch, // per-task branch override
    tokenSource: resolvedToken?.source || "none",
    tokenLabel: resolvedToken?.label || "no token",
    team: null,
    teamReason: null,
    attachments: [],
    ports: null,
    branch: null,
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
    const attachDir = join(config.workspace, ".orchestrator-runs", run.id, "attachments");
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
    ports: run.ports,
    branch: run.branch,
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

      await workflowEngine.executeWorkflow(run, saveRun, resolvedToken);
    } catch (err) {
      console.error(`[${run.id}] Fatal:`, err);
      run.status = "failed";
      run.results = { error: err.message, allPassed: false };
      saveRun(run);
    }
  })();
});

// ── Runs ──

// Verifies: FR-TMP-009 — include riskLevel, e2e, and pr in run list responses
app.get("/api/runs", (req, res) => {
  const runs = listRuns().map(({ id, status, task, team, results, feedbackLoops, riskLevel, e2e, pr, createdAt, updatedAt }) => ({
    id, status, task, team, results, feedbackLoops, riskLevel, e2e, pr, createdAt, updatedAt,
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

// ── Cycles ──

app.get("/api/cycles", (req, res) => {
  const cycles = cycleRegistry.getAll().map((c) => ({
    id: c.id,
    status: c.status,
    team: c.team,
    branch: c.branch,
    ports: c.ports,
    appRunning: c.appRunning,
    currentPhase: c.currentPhase,
    startedAt: c.startedAt,
  }));
  res.json({ data: cycles });
});

app.get("/api/cycles/:id", (req, res) => {
  const cycle = cycleRegistry.get(req.params.id);
  if (!cycle) return res.status(404).json({ error: "Cycle not found" });
  res.json(cycle);
});

app.post("/api/cycles/:id/stop", async (req, res) => {
  const cycle = cycleRegistry.get(req.params.id);
  if (!cycle) return res.status(404).json({ error: "Cycle not found" });
  try {
    await containerManager.teardown(req.params.id, { keepVolume: true, keepBranch: true });
    cycleRegistry.update(req.params.id, { status: "failed", appRunning: false });
    res.json({ stopped: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/cycles/:id/cleanup", async (req, res) => {
  const cycle = cycleRegistry.get(req.params.id);
  if (!cycle) return res.status(404).json({ error: "Cycle not found" });
  try {
    await containerManager.teardown(req.params.id, { keepVolume: false, keepBranch: false });
    cycleRegistry.remove(req.params.id);
    res.json({ cleaned: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a run — removes JSON file, volume, branch, and cycle registry entry.
// Works for any run (active, completed, or failed) regardless of cycle state.
app.delete("/api/runs/:id", async (req, res) => {
  const run = loadRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found" });

  const cleaned = { run: false, volume: false, branch: false, cycle: false };

  // Stop and clean up container/volume/branch if they exist
  try {
    await containerManager.teardown(req.params.id, { keepVolume: false, keepBranch: false });
    cleaned.volume = true;
    cleaned.branch = true;
  } catch (err) {
    // Container/volume may already be gone — that's fine
    console.log(`[runs] Cleanup for ${req.params.id}: ${err.message}`);
  }

  // Remove from cycle registry
  try {
    cycleRegistry.remove(req.params.id);
    cleaned.cycle = true;
  } catch (err) {
    console.log(`[runs] Cycle registry removal for ${req.params.id}: ${err.message}`);
  }

  // Delete the run JSON file
  try {
    const { unlinkSync } = require("fs");
    unlinkSync(join(RUNS_DIR, `${req.params.id}.json`));
    cleaned.run = true;
  } catch (err) {
    console.warn(`[runs] Could not delete run file: ${err.message}`);
  }

  console.log(`[runs] Deleted ${req.params.id}: ${JSON.stringify(cleaned)}`);
  res.json({ deleted: true, cleaned });
});

app.get("/api/cycles/:id/logs", async (req, res) => {
  const cycle = cycleRegistry.get(req.params.id);
  if (!cycle || !cycle.containerId) return res.status(404).json({ error: "Cycle not found" });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  try {
    const logStream = await dockerClient.getContainerLogs(cycle.containerId, true);
    logStream.on("data", (chunk) => {
      res.write(`data: ${chunk.toString().replace(/\n/g, "\ndata: ")}\n\n`);
    });
    logStream.on("end", () => res.end());
    req.on("close", () => { try { logStream.destroy(); } catch {} });
  } catch (err) {
    res.write(`data: Error: ${err.message}\n\n`);
    res.end();
  }
});

// ── Retry ──

app.post("/api/runs/:id/retry", async (req, res) => {
  if (!workflowEngine) {
    return res.status(503).json({ error: "Orchestrator not initialized" });
  }

  const originalRun = loadRun(req.params.id);
  if (!originalRun) return res.status(404).json({ error: "Run not found" });
  if (!["failed"].includes(originalRun.status)) {
    return res.status(409).json({ error: "Only failed runs can be retried" });
  }

  const existingVolume = `workspace-${originalRun.id}`;

  // Create a new run based on the original
  const run = {
    id: `run-${Date.now()}-${randomUUID().slice(0, 8)}`,
    status: "team_selecting",
    task: originalRun.task,
    planFile: originalRun.planFile,
    repo: originalRun.repo,
    repoBranch: originalRun.repoBranch,
    team: null,
    teamReason: null,
    attachments: originalRun.attachments || [],
    ports: null,
    branch: null,
    results: {},
    phases: {},
    feedbackLoops: 0,
    retryOf: originalRun.id,
    reuseVolume: existingVolume,
    createdAt: ts(),
    updatedAt: ts(),
  };
  saveRun(run);

  res.status(201).json({
    id: run.id,
    status: "team_selecting",
    message: `Retrying failed run ${originalRun.id} with existing volume...`,
    statusUrl: `/api/runs/${run.id}`,
    retryOf: originalRun.id,
  });

  // Async: route and execute
  (async () => {
    try {
      let team, teamReason;
      const forceTeam = req.body?.team;
      if (forceTeam && ["TheATeam", "TheFixer"].includes(forceTeam)) {
        team = forceTeam;
        teamReason = `Forced to ${forceTeam} by retry request`;
      } else if (originalRun.team) {
        team = originalRun.team;
        teamReason = `Same team as original run: ${originalRun.teamReason}`;
      } else {
        const selection = await selectTeam(run.task, run.planFile);
        team = selection.team;
        teamReason = selection.reason;
      }

      run.team = team;
      run.teamReason = teamReason;
      console.log(`[${run.id}] Retry of ${originalRun.id} — Team: ${team}`);
      saveRun(run);

      // Retries re-resolve token (per-request token not persisted, falls back to host/env)
      const retryToken = await tokenPool.resolveToken();
      run.tokenSource = retryToken?.source || "none";
      run.tokenLabel = retryToken?.label || "no token";
      saveRun(run);

      await workflowEngine.executeWorkflow(run, saveRun, retryToken);
    } catch (err) {
      console.error(`[${run.id}] Retry fatal:`, err);
      run.status = "failed";
      run.results = { error: err.message, allPassed: false };
      saveRun(run);
    }
  })();
});

// ── Worker Image ──

app.post("/api/worker-image/rebuild", async (req, res) => {
  try {
    await containerManager.ensureWorkerImage(true);
    res.json({ rebuilt: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Repo Validation & Creation ──

/**
 * Validate a GitHub repo exists, or create it if it doesn't.
 * Used by both the /api/repos/validate endpoint and the workflow engine.
 *
 * @param {string} repoInput — full URL or owner/name shorthand
 * @returns {{ exists: boolean, created: boolean, repo: string, fullName: string }}
 * @throws {Error} on validation/creation failure
 */
async function validateOrCreateRepo(repoInput) {
  const repoMatch = repoInput.match(/(?:github\.com\/)?([^\/]+\/[^\/\s]+?)(?:\.git)?$/);
  if (!repoMatch) throw new Error("Invalid repo format. Use owner/repo or full GitHub URL.");
  const fullName = repoMatch[1];

  const token = config.githubToken;
  if (!token) throw new Error("GITHUB_TOKEN not configured");

  const headers = { Authorization: `token ${token}`, Accept: "application/vnd.github.v3+json" };

  // Check if repo exists via GitHub API
  const checkResp = await fetch(`https://api.github.com/repos/${fullName}`, { headers });
  if (checkResp.ok) {
    return { exists: true, created: false, repo: `https://github.com/${fullName}`, fullName };
  }

  if (checkResp.status !== 404) {
    throw new Error(`GitHub API error: ${checkResp.status}`);
  }

  // Repo doesn't exist — create it
  console.log(`[repos] Creating repo ${fullName}...`);
  const [owner, repoName] = fullName.split("/");

  // Try org create first, fall back to user create
  let createResp = await fetch(`https://api.github.com/orgs/${owner}/repos`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name: repoName, auto_init: true }),
  });

  if (!createResp.ok && createResp.status === 404) {
    // Not an org — create as user repo
    createResp = await fetch(`https://api.github.com/user/repos`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: repoName, auto_init: true }),
    });
  }

  if (!createResp.ok) {
    const errBody = await createResp.json();
    throw new Error(`Failed to create repo: ${errBody.message || JSON.stringify(errBody)}`);
  }

  console.log(`[repos] Created: ${fullName}`);
  return { exists: false, created: true, repo: `https://github.com/${fullName}`, fullName };
}

app.post("/api/repos/validate", async (req, res) => {
  const { repo } = req.body;
  if (!repo) return res.status(400).json({ error: "Missing field: repo" });

  try {
    const result = await validateOrCreateRepo(repo);
    return res.json(result);
  } catch (err) {
    console.error(`[repos] Validation/creation failed:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/repos/list", (req, res) => {
  // Return known repos — can be extended to scan GitHub later
  const knownRepos = [
    { name: "container-test", fullName: "Jason-CullumICT/container-test", url: "https://github.com/Jason-CullumICT/container-test" },
    { name: "claude-ai-OS", fullName: "Jason-CullumICT/claude-ai-OS", url: "https://github.com/Jason-CullumICT/claude-ai-OS" },
  ];
  res.json({ data: knownRepos });
});

// ── Portal Update ──

app.post("/api/portal/update", async (req, res) => {
  // Pull latest code into the portal container and restart backend
  try {
    const { execFileSync } = require("child_process");

    // Find the portal container
    const containers = await dockerClient.listContainers({ name: ["portal"] });
    const portal = containers.find((c) => c.Names.some((n) => n.includes("portal")));
    if (!portal) {
      return res.status(404).json({ error: "Portal container not found" });
    }

    const portalId = portal.Id;
    console.log(`[portal] Updating portal (${portalId.slice(0, 12)})...`);

    // Pull latest
    const pullResult = await dockerClient.execInContainer(
      portalId, "bash", ["-c",
        "cd /app && git checkout -- . && git clean -fd 2>/dev/null && git pull origin master 2>&1"
      ],
      { label: "portal-update", quiet: true }
    );
    console.log(`[portal] Git pull: ${pullResult.stdout.trim().split("\\n").pop()}`);

    // Install deps if package.json changed
    await dockerClient.execInContainer(
      portalId, "bash", ["-c",
        "cd /app/Source/Backend && npm install --production=false 2>/dev/null; cd /app/Source/Frontend && npm install --production=false 2>/dev/null"
      ],
      { label: "portal-deps", quiet: true }
    );

    // Kill old backend process and restart
    await dockerClient.execInContainer(
      portalId, "bash", ["-c",
        "pkill -f 'ts-node\\|node.*index\\|node.*server' 2>/dev/null || true"
      ],
      { label: "portal-restart", quiet: true }
    );

    // Start backend fresh
    dockerClient.execInContainer(
      portalId, "bash", ["-c",
        `cd /app/Source/Backend && ENTRY=$(
          if [ -f src/index.ts ]; then echo "npx ts-node src/index.ts";
          elif [ -f src/server.ts ]; then echo "npx ts-node src/server.ts";
          elif [ -f dist/index.js ]; then echo "node dist/index.js";
          else echo "npm start"; fi
        ) && nohup $ENTRY > /tmp/backend.log 2>&1 & disown`
      ],
      { label: "portal-backend", quiet: true }
    ).catch((err) => {
      console.error(`[portal] Backend restart failed: ${err.message}`);
    });

    // Frontend (Vite) hot-reloads automatically — no restart needed

    console.log("[portal] Update complete");
    res.json({
      updated: true,
      pull: pullResult.stdout.trim().split("\n").pop(),
    });
  } catch (err) {
    console.error("[portal] Update failed:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// Dashboard
// ══════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
  const runs = listRuns();
  const cycles = cycleRegistry.getAll();

  const statusColors = {
    complete: "#22c55e", failed: "#ef4444",
    validating: "#8b5cf6", qa_running: "#6366f1",
    implementing: "#f59e0b", dispatching: "#38bdf8",
    planning: "#fb923c", team_selecting: "#7b7f9e", queued: "#7b7f9e",
    pending: "#7b7f9e", interrupted: "#ef4444",
  };

  const statusLabels = {
    team_selecting: "ROUTING", planning: "PLANNING", dispatching: "PARSING",
    implementing: "CODING", qa_running: "QA", validating: "VALIDATING",
    complete: "COMPLETE", failed: "FAILED",
    pending: "PENDING", interrupted: "INTERRUPTED",
  };

  // ── Active Cycles Panel ──
  const cycleRows = cycles
    .filter((c) => !["complete", "failed"].includes(c.status))
    .map((c) => {
      const color = statusColors[c.status] || "#7b7f9e";
      const label = statusLabels[c.status] || c.status.toUpperCase();
      const teamBadge = c.team === "TheATeam"
        ? '<span style="color:#6366f1">TheATeam</span>'
        : c.team === "TheFixer"
          ? '<span style="color:#f59e0b">TheFixer</span>'
          : '<span style="color:#7b7f9e">--</span>';

      // Find the corresponding run for the task text
      const run = runs.find((r) => r.id === c.id);
      const taskText = run ? (run.task || "").slice(0, 60) : "";

      // App link — constructed client-side via inline JS
      const appLink = c.ports && c.appRunning
        ? `<a class="app-link" data-port="${c.ports.frontend}" href="#" onclick="window.open('http://'+location.hostname+':${c.ports.frontend}','_blank');return false;">[App]</a>`
        : "";

      const stopBtn = `<button class="stop-btn" onclick="fetch('/api/cycles/${c.id}/stop',{method:'POST'}).then(()=>location.reload())">[Stop]</button>`;

      return `<tr>
        <td><a href="/api/cycles/${c.id}">${c.id.slice(-12)}</a></td>
        <td>${teamBadge}</td>
        <td style="color:${color};font-weight:600">${label}</td>
        <td>${c.currentPhase || "--"}</td>
        <td>${taskText}</td>
        <td>${appLink}</td>
        <td>${stopBtn}</td>
      </tr>`;
    }).join("\n");

  const portsExhausted = portAllocator.isExhausted();
  const queueIndicator = portsExhausted
    ? '<div class="queue-banner"><span>Port slots exhausted — new cycles will queue until a slot frees up.</span></div>'
    : "";

  const activeCyclesPanel = cycles.filter((c) => !["complete", "failed"].includes(c.status)).length > 0
    ? `<div class="panel">
        <h2>Active Cycles</h2>
        ${queueIndicator}
        <table>
          <thead><tr><th>Cycle</th><th>Team</th><th>Status</th><th>Phase</th><th>Task</th><th>App</th><th>Action</th></tr></thead>
          <tbody>${cycleRows}</tbody>
        </table>
      </div>`
    : (portsExhausted ? `<div class="panel"><h2>Active Cycles</h2>${queueIndicator}<p class="empty">No active cycles.</p></div>` : "");

  // ── Runs Table ──
  const rows = runs.map((r) => {
    const teamBadge = r.team === "TheATeam"
      ? '<span style="color:#6366f1">TheATeam</span>'
      : r.team === "TheFixer"
        ? '<span style="color:#f59e0b">TheFixer</span>'
        : '<span style="color:#7b7f9e">--</span>';

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
        : "--";

    const elapsed = r.updatedAt && r.createdAt
      ? `${Math.round((new Date(r.updatedAt) - new Date(r.createdAt)) / 1000)}s`
      : "--";

    const tokenBadge = r.tokenSource === "api"
      ? `<span style="color:#22c55e" title="${r.tokenLabel || ''}">${(r.tokenLabel || "api").slice(0, 15)}</span>`
      : r.tokenSource === "host"
        ? '<span style="color:#7b7f9e">host</span>'
        : r.tokenSource === "env"
          ? '<span style="color:#f59e0b">env</span>'
          : '<span style="color:#ef4444">none</span>';

    return `<tr>
      <td><a href="/api/runs/${r.id}">${r.id.slice(-12)}</a></td>
      <td>${teamBadge}</td>
      <td style="color:${color};font-weight:600">${label}${progress}</td>
      <td>${(r.task || "").slice(0, 80)}</td>
      <td>${resultBadge}${feedbackBadge}</td>
      <td>${tokenBadge}</td>
      <td>${elapsed}</td>
      <td>${new Date(r.createdAt).toLocaleString()}</td>
    </tr>`;
  }).join("\n");

  // Engine status banner
  const engineBanner = workflowEngine
    ? '<div class="engine-banner ready"><span>Engine: Container Mode</span></div>'
    : '<div class="engine-banner offline"><span>Engine: Not initialized (Docker unavailable)</span></div>';

  // Active run app banners (apps running in worker containers)
  const appBanners = runs
    .filter((r) => r.app && r.app.running)
    .map((r) => `<div class="app-banner running">
      <span>App (${r.id.slice(-12)}):</span>
      ${r.app.backend ? `<a href="#" onclick="window.open('http://'+location.hostname+':${r.ports ? r.ports.backend : 3001}','_blank');return false;">Backend :${r.ports ? r.ports.backend : "?"}</a>` : ""}
      ${r.app.frontend ? `<a href="#" onclick="window.open('http://'+location.hostname+':${r.ports ? r.ports.frontend : 5173}','_blank');return false;">Frontend :${r.ports ? r.ports.frontend : "?"}</a>` : ""}
    </div>`)
    .join("\n");

  res.send(`<!DOCTYPE html>
<html><head><title>claude-ai-OS Pipeline</title>
<meta http-equiv="refresh" content="10">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0f1117; color: #e2e4f0; padding: 2rem; }
  h1 { font-size: 1.4rem; color: #6366f1; margin-bottom: 0.25rem; }
  h2 { font-size: 1.1rem; color: #8b5cf6; margin: 0 0 0.75rem 0; }
  .subtitle { color: #7b7f9e; font-size: 0.85rem; margin-bottom: 1.5rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 0.5rem; }
  th { text-align: left; padding: 0.5rem; color: #7b7f9e; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #2a2d3e; }
  td { padding: 0.5rem; border-bottom: 1px solid #1a1d27; font-size: 0.85rem; }
  a { color: #6366f1; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .empty { color: #7b7f9e; padding: 2rem; text-align: center; }
  .panel { background: #161822; border: 1px solid #2a2d3e; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
  .engine-banner { padding: 0.5rem 1rem; border-radius: 8px; margin-bottom: 0.5rem; font-size: 0.8rem; }
  .engine-banner.ready { background: #052e16; border: 1px solid #22c55e; color: #22c55e; }
  .engine-banner.offline { background: #1a1d27; border: 1px solid #7b7f9e; color: #7b7f9e; }
  .app-banner { padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 1rem; font-size: 0.9rem; }
  .app-banner.running { background: #052e16; border: 1px solid #22c55e; }
  .app-banner a { color: #22c55e; font-weight: 600; }
  .queue-banner { background: #451a03; border: 1px solid #f59e0b; color: #f59e0b; padding: 0.5rem 1rem; border-radius: 6px; margin-bottom: 0.5rem; font-size: 0.8rem; }
  .legend { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; font-size: 0.75rem; }
  .legend span { display: flex; align-items: center; gap: 0.25rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
  .stop-btn { background: #7f1d1d; color: #fca5a5; border: 1px solid #ef4444; border-radius: 4px; padding: 0.2rem 0.5rem; cursor: pointer; font-size: 0.75rem; }
  .stop-btn:hover { background: #991b1b; }
  .app-link { color: #22c55e; font-weight: 600; }
  .submit-form { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: flex-end; margin-bottom: 1rem; }
  .submit-form .field { display: flex; flex-direction: column; gap: 0.25rem; }
  .submit-form label { font-size: 0.7rem; color: #7b7f9e; text-transform: uppercase; letter-spacing: 0.05em; }
  .submit-form input, .submit-form select { background: #1a1d27; border: 1px solid #2a2d3e; border-radius: 4px; color: #e2e4f0; padding: 0.4rem 0.6rem; font-size: 0.85rem; }
  .submit-form input:focus { border-color: #6366f1; outline: none; }
  .submit-form input[name="task"] { min-width: 300px; }
  .submit-form input[name="claudeSessionToken"] { min-width: 200px; font-family: monospace; font-size: 0.75rem; }
  .submit-form button { background: #6366f1; color: white; border: none; border-radius: 4px; padding: 0.4rem 1rem; cursor: pointer; font-size: 0.85rem; font-weight: 600; }
  .submit-form button:hover { background: #4f46e5; }
</style></head><body>
<h1>claude-ai-OS Pipeline</h1>
<p class="subtitle">Container-based dispatch: Leader -> Parse -> Code -> QA (feedback loops) -> Validate. Auto-refreshes 10s.</p>
${engineBanner}
${appBanners}
${activeCyclesPanel}
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
<div class="panel">
  <h2>Submit Work</h2>
  <form class="submit-form" onsubmit="event.preventDefault();
    const fd = Object.fromEntries(new FormData(this));
    Object.keys(fd).forEach(k => { if(!fd[k]) delete fd[k]; });
    fetch('/api/work', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(fd)})
      .then(r=>r.json()).then(r=>{if(r.id){location.reload()}else{alert(r.error||'Failed')}})
      .catch(e=>alert(e.message));">
    <div class="field"><label>Task</label><input name="task" required placeholder="Describe the feature or bug..."></div>
    <div class="field"><label>Repo (optional)</label><input name="repo" placeholder="owner/repo or URL"></div>
    <div class="field"><label>Session Token (optional)</label><input name="claudeSessionToken" placeholder="sk-ant-oat01-..." type="password"></div>
    <div class="field"><label>Token Label</label><input name="tokenLabel" placeholder="e.g. jason's token"></div>
    <div class="field"><label>Team</label><select name="team"><option value="">Auto-route</option><option value="TheATeam">TheATeam</option><option value="TheFixer">TheFixer</option></select></div>
    <div class="field"><label>&nbsp;</label><button type="submit">Submit</button></div>
  </form>
</div>
${runs.length === 0 ? '<p class="empty">No runs yet.</p>' : `
<table>
  <thead><tr><th>Run</th><th>Team</th><th>Status</th><th>Task</th><th>Result</th><th>Token</th><th>Time</th><th>Created</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`}
</body></html>`);
});

// ══════════════════════════════════════════════════════════════
// Start
// ══════════════════════════════════════════════════════════════

app.listen(config.port, "0.0.0.0", async () => {
  console.log(`claude-ai-OS orchestrator on :${config.port}`);
  console.log(`  Dashboard: http://localhost:${config.port}`);
  console.log(`  Submit:    POST http://localhost:${config.port}/api/work`);

  // Initialize Docker
  await dockerClient.init();

  if (dockerClient.available) {
    // Check worker image
    await containerManager.ensureWorkerImage();

    // Recover state from previous runs
    const activeRuns = listRuns().filter(
      (r) => !["complete", "failed"].includes(r.status)
    );
    if (activeRuns.length > 0) {
      portAllocator.recover(activeRuns);
      await cycleRegistry.recover(activeRuns, dockerClient);
      console.log(`[boot] Recovered ${activeRuns.length} cycles`);
    }

    // Start health monitoring
    healthMonitor.start();

    // Create workflow engine with dispatch
    const engine = new WorkflowEngine({
      containerManager, cycleRegistry, learningsSync, dispatch, config,
      validateOrCreateRepo,
    });
    setWorkflowEngine(engine);

    const portStatus = portAllocator.getStatus();
    console.log(`[boot] Docker mode: ${portStatus.available} ports available`);
  } else {
    console.warn("[boot] Docker not available — submit /api/work will return 503");
  }

  // Feature portal runs as its own container (docker-compose portal service)
  // No auto-start needed here — orchestrator workspace is for the target project
});

// ══════════════════════════════════════════════════════════════
// Graceful Shutdown
// ══════════════════════════════════════════════════════════════

process.on("SIGTERM", () => {
  console.log("[shutdown] SIGTERM received — stopping health monitor...");
  healthMonitor.stop();
  learningsSync.cleanup();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[shutdown] SIGINT received — stopping health monitor...");
  healthMonitor.stop();
  learningsSync.cleanup();
  process.exit(0);
});

// Export for testing
module.exports = { app, setWorkflowEngine };
