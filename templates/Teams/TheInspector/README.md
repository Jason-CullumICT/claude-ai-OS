# TheInspector

A config-driven system health audit team that performs adversarial security analysis, spec-drift detection, performance profiling, chaos testing, and dependency auditing. Runs periodically or post-merge to catch systemic issues that accumulate across features.

**Project-agnostic.** All domain knowledge comes from `inspector.config.yml` — the specialists adapt to any project.

## Agents (6)

| Agent | Model | Role | Mode |
|-------|-------|------|------|
| **`team-leader`** | **sonnet** | Pipeline orchestrator — scopes audit, dispatches specialists, synthesises HTML report | Orchestration only |
| `red-teamer` | sonnet | Adversarial security analysis — exploit chains, not code smells | Hybrid (static + optional dynamic) |
| `quality-oracle` | sonnet | Spec-drift analysis, pattern enforcement, documentation audit | Always static |
| `performance-profiler` | sonnet | Load testing (dynamic) or N+1/index analysis (static fallback) | Dynamic-first |
| `chaos-monkey` | sonnet | Fault injection (dynamic) or invariant analysis (static fallback) | Dynamic-first |
| `dependency-auditor` | haiku | CVE scanning, license compliance, outdated packages | Always static |

## Pipeline

```
Stage 1: Scoping (team-leader)
          Reads git log, inspector.config.yml, identifies focus areas,
          determines dynamic vs static mode per specialist
          |
Stage 2: Specialists (ALL dispatched in parallel)
          ┌──────────────┬──────────────┬───────────────────┬──────────────┬──────────────────┐
          v              v              v                   v              v
   red-teamer    quality-oracle  perf-profiler       chaos-monkey  dependency-auditor
   [hybrid]      [static]        [dynamic-first]     [dynamic-first]  [static]
          └──────────────┴──────────────┴───────────────────┴──────────────┴──────────────────┘
          |
Stage 3: Synthesis (team-leader)
          Deduplicates findings, generates HTML report, assigns grade A-F
```

## Configuration

All project-specific knowledge lives in `inspector.config.yml`:

| Section | What it configures |
|---------|-------------------|
| `project` | Name, domain (informs threat model focus) |
| `services` | Endpoints, ports, health checks (for dynamic mode) |
| `specs` | Spec directory, traceability patterns |
| `source` | Source dirs, test dirs, exclusions |
| `security` | Critical operations, threat scenarios, OWASP focus |
| `performance` | Latency budgets per endpoint |
| `chaos` | Fault scenarios, MCP tool discovery |
| `grading` | A-F thresholds (P1/P2 counts, spec coverage) |
| `report` | Output paths and filename patterns |

## How It Works

### Scoping Modes

| Mode | When | Behavior |
|------|------|----------|
| **Full codebase** | First audit, monthly | Scans all source dirs from config |
| **Changes since** | Post-merge, post-sprint | Focuses on files changed since last audit. Prior P1/P2s always re-verified. |

### Re-Verification Strategy (Risk-Stratified)

- **P1 findings:** ALWAYS re-verify on every run
- **P2 findings:** Re-verify every run for first 2 runs after fix, then every 2nd run
- **P3/P4 findings:** Re-verify only when the affected file was modified since last audit
- **Findings open >3 runs:** Flag as "chronic" — escalate with deadline

### Dynamic vs Static

The team leader checks each service's health endpoint from `inspector.config.yml`. If a service responds, specialists targeting that service run in dynamic mode. Otherwise, static fallback.

### Severity Scale (P1-P4)

| Priority | Label | Criteria |
|----------|-------|----------|
| **P1** | Critical | Exploitable vulnerability, data loss risk, critical operation failure, production-breaking performance |
| **P2** | High | Likely exploitable, spec violation on core logic, missing guards, performance degradation at scale |
| **P3** | Medium | Theoretical risk, pattern violation, observability gap, optimisation opportunity |
| **P4** | Low | Hardening, style, housekeeping |

What counts as "critical" comes from `security.critical_operations` in config — access control systems care about door bypasses, fintech cares about payment integrity, SaaS cares about tenant isolation.

### Output

Two artifacts per run:
- **HTML Report** — graded A-F, executive summary, per-specialist findings, trend comparison
- **Bug Backlog JSON** — machine-readable P1/P2 findings for TheFixer to remediate

## How to Invoke

```
Read the role file at Teams/TheInspector/team-leader.md and follow it exactly.

Task context:
Audit: System health audit
Focus: <optional focus areas>

Team folder: Teams/TheInspector
Config: Teams/TheInspector/inspector.config.yml
```

The parent session dispatches specialists based on the leader's scoping plan (team leaders cannot spawn subagents — see known limitations).

## Known Limitations

- **Team leader nesting** — cannot spawn subagents when run as a subagent. Parent session dispatches specialists.
- **Dynamic mode requires running services** — chaos monkey and performance profiler need live endpoints. Static fallback is always available.
- **Read-only** — specialists never modify source code. Findings are documented, fixes deferred to TheFixer.
