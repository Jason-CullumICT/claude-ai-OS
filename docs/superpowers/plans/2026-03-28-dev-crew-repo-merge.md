# dev-crew Repository Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge claude-ai-OS, Work-backlog, and container-test into a single `dev-crew` repo with one `docker compose up` to run everything.

**Architecture:** Create a fresh GitHub repo. Copy current state of all three repos into a unified structure: `platform/` (orchestrator infra), `Source/` (Work-backlog app), `portal/` (container-test debug UI), `templates/` (clean scaffold), and shared governance (Teams/, Specs/, Plans/, tools/) at root. Update all Docker build contexts, compose references, and internal paths. Add iframe debug route in the frontend.

**Tech Stack:** Docker, Node.js, Express, React/Vite, bash

**Spec:** `docs/superpowers/specs/2026-03-27-dev-crew-repo-merge-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `dev-crew/` (new repo root) | Create | Fresh GitHub repo |
| `platform/docker-compose.yml` | Create | Unified compose replacing `docker/docker-compose.yml` |
| `platform/Dockerfile.orchestrator` | Create | Updated build context paths |
| `platform/Dockerfile.worker` | Create | Updated build context paths |
| `platform/Dockerfile.playwright` | Copy | From `docker/Dockerfile.playwright` |
| `platform/.env.example` | Create | Template env with dev-crew defaults |
| `platform/nginx.conf` | Copy | From `docker/nginx.conf` |
| `platform/scripts/` | Copy | From `docker/scripts/` |
| `platform/orchestrator/` | Copy | From `docker/orchestrator/` |
| `portal/Dockerfile` | Create | New Dockerfile for portal service |
| `portal/Backend/` | Copy | From `container-test/Source/Backend/` |
| `portal/Frontend/` | Copy | From `container-test/Source/Frontend/` |
| `Source/` | Copy | From Work-backlog `Source/` |
| `Source/Frontend/src/pages/DebugPortalPage.tsx` | Create | iframe embed for portal |
| `Source/Frontend/src/components/Layout.tsx` | Modify | Add nav link to debug portal |
| `Source/Frontend/src/App.tsx` | Modify | Add route for debug portal |
| `Teams/` | Copy | From claude-ai-OS `Teams/` (canonical) |
| `Specifications/` | Create | Merged from all three repos |
| `Plans/` | Create | Merged from all three repos |
| `tools/` | Copy | From claude-ai-OS `tools/` |
| `docs/` | Copy | From claude-ai-OS `docs/` |
| `templates/` | Create | Sanitised scaffold from Teams/ + tools/ |
| `CLAUDE.md` | Create | Merged project instructions |

---

### Task 1: Create Repo and Copy Platform Infrastructure

**Files:**
- Create: `dev-crew/` (new repo)
- Copy: `platform/orchestrator/`, `platform/scripts/`, `platform/nginx.conf`, `platform/Dockerfile.playwright`

- [ ] **Step 1: Create the GitHub repo**

```bash
gh repo create Jason-CullumICT/dev-crew --public --clone
cd dev-crew
```

- [ ] **Step 2: Copy platform infrastructure from claude-ai-OS**

```bash
# Platform (was docker/)
mkdir -p platform
cp -r ../claude-ai-OS/docker/orchestrator platform/
cp -r ../claude-ai-OS/docker/scripts platform/
cp ../claude-ai-OS/docker/nginx.conf platform/
cp ../claude-ai-OS/docker/Dockerfile.playwright platform/
cp ../claude-ai-OS/docker/guard-cache.json platform/ 2>/dev/null || true
```

- [ ] **Step 3: Copy governance files from claude-ai-OS (canonical)**

```bash
cp -r ../claude-ai-OS/Teams .
cp -r ../claude-ai-OS/tools .
cp -r ../claude-ai-OS/docs .
```

- [ ] **Step 4: Merge Specifications from all three repos**

```bash
mkdir -p Specifications
# claude-ai-OS specs
cp ../claude-ai-OS/Specifications/*.md Specifications/ 2>/dev/null || true
# Work-backlog specs (different content — workflow-engine, self-judging)
git clone --depth 1 https://github.com/Jason-CullumICT/Work-backlog.git /tmp/wb-merge
cp /tmp/wb-merge/Specifications/*.md Specifications/ 2>/dev/null || true
# container-test specs
cp ../container-test/Specifications/*.md Specifications/ 2>/dev/null || true
```

If there are filename collisions, prefer the Work-backlog version (the active product) and rename claude-ai-OS or container-test versions with a prefix.

- [ ] **Step 5: Merge Plans from all three repos**

```bash
mkdir -p Plans
# claude-ai-OS plans
cp -r ../claude-ai-OS/Plans/* Plans/ 2>/dev/null || true
# Work-backlog plans
cp -r /tmp/wb-merge/Plans/* Plans/ 2>/dev/null || true
# container-test plans (may overlap — skip _template if exists)
for dir in ../container-test/Plans/*/; do
  dirname=$(basename "$dir")
  if [ ! -d "Plans/$dirname" ]; then
    cp -r "$dir" "Plans/$dirname"
  fi
