#!/usr/bin/env bash
set -euo pipefail

# claude-ai-OS Bootstrap Script
# Copies the template structure into a target project directory and customizes placeholders.
# Supports interactive mode (default when stdin is a terminal) and non-interactive mode.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/templates"

# --- Defaults ---
TARGET_DIR=""
PROJECT_NAME=""
PROJECT_DESCRIPTION=""
BACKEND_URL="http://localhost:3001"
FRONTEND_URL="http://localhost:5173"
LOGIN_CREDENTIALS=""
TECH_STACK=""
FORCE=false
INTERACTIVE=""  # auto-detect by default

# --- Usage ---
usage() {
  cat <<'USAGE'
Usage: setup.sh <target-directory> [options]

Bootstraps a project with Level 5 AI maturity practices.

Arguments:
  <target-directory>    Path to the project to bootstrap

Options:
  --name "Name"         Project name (default: directory name)
  --description "Desc"  Project description (default: "An AI-first, spec-first project")
  --backend-url URL     Backend URL (default: http://localhost:3001)
  --frontend-url URL    Frontend URL (default: http://localhost:5173)
  --credentials "Cred"  Login credentials (default: "admin@example.com / admin123")
  --stack PRESET        Tech stack preset: node-react, go-react, python-react, custom
                        (default: node-react)
  --force               Overwrite existing files without prompting
  -i, --interactive     Force interactive mode (prompt for each value)
  --non-interactive     Skip prompts entirely, use defaults
  -h, --help            Show this help message

Examples:
  # Interactive (default when run in a terminal):
  ./setup.sh /path/to/my-project

  # Non-interactive with all options:
  ./setup.sh ./my-app --name "My App" --backend-url http://localhost:8080 --stack go-react

  # Piped input auto-uses defaults:
  echo | ./setup.sh ./my-app --name "My App"
USAGE
  exit 0
}

# --- Parse arguments ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      usage
      ;;
    --name)
      PROJECT_NAME="$2"
      shift 2
      ;;
    --description)
      PROJECT_DESCRIPTION="$2"
      shift 2
      ;;
    --backend-url)
      BACKEND_URL="$2"
      shift 2
      ;;
    --frontend-url)
      FRONTEND_URL="$2"
      shift 2
      ;;
    --credentials)
      LOGIN_CREDENTIALS="$2"
      shift 2
      ;;
    --stack)
      TECH_STACK="$2"
      shift 2
      ;;
    --force)
      FORCE=true
      shift
      ;;
    -i|--interactive)
      INTERACTIVE=true
      shift
      ;;
    --non-interactive)
      INTERACTIVE=false
      shift
      ;;
    -*)
      echo "ERROR: Unknown option: $1" >&2
      echo "Run '$0 --help' for usage." >&2
      exit 1
      ;;
    *)
      if [[ -z "$TARGET_DIR" ]]; then
        TARGET_DIR="$1"
      else
        echo "ERROR: Unexpected argument: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

if [[ -z "$TARGET_DIR" ]]; then
  echo "ERROR: Target directory is required." >&2
  echo "Run '$0 --help' for usage." >&2
  exit 1
fi

# Resolve to absolute path
TARGET_DIR="$(cd "$(dirname "$TARGET_DIR")" 2>/dev/null && pwd)/$(basename "$TARGET_DIR")" || TARGET_DIR="$(pwd)/$TARGET_DIR"

# Default project name to directory basename
if [[ -z "$PROJECT_NAME" ]]; then
  PROJECT_NAME="$(basename "$TARGET_DIR")"
fi

# --- Auto-detect interactive mode ---
# Interactive if: explicitly requested, OR no explicit flag set and stdin is a terminal
if [[ -z "$INTERACTIVE" ]]; then
  if [[ -t 0 ]]; then
    INTERACTIVE=true
  else
    INTERACTIVE=false
  fi
fi

# --- Helper: prompt with default value ---
# In non-interactive mode, always returns the default.
prompt_with_default() {
  local prompt_text="$1"
  local default_val="$2"
  local result

  if [[ "$INTERACTIVE" != "true" ]]; then
    echo "$default_val"
    return 0
  fi

  if [[ -n "$default_val" ]]; then
    read -rp "? $prompt_text [$default_val]: " result
    echo "${result:-$default_val}"
  else
    read -rp "? $prompt_text: " result
    echo "$result"
  fi
}

