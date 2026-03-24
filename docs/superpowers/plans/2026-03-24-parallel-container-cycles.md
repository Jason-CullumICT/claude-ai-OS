# Parallel Container Dev Cycles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the orchestrator from single-container sequential execution to unlimited parallel dev cycles with per-cycle Docker containers, git branches, port pairs, and centralized learnings sync.

**Architecture:** The orchestrator becomes a pure control plane that spawns worker containers via Docker API (dockerode), drives each pipeline phase via `container.exec()`, and merges learnings back to main after each cycle. Workers are passive — they only run commands when the orchestrator tells them to.

**Tech Stack:** Node.js, Express, dockerode, Docker API, git

**Spec:** `docs/superpowers/specs/2026-03-24-parallel-container-cycles-design.md`

**Existing code:** `docker/orchestrator/server.js` (~1100 lines, single file)

---

## File Structure

Decompose monolithic `server.js` into focused modules:

```
docker/orchestrator/
  server.js                    -- Express app, routes, dashboard (~400 lines)
  lib/
    config.js                  -- centralized env var config
    port-allocator.js          -- port allocation, persistence, recovery
    cycle-registry.js          -- in-memory + persisted cycle state
    token-pool.js              -- V1 token management (host credentials)
    docker-client.js           -- dockerode wrapper (exec, logs, image mgmt)
    container-manager.js       -- container lifecycle (spawn, init, monitor, teardown)
    learnings-sync.js          -- merge queue with dedicated git worktree
    workflow-engine.js         -- executeWorkflow rewritten for container mode
    health-monitor.js          -- 30s container poll + phase/cycle timeouts
    dispatch.js                -- dispatch plan parsing (extracted from server.js)
  package.json                 -- add dockerode dependency
docker/scripts/
  setup-cycle-workspace.sh     -- NEW: branch-per-cycle workspace init
  setup-workspace.sh           -- KEEP: legacy fallback mode
  run-team.sh                  -- UNCHANGED
  run-smoketest.sh             -- UNCHANGED
docker/
  docker-compose.yml           -- MODIFIED: Docker socket mount, new env vars
  docker-compose.legacy.yml    -- NEW: backup of current config for rollback
```

---

### Task 1: Phase 0 Foundation -- dockerode + config + legacy backup

**Files:**
- Modify: `docker/orchestrator/package.json`
- Create: `docker/orchestrator/lib/config.js`
- Create: `docker/docker-compose.legacy.yml`
- Modify: `docker/docker-compose.yml`

- [ ] **Step 1: Backup current docker-compose as legacy rollback**

```bash
cp docker/docker-compose.yml docker/docker-compose.legacy.yml
```

- [ ] **Step 2: Add dockerode to package.json**

Add `"dockerode": "^4.0.4"` to dependencies in `docker/orchestrator/package.json`.

- [ ] **Step 3: Create lib/config.js -- centralized env var config**

Create `docker/orchestrator/lib/config.js` with all environment variable defaults:
port (8080), workspace, GitHub settings, port range (backend start 5001, frontend start 5101, size 99), timeouts (cycle 2h, phase 30min, health poll 30s), cleanup (volume retention 24h, disk threshold 10%), worker image name, max feedback loops (2).

- [ ] **Step 4: Update docker-compose.yml**

Add `/var/run/docker.sock:/var/run/docker.sock` volume mount to orchestrator.
Add new env vars: `PORT_RANGE_BACKEND_START`, `PORT_RANGE_FRONTEND_START`, `PORT_RANGE_SIZE`, `CYCLE_TIMEOUT_MS`, `PHASE_TIMEOUT_MS`, `VOLUME_RETENTION_HOURS`, `WORKER_IMAGE`.
Remove app port mappings (4001/4173) from orchestrator -- apps will be on worker containers.

- [ ] **Step 5: Add Docker API connectivity check to server.js startup**

On startup, try `require("dockerode")` and `docker.ping()`. Log success or warn that parallel cycles are disabled (fallback to legacy mode).

- [ ] **Step 6: Commit**

```bash
git add docker/orchestrator/package.json docker/orchestrator/lib/config.js \
  docker/docker-compose.yml docker/docker-compose.legacy.yml
git commit -m "feat: Phase 0 -- dockerode, config module, legacy backup, Docker socket"
```

---

### Task 2: Port Allocator

**Files:**
- Create: `docker/orchestrator/lib/port-allocator.js`