done
```

- [ ] **Step 6: Verify structure**

```bash
ls platform/orchestrator/server.js && echo "orchestrator OK"
ls platform/scripts/run-team.sh && echo "scripts OK"
ls Teams/TheATeam/README.md && echo "teams OK"
ls tools/pipeline-update.sh && echo "tools OK"
ls Specifications/ && echo "specs OK"
ls Plans/ && echo "plans OK"
```

Expected: all "OK" lines printed.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: import platform infrastructure, teams, specs, plans, and tools"
```

---

### Task 2: Copy Application Code (Source/ and Portal/)

**Files:**
- Copy: `Source/` from Work-backlog
- Copy: `portal/Backend/`, `portal/Frontend/` from container-test

- [ ] **Step 1: Copy Work-backlog app code**

```bash
cp -r /tmp/wb-merge/Source .
cp /tmp/wb-merge/CLAUDE.md CLAUDE.md.workbacklog  # keep for merging later
rm -rf /tmp/wb-merge
```

- [ ] **Step 2: Copy container-test portal**

```bash
mkdir -p portal
cp -r ../container-test/Source/Backend portal/Backend
cp -r ../container-test/Source/Frontend portal/Frontend
cp -r ../container-test/Source/Shared portal/Shared 2>/dev/null || true
```

- [ ] **Step 3: Verify structure**

```bash
ls Source/Backend/package.json && echo "app backend OK"
ls Source/Frontend/package.json && echo "app frontend OK"
ls Source/Shared/ && echo "app shared OK"
ls portal/Backend/package.json && echo "portal backend OK"
ls portal/Frontend/package.json && echo "portal frontend OK"
```

Expected: all "OK" lines printed.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: import Work-backlog app (Source/) and container-test portal (portal/)"
```

---

### Task 3: Create Dockerfiles and docker-compose.yml

**Files:**
- Create: `platform/Dockerfile.orchestrator`
- Create: `platform/Dockerfile.worker`
- Create: `platform/docker-compose.yml`
- Create: `platform/.env.example`
- Create: `portal/Dockerfile`

- [ ] **Step 1: Create `platform/Dockerfile.orchestrator`**

The build context is now the repo root (so COPY paths change from `orchestrator/` to `platform/orchestrator/`):

```dockerfile
########################################################################
# Orchestrator — API server that routes work to Claude Code workers
########################################################################
FROM node:22-slim

ENV CLAUDE_NONINTERACTIVE=1

