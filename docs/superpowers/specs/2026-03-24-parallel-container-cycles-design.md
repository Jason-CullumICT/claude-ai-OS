# Parallel Container Dev Cycles — Design Specification

## Problem

The current orchestrator runs one dev cycle at a time in a single shared workspace volume. This means:
- No isolation between cycles (agents can overwrite each other)
- No branch-per-cycle (all work on one branch)
- No parallel execution (queue waits for current cycle)
- No per-cycle testability (one app on fixed ports)
- Agent learnings don't compound across cycles

## Goals

1. **Parallel execution** — up to 99 concurrent dev cycles (configurable range), queued beyond that
2. **Branch-per-cycle** — every cycle works on its own git branch
3. **Testable** — each cycle's app runs on its own port pair, accessible from the host; Chrome automation can hit any cycle on demand
4. **Centralized learnings** — agent discoveries (Teams/*/learnings/*.md, team role improvements, CLAUDE.md changes) sync back to main after each cycle, making all future cycles smarter
5. **Production path** — supports multiple Claude tokens, scales to Docker Swarm/K8s
6. **Graceful fallback** — if Docker socket is unavailable, fall back to single-container mode (current behavior)

## Architecture

```
Orchestrator Container :9800 (control plane only — never runs agents)
  ├── POST /api/work → route → spawn worker
  ├── Cycle Registry (active cycles, ports, containers)
  ├── Port Allocator (configurable range, default 99 slots)
  ├── Token Pool (credentials per worker)
  ├── Learnings Merge Queue (sequential lock, dedicated worktree)
  ├── Container Health Monitor (30s poll + per-phase timeouts)
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

## Execution Model

**The orchestrator is the control plane.** It drives every phase of every cycle by
sending commands to worker containers via `dockerode container.exec()`. Workers are
idle (`tail -f /dev/null`) until the orchestrator sends work. This preserves the
orchestrator's ability to:
- Manage feedback loops between QA and implementation
- Persist per-phase state to run JSONs
- Stream agent output to the dashboard
- Apply timeouts per phase and per cycle
- Coordinate learnings merges across cycles

Workers never run autonomously. The orchestrator is always in control.

## Components

### 1. Port Allocator

Assigns unique host port pairs per cycle from a configurable range.

**Port formula:**
- `PORT_RANGE_BACKEND_START` (default: 5001) — first backend port
- `PORT_RANGE_FRONTEND_START` (default: 5101) — first frontend port
- `PORT_RANGE_SIZE` (default: 99) — number of slots
- Backend range: `[BACKEND_START .. BACKEND_START + SIZE - 1]`
- Frontend range: `[FRONTEND_START .. FRONTEND_START + SIZE - 1]`

**Persistence:** Port assignments stored in run JSON files on disk.
**Recovery:** On orchestrator restart, scan active run JSONs AND verify against
Docker API actual port bindings to rebuild port map.
**Release:** Ports freed when cycle completes or container dies.
**Exhaustion:** When all ports are allocated, new cycles are queued. Queue is
FIFO. Dashboard shows queue depth.

### 2. Worker Image Management

Workers use the existing `Dockerfile.worker` image.

**Image name:** `claude-ai-os-worker:latest` (configurable via `WORKER_IMAGE` env var).

**Build strategy:**
- On orchestrator startup, check if image exists via Docker API.
- If missing, build from `Dockerfile.worker` in the mounted build context.
- If present, use cached image.
- Manual rebuild: `POST /api/worker-image/rebuild` endpoint.
- Stale detection: compare Dockerfile checksum in orchestrator against image label.
  Log warning if mismatch; don't auto-rebuild (breaking change risk).

**Image includes:** Node.js, Go, Claude Code CLI, git, jq, python3 (same as current).
**Image does NOT include:** Playwright browsers (see Section 16: Smoketest Strategy).

### 3. Container Lifecycle Manager

Manages worker containers via Docker API (dockerode npm package).

**Spawn:**
1. Create named volume: `workspace-{run-id}`
2. Create container from worker image:
   - Name: `claude-worker-{run-id}` (deterministic, used for recovery)
   - Volume: `workspace-{run-id}` at `/workspace`
   - Auth: per-worker token file mounted at `/root/.claude/.credentials.json:ro`
     (from token pool, or host credentials as default)
   - Ports: `{host-backend}:3001`, `{host-frontend}:5173` via HostConfig.PortBindings
   - Network: `claude-net` via NetworkingConfig (provides DNS resolution for
     github.com, npm registry, and inter-container communication)
   - Env: `WORKSPACE_DIR=/workspace`, `GITHUB_REPO`, `GITHUB_BRANCH=cycle/{run-id}`,
     `GITHUB_TOKEN`, `GIT_AUTHOR_NAME=claude-ai-OS`, `GIT_AUTHOR_EMAIL=pipeline@claude-ai-os.local`
3. Start container
4. Run `setup-cycle-workspace.sh` via Docker exec (see Section 4)

**Monitor:**
- Poll container status every 30 seconds via Docker API
- Detect unexpected exits: mark run as failed, free ports
- Per-cycle timeout: 2 hours default (configurable via `CYCLE_TIMEOUT_MS`)
- Per-phase timeout: 30 minutes default (configurable via `PHASE_TIMEOUT_MS`)
- When timeout exceeded: kill exec session, mark phase as timed out, proceed to teardown

**Teardown:**
- Stop container (SIGTERM, then SIGKILL after 10s)
- Delete remote branch: `git push origin --delete cycle/{run-id}` (after successful merge)
- On successful merge: schedule volume removal after 24h (configurable `VOLUME_RETENTION_HOURS`)
- On failure: keep volume and branch for debugging
- Remove container (always)

### 4. Workspace Initialization (New Script)

New script `setup-cycle-workspace.sh` replaces `setup-workspace.sh` for workers.

**Flow:**
1. Configure git credentials: write GITHUB_TOKEN into git credential helper
   (`git config credential.helper store`, write token to `~/.git-credentials`)
2. Clone the repo: `git clone --branch main --single-branch $CLONE_URL /workspace`
3. Create and checkout cycle branch: `git checkout -b cycle/{run-id}`
4. Push branch to origin: `git push -u origin cycle/{run-id}`
5. Install dependencies (same logic as current setup-workspace.sh lines 41-52)
6. Copy Claude auth (if using env var token instead of mounted file)

**Branch collision handling:** If `cycle/{run-id}` already exists on origin
(from a previous failed run), delete it first: `git push origin --delete cycle/{run-id}`
then create fresh.

**Required token scopes:** `repo` (full repository access) for private repos,
or `public_repo` for public repos. The token must allow branch creation and push.

### 5. Cycle Registry

In-memory + persisted registry of all active cycles.

```
Fields per cycle:
  containerId        — Docker container ID
  containerName      — claude-worker-{run-id} (deterministic)
  branch             — cycle/{run-id}
  ports              — { backend: 5001, frontend: 5101 }
  status             — planning|implementing|qa|validating|merging|complete|failed|interrupted
  tokenId            — which token from pool (default: "host")
  startedAt          — ISO timestamp
  appRunning         — boolean
  currentPhase       — leader|dispatch|stage_0|stage_1|smoketest|inspector
  phaseStartedAt     — ISO timestamp (for timeout tracking)
```

**Persistence:** Stored in run JSON files (existing pattern).

**Recovery on orchestrator restart:**
1. Scan run JSONs for non-terminal status (not complete/failed)
2. For each, check Docker API for container by name `claude-worker-{run-id}`
3. If container is running and phase was mid-exec: mark as `interrupted`,
   log warning, let user decide (retry via revalidate or stop via /api/cycles/:id/stop)
4. If container is gone: mark as `failed` with reason "container lost during restart"
5. Rebuild port map from run JSONs, verify against Docker API actual bindings
6. Free ports for containers that no longer exist

### 6. Token Pool

Manages Claude authentication credentials for workers.

**V1 (single user):**
- Single token from host `~/.claude/.credentials.json`
- Mounted read-only into each worker container
- Rate limit handling: log and continue (Claude handles backoff)

**V2 (production):**
- `tokens.json` config file (permissions: 600, root-only, excluded from git)
- Stored in a Docker secret or encrypted volume for production
- Round-robin assignment to new workers
- Track usage per token
- Queue cycles when all tokens are rate-limited
- `GET /api/tokens` returns usage stats (no raw tokens exposed)

### 7. Learnings Merge Queue

Sequential merge of institutional knowledge back to main.

**What syncs back (auto-merged to main):**
- `Teams/*/learnings/*.md` — agent discoveries
- `Teams/*/*.md` — team role improvements (if modified)
- `CLAUDE.md` — project instruction improvements (skip if conflict, include in PR instead)

**What stays on branch (comes through PRs):**
- `Source/` — all application code
- `Plans/` — plans, contracts, reports
- `Specifications/` — spec changes
- `docs/reports/` — audit reports
- `tools/` — pipeline state

**Merge infrastructure:**
The orchestrator maintains a **dedicated git worktree** at `/workspace/.learnings-merge/`
for merge operations. This worktree is separate from any cycle workspace. If a merge
fails partway through, the worktree is deleted and recreated for the next attempt.

**Flow:**
1. Cycle completes → worker commits all changes to cycle branch and pushes
2. Orchestrator acquires merge lock (mutex, one at a time)
3. Lock has a 60-second timeout — if holder crashes, lock auto-releases
4. In the learnings-merge worktree: `git checkout main && git pull`
5. Cherry-pick only learnings/teams files from cycle branch:
   `git checkout cycle/{run-id} -- Teams/*/learnings/*.md Teams/*/*.md`
6. If CLAUDE.md changed: attempt checkout, skip on conflict (include in PR instead)
7. Commit to main: `"chore: sync learnings from cycle/{run-id}"`
8. Push main
9. Release lock
10. On any failure: delete worktree, recreate next time, release lock, log error

**Conflict handling:**
- Learnings files are append-only by convention (agents add entries, don't rewrite)
- If cherry-pick fails: log conflict, skip the conflicting file, continue with others
- CLAUDE.md conflicts: always skip, include in cycle PR for manual review

### 8. Agent Dispatch (Modified)

Current `runScript`/`runClaude` functions spawn local processes. New model uses
Docker exec to run commands inside worker containers.

**Change:** Add `containerId` parameter to `runScript`. When present, use dockerode
`container.exec()` API instead of local spawn.

```
runScript(command, args, { label, quiet, containerId })
  if containerId:
    → dockerExec(containerId, command, args) → stream stdout/stderr
  else:
    → localSpawn(command, args) → current behavior
```

Streams stdout/stderr back to orchestrator logs tagged with `[cycle-{id}][agent-role]`.
Returns `{ exitCode, stdout, stderr }` — same interface as current runScript.

**Agent prompts unchanged:** Agents receive `WORKSPACE_DIR=/workspace` which resolves
inside their container to the cycle-specific volume. All relative paths work.

### 9. App Launcher (Per-Worker)

Each worker runs its own app on its allocated ports.

- Inside container: backend on 3001, frontend on 5173 (always)
- Host mapping: container:3001 → host:500N, container:5173 → host:51NN
- Vite proxy config unchanged: `/api` targets `localhost:3001` (resolves inside container)
- Started via Docker exec into the worker container
- Dashboard shows clickable links per cycle

**The orchestrator no longer runs its own app.** The current app launcher (startApp/killApp)
is removed. All apps run inside worker containers. The orchestrator serves only the
dashboard at :9800.

### 10. Dashboard Updates

Active Cycles panel showing per-cycle: team, status, port links, action buttons.

```
┌─────────────────────────────────────────────────────────────┐
│ Active Cycles                                               │
│                                                             │
│ CYCLE-005  TheATeam  IMPLEMENTING  Backend Frontend         │
│   "Add authentication"              [App] [Logs] [Stop]     │
│                                                             │
│ CYCLE-006  TheFixer  QA_RUNNING     Backend Frontend        │
│   "Fix voting bug"                  [App] [Logs] [Stop]     │
│                                                             │
│ Queued: 2 cycles waiting for ports                          │
└─────────────────────────────────────────────────────────────┘
```

**URL construction:** App links use `window.location.hostname` (the browser's
current host) with the cycle's port number. This works from any machine that
can reach the Docker host, not just localhost.

**[Logs]** streams container logs via `dockerode container.logs({ follow: true })`.
Includes both the orchestrator's exec output (agent work) and the container's own
stdout (app server output).

### 11. Workflow (New)

```
POST /api/work
  → Route to team (Claude decides)
  → Allocate ports from pool (or queue if exhausted)
  → Create branch cycle/{run-id} from main, push to origin
  → Spawn worker container (own volume, branch, ports, token)
  → Exec setup-cycle-workspace.sh (clone branch, npm install)
  → Exec leader planning (via Docker exec into worker)
  → Parse dispatch plan (orchestrator-side, same as current)
  → Exec implementation agents (via Docker exec into worker)
  → Exec QA agents (via Docker exec into worker)
  → Exec smoketest (via Docker exec into worker)
  → Exec inspector (via Docker exec into worker)
  → Exec app start (via Docker exec into worker, on allocated ports)
  → Worker commits + pushes cycle branch
  → Sync learnings to main (merge queue)
  → Update dashboard with app links
  → Create PR for cycle branch → main (optional, configurable)
```

The orchestrator drives every step via `container.exec()`. Workers are passive.

### 12. docker-compose.yml Changes

```yaml
orchestrator:
  build:
    context: .
    dockerfile: Dockerfile.orchestrator
  ports:
    - "${DASHBOARD_PORT:-9800}:8080"
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock  # Docker API access
    - workspace:/workspace                        # Main repo (learnings merge worktree)
    - claude-config:/root/.claude
  environment:
    - GITHUB_REPO
    - GITHUB_BRANCH
    - GITHUB_TOKEN
    - PROJECT_NAME
    - PORT_RANGE_BACKEND_START=5001
    - PORT_RANGE_FRONTEND_START=5101
    - PORT_RANGE_SIZE=99
    - CYCLE_TIMEOUT_MS=7200000
    - PHASE_TIMEOUT_MS=1800000
    - VOLUME_RETENTION_HOURS=24
    - WORKER_IMAGE=claude-ai-os-worker:latest
```

Port ranges are NOT mapped on the orchestrator. Worker containers get their own
port bindings created dynamically via Docker API `HostConfig.PortBindings`.

The orchestrator no longer exposes app ports (4001/4173 removed). Apps are only
served by worker containers on their allocated ports.

### 13. New Dependencies

| Package | Purpose |
|---------|---------|
| `dockerode` | Docker API client for container lifecycle |

No other new dependencies.

### 14. API Changes

**New endpoints:**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/cycles` | List active cycles with ports, status, container info |
| GET | `/api/cycles/:id` | Cycle detail (container logs, agent status, app URLs) |
| POST | `/api/cycles/:id/stop` | Stop a running cycle (kill container, free ports) |
| POST | `/api/cycles/:id/cleanup` | Remove cycle volume + container + remote branch |
| GET | `/api/tokens` | Token pool status (usage, rate limits) — V2 |
| POST | `/api/tokens` | Add a token to the pool — V2 |
| POST | `/api/worker-image/rebuild` | Rebuild the worker Docker image |

**Modified endpoints:**

| Method | Path | Change |
|--------|------|--------|
| POST | `/api/work` | Returns allocated ports + container ID in response |
| GET | `/api/runs/:id` | Includes container ID, ports, app URLs, branch |
| GET | `/api/health` | Includes active cycle count, port utilization, queue depth |

### 15. Volume and Branch Cleanup

| Condition | Volume | Branch | Container |
|-----------|--------|--------|-----------|
| Merged successfully | Remove after VOLUME_RETENTION_HOURS | Delete from origin | Remove immediately |
| Failed | Keep indefinitely | Keep on origin | Remove immediately |
| Manual cleanup | `POST /api/cycles/:id/cleanup` removes all three |
| Disk pressure (< 10% free) | Alert on dashboard, block new cycles, suggest cleanup |

**Disk monitoring:** Check Docker storage usage every 60 seconds. When free space
drops below 10%, block new cycle creation and show alert on dashboard with list of
cleanable cycles (successful, older than retention period).

### 16. Smoketest Strategy

The worker image does NOT include Playwright browsers (200MB+ download per container
is impractical for dynamic spawning).

**Smoketests in workers use HTTP-only validation:**
- Start backend and frontend (same as current adaptive smoketest)
- Health check probes (informational)
- Endpoint discovery from route files (required)
- Run the app's own test suite: `npm test` (ground truth)
- Skip Playwright entirely in worker containers

**Full Playwright E2E:** Run separately if needed, either from the orchestrator
or a dedicated Playwright container pointing at the worker's exposed ports.

### 17. Security Considerations

**Docker socket mount:**
The orchestrator mounts `/var/run/docker.sock`, which grants full root-equivalent
access to the host Docker daemon.

**Mitigations:**
- **Development:** Acceptable risk. The orchestrator is trusted code.
- **Production:** Use a Docker socket proxy (e.g., Tecnativa/docker-socket-proxy)
  that restricts API calls to only: container create/start/stop/remove/exec,
  volume create/remove, network connect. Block privileged container creation,
  host filesystem mounts, and image deletion.
- **Multi-tenant:** Use Docker API over TLS with certificate-based auth instead
  of socket mount. Each tenant gets scoped API credentials.

**Token storage:**
- V1: Host credentials mounted read-only. No tokens on disk in containers.
- V2: `tokens.json` must have file permissions 600 (root-only). Excluded from git
  via .gitignore. For production: use Docker secrets or HashiCorp Vault.

### 18. Log Aggregation

**Per-cycle logs have two sources:**

1. **Exec output** — captured by the orchestrator when running `container.exec()`.
   Tagged with `[cycle-{id}][agent-role]`. Streamed to orchestrator stdout AND
   stored in run JSON `outputTail` fields (existing pattern).

2. **Container logs** — stdout/stderr from the container itself (app server output,
   background processes). Accessible via `dockerode container.logs()` and the
   dashboard's [Logs] button.

**Dashboard [Logs] button:** Streams `docker logs --follow` for the selected
cycle's container via a Server-Sent Events endpoint: `GET /api/cycles/:id/logs`.

### 19. Error Handling

| Scenario | Response |
|----------|----------|
| No ports available | Queue the cycle (FIFO), start when ports free up |
| Container spawn fails | Mark run as failed, free ports, log error |
| Worker crashes mid-cycle | Detect via health monitor, mark failed, free ports |
| Phase timeout (30 min) | Kill exec session, mark phase timed out, teardown |
| Cycle timeout (2 hours) | Kill container, mark failed, free ports |
| Auth token exhausted (429) | Agent retries with backoff (Claude built-in) |
| Merge conflict on learnings | Skip conflicting file, continue with others, log |
| Merge conflict on CLAUDE.md | Skip auto-merge, include in PR |
| Learnings merge lock timeout | Auto-release after 60s, log warning |
| Learnings merge fails midway | Delete merge worktree, recreate next attempt |
| Orchestrator restart mid-cycle | Recover from run JSONs + Docker API. Mid-exec cycles marked interrupted |
| Docker socket unavailable | Fall back to single-container mode (current behavior) |
| Branch already exists | Delete and recreate |
| Disk pressure (< 10% free) | Block new cycles, alert on dashboard |
| Worker image missing | Auto-build on startup from Dockerfile.worker |

### 20. Migration Path

**Phase 0 (preparation):**
Add dockerode dependency. Validate Docker API connectivity on startup. Add cycle
registry and port allocator as inert components (not yet used). Keep current
single-container execution working. This validates the Docker API integration
without changing how agents run.

**Rollback:** Keep `docker-compose.legacy.yml` with the current single-container
setup. If Phase 1 has issues, switch back.

**Phase 1 (this implementation):**
Switch agent execution from local spawn to Docker exec. Container lifecycle,
branch-per-cycle, learnings merge queue, dashboard with per-cycle app links.

**Phase 2 (pool optimization):**
Pre-spawn N workers, reuse across cycles. `getAvailableWorker()` replaces
`createContainer()`. Faster startup, same interfaces.

**Phase 3 (cached image):**
Build cycle image with deps pre-installed. Sub-10s cold start.

**Phase 4 (multi-machine):**
Docker Swarm or Kubernetes deployment. Orchestrator as service, workers as pods.