- [ ] **Step 1: Create PortAllocator class**

Methods: `allocate(runId)` returns `{ backend, frontend }` or null if exhausted. `release(runId)` frees ports. `isExhausted()` returns boolean. `getStatus()` returns allocated/total/available counts. `recover(activeRuns)` rebuilds from persisted run data.

Port formula: backend = `portRangeBackendStart + i`, frontend = `portRangeFrontendStart + i`, iterate `i` from 0 to `portRangeSize - 1`, skip already-allocated.

- [ ] **Step 2: Verify module loads**

```bash
cd docker/orchestrator && node -e "const {PortAllocator}=require('./lib/port-allocator'); const pa=new PortAllocator(); console.log(pa.allocate('test')); pa.release('test'); console.log('OK')"
```

Expected: `{ backend: 5001, frontend: 5101 }` then `OK`

- [ ] **Step 3: Commit**

```bash
git add docker/orchestrator/lib/port-allocator.js
git commit -m "feat: port allocator with configurable ranges and recovery"
```

---

### Task 3: Cycle Registry

**Files:**
- Create: `docker/orchestrator/lib/cycle-registry.js`

- [ ] **Step 1: Create CycleRegistry class**

Fields per entry: containerId, containerName, branch, ports, status, tokenId, startedAt, appRunning, currentPhase, phaseStartedAt.

Methods: `register(runId, data)`, `update(runId, fields)`, `get(runId)`, `getActive()` (non-terminal), `getAll()`, `remove(runId)`, `getStatus()` (counts by status), `recover(runs, dockerClient)` -- scans run JSONs + Docker API to reconcile. Containers found running but with non-terminal run status: mark as `interrupted`. Containers gone but run non-terminal: mark as `failed`.

- [ ] **Step 2: Verify module loads**

```bash
cd docker/orchestrator && node -e "const {CycleRegistry}=require('./lib/cycle-registry'); const cr=new CycleRegistry(); cr.register('r1',{status:'planning'}); console.log(cr.get('r1')); console.log('OK')"
```

- [ ] **Step 3: Commit**

```bash
git add docker/orchestrator/lib/cycle-registry.js
git commit -m "feat: cycle registry with in-memory state and restart recovery"
```

---

### Task 4: Docker Client Wrapper

**Files:**
- Create: `docker/orchestrator/lib/docker-client.js`

- [ ] **Step 1: Create DockerClient class**

Wraps dockerode. Constructor takes optional socketPath (default `/var/run/docker.sock`). Property `available` set by `init()` which calls `docker.ping()`.

Key methods:
- `init()` -- ping Docker, set available flag
- `imageExists(name)` -- `docker.getImage(name).inspect()`
- `buildImage(contextPath, tag)` -- `docker.buildImage()` with tar stream
- `createContainer(opts)` -- `docker.createContainer()` with HostConfig for volumes, ports, network, env
- `startContainer(id)`, `stopContainer(id, timeout)`, `removeContainer(id)`
- `execInContainer(containerId, cmd, args, { label, quiet, env })` -- THE CRITICAL METHOD:
  1. `container.exec({ Cmd: [cmd, ...args], AttachStdout: true, AttachStderr: true, Env: env })`
  2. `exec.start({ hijack: true })` to get the stream
  3. Demux stdout/stderr using `docker.modem.demuxStream()`
  4. Stream lines to `process.stdout` with `[label]` prefix (matches current runScript behavior)
  5. Collect into buffers
  6. On stream end, `exec.inspect()` to get ExitCode
  7. Return `{ exitCode, stdout, stderr }`
- `createVolume(name)`, `removeVolume(name)`
- `getContainerLogs(id, follow)` -- returns readable stream
- `listContainers(filters)` -- for recovery

- [ ] **Step 2: Verify module initializes**

```bash
cd docker/orchestrator && node -e "const {DockerClient}=require('./lib/docker-client'); const dc=new DockerClient(); dc.init().then(()=>console.log('connected')).catch(()=>console.log('no docker (expected locally)'))"
```

- [ ] **Step 3: Commit**

```bash
git add docker/orchestrator/lib/docker-client.js
git commit -m "feat: Docker client wrapper with exec, lifecycle, and image management"
```

---

### Task 5: Token Pool V1

**Files:**
- Create: `docker/orchestrator/lib/token-pool.js`