RUN apt-get update && apt-get install -y \
    curl git jq python3 \
    && rm -rf /var/lib/apt/lists/*

# Claude Code (for direct session execution)
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app

# Install orchestrator deps
COPY platform/orchestrator/package.json platform/orchestrator/package-lock.json* ./
RUN npm install --production

# Copy orchestrator code
COPY platform/orchestrator/ ./
COPY platform/scripts/ /app/scripts/
RUN chmod +x /app/scripts/*.sh

EXPOSE 8080

CMD ["node", "server.js"]
```

- [ ] **Step 2: Create `platform/Dockerfile.worker`**

Build context is repo root. Templates and scripts use updated paths:

```dockerfile
########################################################################
# Claude Code Worker — runs team sessions in headless mode
########################################################################
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=22
ENV CLAUDE_NONINTERACTIVE=1

# System deps
RUN apt-get update && apt-get install -y \
    curl git jq python3 python3-pip \
    build-essential ca-certificates gnupg \
    && rm -rf /var/lib/apt/lists/*

# Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Go (for controller builds if needed)
RUN curl -fsSL https://go.dev/dl/go1.23.6.linux-amd64.tar.gz | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:${PATH}"

# GitHub CLI (for PR creation and merge)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Playwright system dependencies (for E2E tests in pipeline)
RUN npx playwright install-deps chromium 2>/dev/null || true

# Claude Code
RUN npm install -g @anthropic-ai/claude-code

# Working directory
WORKDIR /workspace

# Copy scripts and templates
COPY platform/scripts/ /app/scripts/
COPY templates/ /app/templates/
RUN chmod +x /app/scripts/*.sh

# Default: idle (orchestrator sends work via exec)
CMD ["tail", "-f", "/dev/null"]
```

- [ ] **Step 3: Create `portal/Dockerfile`**

```dockerfile
########################################################################
# Portal — debug UI for viewing cycles, runs, and reports
########################################################################
FROM node:22-slim

WORKDIR /app

# Install backend deps
COPY Backend/package.json Backend/package-lock.json* ./Backend/
RUN cd Backend && npm install

# Install frontend deps
COPY Frontend/package.json Frontend/package-lock.json* ./Frontend/
RUN cd Frontend && npm install

# Copy all source
COPY . .

EXPOSE 3001 5173

CMD ["bash", "-c", "cd /app/Backend && node src/index.ts & cd /app/Frontend && npx vite --host 0.0.0.0 --port 5173 & wait"]
```

Note: If the portal backend uses TypeScript, the CMD may need `npx tsx src/index.ts` or `npx ts-node src/index.ts` depending on what's in its package.json. Check `portal/Backend/package.json` scripts section and adjust.

- [ ] **Step 4: Create `platform/.env.example`**

```bash
# dev-crew platform configuration
# Copy this to .env and fill in your values

# GitHub — repo the workers will clone and operate on
GITHUB_REPO=https://github.com/Jason-CullumICT/dev-crew
GITHUB_BRANCH=master
GITHUB_TOKEN=

# Project
PROJECT_NAME=dev-crew
WORKSPACE_DIR=/workspace

# Ports
DASHBOARD_PORT=9800
REPORT_PORT=9801
PORTAL_FRONTEND_PORT=4200
PORTAL_BACKEND_PORT=4201

# Port ranges for worker app instances
PORT_RANGE_BACKEND_START=5001
PORT_RANGE_FRONTEND_START=5101
PORT_RANGE_SIZE=50

# Timeouts
CYCLE_TIMEOUT_MS=7200000
PHASE_TIMEOUT_MS=1800000

# Volume retention (hours before auto-cleanup)
VOLUME_RETENTION_HOURS=48
```

- [ ] **Step 5: Create `platform/docker-compose.yml`**

```yaml
services:
  orchestrator:
    build:
      context: ..
      dockerfile: platform/Dockerfile.orchestrator
    ports:
      - "${DASHBOARD_PORT:-9800}:8080"
    environment:
      - GITHUB_REPO=${GITHUB_REPO:-https://github.com/Jason-CullumICT/dev-crew}
      - GITHUB_BRANCH=${GITHUB_BRANCH:-master}
      - GITHUB_TOKEN=${GITHUB_TOKEN:-}
      - PROJECT_NAME=${PROJECT_NAME:-dev-crew}
      - WORKSPACE_DIR=/workspace
      - PORT_RANGE_BACKEND_START=${PORT_RANGE_BACKEND_START:-5001}
      - PORT_RANGE_FRONTEND_START=${PORT_RANGE_FRONTEND_START:-5101}
      - PORT_RANGE_SIZE=${PORT_RANGE_SIZE:-50}
      - CYCLE_TIMEOUT_MS=${CYCLE_TIMEOUT_MS:-7200000}
      - PHASE_TIMEOUT_MS=${PHASE_TIMEOUT_MS:-1800000}
      - VOLUME_RETENTION_HOURS=${VOLUME_RETENTION_HOURS:-48}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - workspace:/workspace
      - claude-config:/root/.claude
      - ~/.claude/.credentials.json:/root/.claude/.credentials.json:ro
    restart: unless-stopped
    networks:
      - dev-crew-net

  worker:
    build:
      context: ..
      dockerfile: platform/Dockerfile.worker
    environment:
      - WORKSPACE_DIR=/workspace
    volumes:
      - workspace:/workspace
      - claude-config:/root/.claude
    deploy:
      replicas: 0
    networks:
      - dev-crew-net

  portal:
    build:
      context: ../portal
    ports:
      - "${PORTAL_FRONTEND_PORT:-4200}:5173"
      - "${PORTAL_BACKEND_PORT:-4201}:3001"
    environment:
      - ORCHESTRATOR_URL=http://orchestrator:8080
      - NODE_ENV=development
    networks:
      - dev-crew-net
    restart: unless-stopped

  dashboard:
    image: nginx:alpine
    ports:
      - "${REPORT_PORT:-9801}:80"
    volumes:
      - workspace:/usr/share/nginx/html/workspace:ro
      - ../platform/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      - dev-crew-net
    restart: unless-stopped

volumes:
  workspace:
  claude-config:

networks:
  dev-crew-net:
    driver: bridge
```

- [ ] **Step 6: Verify Dockerfiles parse**

```bash
docker build --check -f platform/Dockerfile.orchestrator . 2>&1 | head -5
docker build --check -f platform/Dockerfile.worker . 2>&1 | head -5
docker build --check -f portal/Dockerfile portal/ 2>&1 | head -5
```

Expected: no syntax errors. (Build won't fully run — just checking parse.)

- [ ] **Step 7: Commit**

```bash
git add platform/Dockerfile.orchestrator platform/Dockerfile.worker platform/docker-compose.yml platform/.env.example portal/Dockerfile
git commit -m "feat: add Dockerfiles and docker-compose for unified dev-crew platform"
```

---

### Task 4: Create Templates Directory

**Files:**
- Create: `templates/CLAUDE.md`
- Create: `templates/Teams/` (sanitised copy)
- Create: `templates/Specifications/README.md`
- Create: `templates/Plans/_template/`
- Create: `templates/tools/` (copy of pipeline scripts)

- [ ] **Step 1: Copy and sanitise Teams/**

```bash
cp -r Teams templates/Teams

# Clear all learnings (keep directories with .gitkeep)
find templates/Teams -path "*/learnings/*" -type f -name "*.md" -delete
find templates/Teams -path "*/learnings" -type d -exec touch {}/.gitkeep \;