# --- Interactive prompts ---
echo ""
echo "claude-ai-OS Bootstrap"
echo "======================"
echo ""
echo "Project directory: $TARGET_DIR"
echo ""

if [[ "$INTERACTIVE" == "true" ]]; then
  PROJECT_NAME="$(prompt_with_default "Project name" "$PROJECT_NAME")"

  if [[ -z "$PROJECT_DESCRIPTION" ]]; then
    PROJECT_DESCRIPTION="$(prompt_with_default "Project description" "An AI-first, spec-first project")"
  else
    PROJECT_DESCRIPTION="$(prompt_with_default "Project description" "$PROJECT_DESCRIPTION")"
  fi

  BACKEND_URL="$(prompt_with_default "Backend URL" "$BACKEND_URL")"
  FRONTEND_URL="$(prompt_with_default "Frontend URL" "$FRONTEND_URL")"

  if [[ -z "$LOGIN_CREDENTIALS" ]]; then
    LOGIN_CREDENTIALS="$(prompt_with_default "Login credentials" "admin@example.com / admin123")"
  else
    LOGIN_CREDENTIALS="$(prompt_with_default "Login credentials" "$LOGIN_CREDENTIALS")"
  fi

  if [[ -z "$TECH_STACK" ]]; then
    echo ""
    echo "  Tech stack presets configure Build & Test commands and verification gates."
    echo "  Options: node-react, go-react, python-react, custom"
    echo ""
    TECH_STACK="$(prompt_with_default "Tech stack" "node-react")"
  else
    TECH_STACK="$(prompt_with_default "Tech stack (node-react, go-react, python-react, custom)" "$TECH_STACK")"
  fi

  echo ""
else
  # Non-interactive: apply defaults for anything not set via flags
  if [[ -z "$PROJECT_DESCRIPTION" ]]; then
    PROJECT_DESCRIPTION="An AI-first, spec-first project"
  fi
  if [[ -z "$LOGIN_CREDENTIALS" ]]; then
    LOGIN_CREDENTIALS="admin@example.com / admin123"
  fi
  if [[ -z "$TECH_STACK" ]]; then
    TECH_STACK="node-react"
  fi
fi

# Validate tech stack
case "$TECH_STACK" in
  node-react|go-react|python-react|custom) ;;
  *)
    echo "WARNING: Unknown tech stack '$TECH_STACK', falling back to 'custom'" >&2
    TECH_STACK="custom"
    ;;
esac

# --- Generate content from tech stack presets ---

# SOURCE_LAYOUT: the directory tree shown in the Repository Layout section
# BUILD_COMMANDS: the Build & Test table rows
# TEST_COMMANDS: additional test/build notes below the table
# VERIFICATION_GATES: the bash commands in the Testing Rules section

generate_preset_content() {
  case "$TECH_STACK" in
    node-react)
      SOURCE_LAYOUT="Source/
  Backend/               # Node/Express API server
  Frontend/              # React/Vite web UI
  Shared/                # Shared TypeScript types across layers"

      BUILD_COMMANDS="| Component | Build / Install | Test |
