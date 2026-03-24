#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════
# claude-ai-OS — Claude Code Environment Installer
#
# Sets up Claude Code with plugins, permissions, status line,
# and the full agent team development framework.
#
# Usage:
#   bash install.sh                    # Interactive — prompts for everything
#   bash install.sh --non-interactive  # Accept all defaults
#   bash install.sh --skip-plugins     # Skip plugin installation (offline)
#
# What it does:
#   1. Checks Claude Code is installed
#   2. Configures global settings (permissions, effort, updates)
#   3. Installs the status line (git branch, context %, model)
#   4. Installs official plugins (superpowers, code-review, etc.)
#   5. Installs VoltAgent subagent marketplace + plugins
#   6. Prints next steps (project bootstrap, MCP servers, Chrome)
# ═══════════════════════════════════════════════════════════════

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Defaults ──
INTERACTIVE=true
SKIP_PLUGINS=false
EFFORT_LEVEL="high"
DEFAULT_MODE="acceptEdits"
COLOR_THEME="cyan"

# ── Parse args ──
while [[ $# -gt 0 ]]; do
  case "$1" in
    --non-interactive) INTERACTIVE=false; shift ;;
    --skip-plugins)    SKIP_PLUGINS=true; shift ;;
    -h|--help)
      cat <<'EOF'
claude-ai-OS Installer — sets up Claude Code with the full AI development framework.

Usage: bash install.sh [options]

Options:
  --non-interactive   Accept all defaults without prompting
  --skip-plugins      Skip plugin installation (for offline/air-gapped setups)
  -h, --help          Show this help

What gets configured:
  ~/.claude/settings.json     Global settings (permissions, plugins, effort)
  ~/.claude/statusline.sh     Two-line status bar (model, git, context %)
  Plugins                     Official + VoltAgent subagent marketplace

After installation, bootstrap a project:
  ./setup.sh /path/to/project --name "My Project"
EOF
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# Auto-detect non-interactive
if [[ "$INTERACTIVE" == "true" ]] && ! [[ -t 0 ]]; then
  INTERACTIVE=false
fi

# ── Helpers ──
prompt_with_default() {
  local prompt_text="$1" default_val="$2" result
  if [[ "$INTERACTIVE" != "true" ]]; then echo "$default_val"; return; fi
  read -rp "? $prompt_text [$default_val]: " result
  echo "${result:-$default_val}"
}

has_command() { command -v "$1" &>/dev/null; }

info()  { printf '\033[38;5;37m%s\033[0m\n' "$*"; }
warn()  { printf '\033[38;5;173m%s\033[0m\n' "$*"; }
ok()    { printf '\033[38;5;71m  ✓ %s\033[0m\n' "$*"; }
skip()  { printf '\033[38;5;245m  ○ %s\033[0m\n' "$*"; }

# ══════════════════════════════════════════════════════════════
# Step 0: Prerequisites
# ══════════════════════════════════════════════════════════════
echo ""
info "═══════════════════════════════════════════"
info "  claude-ai-OS Installer"
info "═══════════════════════════════════════════"
echo ""

# Check Claude Code
if has_command claude; then
  claude_version=$(claude --version 2>/dev/null || echo "unknown")
  ok "Claude Code found: $claude_version"
else
  warn "Claude Code not found. Install it first:"
  echo "  npm install -g @anthropic-ai/claude-code"
  echo "  claude login"
  exit 1
fi

# Check jq (needed for status line)
if has_command jq; then
  ok "jq found"
else
  warn "jq not found — status line needs it."
  echo "  Windows: winget install jqlang.jq"
  echo "  macOS:   brew install jq"
  echo "  Linux:   apt install jq"
  echo ""
  if [[ "$INTERACTIVE" == "true" ]]; then
    read -rp "? Continue without jq? (status line will show fallback) [Y/n]: " cont
    [[ "${cont:-Y}" =~ ^[Nn] ]] && exit 1
  fi
fi

# Check Node.js (needed for plugins)
if has_command node; then
  ok "Node.js found: $(node --version)"
else
  warn "Node.js not found — plugins require it."
fi

# ══════════════════════════════════════════════════════════════
# Step 1: Preferences
# ══════════════════════════════════════════════════════════════
echo ""
info "── Configuration ──"
echo ""

if [[ "$INTERACTIVE" == "true" ]]; then
  echo "  Permission mode controls how Claude asks before editing files."
  echo "  Options: default (ask every time), acceptEdits (auto-accept file edits), bypassPermissions (no prompts)"
  echo ""
  DEFAULT_MODE=$(prompt_with_default "Permission mode" "$DEFAULT_MODE")

  echo ""
  echo "  Effort level controls response thoroughness."
  echo "  Options: low, medium, high"
  echo ""
  EFFORT_LEVEL=$(prompt_with_default "Effort level" "$EFFORT_LEVEL")

  echo ""
  echo "  Status line color theme."
  echo "  Options: cyan, blue, green, orange, teal, lavender, rose, gold, slate, gray"
  echo ""
  COLOR_THEME=$(prompt_with_default "Status line color" "$COLOR_THEME")