# Remove any findings directories
find templates/Teams -name "findings" -type d -exec rm -rf {} + 2>/dev/null || true
```

- [ ] **Step 2: Create template CLAUDE.md**

```bash
cat > templates/CLAUDE.md << 'SCAFFOLD_EOF'
# CLAUDE.md

## This is an AI-first, spec-first project.

<!-- Replace this with your project description -->

Every decision and line of code must trace back to a specification. If the spec doesn't cover it, write the spec first.

The workflow is always: **Specifications -> Plans -> Source -> Tests**.

## Read These First

| Document | What it covers |
|----------|---------------|
| [`Specifications/`](Specifications/) | Domain specifications. **The most critical documents.** |
| [`Plans/`](Plans/) | Feature plans with prompt, design, and plan files. |
| [`Teams/`](Teams/) | Agent team definitions and learnings |
| [`tools/`](tools/) | Pipeline dashboard reporting and traceability enforcement |

## Repository Layout

```
Specifications/          # Domain truth (technology-agnostic)
Source/                  # Application source code
Plans/                   # Feature plans (prompt/design/plan per feature)
Teams/                   # Agent team definitions and learnings
tools/                   # Pipeline dashboard scripts
```

## Dev Environment Quick Reference

| Item | Value |
|------|-------|
| Backend URL | <!-- Replace --> |
| Frontend URL | <!-- Replace --> |

## Build & Test

<!-- Add your build and test commands here -->

## Architecture Rules

These are non-negotiable. All agents and solo sessions must follow them.

- **Specs are source of truth** -- implementation traces to specs, never the other way around
- **No direct DB calls from route handlers** -- use the service layer
- **Shared types are single source of truth** -- no inline type re-definitions across layers
- **Every FR needs a test** with `// Verifies: FR-XXX` traceability comments
- **Schema changes require a migration**
- **No hardcoded secrets** -- use environment variables via `.env`
- **No silent failures** -- every operation that can fail must have its outcome checked and logged

## Agent Teams

**Source code changes MUST go through a team pipeline** (TheATeam or TheFixer) for QA, code review, traceability, and test coverage.

