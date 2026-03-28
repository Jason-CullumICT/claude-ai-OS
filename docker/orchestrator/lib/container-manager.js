const { readFileSync, existsSync } = require("fs");
const { join } = require("path");
const config = require("./config");

class ContainerManager {
  constructor(dockerClient, portAllocator, tokenPool) {
    this.docker = dockerClient;
    this.ports = portAllocator;
    this.tokens = tokenPool;
  }

  async ensureWorkerImage(forceRebuild = false) {
    // Discover compose-prefixed resource names on first call
    await this._findClaudeConfigVolume();
    await this._findNetwork();

    const exists = await this.docker.imageExists(config.workerImage);
    if (exists && !forceRebuild) {
      console.log(`[container] Worker image ${config.workerImage} ready`);
      return;
    }
    console.log(`[container] Worker image not found or rebuild requested — build needed`);
    // For now, log instruction. Auto-build requires tar context which we add later.
    console.log(`[container] Run: docker build -t ${config.workerImage} -f Dockerfile.worker .`);
  }

  async _cleanOrphanedWorkers() {
    // Find worker containers that exist in Docker but aren't tracked by the port allocator
    try {
      const containers = await this.docker.listContainers({
        filters: { name: ["claude-worker-"] },
      });
      for (const c of containers) {
        const name = (c.Names[0] || "").replace("/", "");
        // Extract run ID from container name: claude-worker-{runId}
        const runId = name.replace("claude-worker-", "");
        if (runId && !this.ports.allocated.has(runId)) {
          console.log(`[container] Cleaning orphaned worker: ${name}`);
          await this.docker.removeContainer(c.Id);
        }
      }
    } catch (err) {
      console.warn(`[container] Orphan cleanup failed: ${err.message}`);
    }
  }

  async _findClaudeConfigVolume() {
    if (this._claudeConfigVolume) return;
    try {
      const volumes = await this.docker.docker.listVolumes();
      const match = (volumes.Volumes || []).find((v) => v.Name.includes("claude-config"));
      if (match) this._claudeConfigVolume = match.Name;
    } catch (err) {
      // Fallback below handles this — log for visibility
      console.log(`[container] Claude config volume lookup failed: ${err.message}`);
    }
    if (!this._claudeConfigVolume) this._claudeConfigVolume = "docker_claude-config";
    console.log(`[container] Claude config volume: ${this._claudeConfigVolume}`);
  }

  async _findNetwork() {
    // Docker Compose prepends project name to networks (e.g., "docker_claude-net")
    // Discover the actual network name dynamically
    if (this._networkName) return this._networkName;
    try {
      const networks = await this.docker.docker.listNetworks();
      const match = networks.find((n) => n.Name.includes("claude-net"));
      if (match) {
        this._networkName = match.Name;
        return this._networkName;
      }
    } catch (err) {
      // Fallback below handles this — log for visibility
      console.log(`[container] Network lookup failed: ${err.message}`);
    }
    // Fallback: try common patterns
    this._networkName = "docker_claude-net";
    return this._networkName;
  }

  async spawnWorker(runId, { repo, repoBranch, credentialsJson } = {}) {
    // Clean up any orphaned worker containers holding ports before allocating
    await this._cleanOrphanedWorkers();

    const ports = this.ports.allocate(runId);
    if (!ports) throw new Error("No ports available — all slots allocated");

    const token = this.tokens.getTokenForWorker(runId);
    const containerName = `claude-worker-${runId}`;
    const volumeName = `workspace-${runId}`;
    const networkName = await this._findNetwork();

    // Per-task repo/branch override (defaults to config)
    const targetRepo = repo || config.githubRepo;
    const targetBranch = repoBranch || config.githubBranch;

    console.log(`[container] Spawning ${containerName} (backend:${ports.backend} frontend:${ports.frontend} network:${networkName})`);

    // Remove any existing container with the same name (stale from previous failed run)
    try { await this.docker.removeContainer(containerName); } catch (err) {
      // Expected: container doesn't exist yet
      console.log(`[container] Stale cleanup for ${containerName}: ${err.reason || err.message}`);
    }

    await this.docker.createVolume(volumeName);

    const container = await this.docker.createContainer({
      Image: config.workerImage,
      name: containerName,
      Cmd: ["tail", "-f", "/dev/null"], // idle until orchestrator sends work
      Env: [
        `WORKSPACE_DIR=/workspace`,
        `GITHUB_REPO=${targetRepo}`,
        `GITHUB_BRANCH=${targetBranch}`,
        `GITHUB_TOKEN=${config.githubToken}`,
        `PROJECT_NAME=${config.projectName}`,
        `RUN_ID=${runId}`,
        `GIT_AUTHOR_NAME=claude-ai-OS`,
        `GIT_AUTHOR_EMAIL=pipeline@claude-ai-os.local`,
      ],
      HostConfig: {
        Binds: [
          `${volumeName}:/workspace`,
        ],
        PortBindings: {
          "3001/tcp": [{ HostPort: String(ports.backend) }],
          "5173/tcp": [{ HostPort: String(ports.frontend) }],
        },
      },
      ExposedPorts: {
        "3001/tcp": {},
        "5173/tcp": {},
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [networkName]: {},
        },
      },
    });