fi

# ══════════════════════════════════════════════════════════════
# Step 2: Global settings.json
# ══════════════════════════════════════════════════════════════
echo ""
info "── Writing global settings ──"

CLAUDE_DIR="$HOME/.claude"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
mkdir -p "$CLAUDE_DIR"

# Build bash permission allow-list
BASH_PERMS='[
      "Bash",
      "Bash(cat*)", "Bash(echo*)", "Bash(find*)", "Bash(grep*)", "Bash(head*)",
      "Bash(ls*)", "Bash(pwd*)", "Bash(tail*)", "Bash(wc*)", "Bash(which*)",
      "Bash(git branch*)", "Bash(git diff*)", "Bash(git fetch*)",
      "Bash(git log*)", "Bash(git show*)", "Bash(git status*)",
      "Bash(node*)", "Bash(npm*)", "Bash(npx*)", "Bash(pnpm*)", "Bash(yarn*)",
      "Bash(python*)", "Bash(python3*)", "Bash(pip*)", "Bash(pip3*)", "Bash(uv*)",
      "Bash(pytest*)", "Bash(vitest*)", "Bash(jest*)",
      "Bash(go*)", "Bash(make*)", "Bash(cmake*)",
      "Bash(gcc*)", "Bash(g++*)", "Bash(clang*)", "Bash(ninja*)",
      "Bash(dotnet*)"
    ]'

# If settings.json already exists, merge rather than overwrite
if [[ -f "$SETTINGS_FILE" ]]; then
  warn "  settings.json exists — merging (preserving your MCP servers and custom settings)"

  # Use a temp file approach with jq if available, otherwise backup and overwrite
  if has_command jq; then
    TMPFILE=$(mktemp)
    jq --argjson perms "$BASH_PERMS" \
       --arg mode "$DEFAULT_MODE" \
       --arg effort "$EFFORT_LEVEL" \
       '
       .permissions.allow = ($perms | map(tostring)) |
       .permissions.defaultMode = $mode |
       .effortLevel = $effort |
       .autoUpdatesChannel = "latest" |
       .statusLine = {"type": "command", "command": "bash ~/.claude/statusline.sh"} |
       .extraKnownMarketplaces["voltagent-subagents"] = {
         "source": {"source": "github", "repo": "VoltAgent/awesome-claude-code-subagents"}
       }
       ' "$SETTINGS_FILE" > "$TMPFILE"
    mv "$TMPFILE" "$SETTINGS_FILE"
    ok "Merged into existing settings.json"
  else
    cp "$SETTINGS_FILE" "${SETTINGS_FILE}.backup.$(date +%s)"
    warn "  No jq — backed up existing settings and will overwrite"
    # Fall through to write new file below
    rm "$SETTINGS_FILE"
  fi
fi

if [[ ! -f "$SETTINGS_FILE" ]]; then
  cat > "$SETTINGS_FILE" <<SETTINGS_EOF
{
  "permissions": {
    "allow": ${BASH_PERMS},
    "defaultMode": "${DEFAULT_MODE}"
  },
  "statusLine": {
    "type": "command",
    "command": "bash ~/.claude/statusline.sh"
  },
  "enabledPlugins": {},
  "extraKnownMarketplaces": {
    "voltagent-subagents": {
      "source": {
        "source": "github",
        "repo": "VoltAgent/awesome-claude-code-subagents"
      }
    }
  },
  "effortLevel": "${EFFORT_LEVEL}",
  "autoUpdatesChannel": "latest"
}
SETTINGS_EOF
  ok "Created settings.json"
fi

# ══════════════════════════════════════════════════════════════
# Step 3: Status line script
# ══════════════════════════════════════════════════════════════
echo ""
info "── Installing status line ──"

STATUSLINE_SRC="$SCRIPT_DIR/statusline.sh"
STATUSLINE_DST="$CLAUDE_DIR/statusline.sh"

if [[ -f "$STATUSLINE_SRC" ]]; then
  cp "$STATUSLINE_SRC" "$STATUSLINE_DST"
  chmod +x "$STATUSLINE_DST"
  ok "Installed statusline.sh"
else
  # Embedded minimal version if source not found
  cat > "$STATUSLINE_DST" <<'STATUSLINE_EOF'
