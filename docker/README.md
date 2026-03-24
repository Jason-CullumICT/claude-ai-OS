# claude-ai-OS Docker

Run Claude Code agent teams in containers with an HTTP orchestrator.

## Architecture — Multi-Stage Dispatch Pipeline

```
External Trigger (curl / webhook / CI)
       │
       ▼
┌──────────────────────────────────────────┐
│  Orchestrator  :9800                     │
│  POST /api/work → Claude decides team    │
│  GET  /api/runs → per-agent detail       │
│  GET  /         → live dashboard         │
└────────────┬─────────────────────────────┘
             │
    Phase 1: Team Leader (produces plan)
             │
     ┌───────┴───────┐
     ▼               ▼
  TheATeam        TheFixer
  (features)      (bugs only)
     └───────┬───────┘
             │
    Phase 2: Dispatch Plan Parser
             │  Claude extracts structured
             │  JSON stages from leader output
             ▼
    Phase 3: Implementation Agents
             │
     ┌───────┼───────┐
     ▼       ▼       ▼
  backend  frontend  (parallel
  -coder   -coder    or sequential)
     └───────┼───────┘
             │
    Phase 4: QA Agents
             │
     ┌───────┼───────┐
     ▼       ▼       ▼
  qa-review security traceability
     └───────┼───────┘
             │
        ╔════╧════╗
        ║ QA fail?║──yes──▶ Feedback loop (max 2)
        ║         ║        Re-run coders with QA output
        ╚════╤════╝        Then re-run QA
             │
    Phase 5: Final Validation (parallel)
             │
     ┌───────┴───────┐
     ▼               ▼
  Playwright      TheInspector
  (smoke tests)   (security audit)
     └───────┬───────┘
             │
     ┌───────┴───────┐
     ▼               ▼
  Dashboard :9800  Reports :9801
```

The orchestrator acts as the "parent session" — the team leader produces a plan
with dispatch instructions, and the orchestrator parses those into structured
stages then executes each agent via `claude -p`. This mirrors the live Claude
Code workflow (where a human session reads team-leader.md and spawns subagents)
but runs fully automated in Docker.

## Quick Start — New Project

Any empty GitHub repo becomes a fully managed AI project:

```bash
# 1. Create an empty GitHub repo and push at least one commit

# 2. Configure
cp .env.example .env
# Edit .env:
#   CLAUDE_SESSION_TOKEN=<from ~/.claude/.credentials.json, field: claudeAiOauth.accessToken>
#   GITHUB_REPO=https://github.com/your-org/your-project.git
#   GITHUB_BRANCH=main
#   GITHUB_TOKEN=<PAT for private repos>

# 3. Start
docker compose up -d

# 4. Submit work
curl -X POST http://localhost:9800/api/work \
  -H "Content-Type: application/json" \
  -d "{\"task\": \"Create a hello world Express API with a health endpoint\"}"

# 5. Watch progress
open http://localhost:9800           # Live dashboard (auto-refreshes 10s)
curl http://localhost:9800/api/runs  # JSON status
```

The setup container will:
1. Clone your repo
2. Auto-bootstrap with Teams/, Plans/, tools/, CLAUDE.md if they don't exist
3. Configure Claude Code auth
4. Start the orchestrator

### Switching Projects

```bash
# Edit .env with the new repo URL
docker compose down -v    # -v clears volumes for fresh clone
docker compose up -d
```

## API

### POST /api/work

Submit a work request. Claude decides the team. Supports optional image attachments.

**JSON (no images):**
```bash
curl -X POST http://localhost:9800/api/work \
  -H "Content-Type: application/json" \
  -d '{"task": "Add user authentication with JWT"}'
```

**Multipart form-data (with images):**
```bash
curl -X POST http://localhost:9800/api/work \
  -F "task=Build a login page matching this mockup" \
  -F "images=@mockup.png" \
  -F "images=@wireframe.png"
```

**JSON with base64 images:**
```json
{
  "task": "Build a dashboard matching this design",
  "images": [
    { "name": "design.png", "data": "<base64-encoded-image>" }
  ]
}
```

Fields:
- `task` (required) — what to build or fix
- `planFile` (optional) — path to an existing plan file in the repo
- `team` (optional) — force TheATeam or TheFixer, skipping Claude routing
- `images` (optional) — mockups, screenshots, or design references (max 10, 10MB each)

Images are saved to the workspace and passed to every agent in the pipeline. Agents view them via Claude Code's multimodal Read tool.

