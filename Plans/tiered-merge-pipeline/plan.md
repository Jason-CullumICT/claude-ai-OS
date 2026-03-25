# Plan: Tiered Merge Pipeline

## Source Spec
`docs/superpowers/specs/2026-03-25-tiered-merge-pipeline-design.md`

## Risk Level
**HIGH** — Cross-cutting architecture change, new pipeline phases, 10+ files modified, infrastructure changes (Dockerfile).

## Implementation Phases

### Phase 1: Configuration + Run Schema [backend-coder-1]
**FRs:** FR-TMP-007, FR-TMP-009
**Points:** 3 (S+M)
**Files:**
- `docker/orchestrator/lib/config.js` — Add merge strategy env vars
- `docker/orchestrator/server.js` — Initialize new run JSON fields (riskLevel, e2e, pr), update dashboard HTML

**Tasks:**
- [ ] Add to config.js: mergeStrategy, defaultRiskLevel, autoMergeLow, autoMergeMedium
- [ ] Add to run initialization in server.js: riskLevel: null, e2e: null, pr: null
- [ ] Update dashboard HTML to show risk badge, E2E count, PR link
- [ ] Write tests: config defaults, run initialization

### Phase 2: Risk Classification + QA Prompt Augmentation [backend-coder-1]
**FRs:** FR-TMP-001, FR-TMP-002
**Points:** 4 (M+M)
**Files:**
- `docker/orchestrator/lib/workflow-engine.js` — Extract RISK_LEVEL from leader output (Phase 1)
- `docker/orchestrator/lib/dispatch.js` — Augment QA agent prompts with E2E generation instructions

**Tasks:**
- [ ] In workflow-engine.js Phase 1 (after leader output): parse RISK_LEVEL via regex, store on run.riskLevel, default to config.defaultRiskLevel
- [ ] In dispatch.js buildAgentPrompt(): when role is QA, append E2E test generation instructions with run ID substitution
- [ ] Write tests: risk extraction regex, QA prompt augmentation

### Phase 3: Merge Pipeline Module [backend-coder-2]
**FRs:** FR-TMP-003, FR-TMP-004, FR-TMP-005, FR-TMP-006
**Points:** 14 (L+L+L+M)
**Files:**
- `docker/orchestrator/lib/merge-pipeline.js` — [NEW] All merge pipeline logic

**Exports:**
```javascript
async function runPlaywrightE2E(containerManager, containerId, runId)
// Returns: { status: 'passed'|'failed'|'skipped', tests, passed, failed, outputTail }

async function createPR(containerManager, containerId, run, config)
// Returns: { number, url } or null on failure

async function runAIReview(containerManager, containerId, run)
// Returns: { verdict: 'APPROVE'|'REQUEST_CHANGES', comment } or null

async function executeMergeDecision(containerManager, containerId, run, config)
// Returns: { action: 'merged'|'open'|'skipped', status, labels }
```

**Tasks:**
- [ ] Implement runPlaywrightE2E: install chromium (cached), find test files, run playwright, parse JSON output
- [ ] Implement createPR: gh pr create with title/body/labels based on risk level
- [ ] Implement runAIReview: build review prompt, run claude -p, parse APPROVE/REQUEST_CHANGES, post via gh pr review
- [ ] Implement executeMergeDecision: risk matrix logic, gh pr merge for auto-merge, gh pr edit for labels
- [ ] Error handling for each function per spec (graceful skip, logging)
- [ ] Write tests: mock container exec, test each function's logic

### Phase 4: Workflow Engine Integration [backend-coder-2]
**FRs:** FR-TMP-003, FR-TMP-004, FR-TMP-005, FR-TMP-006
**Points:** (shared with Phase 3)
**Files:**
- `docker/orchestrator/lib/workflow-engine.js` — Add Phase 5.5 and Phase 6.5

**Tasks:**
- [ ] After Phase 5 (compute results), add Phase 5.5: call runPlaywrightE2E, store on run.e2e, handle feedback loop on failure
- [ ] After Phase 6 (commit+push), add Phase 6.5: if mergeStrategy !== 'manual', call createPR → runAIReview (if medium/high) → executeMergeDecision, store on run.pr
- [ ] Skip all merge phases when config.mergeStrategy === 'manual'
- [ ] Write tests: phase ordering, skip conditions, feedback loop on E2E failure

### Phase 5: Worker Image Update [backend-coder-1]
**FRs:** FR-TMP-008, FR-TMP-010
**Points:** 2 (S+S)
**Files:**
- `docker/Dockerfile.worker` — Add gh CLI installation
- `Source/E2E/playwright.config.ts` — [NEW] Base Playwright configuration

**Tasks:**
- [ ] Add gh CLI installation to Dockerfile.worker (apt-get)
- [ ] Create playwright.config.ts targeting localhost:5173, chromium, JSON reporter
- [ ] Verify gh auth works with GITHUB_TOKEN

## Coder Assignment

### Scaling Decision
Total points: 23 (backend only). Per scaling rules: 13+ points → 3 coders.
However, all FRs are backend/orchestrator with high file proximity. Two coders is optimal to avoid conflicts.

### backend-coder-1 (9 points)
- FR-TMP-007 (S=1): Config env vars
- FR-TMP-009 (M=2): Run JSON schema + dashboard
- FR-TMP-001 (M=2): Risk classification extraction
- FR-TMP-002 (M=2): QA prompt augmentation
- FR-TMP-008 (S=1): Dockerfile gh CLI
- FR-TMP-010 (S=1): Playwright config

**Files owned:** config.js, server.js, dispatch.js, Dockerfile.worker, Source/E2E/playwright.config.ts
**Order:** Phase 1 → Phase 2 → Phase 5

### backend-coder-2 (14 points)
- FR-TMP-003 (L=4): Playwright E2E runner
- FR-TMP-004 (L=4): Auto-PR creation
- FR-TMP-005 (L=4): AI PR review
- FR-TMP-006 (M=2): Auto-merge decision

**Files owned:** merge-pipeline.js (new), workflow-engine.js (Phase 5.5 + 6.5)
**Order:** Phase 3 → Phase 4

## Verification Gates

```bash
# Unit tests for new module
cd /workspace/docker/orchestrator && npm test

# Lint
npm run lint 2>/dev/null || true

# Verify new files exist
test -f docker/orchestrator/lib/merge-pipeline.js
test -f Source/E2E/playwright.config.ts

# Verify config changes
node -e "const c = require('./docker/orchestrator/lib/config'); console.log(c.mergeStrategy, c.defaultRiskLevel)"

# Verify Dockerfile has gh CLI
grep -q "gh" docker/Dockerfile.worker
```

## QA Focus Areas

- **E2E runner error handling:** Verify all skip conditions (no tests, install failure, timeout)
- **Risk extraction:** Test regex with edge cases (mixed case, whitespace, missing)
- **Merge decision matrix:** Test all 5 risk/review combinations
- **PR creation:** Verify title, body, label formatting
- **Feedback loop:** E2E failure triggers re-run, respects max loop count
- **Config:** MERGE_STRATEGY=manual skips all new phases
