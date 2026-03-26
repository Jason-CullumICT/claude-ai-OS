const { existsSync, readFileSync } = require("fs");
const { join } = require("path");

class TokenPool {
  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE || "/root";
    this.hostCredentialsPath = join(home, ".claude", ".credentials.json");
    this.envToken = process.env.CLAUDE_SESSION_TOKEN || "";
  }

  /**
   * Resolve the best available Claude session token using the priority chain:
   *   1. Per-request token (from API/UI)
   *   2. Host credentials file (~/.claude/.credentials.json)
   *   3. CLAUDE_SESSION_TOKEN env var
   *
   * @param {string} [perRequestToken] — token passed via /api/work
   * @param {string} [tokenLabel] — human-readable label from caller
   * @returns {{ token: string|null, source: string, label: string, credentialsJson: string|null }}
   */
  async resolveToken(perRequestToken, tokenLabel) {
    // Priority 1: Per-request token
    if (perRequestToken && perRequestToken.startsWith("sk-ant-")) {
      const label = tokenLabel || await this._identifyTokenOwner(perRequestToken) || "custom token";
      // Build a credentials JSON structure that Claude Code expects
      const credentialsJson = JSON.stringify({
        claudeAiOauth: {
          accessToken: perRequestToken,
          refreshToken: "",
          expiresAt: Date.now() + 3600000, // 1 hour from now
          scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
        },
      });
      console.log(`[tokens] Using per-request token (source: api, label: ${label})`);
      return { token: perRequestToken, source: "api", label, credentialsJson };
    }

    // Priority 2: Host credentials file
    if (existsSync(this.hostCredentialsPath)) {
      try {
        const raw = readFileSync(this.hostCredentialsPath, "utf-8");
        const creds = JSON.parse(raw);
        const accessToken = creds?.claudeAiOauth?.accessToken;
        if (accessToken) {
          console.log("[tokens] Using host credentials file");
          return { token: accessToken, source: "host", label: "host session", credentialsJson: raw };
        }
      } catch (err) {
        console.warn(`[tokens] Host credentials file unreadable: ${err.message}`);
      }
    }

    // Priority 3: Env var
    if (this.envToken) {
      const credentialsJson = JSON.stringify({
        claudeAiOauth: {
          accessToken: this.envToken,
          refreshToken: "",
          expiresAt: Date.now() + 3600000,
          scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
        },
      });
      console.log("[tokens] Using CLAUDE_SESSION_TOKEN env var");
      return { token: this.envToken, source: "env", label: "env token", credentialsJson };
    }

    console.error("[tokens] No Claude session token available from any source");
    return { token: null, source: "none", label: "no token", credentialsJson: null };
  }

  /**
   * Try to identify the owner of a token by calling the Anthropic API.
   * Returns a display name or null if identification fails.
   */
  async _identifyTokenOwner(token) {
    try {
      // Try the Claude API profile endpoint
      const resp = await fetch("https://api.claude.ai/api/auth/current_account", {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const name = data.display_name || data.name || data.email;
        if (name) {
          console.log(`[tokens] Identified token owner: ${name}`);
          return `${name}'s token`;
        }
      }
    } catch (err) {
      // Identification is best-effort — don't fail the pipeline
      console.log(`[tokens] Token owner identification unavailable: ${err.message}`);
    }
    return null;
  }

  /**
   * Legacy method — returns basic info about host credentials availability.
   */
  getTokenForWorker(runId) {
    return {
      tokenId: "host",
      mountPath: this.hostCredentialsPath,
      available: existsSync(this.hostCredentialsPath),
    };
  }

  getStatus() {
    const hostAvailable = existsSync(this.hostCredentialsPath);
    const envAvailable = !!this.envToken;
    return {
      tokens: 1,
      available: (hostAvailable || envAvailable) ? 1 : 0,
      type: hostAvailable ? "host-credentials" : envAvailable ? "env-token" : "none",
      sources: {
        host: hostAvailable,
        env: envAvailable,
      },
    };
  }
}

module.exports = { TokenPool };
