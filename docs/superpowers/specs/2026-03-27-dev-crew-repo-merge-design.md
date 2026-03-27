# dev-crew Repository Merge — Design Specification

## Problem

The platform is split across three repos with confusing names, duplicated governance files, and a multi-step setup process:

- **claude-ai-OS** (`Jason-CullumICT/claude-ai-OS`) — orchestrator platform, docker infrastructure, team templates
- **container-test** (`Jason-CullumICT/container-test`) — portal app (dev-workflow UI)
- **Work-backlog** (`Jason-CullumICT/Work-backlog`) — the app workers build (workflow-engine)

Teams/ is duplicated across all three with drift. Docker-compose clones repos at runtime. Setup requires coordinating multiple repos. Names don't describe what anything does.

## Goals

1. Single repo (`dev-crew`) containing the platform, the app, and the portal
2. `docker compose up -d` runs everything — no runtime repo cloning for the portal
3. Container-test portal available as an embedded debug view in the Work-backlog app's orchestration section
4. Clean template scaffold that can bootstrap external projects with agent team structure
5. External repos still supported via per-request `repo` parameter on `/api/work`

## Non-Goals

- Rewriting the portal UI — it embeds as-is via iframe
- Migrating git histories — fresh repo, import current state, archive originals
- Changing the orchestrator's internal architecture — just relocating files

## Repository Structure

```
dev-crew/
├── CLAUDE.md                    # Merged project instructions
├── Specifications/              # From Work-backlog
├── Plans/                       # Merged from all repos
├── Teams/                       # Canonical team definitions (from claude-ai-OS)
├── tools/                       # Pipeline dashboard, traceability, spec-drift
├── docs/                        # Design specs, implementation plans
│
├── platform/                    # Was: claude-ai-OS/docker/
│   ├── docker-compose.yml
│   ├── Dockerfile.orchestrator
│   ├── Dockerfile.worker
│   ├── Dockerfile.playwright
│   ├── nginx.conf
│   ├── .env.example
│   ├── scripts/                 # setup-workspace.sh, run-team.sh, etc.
│   └── orchestrator/            # server.js + lib/
│       ├── server.js
│       ├── package.json
│       └── lib/
│           ├── config.js
│           ├── container-manager.js
│           ├── cycle-registry.js
│           ├── dispatch.js
│           ├── docker-client.js
│           ├── health-monitor.js
│           ├── port-allocator.js
│           ├── token-pool.js
│           ├── workflow-engine.js
│           └── workflow-engine.test.js
│
├── templates/                   # Clean scaffold for new projects
│   ├── CLAUDE.md               # Template with placeholders
│   ├── Teams/
│   │   ├── Shared/             # chaos-tester.md, design-critic.md, librarian.md
│   │   ├── TheATeam/           # All role files, empty learnings/
│   │   ├── TheFixer/           # All role files, empty learnings/
│   │   └── TheInspector/       # All role files, inspector.config.yml
│   ├── Specifications/
│   │   └── README.md
│   ├── Plans/
│   │   └── _template/
│   └── tools/
│       ├── pipeline-update.sh
│       ├── traceability-enforcer.py
│       └── spec-drift-audit.py
│
├── Source/                      # The app (from Work-backlog)
│   ├── Backend/                # workflow-engine-backend (Express/TS)
│   ├── Frontend/               # React/Vite frontend
│   ├── Shared/                 # Shared types
│   └── E2E/                    # Playwright tests
│
└── portal/                     # Extracted from container-test
    ├── Backend/                # dev-workflow-backend (Express)
    └── Frontend/               # React/Vite (debug UI)
```

### Directory Mapping

