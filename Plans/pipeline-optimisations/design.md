# Design: Pipeline Optimisations

Traces to: `Plans/pipeline-optimisations/prompt.md`

## 1. Model Downgrades

**Files:** `docker/orchestrator/server.js`, team role `.md` files

Three changes, all safe because the output format is fixed/mechanical:

| Agent | Current | Target | Rationale |
|-------|---------|--------|-----------|
| Team routing (`selectTeam()`) | sonnet (default) | haiku | One-line classification: `TEAM: X \| REASON: Y` |
| `traceability-reporter` (TheATeam) | sonnet | haiku | Scans for `// Verifies: FR-XXX`, reports coverage % |
| `verify-reporter` (TheFixer) | sonnet | haiku | Runs tests + generates traceability report |

**How:** The `runClaude()` call in `selectTeam()` needs a model flag. The team `.md` files already declare model — update the model lines.

Note: chaos-tester stays sonnet — it does adversarial reasoning, not mechanical reporting.

## 2. Conditional Inspector

**File:** `docker/orchestrator/lib/workflow-engine.js` — Phase 4 validation block (~line 1141)

**Logic:**
```
if riskLevel === "low" AND team === "TheFixer":
  skip Inspector entirely
else if riskLevel === "medium":
  run Inspector but pass a flag limiting to quality-oracle + dependency-auditor only
else:
  full Inspector suite (existing behavior)
```

**Trade-off:** Low-risk TheFixer skips all inspection. Acceptable because:
- TheFixer already has verify-reporter running tests + traceability
- Low-risk classification means the leader assessed minimal scope
- Inspector can always be triggered manually via `/api/runs/:id/revalidate`

## 3. Early Commit (Before Validation)

**File:** `docker/orchestrator/lib/workflow-engine.js`

Move the commit+push from Phase 6 (after validation) to Phase 3.9 (after implementation stages pass, before validation). Keep the existing Phase 6 as a second push that captures any validation-phase changes.

```
Phase 3:    Implementation + QA stages
Phase 3.5:  Start app
Phase 3.9:  EARLY COMMIT — commit + push implementation work (NEW)
Phase 4:    Validation (smoketest + inspector)
Phase 5:    Compute results
Phase 5.5:  E2E
Phase 6:    FINAL COMMIT — amend/push any validation-phase artifacts (CHANGED)
Phase 6.5:  PR creation + merge
```

**Safety:** The existing push-verification logic at Phase 6 stays. Phase 3.9 uses the same `commitAndPush()` + remote verification. If Phase 3.9 push fails, we log it but continue — Phase 6 will retry.

## 4. Scoped Feedback Loops

**File:** `docker/orchestrator/lib/workflow-engine.js` — feedback loop block (~line 1041)

Currently when QA fails, ALL implementation agents re-run. Change to:

1. Parse QA failure output for layer indicators: `[frontend]`, `[backend]`, `frontend-coder`, `backend-coder`, file paths containing `Frontend/` or `Backend/`
2. Filter the implementation stage's agents to only the affected layer(s)
3. If layer detection fails (ambiguous output), fall back to re-running all (existing behavior)

**Trade-off:** Heuristic-based layer detection may miss cross-cutting issues. The fallback-to-all behavior makes this safe.

## 5. Remove Dead LearningsSync

**File:** `docker/orchestrator/lib/learnings-sync.js` — DELETE entirely

The class is instantiated in `server.js` but the actual learnings sync runs as a bash script inside the worker container (`workflow-engine.js:1406-1418`). The `LearningsSync` class methods are never called by the workflow engine.

Also remove the import and instantiation from `server.js`.

## 6. Bake Playwright into Worker Image

**File:** `docker/Dockerfile.worker`

Add to the build:
```dockerfile
RUN npx playwright install --with-deps chromium
RUN npm install @playwright/test
```

Then in `workflow-engine.js:_runPlaywrightE2E()`, skip the install step if chromium is already present.
