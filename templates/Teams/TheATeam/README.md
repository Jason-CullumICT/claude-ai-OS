# The A-Team

A quality-focused agent team with maximum parallelism, shared API contracts, test-first self-healing coders, merged review/smoke testing, and self-learning capabilities.

## Agents

| Agent | Model | Role | Scalable |
|-------|-------|------|----------|
| **`team-leader`** | **sonnet** | **Pipeline orchestrator -- spawns all agents, manages DAG, handles feedback loops** | **No (1)** |
| `requirements-reviewer` | sonnet | Decomposes requirements into FRs with Autonomous Scoping and Bin-Packing | No (1) |
| `api-contract` | haiku | Generates shared API types and endpoint contracts from FRs | No (1) |
| `backend-coder` | sonnet | Test-first backend implementation with self-healing (3 fix cycles), matches API contract | **Yes** |
| `frontend-coder` | sonnet | Test-first frontend implementation with self-healing (3 fix cycles), mandatory wiring audit | **Yes** |
| `chaos-tester` | sonnet | Adversarial Agent -- attempts to break domain invariants | No (1) |
| `security-qa` | sonnet | Security review with prioritized findings | No (1) |
| `qa-review-and-tests` | sonnet | Runs tests + coverage + test quality grading + FR coverage verification | No (1) |
| `design-critic` | sonnet | Multimodal Reviewer -- visual comparison against design specs | No (1) |
| `integration-reviewer` | haiku | Code review + smoke testing + visual validation | No (1) |
| `traceability-reporter` | sonnet | Generates FR traceability report | No (1) |
| `visual-playwright` | sonnet | Ephemeral Playwright visual validation -- writes throwaway browser tests | No (1) |

### Scalable Roles

Coders (backend and frontend) can be **scaled up** based on complexity-weighted FR points:

| Weight | Points | Criteria |
|--------|--------|----------|
| **S** | 1 | Simple addition, no existing code |
| **M** | 2 | Moderate complexity or minor changes to existing |
| **L** | 4 | Significant refactor or many subcomponents |
| **XL** | 8 | Complex overhaul with many conditional paths |

| Total points (per layer) | Coder instances | Assignment rule |
|---|---|---|
| <= 4 | 1 | Single coder handles all |
| 5-12 | 2 | Balance by points, group related files |
| 13+ | 3 | XL gets own coder, L gets own coder, bin-pack S/M |

## Pipeline

```
                       Requirements Reviewer (Scoper)
                              |
                    Tags FRs + Scopes Labor + Bin-Packs
                              |
                    API Contract Agent [haiku, ~1 min]
                              |
         +--------------------+--------------------+
         v                    v                     v
  Backend Coder(s)     Frontend Coder(s)     [Additional Coders]
  (test-first +        (test-first +         (if your project has
   self-healing)        wiring audit)         more layers)
         |                    |                     |
         +--------------------+---------------------+
                              |
          +-------------------+-------------------+
          v                                        v
   TIER 1 (parallel, no shared state)        Wait for Tier 1
   +-----------------------------+                  |
   | Chaos Tester       [sonnet] |                  v
   | Security QA        [sonnet] |           TIER 2 (sequential)
   | Traceability       [sonnet] |           +-----------------------------+
   | E2E Playwright     [sonnet] |           | QA Review & Tests  [sonnet] |
   +-----------------------------+           +-------------+---------------+
                                                           v
                                             TIER 3 (sequential, needs ports)
                                             +-----------------------------+
                                             | Design Critic (Vision)      |
                                             | Integration Reviewer        |
                                             +-----------------------------+
```

## Key Design Decisions

### 1. API Contract Agent (~1 min, haiku)
- Runs between requirements and coders
- Produces shared type definitions and endpoint specs
- Both coders read the contract to ensure implementations agree on API shapes
- Eliminates integration mismatches discovered late in the pipeline

### 2. Test-First Self-Healing Coders
- Coders write tests before implementation for each FR
- Both coders have retry logic: if tests fail, debug and fix, repeat up to 3 cycles
- Only report complete when 100% pass rate confirmed

### 3. Tiered QA Ordering (Prevents Resource Contention)

| Tier | Agents | Shared Resources | Execution |
|------|--------|-----------------|-----------|
| **Tier 1** | chaos-tester, security-qa, traceability-reporter, visual-playwright | None (read-only, mocked) | **Parallel** |
| **Tier 2** | qa-review-and-tests | Database (test resets) | **Sequential** |
| **Tier 3** | design-critic, integration-reviewer | Ports, database, browser | **Sequential** |

### 4. Self-Learning Across Runs
- Every agent maintains a persistent learnings file at `Teams/TheATeam/learnings/{role}.md`
- Read at start, write at end
- Gives the team institutional memory -- each run benefits from every prior run

### 5. Dashboard State Reporting
- Every agent calls `tools/pipeline-update.sh` to report status
- Call `--action start` on startup, `--action update` during work, `--action complete` or `--action fail` at end

## Comparison: TheATeam vs TheFixer

| Metric | TheATeam (greenfield) | TheFixer (changes) |
|--------|----------------------|-------------------|
| **Agents** | 12+ | 9 |
| **Wall time (est.)** | ~25 min | ~10-15 min |
| **Primary Goal** | Feature implementation from scratch | Surgical fixes and behavior changes |
| **Testing Approach** | Test-first (TDD) via coders | Test-update (existing suites) |
| **Validation** | Full QA + Chaos + Design Critic | QA Spot-check + Chaos + Design Critic |

## When to Use TheATeam vs TheFixer

| Scenario | Team to Use |
|----------|-------------|
| **Greenfield module** with no existing code | **TheATeam** |
| **Complex new feature** requiring deep spec analysis | **TheATeam** |
| **Bug fix** to an existing feature | **TheFixer** |
| **Refactoring** existing code with zero behavioral change | **TheFixer** |
| **Small behavior change** | **TheFixer** |

## Maintenance Workflow (Librarian)

The **Librarian** agent runs outside the feature pipeline (see `Teams/Shared/librarian.md`) to synthesize learnings and prune context bloat across all teams.
