class CycleRegistry {
  constructor() {
    this.cycles = new Map();
  }

  register(runId, data) {
    this.cycles.set(runId, {
      id: runId,
      containerId: null,
      containerName: null,
      branch: null,
      ports: null,
      status: "pending",
      tokenId: "host",
      startedAt: new Date().toISOString(),
      appRunning: false,
      currentPhase: null,
      phaseStartedAt: null,
      ...data,
    });
  }

  update(runId, fields) {
    const cycle = this.cycles.get(runId);
    if (cycle) Object.assign(cycle, fields);
  }

  get(runId) { return this.cycles.get(runId) || null; }

  getActive() {
    return [...this.cycles.values()].filter(
      (c) => !["complete", "failed"].includes(c.status)
    );
  }

  getAll() { return [...this.cycles.values()]; }

  remove(runId) { this.cycles.delete(runId); }

  getStatus() {
    const all = this.getAll();
    return {
      total: all.length,
      active: all.filter((c) => !["complete", "failed"].includes(c.status)).length,
      complete: all.filter((c) => c.status === "complete").length,
      failed: all.filter((c) => c.status === "failed").length,
    };
  }

  async recover(activeRuns, dockerClient) {
    for (const run of activeRuns) {
      const containerName = `claude-worker-${run.id}`;
      let containerAlive = false;

      if (dockerClient && dockerClient.available) {
        try {
          const status = await dockerClient.getContainerStatus(containerName);
          containerAlive = status === "running";
        } catch (err) {
          console.log(`[cycles] Container status check for ${containerName}: ${err.message}`);
        }
      }

      if (containerAlive) {
        this.register(run.id, {
          ...run,
          status: "interrupted",
          containerName,
        });
        console.log(`[registry] Recovered running cycle: ${run.id} (interrupted)`);
      } else {
        this.register(run.id, {
          ...run,
          status: "failed",
          containerName,
        });
        console.log(`[registry] Cycle ${run.id} container gone — marked failed`);
      }
    }
  }
}

module.exports = { CycleRegistry };
