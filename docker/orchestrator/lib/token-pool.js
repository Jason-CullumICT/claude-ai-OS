const { existsSync } = require("fs");
const { join } = require("path");

class TokenPool {
  constructor() {
    // V1: single token from host credentials
    const home = process.env.HOME || process.env.USERPROFILE || "/root";
    this.hostCredentialsPath = join(home, ".claude", ".credentials.json");
  }

  getTokenForWorker(runId) {
    return {
      tokenId: "host",
      mountPath: this.hostCredentialsPath,
      available: existsSync(this.hostCredentialsPath),
    };
  }

  getStatus() {
    return {
      tokens: 1,
      available: existsSync(this.hostCredentialsPath) ? 1 : 0,
      type: "host-credentials",
    };
  }
}

module.exports = { TokenPool };