| Source | Destination | Notes |
|--------|------------|-------|
| `claude-ai-OS/docker/` | `platform/` | Rename only |
| `claude-ai-OS/docker/orchestrator/` | `platform/orchestrator/` | Already nested |
| `claude-ai-OS/docker/scripts/` | `platform/scripts/` | Already nested |
| `claude-ai-OS/Teams/` | `Teams/` | Canonical definitions |
| `claude-ai-OS/Specifications/` | `Specifications/` | Merge with Work-backlog specs |
| `claude-ai-OS/Plans/` | `Plans/` | Merge with Work-backlog plans |
| `claude-ai-OS/tools/` | `tools/` | As-is |
| `claude-ai-OS/docs/` | `docs/` | As-is |
| `claude-ai-OS/CLAUDE.md` | `CLAUDE.md` | Use claude-ai-OS version as base (has architecture rules, team rules, session hygiene). Add Work-backlog's dev environment section (backend/frontend URLs, login credentials) and any app-specific rules |
| `Work-backlog/Source/` | `Source/` | As-is |
| `Work-backlog/Specifications/` | `Specifications/` | Merge — add workflow-engine.md |
| `Work-backlog/Plans/` | `Plans/` | Merge — add self-judging-workflow/ etc. |
| `container-test/Source/Backend/` | `portal/Backend/` | As-is |
| `container-test/Source/Frontend/` | `portal/Frontend/` | As-is |
| `container-test/Teams/` | Discard | Use canonical Teams/ from root |
| `container-test/Specifications/` | `Specifications/` | Merge — add dev-workflow-platform.md |
| `container-test/Plans/` | `Plans/` | Merge relevant plans |

### Templates — Clean Copy

`templates/` contains a sanitised version of the team scaffold:

- All role `.md` files present (from Teams/)
- All `learnings/` directories exist but contain only `.gitkeep`
- `inspector.config.yml` present with placeholder values
- `CLAUDE.md` with generic sections and `<!-- Replace -->` markers
- `tools/` with pipeline-update.sh, traceability-enforcer.py, spec-drift-audit.py
- No project-specific specs, plans, or findings

### Template Auto-Apply

In the workspace init phase (`platform/scripts/setup-workspace.sh` or `container-manager.js:initWorkspace`):

```
if [ ! -d /workspace/Teams ]; then
  echo "[setup] No Teams/ found — applying project scaffold from templates/"
  cp -r /app/templates/* /workspace/
  cd /workspace
  git add -A
  git commit -m "chore: scaffold agent team structure from dev-crew templates"
  git push origin HEAD
fi
```

Existing repos that already have Teams/ are left untouched.

## Docker Compose

```yaml
services:
  orchestrator:
    build:
      context: .
      dockerfile: platform/Dockerfile.orchestrator
    ports:
      - "${DASHBOARD_PORT:-9800}:8080"
    environment:
      - GITHUB_REPO=${GITHUB_REPO:-https://github.com/Jason-CullumICT/dev-crew}
      - GITHUB_BRANCH=${GITHUB_BRANCH:-master}
      - GITHUB_TOKEN=${GITHUB_TOKEN:-}
      - PROJECT_NAME=${PROJECT_NAME:-dev-crew}
      - WORKSPACE_DIR=/workspace
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - workspace:/workspace
      - claude-config:/root/.claude
      - ~/.claude/.credentials.json:/root/.claude/.credentials.json:ro
    restart: unless-stopped
    networks:
      - claude-net

  worker:
    build:
      context: .
      dockerfile: platform/Dockerfile.worker
    environment:
      - WORKSPACE_DIR=/workspace
    volumes:
      - workspace:/workspace
      - claude-config:/root/.claude
    deploy:
      replicas: 0
    networks:
      - claude-net

  portal:
    build:
      context: ./portal
      dockerfile: Dockerfile
    ports:
      - "${PORTAL_FRONTEND_PORT:-4200}:5173"
      - "${PORTAL_BACKEND_PORT:-4201}:3001"
    environment:
      - ORCHESTRATOR_URL=http://orchestrator:8080
      - NODE_ENV=development
    networks:
      - claude-net
    restart: unless-stopped

  dashboard:
    image: nginx:alpine
    ports:
      - "${REPORT_PORT:-9801}:80"
    volumes:
      - workspace:/usr/share/nginx/html/workspace:ro
      - ./platform/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    networks:
      - claude-net
    restart: unless-stopped

volumes:
  workspace:
  claude-config:

networks:
  claude-net:
    driver: bridge
```

Key changes from current docker-compose:
- `setup` service removed — workspace init handled by orchestrator on first run
- `portal` builds from `portal/` directory with its own Dockerfile instead of cloning at runtime
- `GITHUB_REPO` defaults to `dev-crew` (self-referential)
- `playwright` service removed from compose — Playwright runs inside worker containers
- Fewer volumes — `pipeline-state`, `test-results`, `portal-data` consolidated into workspace

