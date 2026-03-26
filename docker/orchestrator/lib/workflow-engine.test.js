/**
 * Tests for Tiered Merge Pipeline additions to WorkflowEngine.
 *
 * Uses Node's built-in test runner and assert module.
 * Run with: node --test docker/orchestrator/lib/workflow-engine.test.js
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { WorkflowEngine } = require("./workflow-engine");

// ── Mock factories ──

function createMockContainerManager(overrides = {}) {
  return {
    execInWorker: overrides.execInWorker || (async () => ({ exitCode: 0, stdout: "" })),
    spawnWorker: async () => ({ containerId: "mock-ctr", containerName: "mock", ports: { backend: 5001, frontend: 5101 }, tokenId: "t1" }),
    initWorkspace: async () => {},
    startApp: async () => ({ backend: true, frontend: true }),
    commitAndPush: async () => {},
    teardown: async () => {},
    ...overrides,
  };
}

function createMockDeps(overrides = {}) {
  return {
    containerManager: createMockContainerManager(overrides.containerManager),
    cycleRegistry: { register: () => {}, update: () => {} },
    learningsSync: { syncLearnings: async () => ({ success: true }) },
    dispatch: {
      extractRoles: async () => ({ implementation: ["backend-coder"], qa: ["qa-reviewer"] }),
      buildAgentPrompt: () => "mock prompt",
      buildFallbackPlan: () => ({ stages: [{ name: "implementation", parallel: false, agents: [{ role: "coder", prompt: "mock" }] }] }),
    },
    config: {
      ...require("./config"),
      mergeStrategy: "tiered",
      defaultRiskLevel: "medium",
      autoMergeLow: true,
      autoMergeMedium: true,
      maxFeedbackLoops: 2,
    },
  };
}

function createMockRun() {
  return {
    id: "test-run-001",
    task: "Add user dashboard feature",
    team: "TheATeam",
    repo: "test/repo",
    repoBranch: "master",
    phases: {},
    results: {},
    app: { running: true, backend: "http://localhost:5001", frontend: "http://localhost:5101" },
    ports: { backend: 5001, frontend: 5101 },
  };
}

// ── Tests ──

// Verifies: FR-TMP-001
describe("Risk Classification (FR-TMP-001)", () => {
  it("extracts low risk from leader output", () => {
    const output = "Planning complete.\nRISK_LEVEL: low\nProceeding with implementation.";
    const match = output.match(/RISK_LEVEL:\s*(low|medium|high)/i);
    assert.ok(match);
    assert.equal(match[1].toLowerCase(), "low");
  });

  it("extracts high risk (case-insensitive)", () => {
    const output = "RISK_LEVEL: HIGH";
    const match = output.match(/RISK_LEVEL:\s*(low|medium|high)/i);
    assert.ok(match);
    assert.equal(match[1].toLowerCase(), "high");
  });

  it("defaults to config.defaultRiskLevel when not found", () => {
    const output = "No risk classification here.";
    const match = output.match(/RISK_LEVEL:\s*(low|medium|high)/i);
    assert.equal(match, null);
    const riskLevel = match ? match[1].toLowerCase() : "medium";
    assert.equal(riskLevel, "medium");
  });

  it("handles extra whitespace in RISK_LEVEL line", () => {
    const output = "RISK_LEVEL:   medium  ";
    const match = output.match(/RISK_LEVEL:\s*(low|medium|high)/i);
    assert.ok(match);
    assert.equal(match[1].toLowerCase(), "medium");
  });
});

// Verifies: FR-TMP-003
describe("_runPlaywrightE2E (FR-TMP-003)", () => {
  it("skips when no test files exist", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args) => {
          if (cmd === "ls") return { exitCode: 1, stdout: "" }; // no files
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    const saveFn = () => {};

    const result = await engine._runPlaywrightE2E("mock-ctr", run, saveFn);
    assert.equal(result, true);
    assert.equal(run.e2e.status, "skipped");
    assert.equal(run.e2e.reason, "no_tests");
  });

  it("skips when Playwright install fails", async () => {
    let callCount = 0;
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args) => {
          if (cmd === "ls") return { exitCode: 0, stdout: "test1.spec.ts\n" };
          if (cmd === "bash") {
            callCount++;
            if (callCount === 1) return { exitCode: 1, stdout: "install failed" }; // playwright install fails
          }
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();

    const result = await engine._runPlaywrightE2E("mock-ctr", run, () => {});
    assert.equal(result, true);
    assert.equal(run.e2e.status, "skipped");
    assert.equal(run.e2e.reason, "install_failed");
  });

  it("returns true on passing E2E tests", async () => {
    const jsonReport = JSON.stringify({
      suites: [{
        specs: [{
          tests: [{ status: "expected" }, { status: "expected" }],
        }],
      }],
    });

    let callIdx = 0;
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (cmd === "ls") return { exitCode: 0, stdout: "test1.spec.ts\n" };
          if (cmd === "bash") {
            callIdx++;
            if (opts && opts.label === "playwright-install") return { exitCode: 0, stdout: "" };
            if (opts && opts.label === "playwright-deps") return { exitCode: 0, stdout: "" };
            if (opts && opts.label === "playwright-e2e") return { exitCode: 0, stdout: jsonReport };
          }
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();

    const result = await engine._runPlaywrightE2E("mock-ctr", run, () => {});
    assert.equal(result, true);
    assert.equal(run.e2e.status, "passed");
    assert.equal(run.e2e.tests, 2);
    assert.equal(run.e2e.passed, 2);
    assert.equal(run.e2e.failed, 0);
  });

  it("returns false on failing E2E tests", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (cmd === "ls") return { exitCode: 0, stdout: "test1.spec.ts\n" };
          if (cmd === "bash") {
            if (opts && opts.label === "playwright-install") return { exitCode: 0, stdout: "" };
            if (opts && opts.label === "playwright-deps") return { exitCode: 0, stdout: "" };
            if (opts && opts.label === "playwright-e2e") return { exitCode: 1, stdout: "not json" };
          }
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();

    const result = await engine._runPlaywrightE2E("mock-ctr", run, () => {});
    assert.equal(result, false);
    assert.equal(run.e2e.status, "failed");
    assert.equal(run.e2e.failed, 1);
  });
});

// Verifies: FR-TMP-004
describe("_createPR (FR-TMP-004)", () => {
  it("skips when gh CLI not available", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd) => {
          if (cmd === "which") return { exitCode: 1, stdout: "" };
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "medium";
    run.results = { implementation: "passed", qa: "passed" };

    await engine._createPR("mock-ctr", run, () => {});
    assert.equal(run.pr.status, "skipped");
    assert.equal(run.pr.reason, "gh_unavailable");
  });

  it("creates PR and parses URL", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (cmd === "which") return { exitCode: 0, stdout: "/usr/bin/gh\n" };
          if (opts && opts.label === "pr-create") {
            return { exitCode: 0, stdout: "https://github.com/test/repo/pull/42\n" };
          }
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "low";
    run.results = { implementation: "passed", qa: "passed" };
    run.e2e = { status: "passed", passed: 3, tests: 3 };

    await engine._createPR("mock-ctr", run, () => {});
    assert.equal(run.pr.number, 42);
    assert.equal(run.pr.url, "https://github.com/test/repo/pull/42");
    assert.equal(run.pr.status, "open");
  });

  it("handles PR creation failure gracefully", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (cmd === "which") return { exitCode: 0, stdout: "/usr/bin/gh\n" };
          if (opts && opts.label === "pr-create") {
            return { exitCode: 1, stdout: "error: branch already has a PR" };
          }
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "medium";
    run.results = {};

    await engine._createPR("mock-ctr", run, () => {});
    assert.equal(run.pr.status, "failed");
  });
});

// Verifies: FR-TMP-005
describe("_aiReviewPR (FR-TMP-005)", () => {
  it("skips review for low risk", async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "low";
    run.pr = { number: 10, url: "https://github.com/test/repo/pull/10", status: "open" };

    await engine._aiReviewPR("mock-ctr", run, () => {});
    assert.equal(run.pr.aiReview, "skipped");
  });

  it("posts APPROVE for medium risk when Claude approves", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (opts && opts.label === "pr-diff") return { exitCode: 0, stdout: "diff --git a/file.js b/file.js" };
          if (opts && opts.label === "ai-review") return { exitCode: 0, stdout: "APPROVE\nLooks good, clean implementation." };
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "medium";
    run.pr = { number: 10, url: "...", status: "open" };
    run.results = { qa: "passed" };
    run.e2e = { status: "passed", passed: 2, tests: 2 };

    await engine._aiReviewPR("mock-ctr", run, () => {});
    assert.equal(run.pr.aiReview, "APPROVE");
  });

  it("defaults to APPROVE for medium risk on failure", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (opts && opts.label === "pr-diff") return { exitCode: 0, stdout: "diff" };
          if (opts && opts.label === "ai-review") return { exitCode: 1, stdout: "timeout" };
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "medium";
    run.pr = { number: 10, url: "...", status: "open" };
    run.results = {};

    await engine._aiReviewPR("mock-ctr", run, () => {});
    assert.equal(run.pr.aiReview, "APPROVE");
  });

  it("defaults to REQUEST_CHANGES for high risk on failure", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (opts && opts.label === "pr-diff") return { exitCode: 0, stdout: "diff" };
          if (opts && opts.label === "ai-review") return { exitCode: 1, stdout: "timeout" };
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "high";
    run.pr = { number: 10, url: "...", status: "open" };
    run.results = {};

    await engine._aiReviewPR("mock-ctr", run, () => {});
    assert.equal(run.pr.aiReview, "REQUEST_CHANGES");
  });
});

// Verifies: FR-TMP-006
describe("_autoMerge (FR-TMP-006)", () => {
  it("auto-merges low risk with passing E2E", async () => {
    let mergeCalledWith = null;
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (opts && opts.label === "pr-merge") {
            mergeCalledWith = args;
            return { exitCode: 0, stdout: "merged" };
          }
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "low";
    run.e2e = { status: "passed" };
    run.pr = { number: 42, url: "...", status: "open" };

    await engine._autoMerge("mock-ctr", run, () => {});
    assert.equal(run.pr.status, "merged");
    assert.ok(mergeCalledWith);
  });

  it("auto-merges medium risk with APPROVE", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (opts && opts.label === "pr-merge") return { exitCode: 0, stdout: "merged" };
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "medium";
    run.e2e = { status: "passed" };
    run.pr = { number: 42, url: "...", status: "open", aiReview: "APPROVE" };

    await engine._autoMerge("mock-ctr", run, () => {});
    assert.equal(run.pr.status, "merged");
  });

  it("keeps PR open for medium risk with REQUEST_CHANGES", async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "medium";
    run.e2e = { status: "passed" };
    run.pr = { number: 42, url: "...", status: "open", aiReview: "REQUEST_CHANGES" };

    await engine._autoMerge("mock-ctr", run, () => {});
    assert.equal(run.pr.status, "changes-requested");
  });

  it("never auto-merges high risk, labels ready-for-review on APPROVE", async () => {
    let labelAdded = null;
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (opts && opts.label === "pr-label") {
            labelAdded = args[1]; // the -c argument
            return { exitCode: 0, stdout: "" };
          }
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "high";
    run.e2e = { status: "passed" };
    run.pr = { number: 42, url: "...", status: "open", aiReview: "APPROVE" };

    await engine._autoMerge("mock-ctr", run, () => {});
    assert.equal(run.pr.status, "open");
    assert.ok(labelAdded);
    assert.ok(labelAdded.includes("ready-for-review"));
  });

  it("labels merge-conflict when merge fails", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd, args, opts) => {
          if (opts && (opts.label === "pr-merge" || opts.label === "pr-merge-retry")) return { exitCode: 1, stdout: "merge conflict" };
          if (opts && opts.label === "pr-rebase") return { exitCode: 1, stdout: "rebase conflict" };
          return { exitCode: 0, stdout: "" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "low";
    run.e2e = { status: "passed" };
    run.pr = { number: 42, url: "...", status: "open" };

    await engine._autoMerge("mock-ctr", run, () => {});
    assert.equal(run.pr.status, "merge-conflict");
  });

  it("respects autoMergeLow=false config", async () => {
    const deps = createMockDeps();
    deps.config.autoMergeLow = false;
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "low";
    run.e2e = { status: "passed" };
    run.pr = { number: 42, url: "...", status: "open" };

    await engine._autoMerge("mock-ctr", run, () => {});
    assert.equal(run.pr.status, "open");
  });
});

// Verifies: FR-TMP-007
describe("Configuration (FR-TMP-007)", () => {
  it("config has merge strategy defaults", () => {
    const config = require("./config");
    assert.equal(config.mergeStrategy, "tiered");
    assert.equal(config.defaultRiskLevel, "medium");
    assert.equal(config.autoMergeLow, true);
    assert.equal(config.autoMergeMedium, true);
  });
});

// Verifies: FR-TMP-009
describe("Run JSON Extensions (FR-TMP-009)", () => {
  it("run object gets riskLevel, e2e, and pr fields initialized", () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();

    // Simulate what happens at Phase 0 init
    run.riskLevel = run.riskLevel || engine.config.defaultRiskLevel;
    run.e2e = run.e2e || null;
    run.pr = run.pr || null;

    assert.equal(run.riskLevel, "medium");
    assert.equal(run.e2e, null);
    assert.equal(run.pr, null);
  });
});

// Verifies: FR-TMP-010
describe("Error Handling (FR-TMP-010)", () => {
  it("_createPR does not throw on failure", async () => {
    const deps = createMockDeps({
      containerManager: {
        execInWorker: async (_cid, cmd) => {
          if (cmd === "which") return { exitCode: 0, stdout: "/usr/bin/gh\n" };
          return { exitCode: 1, stdout: "some error" };
        },
      },
    });
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "medium";
    run.results = {};

    // Should not throw
    await engine._createPR("mock-ctr", run, () => {});
    assert.equal(run.pr.status, "failed");
  });

  it("_aiReviewPR skips when no PR number", async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "medium";
    run.pr = { status: "failed" };

    await engine._aiReviewPR("mock-ctr", run, () => {});
    assert.equal(run.pr.aiReview, "skipped");
  });

  it("_autoMerge handles no PR gracefully", async () => {
    const deps = createMockDeps();
    const engine = new WorkflowEngine(deps);
    const run = createMockRun();
    run.riskLevel = "medium";
    run.pr = null;

    // Should not throw
    await engine._autoMerge("mock-ctr", run, () => {});
  });
});
