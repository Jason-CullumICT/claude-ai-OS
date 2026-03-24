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
const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } = require("fs");
const { join } = require("path");
const { randomUUID } = require("crypto");
const { createDispatcher } = require("./lib/dispatch");
const { WorkflowEngine } = require("./lib/workflow-engine");

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
// Dispatch Plan Parsing (extracted to lib/dispatch.js)
// ══════════════════════════════════════════════════════════════

const dispatch = createDispatcher(runClaude, WORKSPACE);

// Workflow engine — initialized by Task 12 (container bootstrap).
// Until then, POST /api/work returns 503.
let workflowEngine = null;

// ══════════════════════════════════════════════════════════════
// API Endpoints
// ══════════════════════════════════════════════════════════════

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    workspace: WORKSPACE,
    runs: listRuns().length,
    engineReady: !!workflowEngine,
  });
});

app.post("/api/work", upload.array("images", 10), async (req, res) => {
  if (!workflowEngine) {
    return res.status(503).json({ error: "Orchestrator not initialized — Docker not available" });
  }

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

      await workflowEngine.executeWorkflow(run, saveRun);
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

  // Engine status banner
  const engineBanner = workflowEngine
    ? '<div class="engine-banner ready"><span>Engine: Container Mode</span></div>'
    : '<div class="engine-banner offline"><span>Engine: Not initialized (Docker unavailable)</span></div>';

  // Active run app banners (apps running in worker containers)
  const appBanners = runs
    .filter((r) => r.app && r.app.running)
    .map((r) => `<div class="app-banner running">
      <span>App (${r.id.slice(-12)}):</span>
      ${r.app.backend ? `<a href="${r.app.backend}" target="_blank">Backend ${r.app.backend}</a>` : ""}
      ${r.app.frontend ? `<a href="${r.app.frontend}" target="_blank">Frontend ${r.app.frontend}</a>` : ""}
    </div>`)
    .join("\n");

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
  .engine-banner { padding: 0.5rem 1rem; border-radius: 8px; margin-bottom: 0.5rem; font-size: 0.8rem; }
  .engine-banner.ready { background: #052e16; border: 1px solid #22c55e; color: #22c55e; }
  .engine-banner.offline { background: #1a1d27; border: 1px solid #7b7f9e; color: #7b7f9e; }
  .app-banner { padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 0.5rem; display: flex; align-items: center; gap: 1rem; font-size: 0.9rem; }
  .app-banner.running { background: #052e16; border: 1px solid #22c55e; }
  .app-banner a { color: #22c55e; font-weight: 600; }
  .legend { display: flex; gap: 1rem; flex-wrap: wrap; margin: 1rem 0; font-size: 0.75rem; }
  .legend span { display: flex; align-items: center; gap: 0.25rem; }
  .dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
</style></head><body>
<h1>claude-ai-OS Pipeline</h1>
<p class="subtitle">Container-based dispatch: Leader -> Parse -> Code -> QA (feedback loops) -> Validate. Auto-refreshes 10s.</p>
${engineBanner}
${appBanners}
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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`claude-ai-OS orchestrator listening on :${PORT}`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Submit:     POST http://localhost:${PORT}/api/work`);
  console.log(`  Workspace:  ${WORKSPACE}`);
  console.log(`  Engine:     ${workflowEngine ? "container mode" : "not initialized (Task 12 wires it up)"}`);
});

// Export for Task 12 integration — allows setting the engine after Docker init
module.exports = { app, setWorkflowEngine: (engine) => { workflowEngine = engine; } };