**Team rules:**
1. **Read `CLAUDE.md` in full** before starting any task
2. **Stay in your module** -- do not edit files outside your assigned scope
3. **Run verification gates** before reporting completion
4. **Share findings** via `agent.md` when you discover something that affects other agents
5. **Do not suppress test output** or skip verification
SCAFFOLD_EOF
```

- [ ] **Step 3: Create template Specifications and Plans**

```bash
mkdir -p templates/Specifications
cat > templates/Specifications/README.md << 'EOF'
# Specifications

Add your domain specifications here. Each spec should be technology-agnostic and describe WHAT the system does, not HOW.

Use functional requirement IDs (e.g., FR-XX-001) for traceability.
EOF

mkdir -p templates/Plans/_template
cat > templates/Plans/_template/README.md << 'EOF'
# Plan Template

Each feature plan should contain:
- `prompt.md` — Original problem statement
- `design.md` — Architecture decisions and trade-offs
- `plan.md` — Phased implementation plan
- `requirements.md` — Formal FR-XXX requirements (for TheATeam)
EOF
```

- [ ] **Step 4: Copy tools**

```bash
cp -r tools templates/tools
```

- [ ] **Step 5: Verify templates are clean**

```bash
# No learnings content
find templates/Teams -path "*/learnings/*.md" -type f | head -5
# Should print nothing (only .gitkeep files)

# Template CLAUDE.md has placeholders
grep "Replace" templates/CLAUDE.md
# Should print the placeholder lines
```

- [ ] **Step 6: Commit**

```bash
git add templates/
git commit -m "feat: add clean project scaffold templates for external repos"
```

---

### Task 5: Create Merged CLAUDE.md

**Files:**
- Create: `CLAUDE.md` (merged from claude-ai-OS + Work-backlog)

- [ ] **Step 1: Read both CLAUDE.md files and merge**

The root `CLAUDE.md` should use claude-ai-OS's version as the base (it has architecture rules, team rules, session hygiene, observability, testing rules). Add Work-backlog's dev environment section.

```bash
# Start with claude-ai-OS version
cp ../claude-ai-OS/CLAUDE.md CLAUDE.md
```

- [ ] **Step 2: Update the project description**

Edit `CLAUDE.md` — replace the first `## This is an AI-first, spec-first project.` section description:

Change:
```
**Work-backlog** — AI-managed project. Update this description in CLAUDE.md.
```

To:
```
**dev-crew** — AI-powered development platform. Orchestrates autonomous agent teams to build software through specifications, plans, and automated pipelines.
```

- [ ] **Step 3: Update the repository layout**

Replace the repository layout section with:

```
## Repository Layout

\```
Specifications/          # Domain truth (technology-agnostic)
Source/                  # Application source code (the product)
Plans/                   # Feature plans (prompt/design/plan per feature)
Teams/                   # Agent team definitions and learnings
tools/                   # Pipeline dashboard scripts
platform/                # Orchestrator infrastructure (Docker, server, scripts)
portal/                  # Debug UI (embedded via iframe)
templates/               # Clean scaffold for external projects
docs/                    # Design specs and implementation plans
\```
```

- [ ] **Step 4: Add the Work-backlog dev environment section**

Ensure the Dev Environment Quick Reference section has the correct URLs:

```markdown
## Dev Environment Quick Reference

| Item | Value |
|------|-------|
| Orchestrator Dashboard | `http://localhost:9800` |
| Portal (Debug UI) | `http://localhost:4200` |
| Reports Dashboard | `http://localhost:9801` |
| App Backend URL | `http://localhost:3001` |
| App Frontend URL | `http://localhost:5173` |
| Login credentials | `admin@example.com / admin123` |
```

- [ ] **Step 5: Update module ownership table**

Replace the module ownership table with:

```markdown
| Module | Owner | Notes |
|--------|-------|-------|
| `Source/Backend/` | backend-coder | Routes, services, database, tests |
| `Source/Frontend/` | frontend-coder | Components, hooks, pages, tests |
| `Source/Shared/` | api-contract | Shared types |
| `platform/orchestrator/` | backend-coder | Orchestrator server and lib |
| `portal/` | frontend-coder | Debug portal UI |
| `Specifications/` | requirements-reviewer | Domain truth documents |
| `templates/` | solo-session | Clean scaffold — no team pipeline needed |
```

- [ ] **Step 6: Clean up temp file**

```bash
rm -f CLAUDE.md.workbacklog
```

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md
git commit -m "feat: merged CLAUDE.md with dev-crew project instructions"
```

