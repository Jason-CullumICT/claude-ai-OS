# claude-ai-OS

A framework for bootstrapping AI-assisted software development projects with Level 5 AI maturity practices. Based on battle-tested patterns from a production project, generalized into reusable templates.

## What You Get

- **Agent team pipelines** with orchestration-only leaders, parallel coders, and tiered QA
- **Traceability enforcement** linking every requirement to implementation code
- **Self-learning agents** that accumulate institutional knowledge across runs
- **Dashboard reporting** for real-time pipeline visibility
- **Cross-session coordination** via phase signal files
- **Architecture governance** enforced through CLAUDE.md project instructions

## Quick Start

```bash
git clone https://github.com/your-org/claude-ai-OS.git
cd claude-ai-OS
./setup.sh /path/to/my-project --name "My Project"
```

This copies the template structure into your project directory, customizes placeholders, and sets up the agent teams.

## What Gets Created

```
your-project/
├── CLAUDE.md                    # Project instructions for Claude Code
├── Teams/
│   ├── TheATeam/                # Feature development pipeline (13 agents)
│   │   ├── README.md
│   │   ├── team-leader.md
│   │   ├── requirements-reviewer.md
│   │   ├── api-contract.md
│   │   ├── backend-coder.md
│   │   ├── frontend-coder.md
│   │   └── learnings/           # Self-learning persistence
│   ├── TheFixer/                # Bug fix pipeline (9 agents)
│   │   ├── README.md
│   │   ├── team-leader.md
│   │   ├── planner.md
│   │   ├── backend-fixer.md
│   │   ├── frontend-fixer.md
│   │   └── learnings/
│   └── Shared/                  # Cross-team agents
│       ├── chaos-tester.md
│       ├── design-critic.md
│       └── librarian.md
├── tools/
│   ├── traceability-enforcer.py # FR traceability gate
│   └── pipeline-update.sh       # Dashboard state reporting
└── Plans/
    ├── phase-signals/            # Cross-session coordination
    └── _template/                # Plan structure template
```

## Customization Guide

After running `setup.sh`, edit these files for your project:

| File | What to Customize |
|------|-------------------|
| `CLAUDE.md` | Fill in remaining `{{PLACEHOLDER}}` tokens with your project details |
| `Teams/TheATeam/backend-coder.md` | Add your tech stack, test framework, and coding standards |
| `Teams/TheATeam/frontend-coder.md` | Add your UI framework, component library, and styling rules |
| `Teams/TheFixer/backend-fixer.md` | Mirror backend-coder customizations |
| `Teams/TheFixer/frontend-fixer.md` | Mirror frontend-coder customizations |
| `Teams/Shared/chaos-tester.md` | Define your domain invariants to test against |

## Team Selection

| Scenario | Team |
|----------|------|
| Greenfield module with no existing code | **TheATeam** |
| Complex new feature requiring deep spec analysis | **TheATeam** |
| Bug fix to an existing feature | **TheFixer** |
| Refactoring existing code | **TheFixer** |
| Small behavior change | **TheFixer** |

## Key Principles

1. **Specs are source of truth** -- implementation traces to specifications, never the reverse
2. **Orchestrators do not implement** -- team leaders spawn agents, they never edit source code
3. **Every requirement has a test** -- with `// Verifies: FR-XXX` traceability comments
4. **Self-learning is persistent** -- agents read and write learnings files across runs
5. **QA is unconditional** -- verification agents run on every pipeline execution, never skipped

## Requirements

- [Claude Code](https://claude.ai/claude-code) CLI
- Python 3.6+ (for traceability enforcer)
- `jq` (for pipeline dashboard)
- Bash (Linux/Mac or Git Bash on Windows)

## Further Reading

- [Level 5 AI Maturity](docs/level5-maturity.md) -- what it means and how this framework achieves it
- [Phase Signals](templates/Plans/phase-signals/README.md) -- cross-session coordination
- [Plan Template](templates/Plans/_template/README.md) -- how to structure feature plans

## License

MIT
