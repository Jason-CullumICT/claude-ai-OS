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
    } catch {}
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
    } catch {}
    // Fallback: try common patterns
    this._networkName = "docker_claude-net";
    return this._networkName;
  }

  async spawnWorker(runId) {
    // Clean up any orphaned worker containers holding ports before allocating
    await this._cleanOrphanedWorkers();

    const ports = this.ports.allocate(runId);
    if (!ports) throw new Error("No ports available — all slots allocated");

    const token = this.tokens.getTokenForWorker(runId);
    const containerName = `claude-worker-${runId}`;
    const volumeName = `workspace-${runId}`;
    const networkName = await this._findNetwork();

    console.log(`[container] Spawning ${containerName} (backend:${ports.backend} frontend:${ports.frontend} network:${networkName})`);

    // Remove any existing container with the same name (stale from previous failed run)
    try { await this.docker.removeContainer(containerName); } catch {}

    await this.docker.createVolume(volumeName);

    const container = await this.docker.createContainer({
      Image: config.workerImage,
      name: containerName,
      Cmd: ["tail", "-f", "/dev/null"], // idle until orchestrator sends work
      Env: [
        `WORKSPACE_DIR=/workspace`,
        `GITHUB_REPO=${config.githubRepo}`,
        `GITHUB_BRANCH=${config.githubBranch}`,
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
    await this._injectCredentials(container.id);

    return {
      containerId: container.id,
      containerName,
      ports,
      tokenId: token.tokenId,
    };
  }

  async _injectCredentials(containerId) {
    // Read credentials from orchestrator's own filesystem (bind-mounted from host)
    const credPath = "/root/.claude/.credentials.json";
    try {
      const creds = readFileSync(credPath, "utf-8");
      // Write into worker via exec
      await this.docker.execInContainer(
        containerId, "bash", ["-c",
          `mkdir -p /root/.claude && cat > /root/.claude/.credentials.json << 'CREDEOF'\n${creds}\nCREDEOF\nchmod 600 /root/.claude/.credentials.json`
        ],
        { label: "auth", quiet: true }
      );
      console.log("[container] Credentials injected into worker");
    } catch (err) {
      console.warn(`[container] Failed to inject credentials: ${err.message}`);
    }
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
    // Check what exists and start appropriately
    const checkBackend = await this.docker.execInContainer(
      containerId, "test", ["-f", "/workspace/Source/Backend/package.json"],
      { quiet: true }
    );
    const checkFrontend = await this.docker.execInContainer(
      containerId, "test", ["-f", "/workspace/Source/Frontend/package.json"],
      { quiet: true }
    );

    const result = { backend: false, frontend: false };

    if (checkBackend.exitCode === 0) {
      // Start backend in background
      await this.docker.execInContainer(
        containerId, "bash", ["-c",
          "cd /workspace/Source/Backend && " +
          "(npx ts-node src/index.ts > /tmp/backend.log 2>&1 &) || " +
          "(node dist/index.js > /tmp/backend.log 2>&1 &) || " +
          "(npm start > /tmp/backend.log 2>&1 &)"
        ],
        { label: "app:backend", quiet: true }
      );
      result.backend = true;
    }

    if (checkFrontend.exitCode === 0) {
      await this.docker.execInContainer(
        containerId, "bash", ["-c",
          "cd /workspace/Source/Frontend && npx vite --host 0.0.0.0 --port 5173 > /tmp/frontend.log 2>&1 &"
        ],
        { label: "app:frontend", quiet: true }
      );
      result.frontend = true;
    }

    return result;
  }

  async commitAndPush(containerId, runId, message) {
    console.log(`[container] Committing and pushing cycle/${runId}...`);
    const result = await this.docker.execInContainer(
      containerId, "bash", ["-c",
        `cd /workspace && git add -A && ` +
        `git diff --cached --quiet || git commit -m "${message}" && ` +
        `git push origin "cycle/${runId}"`
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
      } catch {}
    }

    this.ports.release(runId);
    console.log(`[container] Ports released for ${runId}`);
  }

  async getWorkerStatus(containerId) {
    return this.docker.getContainerStatus(containerId);
  }
}

module.exports = { ContainerManager };