---

### Task 6: Add Debug Portal Route to Work-backlog Frontend

**Files:**
- Create: `Source/Frontend/src/pages/DebugPortalPage.tsx`
- Modify: `Source/Frontend/src/components/Layout.tsx`
- Modify: `Source/Frontend/src/App.tsx`

- [ ] **Step 1: Create the debug portal page**

Create `Source/Frontend/src/pages/DebugPortalPage.tsx`:

```typescript
// Verifies: dev-crew debug portal — embedded container-test viewer
import React from 'react';

export const DebugPortalPage: React.FC = () => {
  const portalUrl = import.meta.env.VITE_PORTAL_URL || 'http://localhost:4200';

  return (
    <div style={{ margin: '-24px', height: 'calc(100vh - 56px)' }}>
      <iframe
        src={portalUrl}
        style={{ width: '100%', height: '100%', border: 'none' }}
        title="Debug Portal"
      />
    </div>
  );
};
```

- [ ] **Step 2: Add the route in App.tsx**

In `Source/Frontend/src/App.tsx`, add the import and route:

Add import at line 4 (after other page imports):
```typescript
import { DebugPortalPage } from './pages/DebugPortalPage';
```

Add route inside the `<Route element={<Layout />}>` block, after line 20 (`<Route path="/work-items/:id" ...`):
```typescript
          <Route path="/debug" element={<DebugPortalPage />} />
```

- [ ] **Step 3: Add nav link in Layout.tsx**

In `Source/Frontend/src/components/Layout.tsx`, add the debug link to `NAV_ITEMS`:

Change:
```typescript
const NAV_ITEMS = [
  { path: '/', label: 'Dashboard' },
  { path: '/work-items', label: 'Work Items' },
  { path: '/work-items/new', label: 'Create Item' },
];
```

To:
```typescript
const NAV_ITEMS = [
  { path: '/', label: 'Dashboard' },
  { path: '/work-items', label: 'Work Items' },
  { path: '/work-items/new', label: 'Create Item' },
  { path: '/debug', label: 'Debug Portal' },
];
```

- [ ] **Step 4: Verify the frontend compiles**

