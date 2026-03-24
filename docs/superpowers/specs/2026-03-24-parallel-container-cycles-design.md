# Parallel Container Dev Cycles — Design Specification

## Problem

The current orchestrator runs one dev cycle at a time in a single shared workspace volume. This means:
- No isolation between cycles (agents can overwrite each other)
- No branch-per-cycle (all work on one branch)
- No parallel execution (queue waits for current cycle)
- No per-cycle testability (one app on fixed ports)
- Agent learnings don't compound across cycles

## Goals

1. **Parallel execution** — unlimited concurrent dev cycles, each isolated
2. **Branch-per-cycle** — every cycle works on its own git branch
3. **Testable** — each cycle's app runs on its own port pair, accessible from the host; Chrome automation can hit any cycle on demand
4. **Centralized learnings** — agent discoveries (Teams/*/learnings/*.md, team role improvements, CLAUDE.md changes) sync back to main after each cycle, making all future cycles smarter
5. **Production path** — supports multiple Claude tokens, scales to Docker Swarm/K8s

## Architecture

```
Orchestrator Container :9800 (control plane)
  ├── POST /api/work → route → spawn worker
  ├── Cycle Registry (active cycles, ports, containers)
  ├── Port Allocator (5001-5099 backend, 5101-5199 frontend)
  ├── Token Pool (credentials per worker)
  ├── Learnings Merge Queue (sequential lock)
  ├── Container Health Monitor (30s poll)
  │
  │  Docker API (/var/run/docker.sock)
  │
  ├── Worker 1 (CYCLE-005, branch cycle/005, host 5001/5101)
  ├── Worker 2 (CYCLE-006, branch cycle/006, host 5002/5102)
  ├── Worker 3 (CYCLE-007, branch cycle/007, host 5003/5103)
  └── Worker N ...
```

Inside every worker container, ports are always 3001 (backend) and 5173 (frontend).
Only the host-side mapping varies per cycle. Agent prompts, vite config, and backend
config require zero changes.

## Components

### 1. Port Allocator

Assigns unique host port pairs per cycle from a configurable range.

- Backend range: 5001-5099 (maps to container :3001)
- Frontend range: 5101-5199 (maps to container :5173)
- Persistence: port assignments stored in run JSON files on disk
- Recovery: on orchestrator restart, scan active run JSONs to rebuild port map
- Release: ports freed when cycle completes or container dies
- Configurable via PORT_RANGE_START env var

### 2. Container Lifecycle Manager

Manages worker containers via Docker API (dockerode npm package).

**Spawn:**
1. Create named volume: workspace-{run-id}
2. Create container from worker image:
   - Volume: workspace-{run-id} at /workspace
   - Auth: per-worker token from pool, or host credentials as default
   - Ports: {host-backend}:3001, {host-frontend}:5173
   - Network: claude-net
   - Env: WORKSPACE_DIR, GITHUB_REPO, GITHUB_BRANCH=cycle/{run-id}, GITHUB_TOKEN
3. Start container
4. Run setup-workspace.sh via Docker exec (clone branch, install deps)

**Monitor:**
- Poll container status every 30 seconds via Docker API
- Detect unexpected exits: mark run as failed, free ports
- Log container resource usage for capacity planning

**Teardown:**
- Stop container (SIGTERM, then SIGKILL after 10s)
- On successful merge: remove volume after 24h (configurable)
- On failure: keep volume for debugging
- Remove container

### 3. Cycle Registry

In-memory + persisted registry of all active cycles.

Fields per cycle: containerId, containerName, branch, ports (backend + frontend),
status (planning/implementing/qa/validating/merging/complete/failed), tokenId,
startedAt, appRunning.

Persisted via run JSON files (existing pattern). On restart, scan files + Docker API
to reconcile state.

### 4. Token Pool

Manages Claude authentication credentials for workers.

**V1 (single user):**
- Single token from host ~/.claude/.credentials.json
- All workers share it
- Rate limit handling: log and continue (Claude handles backoff)

**V2 (production):**
- tokens.json config with multiple credentials
- Round-robin assignment to new workers
- Track usage per token
- Queue cycles when all tokens are rate-limited

### 5. Learnings Merge Queue

Sequential merge of institutional knowledge back to main.

**What syncs back (auto-merged to main):**
- Teams/*/learnings/*.md — agent discoveries
- Teams/*/*.md — team role improvements (if modified)
- CLAUDE.md — project instruction improvements (skip if conflict, include in PR instead)

**What stays on branch (comes through PRs):**
- Source/ — all application code
- Plans/ — plans, contracts, reports
- Specifications/ — spec changes
- docs/reports/ — audit reports
- tools/ — pipeline state

**Flow:**
1. Cycle completes, worker commits all changes to cycle branch and pushes
2. Orchestrator acquires merge lock (one at a time)
3. Checkout main, pull latest
4. Cherry-pick only learnings/teams files from cycle branch
5. Commit to main: "chore: sync learnings from cycle/{run-id}"
6. Push main
7. Release lock

**Conflict handling:**
- Learnings files are append-only by convention
- If merge conflict occurs: keep both versions (ours + theirs), flag for review
- CLAUDE.md conflicts: skip auto-merge, include in PR for manual review

### 6. Agent Dispatch (Modified)

Current runScript/runClaude functions spawn local processes. New model uses Docker
exec to run commands inside worker containers.

**Change:** Add containerId parameter to runScript. When present, use dockerode
container.exec() API instead of local spawn. Streams stdout/stderr back to
orchestrator logs tagged with cycle ID + agent role.

**Agent prompts unchanged:** Agents receive WORKSPACE_DIR=/workspace which resolves
inside their container to the cycle-specific volume. All relative paths work.

### 7. App Launcher (Per-Worker)

Each worker runs its own app on its allocated ports.

- Inside container: backend on 3001, frontend on 5173 (always)
- Host mapping: container:3001 mapped to host:500N, container:5173 mapped to host:51NN
- Vite proxy config unchanged: /api targets localhost:3001 (resolves inside container)
- Dashboard shows clickable links per cycle

### 8. Dashboard Updates

Active Cycles panel showing per-cycle: team, status, port links, action buttons.

Each cycle row shows:
- Run ID, team name, current status
- Task description
- [App] link to frontend port (clickable)
- [Logs] for streaming container logs
- [Stop] to kill the cycle

### 9. Workflow (New)

```
POST /api/work
  -> Route to team (Claude decides)
  -> Allocate ports from pool
  -> Create branch cycle/{run-id} from main, push to origin
  -> Spawn worker container (own volume, branch, ports, token)
  -> Init workspace (clone branch, npm install)
  -> Leader plans (in worker via Docker exec)
  -> Dispatch agents (in worker via Docker exec)
  -> QA agents (in worker via Docker exec)
  -> Smoketest (in worker)
  -> Inspector (in worker)
  -> Start app (in worker on allocated ports)
  -> Push cycle branch to origin
  -> Sync learnings to main (merge queue)
  -> Update dashboard with app links
```

Everything after "spawn worker" runs inside the worker container.
The orchestrator is purely a control plane.

### 10. docker-compose.yml Changes

Orchestrator gains:
- /var/run/docker.sock mount (Docker API access)
- PORT_RANGE_START env var

Port ranges are NOT mapped on the orchestrator. Worker containers get their own
port bindings created dynamically via Docker API HostConfig.PortBindings.

### 11. New Dependencies

dockerode — Docker API client for container lifecycle. No other new dependencies.

### 12. API Changes

**New endpoints:**
- GET /api/cycles — list active cycles with ports, status, container info
- GET /api/cycles/:id — cycle detail (logs, agents, app URLs)
- POST /api/cycles/:id/stop — stop a running cycle
- POST /api/cycles/:id/cleanup — remove cycle volume + container
- GET /api/tokens — token pool status (V2)
- POST /api/tokens — add token to pool (V2)

**Modified endpoints:**
- POST /api/work — returns allocated ports in response
- GET /api/runs/:id — includes container ID, ports, app URLs
- GET /api/health — includes active cycle count, port utilization

### 13. Volume Cleanup Policy

- Cycle merged successfully: remove volume after 24h (configurable)
- Cycle failed: keep volume indefinitely (debugging)
- Manual: POST /api/cycles/:id/cleanup
- Disk pressure: alert on dashboard, suggest cleanup

### 14. Error Handling

- No ports available: queue the cycle, start when ports free up
- Container spawn fails: mark run as failed, free ports, log error
- Worker crashes mid-cycle: detect via health monitor, mark failed, free ports
- Auth token exhausted: log 429, agent retries with backoff
- Merge conflict on learnings: keep both versions, flag for review
- Merge conflict on CLAUDE.md: skip auto-merge, include in PR
- Orchestrator restart: recover state from run JSONs + Docker API
- Docker socket unavailable: fall back to single-container mode (current behavior)

### 15. Migration Path

**Phase 1 (this implementation):**
Docker API integration, port allocator, cycle registry, container lifecycle,
branch-per-cycle, learnings merge queue, dashboard with per-cycle app links.

**Phase 2 (pool optimization):**
Pre-spawn N workers, reuse across cycles. Faster startup, same interfaces.

**Phase 3 (cached image):**
Build cycle image with deps pre-installed. Sub-10s cold start.

**Phase 4 (multi-machine):**
Docker Swarm or Kubernetes deployment. Orchestrator as service, workers as pods.
