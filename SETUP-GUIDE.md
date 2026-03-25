# claude-ai-OS — End-to-End Setup Guide

## What This Is

A fully automated AI development pipeline. You create a feature request in a web portal, it gets built by AI agent teams in isolated Docker containers, tested with real browser tests, and merged via PR — all without touching code yourself.

```
Feature Portal          Orchestrator           Worker Containers        GitHub
     |                      |                       |                    |
  Create Feature  ------>  Route to team  ------> Spawn container       |
     |                      |                    Clone repo + branch     |
     |                   Plan + dispatch -------> Agents code + test     |
     |                      |                    Start app               |
  Watch progress  <------  Stream logs  <------- QA + E2E tests         |
     |                      |                    Commit + push --------> Branch
     |                   Create PR  ----------------------------------> PR
     |                   AI reviews PR  --------------------------------> Review
     |                   Auto-merge (low/medium) ----------------------> Merge
     |                   OR wait for approval (high risk)               |
  Test the app   <------  App on ports  <------- Running in container   |
```

## Prerequisites

- Docker Desktop running
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- Logged in (`claude login`)
- GitHub account with a PAT (personal access token) that has `repo` scope

## Quick Start (5 minutes)

### 1. Clone the orchestrator

```bash
git clone https://github.com/Jason-CullumICT/claude-ai-OS
cd claude-ai-OS/docker
```

### 2. Configure

```bash
cp .env.example .env
```

Edit `.env`:
```bash
GITHUB_REPO=https://github.com/your-org/your-project   # default target repo
GITHUB_BRANCH=main                                       # or master
GITHUB_TOKEN=ghp_your_token_here                         # needs repo scope
PROJECT_NAME=your-project
```

### 3. Build and start

```bash
# Build the worker image (first time only, ~3 min)
docker compose build
docker build -t claude-ai-os-worker:latest -f Dockerfile.worker ..

# Start everything
docker compose up -d
```

### 4. Verify

```bash
# Orchestrator dashboard
open http://localhost:9800

# Feature portal
open http://localhost:4200

# Check health
curl http://localhost:9800/api/health
```

You should see:
- Dashboard at :9800 showing "Engine: Container Mode"
- Feature portal at :4200 with sidebar (Dashboard, Feature Requests, Bug Reports, Dev Cycle, etc.)

## The Full Workflow

### Step 1: Create a Feature in the Portal

Open **http://localhost:4200/feature-requests** and click "+ New Feature Request":

- **Title**: "Add dark mode toggle"
- **Description**: "Users should be able to switch between light and dark themes. Add a toggle in the header that persists the preference in localStorage."
- **Source**: Manual
- **Priority**: Medium
- **Attachments**: (optional) Upload a mockup image

The feature is saved in the portal's database.

### Step 2: Submit to Build Pipeline

The portal has an orchestrator proxy built in. When a feature is approved for development, it can be submitted to the pipeline.

**Via the portal** (when the "Submit to Pipeline" button is wired up):
The portal calls `POST /api/orchestrator/api/work` with the feature description.

**Via curl** (direct):
```bash
curl -X POST http://localhost:9800/api/work \
  -F "task=Add dark mode toggle with localStorage persistence" \
  -F "repo=https://github.com/your-org/your-project" \
  -F "repoBranch=main" \
  -F "images=@mockup.png"
```

**Via curl with JSON** (no images):
```bash
curl -X POST http://localhost:9800/api/work \
  -H "Content-Type: application/json" \
  -d '{"task":"Add dark mode toggle","repo":"https://github.com/your-org/your-project","repoBranch":"main"}'
```

### Step 3: Watch the Pipeline

**Dashboard**: http://localhost:9800
- Shows active cycles with team, phase, progress
- Auto-refreshes every 10 seconds

**Portal Dev Cycle page**: http://localhost:4200/cycle
- Shows orchestrator cycles with real-time log streaming
- Each cycle shows: team badge, phase, elapsed time, port links

**Container logs** (most detail):
```bash
docker compose logs -f orchestrator
```

### What happens inside the pipeline:

```
Phase 1:   Team leader reads task, writes specs + plans (4-8 min)
Phase 2:   Orchestrator parses dispatch plan, assigns agents
Phase 3:   Coders implement in parallel — backend + frontend (10-30 min)
Phase 3.5: App starts inside worker container
Phase 4:   QA agents review + write Playwright E2E tests (5-10 min)
Phase 4.5: Playwright E2E tests run against live app
Phase 5:   Smoketest + Inspector audit
Phase 6:   Risk classification → auto-PR → AI review → merge decision
Phase 7:   Commit + push cycle branch
Phase 8:   Sync learnings to main branch
```

### Step 4: Test the Built App