- [ ] **Step 1: Create TokenPool class**

V1: single token from host credentials. Method `getTokenForWorker(runId)` returns `{ tokenId: "host", mountPath: "~/.claude/.credentials.json" }`. Method `getStatus()` returns `{ tokens: 1, available: 1, type: "host-credentials" }`.

- [ ] **Step 2: Commit**

```bash
git add docker/orchestrator/lib/token-pool.js
git commit -m "feat: token pool V1 -- host credentials passthrough"
```

---

### Task 6: setup-cycle-workspace.sh

**Files:**
- Create: `docker/scripts/setup-cycle-workspace.sh`

- [ ] **Step 1: Create the script**

Flow:
1. Configure git identity (GIT_AUTHOR_NAME/EMAIL from env)
2. Configure git credentials (write GITHUB_TOKEN to ~/.git-credentials, set credential.helper store)
3. Build clone URL with token
4. Clone from main branch to /workspace
5. Delete stale remote branch if exists: `git push origin --delete cycle/$RUN_ID` (ignore errors)
6. Create and checkout cycle branch: `git checkout -b cycle/$RUN_ID`
7. Push branch to origin: `git push -u origin cycle/$RUN_ID`
8. Install npm deps (same loop as current setup-workspace.sh)
9. Prisma generate if schema exists

Requires env vars: `GITHUB_REPO`, `GITHUB_TOKEN`, `RUN_ID`, `GITHUB_BRANCH` (defaults to main).

- [ ] **Step 2: Make executable and commit**

```bash
chmod +x docker/scripts/setup-cycle-workspace.sh
git add docker/scripts/setup-cycle-workspace.sh
git commit -m "feat: setup-cycle-workspace.sh -- branch-per-cycle initialization"
```

---

### Task 7: Container Manager

**Files:**
- Create: `docker/orchestrator/lib/container-manager.js`

- [ ] **Step 1: Create ContainerManager class**

Constructor takes: dockerClient, portAllocator, tokenPool, config.

Methods:
- `ensureWorkerImage(forceRebuild)` -- check image exists, build from Dockerfile.worker if missing
- `spawnWorker(runId)` -- allocate ports, get token, create volume `workspace-{runId}`, create container `claude-worker-{runId}` with volume/token/ports/network/env, start container. Returns `{ containerId, containerName, ports, tokenId }`.
- `initWorkspace(containerId, runId)` -- exec `setup-cycle-workspace.sh` in worker with `RUN_ID` env var
- `execInWorker(containerId, command, args, opts)` -- delegate to `dockerClient.execInContainer()`
- `startApp(containerId)` -- exec ts-node/vite inside worker (same detection logic as current startApp)
- `commitAndPush(containerId, runId, message)` -- exec git add/commit/push inside worker
- `teardown(runId, { keepVolume, keepBranch })` -- stop container, remove container, optionally remove volume + delete remote branch
- `getWorkerStatus(containerId)` -- container inspect

- [ ] **Step 2: Commit**

```bash
git add docker/orchestrator/lib/container-manager.js
git commit -m "feat: container manager -- spawn, init, exec, app, teardown workers"
```

---

### Task 8: Learnings Sync

**Files:**
- Create: `docker/orchestrator/lib/learnings-sync.js`

- [ ] **Step 1: Create LearningsSync class**

Constructor takes config. Properties: mergeDir (`/workspace/.learnings-merge`), locked (boolean), lockTimeout (60s).

Methods:
- `acquireLock()` -- wait for lock with 60s auto-release timeout
- `releaseLock()` -- clear lock + timer
- `syncLearnings(runId, branch)` -- acquire lock, ensure merge worktree exists (`git worktree add`), checkout main + pull, checkout learnings files from cycle branch (`git checkout cycle/{runId} -- Teams/*/learnings/*.md Teams/*/*.md`), try CLAUDE.md (skip on conflict), commit + push main, release lock. On any failure: delete worktree, release lock, log error, return `{ success: false, error }`.
- `cleanup()` -- remove merge worktree

- [ ] **Step 2: Commit**

```bash
git add docker/orchestrator/lib/learnings-sync.js
git commit -m "feat: learnings sync -- sequential merge queue with dedicated worktree"
```

---

### Task 9: Health Monitor

**Files:**
- Create: `docker/orchestrator/lib/health-monitor.js`

- [ ] **Step 1: Create HealthMonitor class**