    try {
      await this.docker.startContainer(container.id);
    } catch (err) {
      // Start failed (e.g., port conflict) — clean up the created container
      console.error(`[container] ${containerName} failed to start: ${err.message}`);
      await this.docker.removeContainer(container.id);
      await this.docker.removeVolume(volumeName);
      this.ports.release(runId);
      throw err;
    }

    console.log(`[container] ${containerName} started (id: ${container.id.slice(0, 12)})`);

    // Inject Claude credentials from orchestrator into worker
    await this._injectCredentials(container.id, credentialsJson);

    return {
      containerId: container.id,
      containerName,
      ports,
      tokenId: token.tokenId,
    };
  }

  /**
   * Inject credentials into a worker. Called at spawn AND before each agent exec
   * to handle token refresh during long-running cycles.
   *
   * @param {string} containerId
   * @param {string} [credentialsJson] — pre-resolved credentials JSON from token pool.
   *   If not provided, falls back to reading the host credentials file.
   */
  async refreshCredentials(containerId, credentialsJson) {
    let creds = credentialsJson;
    if (!creds) {
      // Fallback: read from host credentials file (legacy path)
      const credPath = "/root/.claude/.credentials.json";
      try {
        creds = readFileSync(credPath, "utf-8");
      } catch (err) {
        console.warn(`[container] No credentials to inject: ${err.message}`);
        return;
      }
    }

    try {
      await this.docker.execInContainer(
        containerId, "bash", ["-c",
          `mkdir -p /root/.claude && cat > /root/.claude/.credentials.json << 'CREDEOF'\n${creds}\nCREDEOF\nchmod 600 /root/.claude/.credentials.json`
        ],
        { label: "auth", quiet: true }
      );
    } catch (err) {
      console.warn(`[container] Credential injection failed: ${err.message}`);
    }
  }

  // Keep backward compat
  async _injectCredentials(containerId, credentialsJson) {
    return this.refreshCredentials(containerId, credentialsJson);
  }

  /**
   * Spawn a worker reusing an existing volume (for retry of failed runs).
   * Skips clone + npm install since the volume already has the code.
   */
  async spawnWorkerFromVolume(runId, existingVolumeName, { repo, repoBranch, credentialsJson } = {}) {
    await this._cleanOrphanedWorkers();

    const ports = this.ports.allocate(runId);
    if (!ports) throw new Error("No ports available — all slots allocated");

    const token = this.tokens.getTokenForWorker(runId);
    const containerName = `claude-worker-${runId}`;
    const networkName = await this._findNetwork();

    const targetRepo = repo || config.githubRepo;
    const targetBranch = repoBranch || config.githubBranch;

    console.log(`[container] Spawning ${containerName} from existing volume ${existingVolumeName}`);

    try { await this.docker.removeContainer(containerName); } catch (err) {
      // Expected: container doesn't exist yet
      console.log(`[container] Stale cleanup for ${containerName}: ${err.reason || err.message}`);
    }

    const container = await this.docker.createContainer({
      Image: config.workerImage,
      name: containerName,
      Cmd: ["tail", "-f", "/dev/null"],
      Env: [
        `WORKSPACE_DIR=/workspace`,
        `GITHUB_REPO=${targetRepo}`,
        `GITHUB_BRANCH=${targetBranch}`,
        `GITHUB_TOKEN=${config.githubToken}`,
        `PROJECT_NAME=${config.projectName}`,
        `RUN_ID=${runId}`,
        `GIT_AUTHOR_NAME=claude-ai-OS`,
        `GIT_AUTHOR_EMAIL=pipeline@claude-ai-os.local`,
      ],
      HostConfig: {
        Binds: [`${existingVolumeName}:/workspace`],
        PortBindings: {
          "3001/tcp": [{ HostPort: String(ports.backend) }],
          "5173/tcp": [{ HostPort: String(ports.frontend) }],
        },
      },
      ExposedPorts: { "3001/tcp": {}, "5173/tcp": {} },
      NetworkingConfig: { EndpointsConfig: { [networkName]: {} } },
    });

    try {
      await this.docker.startContainer(container.id);
    } catch (err) {
      console.error(`[container] ${containerName} failed to start: ${err.message}`);
      await this.docker.removeContainer(container.id);
      this.ports.release(runId);
      throw err;
    }

    console.log(`[container] ${containerName} started from volume (id: ${container.id.slice(0, 12)})`);
    await this.refreshCredentials(container.id, credentialsJson);

    return {
      containerId: container.id,
      containerName,
      ports,
      tokenId: token.tokenId,
    };
  }

  async initWorkspace(containerId, runId) {
    console.log(`[container] Initializing workspace for cycle/${runId}...`);
    const result = await this.docker.execInContainer(
      containerId,
      "bash",
      ["/app/scripts/setup-cycle-workspace.sh"],
      { label: "setup", env: [`RUN_ID=${runId}`] }
    );
    if (result.exitCode !== 0) {
      throw new Error(`Workspace init failed (exit ${result.exitCode}): ${result.stderr.slice(-500)}`);
    }
    return result;
  }

  async execInWorker(containerId, command, args = [], opts = {}) {
    return this.docker.execInContainer(containerId, command, args, opts);
  }

  async startApp(containerId) {
    const checkBackend = await this.docker.execInContainer(
      containerId, "test", ["-f", "/workspace/Source/Backend/package.json"],
      { quiet: true }
    );
    const checkFrontend = await this.docker.execInContainer(
      containerId, "test", ["-f", "/workspace/Source/Frontend/package.json"],
      { quiet: true }
    );

    const result = { backend: false, frontend: false };

    // Write a supervisor script into the container that keeps apps alive.
    // This runs as a child of PID 1 (tail -f /dev/null) so it persists
    // after the docker exec session that starts it ends.
    const supervisorScript = `#!/bin/bash
# App supervisor — keeps backend and frontend alive
BACKEND_ENTRY=""
FRONTEND_ENTRY=""

if [ -f /workspace/Source/Backend/package.json ]; then
  cd /workspace/Source/Backend
  if [ -f src/index.ts ]; then BACKEND_ENTRY="npx ts-node src/index.ts"
  elif [ -f src/server.ts ]; then BACKEND_ENTRY="npx ts-node src/server.ts"
  elif [ -f src/app.ts ]; then BACKEND_ENTRY="npx ts-node src/app.ts"
  elif [ -f dist/index.js ]; then BACKEND_ENTRY="node dist/index.js"
  elif [ -f dist/server.js ]; then BACKEND_ENTRY="node dist/server.js"
  elif grep -q '"start"' package.json 2>/dev/null; then BACKEND_ENTRY="npm start"
  fi
fi

if [ -f /workspace/Source/Frontend/package.json ]; then
  FRONTEND_ENTRY="npx vite --host 0.0.0.0 --port 5173"
fi

# Start backend
if [ -n "$BACKEND_ENTRY" ]; then
  echo "[supervisor] Starting backend: $BACKEND_ENTRY"
  cd /workspace/Source/Backend
  $BACKEND_ENTRY > /tmp/backend.log 2>&1 &
  BACKEND_PID=$!
  echo "[supervisor] Backend PID: $BACKEND_PID"
fi

# Start frontend
if [ -n "$FRONTEND_ENTRY" ]; then
  echo "[supervisor] Starting frontend: $FRONTEND_ENTRY"
  cd /workspace/Source/Frontend
  $FRONTEND_ENTRY > /tmp/frontend.log 2>&1 &
  FRONTEND_PID=$!
  echo "[supervisor] Frontend PID: $FRONTEND_PID"
fi

# Keep this script alive so its children survive
echo "[supervisor] Apps started. Waiting..."
wait
`;

    // Write supervisor to container and execute it
    await this.docker.execInContainer(
      containerId, "bash", ["-c",
        `cat > /tmp/app-supervisor.sh << 'SUPERVISOR_EOF'\n${supervisorScript}\nSUPERVISOR_EOF\nchmod +x /tmp/app-supervisor.sh`
      ],
      { label: "app:setup", quiet: true }
    );

    // Start supervisor — it runs as a background process inside the container
    // The key: we DON'T wait for it to complete (it runs forever via `wait`)
    // But we DO log if the exec itself fails (e.g., container gone, script missing)
    this.docker.execInContainer(
      containerId, "bash", ["-c", "nohup /tmp/app-supervisor.sh > /tmp/supervisor.log 2>&1 &"],
      { label: "app:supervisor", quiet: true }
    ).catch((err) => {
      console.error(`[container] App supervisor failed to start: ${err.message}`);
    });

    // Give apps time to start
    await new Promise(r => setTimeout(r, 5000));

    // Verify they're running
    if (checkBackend.exitCode === 0) {
      const check = await this.docker.execInContainer(
        containerId, "bash", ["-c", "curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:3001/ || echo 000"],
        { quiet: true }
      );
      result.backend = check.stdout.trim() !== "000";
    }

    if (checkFrontend.exitCode === 0) {
      const check = await this.docker.execInContainer(
        containerId, "bash", ["-c", "curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:5173/ || echo 000"],
        { quiet: true }
      );
      result.frontend = check.stdout.trim() !== "000";
    }

    return result;
  }

  async commitAndPush(containerId, runId, message) {
    console.log(`[container] Committing and pushing cycle/${runId}...`);
    // Sanitize message for shell safety: escape double quotes, strip control chars
    const safeMsg = message.replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
    const result = await this.docker.execInContainer(
      containerId, "bash", ["-c",
        `cd /workspace && ` +
        `git rm -r --cached .playwright/ 2>/dev/null || true && ` +
        `git reset HEAD -- '*.db-shm' '*.db-wal' 2>/dev/null || true && ` +
        `git add -A && ` +
        // Commit if there are staged changes
        `if ! git diff --cached --quiet 2>/dev/null; then ` +
        `git commit -m "${safeMsg}"; fi && ` +
        // Push if there are any unpushed commits (whether we just committed or coders committed earlier)
        `UNPUSHED=$(git log --oneline origin/${runId.includes('/') ? runId : 'cycle/' + runId}..HEAD 2>/dev/null | wc -l || echo 999) && ` +
        `if [ "$UNPUSHED" -gt 0 ] 2>/dev/null || ! git ls-remote --heads origin "cycle/${runId}" | grep -q .; then ` +
        `git push origin "HEAD:cycle/${runId}"; ` +
        `else echo "No unpushed commits"; fi`
      ],
      { label: "git", quiet: true }
    );
    return result;
  }

  async teardown(runId, { keepVolume = false, keepBranch = false } = {}) {
    const containerName = `claude-worker-${runId}`;
    const volumeName = `workspace-${runId}`;

    console.log(`[container] Tearing down ${containerName}...`);

    await this.docker.stopContainer(containerName);
    await this.docker.removeContainer(containerName);

    if (!keepVolume) {
      await this.docker.removeVolume(volumeName);
      console.log(`[container] Volume ${volumeName} removed`);
    }

    if (!keepBranch) {
      // Delete remote branch — run from orchestrator's local context
      try {
        const { execFileSync } = require("child_process");
        execFileSync("git", ["push", "origin", "--delete", `cycle/${runId}`], {
          cwd: config.workspace,
          timeout: 10000,
        });
        console.log(`[container] Branch cycle/${runId} deleted from origin`);
      } catch (err) {
        // Branch may not exist on remote — log but don't fail teardown
        console.warn(`[container] Branch cycle/${runId} delete failed: ${err.message}`);
      }
    }

    this.ports.release(runId);
    console.log(`[container] Ports released for ${runId}`);
  }

  async getWorkerStatus(containerId) {
    return this.docker.getContainerStatus(containerId);
  }
}

module.exports = { ContainerManager };