## Portal as Debug View

The container-test portal is preserved as a standalone service in `portal/` and embedded in the Work-backlog frontend via iframe.

### Portal Dockerfile

New file at `portal/Dockerfile`:

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY Backend/package*.json ./Backend/
COPY Frontend/package*.json ./Frontend/
RUN cd Backend && npm install && cd ../Frontend && npm install
COPY . .
EXPOSE 3001 5173
CMD ["bash", "-c", "cd Backend && npx ts-node src/index.ts & cd Frontend && npx vite --host 0.0.0.0 --port 5173"]
```

No more runtime git clone — the portal code is in the image.

### iframe Integration

Add a route in the Work-backlog frontend (`Source/Frontend/src/pages/`):

```typescript
// OrchestrationDebugPage.tsx
export function OrchestrationDebugPage() {
  return (
    <div style={{ height: "100vh", width: "100%" }}>
      <iframe
        src="http://localhost:4200"
        style={{ width: "100%", height: "100%", border: "none" }}
        title="Debug Portal"
      />
    </div>
  );
}
```

Add navigation link in the orchestration section of the app's sidebar/nav.

## External Repo Support

The orchestrator continues to support external repos. The workflow:

1. `POST /api/work` with `repo` param → workers clone that repo
2. During workspace init, if cloned repo has no `Teams/` → copy from `templates/`
3. Workers operate on external repo's code, push to cycle branch, create PR
4. Without `repo` param → defaults to dev-crew itself

No changes to the orchestrator API. The `GITHUB_REPO` env var is the default, per-request `repo` overrides it.

## Operational Usage

### Setup (one-time)
```bash
git clone https://github.com/Jason-CullumICT/dev-crew
cd dev-crew/platform
cp .env.example .env    # set GITHUB_TOKEN
docker compose up -d
```

### Work on dev-crew itself
```bash
curl -X POST http://localhost:9800/api/work \
  -d '{"task": "Add user authentication"}'
```

### Work on external project
```bash
curl -X POST http://localhost:9800/api/work \
  -d '{"task": "Fix login bug", "repo": "https://github.com/org/project", "repoBranch": "main"}'
```

### Monitor
- `:9800` — orchestrator dashboard (runs, phases, logs)
- `:9801` — static HTML reports (Inspector, QA)
- `:4200` — debug portal (embedded in app at `/orchestration/debug`)
- `GET /api/runs/:id` — programmatic run status

### Failure recovery
- Failed runs preserve volumes → retry reuses code
- Checkpoint-resume (when shipped): `POST /api/runs/:id/retry?resumeFrom=validation`
- Push verification prevents lost work

## Migration Steps

1. Create `Jason-CullumICT/dev-crew` repo on GitHub
2. Copy current state of all three repos into the new structure (no git history)
3. Update all internal references (`GITHUB_REPO`, hardcoded URLs, import paths)
4. Add `portal/Dockerfile`
5. Update `CLAUDE.md` to reflect merged structure
6. Create `templates/` from sanitised copy of Teams/ + tools/
7. Update `platform/docker-compose.yml`
8. Update Dockerfile build contexts for new paths
9. Verify `docker compose up -d` brings everything up
10. Archive original repos (mark as archived on GitHub, add redirect in README)

## Files Changed

| Category | Files |
|----------|-------|
| New repo structure | All files relocated per mapping table above |
| New files | `portal/Dockerfile`, `Source/Frontend/src/pages/OrchestrationDebugPage.tsx`, `templates/**` |
| Modified | `platform/docker-compose.yml`, `platform/Dockerfile.orchestrator`, `platform/Dockerfile.worker`, `platform/.env.example`, `CLAUDE.md`, `platform/orchestrator/lib/config.js` |
| Deleted | `claude-ai-OS/docker/orchestrator/lib/learnings-sync.js` (dead code, from pipeline-optimisations) |

## Testing

- `docker compose up -d` from `platform/` starts all services
- `curl http://localhost:9800/api/health` returns ok
- `POST /api/work` with no repo → workers clone dev-crew
- `POST /api/work` with external repo → workers clone external repo, scaffold applied if no Teams/
- Portal accessible at `:4200` and via iframe in Work-backlog app
- Workers can modify Source/, platform/orchestrator/, Teams/ — all detected as code changes
