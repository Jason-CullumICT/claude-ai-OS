#!/bin/bash
# Don't use set -e — we need to capture claude's exit code manually
set -uo pipefail

# ═══════════════════════════════════════════════════════════
# Run Team — executes a Claude Code team session
# ═══════════════════════════════════════════════════════════

TEAM="${1:?Usage: run-team.sh <team> <task> [plan_file]}"
TASK="${2:?Usage: run-team.sh <team> <task> [plan_file]}"
PLAN_FILE="${3:-}"
WORKSPACE="${WORKSPACE_DIR:-/workspace}"

cd "$WORKSPACE" || { echo "ERROR: Cannot cd to $WORKSPACE" >&2; exit 1; }

# Build the prompt based on team
case "$TEAM" in
  TheATeam)
    PROMPT="Read the role file at Teams/TheATeam/team-leader.md and follow it exactly.

CRITICAL: You are running in PLANNING-ONLY mode inside a Docker orchestrator.
You MUST NOT implement, code, write tests, or edit Source/ files yourself.
Your ONLY job is to:
1. Analyze the task and create specifications, plans, and requirements
2. Write plan files, design docs, and API contracts to Plans/ and Specifications/
3. Output structured dispatch instructions for implementation and QA agents
The orchestrator will parse your output and dispatch the agents for you.
Do NOT spawn agents via the Agent tool — the orchestrator handles dispatch.

DISPATCH PLAN FILE REQUIREMENT:
You MUST write your dispatch plan to Plans/<task-slug>/dispatch-plan.md (the file MUST be named dispatch-plan.md).
The orchestrator looks for this exact filename. If you write plan.md instead, it will NOT be found.
Your dispatch plan MUST include implementation agent headings using this exact format:
  ### frontend-coder-1
  ### backend-coder-1
Do NOT use '### Agent: name' format — use the role name directly as the heading.
You MUST include at least one coder agent in your dispatch plan.

Task context:
Implement: ${TASK}
$([ -n "$PLAN_FILE" ] && echo "Plan file: ${PLAN_FILE}")
$([ -n "$PLAN_FILE" ] && echo "Specs: Specifications/")

Team folder: Teams/TheATeam"
    ;;

  TheFixer)
    PROMPT="Read the role file at Teams/TheFixer/team-leader.md and follow it exactly.

CRITICAL: You are running in PLANNING-ONLY mode inside a Docker orchestrator.
You MUST NOT fix code, write patches, or edit Source/ files yourself.
Your ONLY job is to:
1. Analyze the bug/issue and create a fix plan
2. Write plan files to Plans/
3. Output structured dispatch instructions for fixer and verification agents
The orchestrator will parse your output and dispatch the agents for you.
Do NOT spawn agents via the Agent tool — the orchestrator handles dispatch.

DISPATCH PLAN FILE REQUIREMENT:
You MUST write your dispatch plan to Plans/<task-slug>/dispatch-plan.md (the file MUST be named dispatch-plan.md).
The orchestrator looks for this exact filename. If you write plan.md instead, it will NOT be found.
Your dispatch plan MUST include fixer agent headings using this exact format:
  ### backend-fixer-1
  ### frontend-fixer-1
Do NOT use '### Agent: name' format — use the role name directly as the heading.

Task context:
Fix: ${TASK}
$([ -n "$PLAN_FILE" ] && echo "Plan file: ${PLAN_FILE}")

Team folder: Teams/TheFixer"
    ;;

  TheInspector)
    PROMPT="Read the role file at Teams/TheInspector/team-leader.md and follow it exactly.

Task context:
Audit: ${TASK}

Team folder: Teams/TheInspector"
    ;;

  *)
    echo "ERROR: Unknown team '$TEAM'. Valid: TheATeam, TheFixer, TheInspector" >&2
    exit 1
    ;;
esac

echo "═══════════════════════════════════════════"
echo "  Running $TEAM"
echo "  Task: $TASK"
echo "  Workspace: $WORKSPACE"
echo "  Claude auth: $([ -f /root/.claude/.credentials.json ] && echo 'found' || echo 'MISSING')"
echo "═══════════════════════════════════════════"
echo ""

# Leader teams get read + write (for Plans/Specs), but NOT Bash/Agent (no implementation)
# TheInspector gets full tools since it audits the running system
case "$TEAM" in
  TheATeam|TheFixer)
    TOOLS="Read,Write,Edit,Glob,Grep"
    ;;
  TheInspector)
    TOOLS="Bash,Read,Write,Edit,Glob,Grep,Agent"
    ;;
esac

echo "[debug] claude -p <prompt> --allowedTools $TOOLS --output-format text"
echo "[debug] Working directory: $(pwd)"
echo "[debug] Files in workspace: $(ls | head -5)"
echo ""

# Run Claude Code — capture both stdout and stderr, don't let set -e kill us
OUTPUT=$(claude -p "$PROMPT" \
  --allowedTools "$TOOLS" \
  --output-format text \
  2>&1) || true

EXIT_CODE=${PIPESTATUS[0]:-$?}

# Output whatever claude produced (including errors)
echo "$OUTPUT"

echo ""
echo "═══════════════════════════════════════════"
echo "  $TEAM completed (exit: $EXIT_CODE)"
echo "═══════════════════════════════════════════"

exit $EXIT_CODE
