const { execFileSync } = require("child_process");
const { existsSync, mkdirSync, rmSync } = require("fs");
const config = require("./config");

class LearningsSync {
  constructor() {
    this.mergeDir = `${config.workspace}/.learnings-merge`;
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

  _git(args, cwd) {
    return execFileSync("git", args, {
      cwd: cwd || this.mergeDir,
      timeout: 30000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  _ensureWorktree() {
    if (!existsSync(this.mergeDir)) {
      console.log("[learnings] Creating merge worktree...");
      this._git(["worktree", "add", this.mergeDir, "main"], config.workspace);
    }
  }

  _destroyWorktree() {
    try {
      if (existsSync(this.mergeDir)) {
        rmSync(this.mergeDir, { recursive: true, force: true });
      }
      this._git(["worktree", "prune"], config.workspace);
    } catch {}
  }

  async syncLearnings(runId, branch) {
    await this.acquireLock();
    console.log(`[learnings] Syncing learnings from ${branch} to main...`);

    try {
      this._ensureWorktree();

      // Update main
      this._git(["checkout", "main"]);
      this._git(["pull", "origin", "main"]);

      // Fetch the cycle branch
      this._git(["fetch", "origin", branch]);

      // Cherry-pick learnings files
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
        } catch {} // Pattern may not match — that's OK
      }

      // Try CLAUDE.md (skip on conflict)
      try {
        this._git(["checkout", `origin/${branch}`, "--", "CLAUDE.md"]);
        hasChanges = true;
      } catch {
        console.log("[learnings] CLAUDE.md conflict — skipping (will be in PR)");
      }

      if (hasChanges) {
        try {
          this._git(["add", "-A"]);
          this._git(["commit", "-m", `chore: sync learnings from cycle/${runId}`]);
          this._git(["push", "origin", "main"]);
          console.log(`[learnings] Learnings merged to main from ${branch}`);
        } catch (err) {
          // Nothing to commit
          console.log("[learnings] No learnings changes to sync");
        }
      } else {
        console.log("[learnings] No learnings files found in cycle branch");
      }

      this.releaseLock();
      return { success: true };
    } catch (err) {
      console.error(`[learnings] Sync failed: ${err.message}`);
      this._destroyWorktree();
      this.releaseLock();
      return { success: false, error: err.message };
    }
  }

  cleanup() {
    this._destroyWorktree();
  }
}

module.exports = { LearningsSync };