Response:
```json
{
  "id": "run-1711234567-abc12345",
  "status": "team_selecting",
  "message": "Claude is analyzing the task to select the right team...",
  "statusUrl": "/api/runs/run-1711234567-abc12345",
  "attachments": 2
}
```

### GET /api/runs/:id

Get detailed run status including per-agent results for each stage.

```json
{
  "id": "run-1711234567-abc12345",
  "status": "complete",
  "team": "TheATeam",
  "teamReason": "Adding a new API endpoint is feature work.",
  "feedbackLoops": 0,
  "phases": {
    "leader": { "status": "passed", "exitCode": 0 },
    "dispatch": { "stageCount": 2, "agentCount": 3 },
    "stage_0_implementation": {
      "status": "passed",
      "parallel": false,
      "agents": {
        "backend-coder": { "status": "passed", "exitCode": 0 }
      }
    },
    "stage_1_qa": {
      "status": "passed",
      "parallel": true,
      "agents": {
        "qa-review": { "status": "passed", "exitCode": 0 },
        "security-qa": { "status": "passed", "exitCode": 0 }
      }
    },
    "smoketest": { "status": "passed", "exitCode": 0 },
    "inspector": { "status": "passed", "exitCode": 0 }
  },
  "results": {
    "leader": "passed",
    "implementation": "passed",
    "smoketest": "passed",
    "inspector": "passed",
    "feedbackLoops": 0,
    "allPassed": true
  }
}
```

**Run statuses:** `team_selecting` → `planning` → `dispatching` → `implementing` → `qa_running` → `validating` → `complete` / `failed`

**Feedback loops:** If QA agents fail, the orchestrator re-runs the implementation agents with QA feedback appended, then re-runs QA. Max 2 loops before proceeding to validation.

### GET /api/runs

List all runs (most recent first).

### POST /api/runs/:id/revalidate

Re-run smoketests + inspector without re-running the team.

## Team Selection

Claude reads the task and CLAUDE.md, then decides:

| Scenario | Team | Why |
|----------|------|-----|
| New feature (even on existing code) | TheATeam | Full pipeline: requirements → contracts → TDD → QA |
| Enhancing or extending a feature | TheATeam | Adding functionality = feature work |
| Bug fix, broken test, regression | TheFixer | Lean pipeline: plan → fix → verify |
| Security vulnerability patch | TheFixer | Fixing what's broken |
| Ambiguous | TheATeam | When in doubt, treat as feature work |

No keyword matching — Claude makes an informed decision based on the codebase context. Override with `"team": "TheATeam"` in the request.

## Ports

| Port | Service | Purpose |
|------|---------|---------|
| 9800 (configurable) | Orchestrator | API + live dashboard |
| 9801 (configurable) | Nginx | Static reports (pipeline JSON, test results, audit reports) |

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| CLAUDE_SESSION_TOKEN | Yes | — | Claude Code session token (from `claude login` → `~/.claude/.credentials.json` → `claudeAiOauth.accessToken`) |
| GITHUB_REPO | Yes | — | HTTPS URL to clone |
| GITHUB_BRANCH | No | main | Branch to clone |
| GITHUB_TOKEN | No | — | GitHub PAT for private repos |
| PROJECT_NAME | No | my-project | Used in pipeline state and reports |
| DASHBOARD_PORT | No | 8080 | Orchestrator port |
| REPORT_PORT | No | 8081 | Report server port |
| SMOKE_TEST_URL | No | http://host.docker.internal:5173 | App URL for smoke tests |

**Note:** Model selection is defined per-agent in the team role files (Teams/*.md), not via environment variables.

## Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| workspace | /workspace | Cloned project repo + bootstrapped framework |
| claude-config | /root/.claude | Claude Code auth |
| pipeline-state | /workspace/tools | Pipeline JSON state files |
| test-results | /workspace/Source/E2E/test-results | Playwright results |

## Auto-Bootstrap

When the setup container clones a repo that doesn't have `Teams/`, it automatically copies the claude-ai-OS templates into the workspace:

- `Teams/TheATeam/` — feature development pipeline
- `Teams/TheFixer/` — bug fix pipeline
- `Teams/TheInspector/` — system health audit
- `Teams/Shared/` — shared agent roles
- `Plans/` — plan templates and phase signals
- `tools/` — traceability enforcer, pipeline dashboard
- `CLAUDE.md` — project instructions template

This means any empty repo becomes a fully managed AI project on first `docker compose up`.
