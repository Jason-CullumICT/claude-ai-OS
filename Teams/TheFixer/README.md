# TheFixer

A lean agent team optimized for **bug fixes and changes to existing code**. Mirrors the real developer workflow: read code, apply fixes, run tests, fix broken tests, smoke test, iterate -- without the greenfield overhead of requirements decomposition, API contract generation, or test-first phases.

## Agents (8 agents, 4-6 typical)

| Agent | Model | Role | Scalable |
|-------|-------|------|----------|
| **`team-leader`** | **sonnet** | **Pipeline orchestrator -- spawns all agents, manages DAG, handles feedback loops** | No (1) |
| `planner` | **haiku** | Reads change request + affected code, produces scoped fix plan with file lists, scope tags, and complexity weights | No (1) |
| `backend-fixer` | sonnet | Applies backend/shared fixes, updates tests, runs suite, smoke tests, 5 fix cycles | **Yes** |
| `frontend-fixer` | sonnet | Applies frontend fixes, updates tests, runs suite, wiring audit, 5 fix cycles | **Yes** |
| `chaos-tester` | sonnet | Adversarial Agent -- attempts to break domain invariants | No (1) |
| `verify-reporter` | sonnet | Independent test run, smoke tests, generates traceability report | No (1) |
| `design-critic` | sonnet | Multimodal Reviewer -- visual comparison against design specs | No (1) |
| `visual-playwright` | sonnet | Ephemeral Playwright visual validation -- scoped to the fix | No (1) |
| `security-spotter` | **haiku** | Read-only security spot-check on changed files | No (1) |

### Scalable Roles

Fixers scale based on complexity-weighted issue points (S=1, M=2, L=4, XL=8):

| Total points (per layer) | Fixer instances | Assignment rule |
|---|---|---|
| <= 3 | 1 | Single fixer handles all (most change requests) |
| 4-8 | 2 | Balance by points, group related files |
| 9+ | 3 | XL gets own fixer, L gets own fixer, bin-pack S/M |

## Pipeline

```
                    Planner [haiku, ~1 min]
                    Reads change request + affected code
                    Produces: fix plan, file list, scope tags
                         |
            +------------+------------+
            v                         v
   Backend Fixer [sonnet]    Frontend Fixer [sonnet]
   (skipped if frontend-only) (skipped if backend-only)
   Read > Fix > Test > Iterate  Read > Fix > Test > Iterate
   Up to 5 fix cycles           Up to 5 fix cycles
            |                         |
            +------------+------------+
                         |
          +--------+----------+---------+----------+
          v                  v          v          v
  E2E Playwright      Verify & Report  Security   Chaos Tester
     [sonnet]            [sonnet]      Spotter    [sonnet]
  Ephemeral visual    Job 1: Test      [haiku]    Adversarial
  validation          Job 2: Smoke     Spot-check invariant
                      Job 3: Trace     on diff    testing
                             report
                                |
                                v
                      Design Critic (Vision)
                         [sonnet, Tier 2]
```

## Key Design Decisions

### 1. Planner is haiku
Reads and analyzes code, doesn't generate. Fast and cheap.

### 2. Five fix cycles instead of three
Bug fixes naturally iterate more. The real workflow often has 3 cycles -- 5 gives headroom.

### 3. Smoke testing embedded in fixers
Keeps the feedback loop internal rather than creating downstream feedback.

### 4. Verify + security-spotter instead of many reviewers
For changes to existing code, one verify agent runs tests and smoke tests while a lightweight haiku security-spotter does read-only analysis in parallel.

### 5. Self-learning carried over
Each agent reads/writes `Teams/TheFixer/learnings/{role}.md` for institutional memory across runs.