Each cycle gets its own port pair:
- First cycle: **http://localhost:5101** (frontend), **http://localhost:5001** (backend)
- Second cycle: **http://localhost:5102**, **http://localhost:5002**
- Up to 99 parallel cycles

Open the frontend URL in your browser. The app is running with the new feature.

### Step 5: Review and Merge

**Low risk** (bug fixes, < 3 files): Auto-merges if all tests pass.

**Medium risk** (new features): Creates a PR, AI reviews it, auto-merges if approved.

**High risk** (architecture changes, schema migrations): Creates a PR with AI review, labels "needs-approval", waits for you.

Check PRs at: `https://github.com/your-org/your-project/pulls`

### Step 6: Verify After Merge

After merge, pull locally and run:
```bash
cd your-project
git pull
cd Source/Backend && npm install && npx ts-node src/index.ts &
cd ../Frontend && npm install && npx vite
```

Or just keep using the worker container's app — it stays running on its ports.

## Architecture

```
Your Machine
├── Docker Desktop
│   ├── Orchestrator (:9800)     — control plane, dashboard, API
│   ├── Portal (:4200/:4201)     — feature management UI
│   ├── Dashboard (:9801)        — static reports
│   └── Workers (dynamic)
│       ├── Worker 1 (:5001/:5101) — cycle 1
│       ├── Worker 2 (:5002/:5102) — cycle 2
│       └── ... up to 99
│
├── ~/.claude/.credentials.json  — Claude auth (auto-mounted)
└── GitHub repos                 — code lives here
```

## Port Map

| Port | Service | Purpose |
|------|---------|---------|
| 9800 | Orchestrator | Pipeline dashboard + API |
| 9801 | Nginx | Static reports |
| 4200 | Portal Frontend | Feature management UI |
| 4201 | Portal Backend | Feature management API |
| 5001-5099 | Worker backends | Per-cycle backend apps |
| 5101-5199 | Worker frontends | Per-cycle frontend apps |

## API Reference

### Submit Work
```bash
POST http://localhost:9800/api/work
```
Fields:
- `task` (required) — what to build
- `repo` (optional) — GitHub repo URL (defaults to .env GITHUB_REPO)
- `repoBranch` (optional) — branch to base on (defaults to .env GITHUB_BRANCH)
- `team` (optional) — force "TheATeam" or "TheFixer"
- `images` (optional) — multipart file uploads, mockups/specs

### Monitor
```bash
GET http://localhost:9800/api/health       # system status
GET http://localhost:9800/api/runs         # all pipeline runs
GET http://localhost:9800/api/runs/:id     # run detail with per-agent results
GET http://localhost:9800/api/cycles       # active worker cycles
GET http://localhost:9800/api/cycles/:id   # cycle detail
```

### Control
```bash
POST http://localhost:9800/api/cycles/:id/stop      # kill a cycle
POST http://localhost:9800/api/cycles/:id/cleanup    # remove container + volume + branch
POST http://localhost:9800/api/worker-image/rebuild  # rebuild worker Docker image
```

## Working with Multiple Projects

The orchestrator can work on any GitHub repo. Pass `repo` in the work request:

```bash
# Work on project A
curl -X POST http://localhost:9800/api/work \
  -H "Content-Type: application/json" \
  -d '{"task":"Add auth","repo":"https://github.com/org/project-a","repoBranch":"main"}'

# Simultaneously work on project B
curl -X POST http://localhost:9800/api/work \
  -H "Content-Type: application/json" \
  -d '{"task":"Fix login bug","repo":"https://github.com/org/project-b","repoBranch":"master"}'
```

Both run in parallel in separate worker containers with separate branches.

## Troubleshooting

### Token expired
```bash
claude login
docker compose restart orchestrator
```

### Port conflict
```bash
# Kill orphaned workers
docker rm -f $(docker ps -aq --filter "name=claude-worker")
docker compose restart orchestrator
```

### Worker app not running
The app supervisor should keep it alive. If not:
```bash
docker exec -d claude-worker-{run-id} bash -c "/tmp/app-supervisor.sh"
```

### Portal not loading
```bash
docker compose restart portal
```

### Rebuild everything from scratch
```bash
docker compose down -v
docker build -t claude-ai-os-worker:latest -f Dockerfile.worker ..
docker compose up -d --build
```

## How It Was Built

This entire system was built iteratively using Claude Code over multiple sessions:
1. Single-container orchestrator with `claude -p` headless execution
2. Multi-stage dispatch pipeline (leader plans, agents execute)
3. Parallel container architecture (per-cycle isolation)
4. Feature portal (built by the pipeline itself from a hand-drawn doodle)
5. Tiered merge pipeline (risk-based auto-PR and merge)
6. Learnings sync (agent knowledge compounds across cycles)

The system builds its own features through the pipeline.
