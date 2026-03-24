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
    const exists = await this.docker.imageExists(config.workerImage);
    if (exists && !forceRebuild) {
      console.log(`[container] Worker image ${config.workerImage} ready`);
      return;
    }
    console.log(`[container] Worker image not found or rebuild requested — build needed`);
    // For now, log instruction. Auto-build requires tar context which we add later.
    console.log(`[container] Run: docker build -t ${config.workerImage} -f Dockerfile.worker .`);
  }

  async spawnWorker(runId) {
    const ports = this.ports.allocate(runId);
    if (!ports) throw new Error("No ports available — all slots allocated");

    const token = this.tokens.getTokenForWorker(runId);
    const containerName = `claude-worker-${runId}`;
    const volumeName = `workspace-${runId}`;

    console.log(`[container] Spawning ${containerName} (backend:${ports.backend} frontend:${ports.frontend})`);

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
          ...(token.available ? [`${token.mountPath}:/root/.claude/.credentials.json:ro`] : []),
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
          "claude-net": {},
        },
      },
    });

    await this.docker.startContainer(container.id);
    console.log(`[container] ${containerName} started (id: ${container.id.slice(0, 12)})`);

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