Constructor takes: dockerClient, cycleRegistry, portAllocator, config.

Methods:
- `start()` -- `setInterval(poll, config.healthPollMs)`
- `stop()` -- `clearInterval`
- `poll()` -- for each active cycle: check container status via Docker API, if exited mark failed + free ports, check phase timeout (phaseStartedAt + phaseTimeoutMs < now), check cycle timeout (startedAt + cycleTimeoutMs < now), check disk usage
- `isDiskPressured()` -- return cached disk pressure flag

- [ ] **Step 2: Commit**

```bash
git add docker/orchestrator/lib/health-monitor.js
git commit -m "feat: health monitor -- container polling, timeouts, disk pressure"
```

---

### Task 10: Extract Dispatch Logic from server.js

**Files:**
- Create: `docker/orchestrator/lib/dispatch.js`
- Modify: `docker/orchestrator/server.js`

- [ ] **Step 1: Move dispatch functions from server.js to dispatch.js**

Extract: `findPlanContext()`, `extractRoles()`, `classifyRoles()`, `buildAgentPrompt()`, `parseDispatchPlan()`, `buildFallbackPlan()`, `extractJson()` (approximately lines 197-370 in current server.js).

Functions that call `runClaude()` (like `extractRoles`) need it injected. Export a factory: `createDispatcher(runClaudeFn, workspace)` that returns all functions with dependencies bound.

- [ ] **Step 2: Update server.js to import from dispatch.js**

Replace inline functions with: `const dispatch = require("./lib/dispatch").createDispatcher(runClaude, WORKSPACE);`

- [ ] **Step 3: Verify server.js syntax is valid**

```bash
cd docker/orchestrator && node -c server.js && echo "Syntax OK"
```

- [ ] **Step 4: Commit**

```bash
git add docker/orchestrator/lib/dispatch.js docker/orchestrator/server.js
git commit -m "refactor: extract dispatch logic into lib/dispatch.js"
```

---

### Task 11: Workflow Engine -- Container Mode

**Files:**
- Create: `docker/orchestrator/lib/workflow-engine.js`
- Modify: `docker/orchestrator/server.js`

This is the largest task. Rewrites the execution model.

- [ ] **Step 1: Create WorkflowEngine class**

Constructor takes: `{ containerManager, cycleRegistry, learningsSync, dispatch, selectTeamFn, config }`.

Method `executeWorkflow(run)`:
1. Update registry: status=planning, currentPhase=leader
2. Spawn worker: `containerManager.spawnWorker(run.id)` -- returns containerId, ports
3. Store containerId + ports on run object, save
4. Init workspace: `containerManager.initWorkspace(containerId, run.id)`
5. Leader planning: `containerManager.execInWorker(containerId, "bash", ["/app/scripts/run-team.sh", team, task, planFile])` with label `${team}-leader`
6. Parse dispatch plan: `dispatch.parseDispatchPlan(leaderOutput, task, team)` -- runs locally in orchestrator (reads files from worker volume via Docker exec `cat`)
7. Execute implementation stages: for each agent, `containerManager.execInWorker(containerId, "claude", ["-p", prompt, "--allowedTools", tools, "--output-format", "text"])` with label=role
8. Execute QA stages: same pattern
9. Smoketest: `containerManager.execInWorker(containerId, "bash", ["/app/scripts/run-smoketest.sh"])`
10. Inspector: `containerManager.execInWorker(containerId, "bash", ["/app/scripts/run-team.sh", "TheInspector", ...])`
11. Start app: `containerManager.startApp(containerId)`
12. Commit and push: `containerManager.commitAndPush(containerId, run.id, "feat: ${task}")`
13. Sync learnings: `learningsSync.syncLearnings(run.id, "cycle/" + run.id)`
14. Compute results (same override logic: impl+QA pass -> smoke advisory)
15. Update registry: status=complete, appRunning=true

On failure at any step: teardown worker (keepVolume=true for debugging), free ports, mark failed.

Helper methods:
- `runAgentInWorker(containerId, role, prompt, feedback)` -- same as current runAgent but via container exec
- `executeStageInWorker(containerId, stage, feedback)` -- parallel/sequential agent execution in container

- [ ] **Step 2: Remove old execution code from server.js**

