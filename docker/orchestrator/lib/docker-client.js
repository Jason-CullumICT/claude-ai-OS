const Docker = require("dockerode");
const { PassThrough } = require("stream");

class DockerClient {
  constructor(socketPath = "/var/run/docker.sock") {
    this.docker = new Docker({ socketPath });
    this.available = false;
  }

  async init() {
    try {
      await this.docker.ping();
      this.available = true;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  async imageExists(name) {
    try {
      await this.docker.getImage(name).inspect();
      return true;
    } catch { return false; }
  }

  async createContainer(opts) {
    return this.docker.createContainer(opts);
  }

  async startContainer(containerId) {
    const container = this.docker.getContainer(containerId);
    await container.start();
  }

  async stopContainer(containerId, timeout = 10) {
    try {
      const container = this.docker.getContainer(containerId);
      await container.stop({ t: timeout });
    } catch (err) {
      // Expected when container already stopped or doesn't exist
      console.log(`[docker] stopContainer ${containerId}: ${err.reason || err.message}`);
    }
  }

  async removeContainer(containerId) {
    try {
      const container = this.docker.getContainer(containerId);
      await container.remove({ force: true });
    } catch (err) {
      // Expected when container doesn't exist
      console.log(`[docker] removeContainer ${containerId}: ${err.reason || err.message}`);
    }
  }

  async execInContainer(containerId, cmd, args = [], { label, quiet, env } = {}) {
    const container = this.docker.getContainer(containerId);
    const tag = label || cmd;

    const exec = await container.exec({
      Cmd: [cmd, ...args],
      AttachStdout: true,
      AttachStderr: true,
      Env: env || [],
    });

    const stream = await exec.start({ hijack: true, stdin: false });

    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const stdoutStream = new PassThrough();
      const stderrStream = new PassThrough();

      this.docker.modem.demuxStream(stream, stdoutStream, stderrStream);

      stdoutStream.on("data", (d) => {
        const chunk = d.toString();
        stdout += chunk;
        if (!quiet) {
          for (const line of chunk.split("\n")) {
            if (line.trim()) process.stdout.write(`  [${tag}] ${line}\n`);
          }
        }
      });

      stderrStream.on("data", (d) => {
        const chunk = d.toString();
        stderr += chunk;
        if (!quiet) {
          for (const line of chunk.split("\n")) {
            if (line.trim()) process.stderr.write(`  [${tag}] ${line}\n`);
          }
        }
      });

      stream.on("end", async () => {
        try {
          const inspect = await exec.inspect();
          resolve({ exitCode: inspect.ExitCode, stdout, stderr });
        } catch (err) {
          resolve({ exitCode: 1, stdout, stderr: stderr + err.message });
        }
      });

      stream.on("error", reject);
    });
  }

  async getContainerStatus(containerIdOrName) {
    try {
      const container = this.docker.getContainer(containerIdOrName);
      const info = await container.inspect();
      return info.State.Running ? "running" : info.State.Status;
    } catch { return "not_found"; }
  }

  async createVolume(name) {
    return this.docker.createVolume({ Name: name });
  }

  async removeVolume(name) {
    try {
      const volume = this.docker.getVolume(name);
      await volume.remove();
    } catch (err) {
      // Expected when volume doesn't exist or is in use
      console.log(`[docker] removeVolume ${name}: ${err.reason || err.message}`);
    }
  }

  async getContainerLogs(containerId, follow = false) {
    const container = this.docker.getContainer(containerId);
    return container.logs({
      stdout: true, stderr: true, follow, timestamps: true,
    });
  }

  async listContainers(filters = {}) {
    return this.docker.listContainers({ all: true, filters });
  }
}

module.exports = { DockerClient };