|-----------|----------------|------|
| Backend | \`cd Source/Backend && npm install\` | \`npm run test\` |
| Frontend | \`cd Source/Frontend && npm install\` | \`npm run test\` |

<!-- Add more rows for your stack: -->
<!-- | E2E Tests | \`cd Source/E2E && npm install\` | \`npx playwright test\` | -->

Type checks: \`npx tsc --noEmit\` in Backend and Frontend directories.

<!-- Add project-specific build notes: -->
<!-- Prisma: schema at Source/Backend/prisma/schema.prisma. Run \`npx prisma generate\` on fresh checkout. -->"

      VERIFICATION_GATES="# Traceability Enforcer (MANDATORY for Level 5 Maturity)
python3 tools/traceability-enforcer.py

# Backend
cd Source/Backend && npm run test && npx tsc --noEmit

# Frontend
cd Source/Frontend && npm run test && npx tsc --noEmit

# Add your gates here -- every component must have a verification command"
      ;;

    go-react)
      SOURCE_LAYOUT="Source/
  API/                   # Go API server
  Frontend/              # React/Vite web UI
  Shared/                # Shared TypeScript types for frontend"

      BUILD_COMMANDS="| Component | Build / Install | Test |
|-----------|----------------|------|
| API (Go) | \`go build ./...\` | \`go test ./... -v\` |
| Frontend | \`cd Source/Frontend && npm install\` | \`npm run test\` |

<!-- Add more rows for your stack: -->
<!-- | CLI Tools | \`go build ./cmd/...\` | \`go test ./cmd/... -v\` | -->

Type checks: \`npx tsc --noEmit\` in the Frontend directory.

<!-- Add project-specific build notes: -->
<!-- Go modules: run \`go mod tidy\` after adding dependencies. -->"

      VERIFICATION_GATES="# Traceability Enforcer (MANDATORY for Level 5 Maturity)
python3 tools/traceability-enforcer.py

# Go API
go build ./... && go test ./... -v

# Frontend
cd Source/Frontend && npm run test && npx tsc --noEmit

# Add your gates here -- every component must have a verification command"
      ;;

    python-react)
      SOURCE_LAYOUT="Source/
  Backend/               # Python/FastAPI server
  Frontend/              # React/Vite web UI
  Shared/                # Shared TypeScript types for frontend"

      BUILD_COMMANDS="| Component | Build / Install | Test |
|-----------|----------------|------|
| Backend | \`cd Source/Backend && pip install -r requirements.txt\` | \`pytest\` |
| Frontend | \`cd Source/Frontend && npm install\` | \`npm run test\` |

<!-- Add more rows for your stack: -->
<!-- | Worker | \`cd Source/Worker && pip install -r requirements.txt\` | \`pytest\` | -->

Type checks: \`mypy Source/Backend/\` for backend, \`npx tsc --noEmit\` for frontend.

<!-- Add project-specific build notes: -->
<!-- Virtual env: run \`python -m venv .venv && source .venv/bin/activate\` on fresh checkout. -->"

      VERIFICATION_GATES="# Traceability Enforcer (MANDATORY for Level 5 Maturity)
python3 tools/traceability-enforcer.py

# Backend
cd Source/Backend && pytest && mypy .

# Frontend
cd Source/Frontend && npm run test && npx tsc --noEmit

# Add your gates here -- every component must have a verification command"
      ;;

    custom)
      SOURCE_LAYOUT="Source/
  # TODO: Add your source directories here
  # Backend/             # API server
  # Frontend/            # Web UI
  # Shared/              # Shared types across layers"

      BUILD_COMMANDS="| Component | Build / Install | Test |
|-----------|----------------|------|
| <!-- TODO --> | \`TODO\` | \`TODO\` |

<!-- Add rows for each component in your stack. Examples: -->
<!-- | Backend | \`cd Source/Backend && npm install\` | \`npm run test\` | -->
<!-- | Frontend | \`cd Source/Frontend && npm install\` | \`npm run test\` | -->
<!-- | Go API | \`go build ./...\` | \`go test ./... -v\` | -->
<!-- | Python API | \`pip install -r requirements.txt\` | \`pytest\` | -->
<!-- | Mobile | \`cd Source/Mobile && npm install\` | \`npm run test\` | -->

<!-- Type checks: \`npx tsc --noEmit\` in Backend and Frontend directories. -->

<!-- Add project-specific build notes here -->"

      VERIFICATION_GATES="# Traceability Enforcer (MANDATORY for Level 5 Maturity)
python3 tools/traceability-enforcer.py

# TODO: Add verification gates for each component
# Example:
# cd Source/Backend && npm run test && npx tsc --noEmit
# cd Source/Frontend && npm run test && npx tsc --noEmit"
      ;;
  esac
}

generate_preset_content

# Fixed defaults that are always the same
SPECS_DIR="Specifications"
PLANS_DIR="Plans"

# Domain concepts are left as the commented example block -- users must write this themselves
DOMAIN_CONCEPTS='<!-- Delete the examples in the HTML comments above and replace this line with your domain concepts. -->
<!-- Use the format: - **Entity** -- description of what it is and why it matters -->'

# --- Print configuration summary ---
echo "Setting up files..."
echo ""
echo "  Project name:    $PROJECT_NAME"
echo "  Description:     $PROJECT_DESCRIPTION"
echo "  Backend URL:     $BACKEND_URL"
echo "  Frontend URL:    $FRONTEND_URL"
echo "  Credentials:     $LOGIN_CREDENTIALS"
echo "  Tech stack:      $TECH_STACK"
echo ""

# --- Helper: copy file with overwrite protection ---
copy_file() {
  local src="$1"
  local dest="$2"

  # Create parent directory
  mkdir -p "$(dirname "$dest")"

  if [[ -f "$dest" ]] && [[ "$FORCE" != "true" ]]; then
    echo "  [SKIP] $dest (already exists, use --force to overwrite)"
    return 0
  fi

  cp "$src" "$dest"
  echo "  [CREATE] $dest"
}

# --- Helper: copy file and replace ALL placeholders ---
# Uses a temp file approach for multi-line replacements.
copy_and_replace() {
  local src="$1"
  local dest="$2"

  mkdir -p "$(dirname "$dest")"

  if [[ -f "$dest" ]] && [[ "$FORCE" != "true" ]]; then
    echo "  [SKIP] $dest (already exists, use --force to overwrite)"
    return 0
  fi

  # Start with the template
  cp "$src" "$dest"

  # Create a temporary file for multi-line replacements
  local tmpfile
  tmpfile="$(mktemp)"

  # --- Simple single-line replacements (sed works fine for these) ---
  # These are safe because the replacement values don't contain newlines.
  # Use | as delimiter to avoid conflicts with URLs containing /
  sed \
    -e "s|{{PROJECT_NAME}}|${PROJECT_NAME}|g" \
    -e "s|{{PROJECT_DESCRIPTION}}|${PROJECT_DESCRIPTION}|g" \
    -e "s|{{BACKEND_URL}}|${BACKEND_URL}|g" \
    -e "s|{{FRONTEND_URL}}|${FRONTEND_URL}|g" \
    -e "s|{{LOGIN_CREDENTIALS}}|${LOGIN_CREDENTIALS}|g" \
    -e "s|{{SPECS_DIR}}|${SPECS_DIR}|g" \
    -e "s|{{PLANS_DIR}}|${PLANS_DIR}|g" \
    "$dest" > "$tmpfile"
  cp "$tmpfile" "$dest"

  # --- Multi-line replacements (use awk for reliability) ---
  # Each placeholder that may contain newlines gets replaced via awk.

  # Replace {{SOURCE_LAYOUT}}
  awk -v replacement="$SOURCE_LAYOUT" '{
    if (index($0, "{{SOURCE_LAYOUT}}") > 0) {
      # Split the line at the placeholder
      n = index($0, "{{SOURCE_LAYOUT}}")
      before = substr($0, 1, n - 1)
      after = substr($0, n + length("{{SOURCE_LAYOUT}}"))
      print before replacement after
    } else {
      print
    }
  }' "$dest" > "$tmpfile"
  cp "$tmpfile" "$dest"

  # Replace {{BUILD_COMMANDS}}
  awk -v replacement="$BUILD_COMMANDS" '{
    if (index($0, "{{BUILD_COMMANDS}}") > 0) {
      n = index($0, "{{BUILD_COMMANDS}}")
      before = substr($0, 1, n - 1)
      after = substr($0, n + length("{{BUILD_COMMANDS}}"))
      print before replacement after
    } else {
      print
    }
  }' "$dest" > "$tmpfile"
  cp "$tmpfile" "$dest"

  # Replace {{VERIFICATION_GATES}}
  awk -v replacement="$VERIFICATION_GATES" '{
    if (index($0, "{{VERIFICATION_GATES}}") > 0) {
      n = index($0, "{{VERIFICATION_GATES}}")
      before = substr($0, 1, n - 1)
      after = substr($0, n + length("{{VERIFICATION_GATES}}"))
      print before replacement after
    } else {
      print
    }
  }' "$dest" > "$tmpfile"
  cp "$tmpfile" "$dest"

  # Replace {{DOMAIN_CONCEPTS}}
  awk -v replacement="$DOMAIN_CONCEPTS" '{
    if (index($0, "{{DOMAIN_CONCEPTS}}") > 0) {
      n = index($0, "{{DOMAIN_CONCEPTS}}")
      before = substr($0, 1, n - 1)
      after = substr($0, n + length("{{DOMAIN_CONCEPTS}}"))
      print before replacement after
    } else {
      print
    }
  }' "$dest" > "$tmpfile"
  cp "$tmpfile" "$dest"

  # Clean up temp file
  rm -f "$tmpfile"

  echo "  [CREATE] $dest"
}

# --- Create directory structure ---
echo "Creating directory structure..."
mkdir -p "$TARGET_DIR"/{Teams/{TheATeam/learnings,TheFixer/learnings,TheInspector/learnings,Shared},tools,Plans/{phase-signals,_template},Specifications,Source}

# --- Copy and customize CLAUDE.md ---
echo ""
echo "Setting up CLAUDE.md..."
if [[ -f "$TEMPLATE_DIR/CLAUDE.md.template" ]]; then
  copy_and_replace "$TEMPLATE_DIR/CLAUDE.md.template" "$TARGET_DIR/CLAUDE.md"
else
  echo "  [ERROR] CLAUDE.md.template not found in $TEMPLATE_DIR"
  exit 1
fi

# --- Copy team files ---
echo ""
echo "Setting up Teams..."

# TheATeam
for file in "$TEMPLATE_DIR"/Teams/TheATeam/*.md; do
  [[ -f "$file" ]] || continue
  copy_file "$file" "$TARGET_DIR/Teams/TheATeam/$(basename "$file")"
done

# TheFixer
for file in "$TEMPLATE_DIR"/Teams/TheFixer/*.md; do
  [[ -f "$file" ]] || continue
  copy_file "$file" "$TARGET_DIR/Teams/TheFixer/$(basename "$file")"
done

# TheInspector
for file in "$TEMPLATE_DIR"/Teams/TheInspector/*.md "$TEMPLATE_DIR"/Teams/TheInspector/*.yml; do
  [[ -f "$file" ]] || continue
  copy_file "$file" "$TARGET_DIR/Teams/TheInspector/$(basename "$file")"
done

# Shared
for file in "$TEMPLATE_DIR"/Teams/Shared/*.md; do
  [[ -f "$file" ]] || continue
  copy_file "$file" "$TARGET_DIR/Teams/Shared/$(basename "$file")"
done

# --- .gitkeep for learnings directories ---
touch "$TARGET_DIR/Teams/TheATeam/learnings/.gitkeep"
touch "$TARGET_DIR/Teams/TheFixer/learnings/.gitkeep"
touch "$TARGET_DIR/Teams/TheInspector/learnings/.gitkeep"

# --- Copy tools ---
echo ""
echo "Setting up tools..."
for file in "$TEMPLATE_DIR"/tools/*; do
  [[ -f "$file" ]] || continue
  copy_file "$file" "$TARGET_DIR/tools/$(basename "$file")"
done

# Make scripts executable
chmod +x "$TARGET_DIR/tools/pipeline-update.sh" 2>/dev/null || true
chmod +x "$TARGET_DIR/tools/traceability-enforcer.py" 2>/dev/null || true

# --- Copy Plans ---
echo ""
echo "Setting up Plans..."
for file in "$TEMPLATE_DIR"/Plans/phase-signals/*.md; do
  [[ -f "$file" ]] || continue
  copy_file "$file" "$TARGET_DIR/Plans/phase-signals/$(basename "$file")"
done
for file in "$TEMPLATE_DIR"/Plans/_template/*.md; do
  [[ -f "$file" ]] || continue
  copy_file "$file" "$TARGET_DIR/Plans/_template/$(basename "$file")"
done

# --- Summary ---
echo ""
echo "=========================================="
echo "  Bootstrap Complete!"
echo "=========================================="
echo ""
echo "  Created in: $TARGET_DIR"
echo ""
echo "  Files created:"
echo "    CLAUDE.md (customized for \"$PROJECT_NAME\", stack: $TECH_STACK)"
echo "    Teams/TheATeam/     (feature implementation pipeline)"
echo "    Teams/TheFixer/     (bug fix / refactor pipeline)"
echo "    Teams/TheInspector/ (system health audit — security, quality, perf, chaos)"
echo "    Teams/Shared/       (shared agent roles)"
echo "    tools/           (pipeline dashboard, traceability enforcer)"
echo "    Plans/           (phase signals, plan templates)"
echo ""
echo "  Still needs your attention:"
echo "    - CLAUDE.md: Fill in \"Key Domain Concepts\" section with your domain entities"
echo "    - CLAUDE.md: Add any MCP tool references you use"
echo "    - CLAUDE.md: Customize Architecture Rules for your specific tech stack"
if [[ "$TECH_STACK" == "custom" ]]; then
echo "    - CLAUDE.md: Fill in Build & Test table and verification gates"
echo "    - CLAUDE.md: Update Repository Layout with your source directories"
fi
echo "    - CLAUDE.md: Add extra Dev Environment rows (database, Redis, etc.)"
echo "    - Teams/: Customize role files for your project's modules"
echo "    - Teams/TheInspector/inspector.config.yml: (optional) Override auto-discovered settings"
echo "    - Specifications/: Add your domain specifications"
echo "    - Plans/: Create your first feature plan"
echo ""
