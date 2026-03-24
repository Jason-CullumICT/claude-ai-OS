const config = require("./config");

class PortAllocator {
  constructor() {
    this.allocated = new Map(); // runId → { backend, frontend }
  }

  allocate(runId) {
    for (let i = 0; i < config.portRangeSize; i++) {
      const backend = config.portRangeBackendStart + i;
      const frontend = config.portRangeFrontendStart + i;
      const inUse = [...this.allocated.values()].some(
        (p) => p.backend === backend || p.frontend === frontend
      );
      if (!inUse) {
        const ports = { backend, frontend };
        this.allocated.set(runId, ports);
        return ports;
      }
    }
    return null; // exhausted
  }

  release(runId) { this.allocated.delete(runId); }
  isExhausted() { return this.allocated.size >= config.portRangeSize; }

  getStatus() {
    return {
      allocated: this.allocated.size,
      total: config.portRangeSize,
      available: config.portRangeSize - this.allocated.size,
    };
  }

  recover(activeRuns) {
    for (const run of activeRuns) {
      if (run.ports) this.allocated.set(run.id, run.ports);
    }
  }
}

module.exports = { PortAllocator };
