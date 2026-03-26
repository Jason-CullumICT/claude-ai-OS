const { execFileSync } = require("child_process");
const config = require("./config");

class LearningsSync {
  constructor() {
    // Use the orchestrator's own workspace — it's already on the main branch
    this.repoDir = config.workspace;
    this.locked = false;
    this.lockTimer = null;
    this.lockTimeout = 60000;
  }

  async acquireLock() {
    const start = Date.now();
    while (this.locked) {
      if (Date.now() - start > this.lockTimeout) {
        console.warn("[learnings] Lock timeout — force releasing");
        this.releaseLock();
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    this.locked = true;
    this.lockTimer = setTimeout(() => {
      console.warn("[learnings] Lock auto-release (timeout)");
      this.releaseLock();
    }, this.lockTimeout);
  }

  releaseLock() {
    this.locked = false;
    if (this.lockTimer) {
      clearTimeout(this.lockTimer);
      this.lockTimer = null;
    }
  }

  _git(args) {
    return execFileSync("git", args, {
      cwd: this.repoDir,
      timeout: 30000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  async syncLearnings(runId, branch) {
    await this.acquireLock();
    const mainBranch = config.githubBranch;
    console.log(`[learnings] Syncing learnings from ${branch} to ${mainBranch}...`);

    try {
      // Ensure we're on the main branch and up to date
      this._git(["checkout", mainBranch]);
      this._git(["pull", "origin", mainBranch]);

      // Fetch the cycle branch
      this._git(["fetch", "origin", branch]);

      // Cherry-pick learnings files from the cycle branch
      let hasChanges = false;
      const filePatterns = [
        "Teams/*/learnings/*.md",
        "Teams/TheATeam/*.md",
        "Teams/TheFixer/*.md",
        "Teams/TheInspector/*.md",
        "Teams/Shared/*.md",
      ];

      for (const pattern of filePatterns) {
        try {
          this._git(["checkout", `origin/${branch}`, "--", pattern]);
          hasChanges = true;
        } catch (err) {
          // Pattern may not match (no learnings files yet) — expected and non-fatal
          console.log(`[learnings] Pattern ${pattern}: ${err.message.split("\n")[0]}`);
        }
      }

      // Try CLAUDE.md (skip on conflict)
      try {
        this._git(["checkout", `origin/${branch}`, "--", "CLAUDE.md"]);
        hasChanges = true;
      } catch {
        console.log("[learnings] CLAUDE.md conflict or unchanged — skipping");
      }

      if (hasChanges) {
        try {
          this._git(["add", "-A"]);
          // Check if there's actually anything to commit
          try {
            this._git(["diff", "--cached", "--quiet"]);
            // No diff = nothing to commit
            console.log("[learnings] No new learnings changes to sync");
          } catch {
            // diff --quiet exits non-zero when there ARE changes
            this._git(["commit", "-m", `chore: sync learnings from cycle/${runId}`]);
            this._git(["push", "origin", mainBranch]);
            console.log(`[learnings] Learnings merged to ${mainBranch} from ${branch}`);
          }
        } catch (err) {
          console.error(`[learnings] Commit/push failed: ${err.message}`);
          this.releaseLock();
          return { success: false, error: `Commit/push failed: ${err.message}` };
        }
      } else {
        console.log("[learnings] No learnings files found in cycle branch");
      }

      this.releaseLock();
      return { success: true };
    } catch (err) {
      console.error(`[learnings] Sync failed: ${err.message}`);
      // Reset any partial checkout state
      try { this._git(["checkout", mainBranch]); } catch (resetErr) {
        console.warn(`[learnings] Recovery checkout failed: ${resetErr.message}`);
      }
      try { this._git(["reset", "--hard", `origin/${mainBranch}`]); } catch (resetErr) {
        console.warn(`[learnings] Recovery reset failed: ${resetErr.message}`);
      }
      this.releaseLock();
      return { success: false, error: err.message };
    }
  }

  cleanup() {
    // No worktree to clean up — using the main workspace directly
  }
}

module.exports = { LearningsSync };