Remove: `executeWorkflow()`, `runAgent()`, `executeStage()`, `startApp()`, `killApp()`, `isPortInUse()`, `waitForPortFree()`, `appProcesses`, `getAppStatus()`, the app management endpoints (`/api/app`, `/api/app/start`, `/api/app/stop`), the auto-start-on-boot logic.

Keep: `selectTeam()`, `runScript()` (for orchestrator-local ops), `runClaude()` (for team routing + dispatch parsing), all run state functions, dashboard, existing API endpoints.

- [ ] **Step 3: Wire WorkflowEngine into POST /api/work handler**

Replace `await executeWorkflow(run)` with `await workflowEngine.executeWorkflow(run)`.

- [ ] **Step 4: Verify syntax**

```bash
cd docker/orchestrator && node -c server.js && echo "Syntax OK"
```

- [ ] **Step 5: Commit**

```bash
git add docker/orchestrator/lib/workflow-engine.js docker/orchestrator/server.js
git commit -m "feat: workflow engine rewrite -- container-based execution with full lifecycle"
```

---

### Task 12: API Endpoints + Dashboard + Integration

**Files:**
- Modify: `docker/orchestrator/server.js`

- [ ] **Step 1: Add cycle management endpoints**

- `GET /api/cycles` -- list active cycles from registry with ports, status, app URLs
- `GET /api/cycles/:id` -- cycle detail from registry
- `POST /api/cycles/:id/stop` -- teardown worker (keep volume+branch), free ports, mark failed
- `POST /api/cycles/:id/cleanup` -- teardown worker (remove volume+branch)
- `GET /api/cycles/:id/logs` -- SSE endpoint streaming container logs via `dockerClient.getContainerLogs()`
- `POST /api/worker-image/rebuild` -- `containerManager.ensureWorkerImage(true)`

- [ ] **Step 2: Update health endpoint**

Return: status, workspace, runs count, cycles status (from registry), ports status (from allocator), tokens status (from pool), docker available flag.

- [ ] **Step 3: Update POST /api/work response**

Add `ports` and `branch` fields to the 201 response.

- [ ] **Step 4: Update dashboard HTML -- Active Cycles panel**

Add a panel above the runs table showing active cycles. Each row: run ID (linked), team badge, status with color, task text, app link (`http://${window.location.hostname}:${ports.frontend}`), logs link, stop button. Show queue depth if ports exhausted.

- [ ] **Step 5: Wire module initialization in server startup**

Import all lib modules. Initialize: dockerClient, portAllocator, cycleRegistry, tokenPool, containerManager, learningsSync, healthMonitor, workflowEngine. On startup: `dockerClient.init()`, if available: `ensureWorkerImage()`, recover state from run JSONs, start health monitor. If not available: log legacy mode.

Add graceful shutdown: `process.on("SIGTERM")` stops health monitor.

- [ ] **Step 6: Build and test end-to-end**

```bash
cd docker && docker compose build orchestrator
docker compose up -d orchestrator
docker compose logs orchestrator --tail 20
# Verify: Docker API connected, worker image ready, N ports available

# Submit a task
curl -X POST http://localhost:9800/api/work \
  -H "Content-Type: application/json" \
  -d '{"task": "Add a health endpoint"}'

# Watch
docker compose logs -f orchestrator

# Verify cycle
curl http://localhost:9800/api/cycles | jq .

# Verify branch
docker compose exec orchestrator bash -c "cd /workspace && git branch -r | grep cycle"
```

- [ ] **Step 7: Commit and push**

```bash
git add docker/orchestrator/server.js
git commit -m "feat: cycle management API, dashboard active cycles, full integration"
git push origin master
```

---

## Post-Implementation Verification

After all tasks complete, verify the full system:

1. **Parallel cycles:** Submit 2 tasks simultaneously, confirm both get containers + unique ports
2. **Branch isolation:** `git branch -r` on the repo shows two `cycle/` branches
3. **App testability:** Open both cycle frontends in separate browser tabs
4. **Chrome automation:** Point Chrome tools at a specific cycle's port
5. **Learnings sync:** After cycles complete, check main branch has updated learnings
6. **Dashboard:** Active cycles panel shows both with clickable [App] links
7. **Stop/cleanup:** Stop a cycle via API, verify port freed and container removed
8. **Orchestrator restart:** Restart orchestrator, verify it recovers running cycles
9. **Fallback:** Remove Docker socket mount, verify single-container mode works
10. **Queue:** Allocate all ports, submit another task, verify it queues