#!/bin/bash
input=$(cat)
if ! command -v jq &>/dev/null; then printf 'jq not found\n'; exit 0; fi
model=$(echo "$input" | jq -r '.model.display_name // .model.id // "?"')
cwd=$(echo "$input" | jq -r '.cwd // empty')
cwd="${cwd//\\//}"
dir=$(basename "$cwd" 2>/dev/null || echo "?")
branch=$(git -C "$cwd" branch --show-current 2>/dev/null)
printf '%s | %s' "$model" "$dir"
[[ -n "$branch" ]] && printf ' | %s' "$branch"
printf '\n'
STATUSLINE_EOF
  chmod +x "$STATUSLINE_DST"
  ok "Installed minimal statusline.sh (full version not found in repo)"
fi

# Set color theme
if [[ "$COLOR_THEME" != "cyan" ]]; then
  # Add CLAUDE_STATUSLINE_COLOR to shell profile
  PROFILE=""
  for f in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
    [[ -f "$f" ]] && PROFILE="$f" && break
  done
  if [[ -n "$PROFILE" ]]; then
    if ! grep -q "CLAUDE_STATUSLINE_COLOR" "$PROFILE" 2>/dev/null; then
      echo "export CLAUDE_STATUSLINE_COLOR=\"$COLOR_THEME\"" >> "$PROFILE"
      ok "Set status line color to $COLOR_THEME in $PROFILE"
    fi
  fi
fi

# ══════════════════════════════════════════════════════════════
# Step 4: Install plugins
# ══════════════════════════════════════════════════════════════
if [[ "$SKIP_PLUGINS" == "true" ]]; then
  echo ""
  skip "Skipping plugin installation (--skip-plugins)"
else
  echo ""
  info "── Installing plugins ──"
  echo "  This uses 'claude plugins' commands. If Claude Code isn't"
  echo "  authenticated, plugins will fail — run 'claude login' first."
  echo ""

  # Official plugins
  OFFICIAL_PLUGINS=(
    "context7"
    "superpowers"
    "code-review"
    "commit-commands"
    "feature-dev"
    "code-simplifier"
    "frontend-design"
    "explanatory-output-style"
  )

  for plugin in "${OFFICIAL_PLUGINS[@]}"; do
    if claude plugins install "$plugin" 2>/dev/null; then
      ok "$plugin"
    else
      skip "$plugin (may already be installed or requires auth)"
    fi
  done

  # VoltAgent marketplace + plugins
  echo ""
  info "── Installing VoltAgent subagents ──"

  VOLTAGENT_PLUGINS=(
    "voltagent-lang"
    "voltagent-qa-sec"
    "voltagent-core-dev"
    "voltagent-infra"
    "voltagent-dev-exp"
    "voltagent-domains"
  )

  for plugin in "${VOLTAGENT_PLUGINS[@]}"; do
    if claude plugins install "${plugin}@voltagent-subagents" 2>/dev/null; then
      ok "$plugin"
    else
      skip "$plugin (may already be installed or marketplace not synced)"
    fi
  done
fi

# ══════════════════════════════════════════════════════════════
# Step 5: Copy the full statusline if available
# ══════════════════════════════════════════════════════════════

# The full statusline with git info, context bar, and last-message was captured
# from a working installation. If the repo has it, it was already copied in Step 3.
# If not, the embedded minimal version works but lacks the visual bar.

# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════
echo ""
info "═══════════════════════════════════════════"
info "  Installation Complete!"
info "═══════════════════════════════════════════"
echo ""
echo "  Installed to: $CLAUDE_DIR"
echo ""
echo "  What was configured:"
echo "    ✓ Global settings (permissions: $DEFAULT_MODE, effort: $EFFORT_LEVEL)"
echo "    ✓ Status line ($COLOR_THEME theme — shows model, git branch, context %)"
echo "    ✓ VoltAgent marketplace registered"
if [[ "$SKIP_PLUGINS" != "true" ]]; then
echo "    ✓ ${#OFFICIAL_PLUGINS[@]} official plugins + ${#VOLTAGENT_PLUGINS[@]} VoltAgent subagent packs"
fi
echo ""
echo "  Next steps:"
echo ""
echo "  1. Bootstrap a project with the AI team framework:"
echo "     cd $(basename "$SCRIPT_DIR")"
echo "     ./setup.sh /path/to/project --name \"My Project\""
echo ""
echo "  2. Add MCP servers (optional):"
echo "     claude mcp add my-docs --type sse --url https://mcp.example.com"
echo ""
echo "  3. Install Chrome extension (optional — for browser automation):"
echo "     https://claude.ai/chrome"
echo ""
echo "  4. Start Claude Code in your project:"
echo "     cd /path/to/project && claude"
echo ""
echo "  5. Run a team (open a dedicated session):"
echo "     claude"
echo "     > Read Teams/TheATeam/team-leader.md and follow it exactly."
echo "     > Task: implement <feature>. Plan file: Plans/<plan>.md"
echo ""
