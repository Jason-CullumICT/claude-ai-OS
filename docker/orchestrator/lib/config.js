/**
 * Centralized configuration — all tunables read from env with sane defaults.
 */

const config = {
  port: Number(process.env.PORT) || 8080,
  workspace: process.env.WORKSPACE_DIR || "/workspace",

  // GitHub
  githubRepo: process.env.GITHUB_REPO || "",
  githubBranch: process.env.GITHUB_BRANCH || "main",
  githubToken: process.env.GITHUB_TOKEN || "",
  projectName: process.env.PROJECT_NAME || "",

  // Port ranges for worker containers
  portRangeBackendStart: Number(process.env.PORT_RANGE_BACKEND_START) || 5001,
  portRangeFrontendStart: Number(process.env.PORT_RANGE_FRONTEND_START) || 5101,
  portRangeSize: Number(process.env.PORT_RANGE_SIZE) || 99,

  // Timeouts
  cycleTimeoutMs: Number(process.env.CYCLE_TIMEOUT_MS) || 7200000,   // 2 hours
  phaseTimeoutMs: Number(process.env.PHASE_TIMEOUT_MS) || 1800000,   // 30 minutes
  healthPollMs: 30000,

  // Cleanup
  volumeRetentionHours: Number(process.env.VOLUME_RETENTION_HOURS) || 24,
  diskPressureThreshold: 0.10,

  // Worker
  workerImage: process.env.WORKER_IMAGE || "claude-ai-os-worker:latest",

  // Feedback
  maxFeedbackLoops: 2,

  // Tiered merge pipeline (FR-TMP-007)
  // Verifies: FR-TMP-007
  mergeStrategy: process.env.MERGE_STRATEGY || "tiered",
  defaultRiskLevel: process.env.DEFAULT_RISK_LEVEL || "medium",
  autoMergeLow: process.env.AUTO_MERGE_LOW !== "false",
  autoMergeMedium: process.env.AUTO_MERGE_MEDIUM !== "false",
};

module.exports = config;