```bash
cd Source/Frontend && npx tsc --noEmit 2>&1 | head -10
```

Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add Source/Frontend/src/pages/DebugPortalPage.tsx Source/Frontend/src/components/Layout.tsx Source/Frontend/src/App.tsx
git commit -m "feat: add debug portal route embedding container-test viewer"
```

---

### Task 7: Update Internal Path References

**Files:**
- Modify: `platform/orchestrator/lib/config.js` (if it references `docker/` paths)
- Modify: `platform/scripts/setup-workspace.sh` (template copy logic)
- Modify: Any hardcoded repo URLs

- [ ] **Step 1: Search for all hardcoded path references**

```bash
grep -rn "claude-ai-OS\|container-test\|Work-backlog" platform/ Source/ portal/ CLAUDE.md tools/ Teams/ --include="*.js" --include="*.ts" --include="*.tsx" --include="*.sh" --include="*.md" --include="*.yml" --include="*.yaml" --include="*.json" | grep -v node_modules | grep -v ".git/"
```

Review each hit and update:
- `claude-ai-OS` → `dev-crew` (or remove if it's a repo reference)
- `container-test` → `portal` (or the new path)
- `Work-backlog` → `dev-crew` (or the new path)

- [ ] **Step 2: Update setup-workspace.sh with template auto-apply**

Add template scaffolding to `platform/scripts/setup-workspace.sh` — after the workspace clone step, add:

```bash
# Auto-apply project scaffold for repos that don't have Teams/
if [ ! -d /workspace/Teams ]; then
  echo "[setup] No Teams/ found — applying project scaffold from templates/"
  cp -r /app/templates/* /workspace/
  cd /workspace
  git add -A
  git commit -m "chore: scaffold agent team structure from dev-crew templates"
  if ! git push origin HEAD; then
    echo "[setup] WARNING: Failed to push scaffold commit — continuing anyway"
  fi
  echo "[setup] Scaffold applied and pushed"
else
  echo "[setup] Teams/ exists — skipping scaffold"
fi
```

- [ ] **Step 3: Update any config.js defaults**

Check `platform/orchestrator/lib/config.js` for default repo references:

```bash
grep -n "GITHUB_REPO\|Work-backlog\|claude-ai-OS\|container-test" platform/orchestrator/lib/config.js
```

Update any defaults from `Work-backlog` to `dev-crew`.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "fix: update all internal path and repo references for dev-crew structure"
```

---

### Task 8: Integration Test — Docker Compose Up

- [ ] **Step 1: Create .env from example**

```bash
cd platform
cp .env.example .env
# Edit .env — add GITHUB_TOKEN
```

- [ ] **Step 2: Build and start all services**

```bash
cd platform
docker compose up -d --build
```

Expected: all four services start (orchestrator, portal, dashboard, no workers yet).

- [ ] **Step 3: Verify orchestrator health**

```bash
curl -s http://localhost:9800/api/health | python -m json.tool
```

Expected: `{"status":"ok",...}`

- [ ] **Step 4: Verify portal is accessible**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:4200
```

Expected: `200`

- [ ] **Step 5: Verify reports dashboard**

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:9801
```

Expected: `200` or `403` (nginx serves directory listing or returns forbidden — both mean it's running).

- [ ] **Step 6: Submit a test work request**

```bash
curl -s -X POST http://localhost:9800/api/work \
  -H "Content-Type: application/json" \
  -d '{"task": "List all files in the repo root and verify the dev-crew structure is correct"}' \
  | python -m json.tool
```

Expected: run created, status URL returned, team assigned.

- [ ] **Step 7: Verify template auto-apply with an external repo**

```bash
curl -s -X POST http://localhost:9800/api/work \
  -H "Content-Type: application/json" \
  -d '{"task": "Verify this repo has a Teams/ directory", "repo": "https://github.com/Jason-CullumICT/some-test-repo"}' \
  | python -m json.tool
```

Expected: run created. If the external repo has no Teams/, the worker should scaffold it from templates/.

- [ ] **Step 8: Fix any issues found, commit**

```bash
git add -A
git commit -m "fix: address integration issues from docker compose test"
```

Only if fixes were needed.

---

### Task 9: Push and Archive Original Repos

- [ ] **Step 1: Push dev-crew to GitHub**

```bash
git push origin main
```

- [ ] **Step 2: Archive claude-ai-OS**

Add a redirect notice to its README:

```bash
cd ../claude-ai-OS
cat > ARCHIVED.md << 'EOF'
# This repo has been archived

This project has been merged into [dev-crew](https://github.com/Jason-CullumICT/dev-crew).

All platform infrastructure, team definitions, and tools now live in the dev-crew repo.
EOF
git add ARCHIVED.md
git commit -m "chore: archive — merged into dev-crew"
git push origin master
```

Then archive on GitHub: Settings > Danger Zone > Archive this repository.

- [ ] **Step 3: Archive container-test**

```bash
cd ../container-test
cat > ARCHIVED.md << 'EOF'
# This repo has been archived

This project has been merged into [dev-crew](https://github.com/Jason-CullumICT/dev-crew) as the `portal/` directory.

The debug portal is now accessible at http://localhost:4200 or via the /debug route in the main app.
EOF
git add ARCHIVED.md
git commit -m "chore: archive — merged into dev-crew as portal/"
git push origin master
```

Then archive on GitHub.

- [ ] **Step 4: Archive Work-backlog**

```bash
cd /tmp
git clone --depth 1 https://github.com/Jason-CullumICT/Work-backlog.git wb-archive
cd wb-archive
cat > ARCHIVED.md << 'EOF'
# This repo has been archived

This project has been merged into [dev-crew](https://github.com/Jason-CullumICT/dev-crew) as the `Source/` directory.

All specifications, plans, and team definitions now live in the dev-crew repo.
EOF
git add ARCHIVED.md
git commit -m "chore: archive — merged into dev-crew as Source/"
git push origin master
cd /tmp && rm -rf wb-archive
```

Then archive on GitHub.

- [ ] **Step 5: Verify dev-crew is fully operational**

```bash
cd ../dev-crew/platform
docker compose down
docker compose up -d --build
sleep 5
curl -s http://localhost:9800/api/health
```

Expected: healthy, all services running, the single repo is the source of truth.
