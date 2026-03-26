const { execFileSync } = require("child_process");
const config = require("./config");

class HealthMonitor {
  constructor(dockerClient, cycleRegistry, portAllocator) {
    this.docker = dockerClient;
    this.registry = cycleRegistry;
    this.ports = portAllocator;
    this.interval = null;
    this.diskPressured = false;
  }

  start() {
    if (this.interval) return;
    this.interval = setInterval(() => this.poll(), config.healthPollMs);
    console.log(`[health] Monitoring started (${config.healthPollMs / 1000}s interval)`);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      console.log("[health] Monitoring stopped");
    }
  }

  async poll() {
    const active = this.registry.getActive();

    for (const cycle of active) {
      if (!cycle.containerId) continue;

      try {
        const status = await this.docker.getContainerStatus(cycle.containerId);

        if (status !== "running" && !["complete", "failed", "interrupted"].includes(cycle.status)) {
          console.warn(`[health] Container ${cycle.containerName} died unexpectedly (status: ${status})`);
          this.registry.update(cycle.id, { status: "failed", appRunning: false });
          this.ports.release(cycle.id);
        }

        // Phase timeout
        if (cycle.phaseStartedAt) {
          const phaseElapsed = Date.now() - new Date(cycle.phaseStartedAt).getTime();
          if (phaseElapsed > config.phaseTimeoutMs) {
            console.warn(`[health] Phase timeout for ${cycle.id} (${cycle.currentPhase}, ${Math.round(phaseElapsed / 60000)}min)`);
            // The workflow engine should handle the timeout — we just flag it
            this.registry.update(cycle.id, { status: "failed" });
          }
        }

        // Cycle timeout
        if (cycle.startedAt) {
          const cycleElapsed = Date.now() - new Date(cycle.startedAt).getTime();
          if (cycleElapsed > config.cycleTimeoutMs) {
            console.warn(`[health] Cycle timeout for ${cycle.id} (${Math.round(cycleElapsed / 60000)}min)`);
            this.registry.update(cycle.id, { status: "failed" });
            this.ports.release(cycle.id);
          }
        }
      } catch (err) {
        console.error(`[health] Error checking ${cycle.id}: ${err.message}`);
      }
    }

    // Disk check
    this._checkDisk();
  }

  _checkDisk() {
    try {
      const df = execFileSync("df", ["-P", "/workspace"], { encoding: "utf-8", timeout: 5000 });
      const lines = df.trim().split("\n");
      if (lines.length >= 2) {
        const parts = lines[1].split(/\s+/);
        const usePct = parseInt(parts[4], 10) / 100;
        this.diskPressured = (1 - usePct) < config.diskPressureThreshold;
        if (this.diskPressured) {
          console.warn(`[health] Disk pressure! ${parts[4]} used — blocking new cycles`);
        }
      }
    } catch (err) {
      // df may not be available in all containers — log once
      console.log(`[health] Disk check unavailable: ${err.message}`);
    }
  }

  isDiskPressured() {
    return this.diskPressured;
  }
}

module.exports = { HealthMonitor };
