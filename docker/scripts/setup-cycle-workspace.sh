#!/usr/bin/env bash
set -euo pipefail

# ── Environment ──────────────────────────────────────────────────────────────
WORKSPACE="${WORKSPACE_DIR:-/workspace}"
GITHUB_REPO="${GITHUB_REPO:?GITHUB_REPO is required}"
GITHUB_BRANCH="${GITHUB_BRANCH:-main}"
GITHUB_TOKEN="${GITHUB_TOKEN:?GITHUB_TOKEN is required}"
RUN_ID="${RUN_ID:?RUN_ID is required}"

# ── Git identity ─────────────────────────────────────────────────────────────
git config --global user.name  "${GIT_AUTHOR_NAME:-claude-ai-OS}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-pipeline@claude-ai-os.local}"

# ── Clone URL with embedded token ────────────────────────────────────────────
CLONE_URL=$(echo "$GITHUB_REPO" | sed "s|https://|https://${GITHUB_TOKEN}@|")

# ── Credential store ────────────────────────────────────────────────────────
mkdir -p ~/.git-credentials 2>/dev/null && rmdir ~/.git-credentials 2>/dev/null || true
echo "$CLONE_URL" > ~/.git-credentials
git config --global credential.helper store

# ── GitHub CLI auth (for PR creation and auto-merge) ────────────────────────
if command -v gh &>/dev/null && [ -n "$GITHUB_TOKEN" ]; then
  echo "$GITHUB_TOKEN" | gh auth login --with-token 2>/dev/null || true
  gh auth setup-git 2>/dev/null || true
  echo "[setup] GitHub CLI authenticated"
fi

# ── Clone if workspace is empty ──────────────────────────────────────────────
if [ ! -d "$WORKSPACE/.git" ]; then
  echo "[setup] Cloning $GITHUB_BRANCH into $WORKSPACE..."
  git clone --branch "$GITHUB_BRANCH" --single-branch "$CLONE_URL" "$WORKSPACE"
fi

cd "$WORKSPACE"

# ── Bootstrap with claude-ai-OS templates if Teams/ doesn't exist ────────────
TEMPLATE_DIR="/app/templates"
if [ ! -d "$WORKSPACE/Teams" ] && [ -d "$TEMPLATE_DIR/Teams" ]; then
  echo "[setup] Bootstrapping with claude-ai-OS framework templates..."
  cp -r "$TEMPLATE_DIR/Teams" "$WORKSPACE/Teams"
  [ -d "$TEMPLATE_DIR/Plans" ] && [ ! -d "$WORKSPACE/Plans" ] && cp -r "$TEMPLATE_DIR/Plans" "$WORKSPACE/Plans"
  mkdir -p "$WORKSPACE/tools"
  [ -d "$TEMPLATE_DIR/tools" ] && cp -r "$TEMPLATE_DIR/tools/"* "$WORKSPACE/tools/" 2>/dev/null || true
  if [ ! -f "$WORKSPACE/CLAUDE.md" ] && [ -f "$TEMPLATE_DIR/CLAUDE.md.template" ]; then
    cp "$TEMPLATE_DIR/CLAUDE.md.template" "$WORKSPACE/CLAUDE.md"
    PNAME="${PROJECT_NAME:-my-project}"
    sed -i "s|{{PROJECT_NAME}}|${PNAME}|g" "$WORKSPACE/CLAUDE.md"
    sed -i "s|{{PROJECT_DESCRIPTION}}|AI-managed project. Update this description in CLAUDE.md.|g" "$WORKSPACE/CLAUDE.md"
    sed -i "s|{{SPECS_DIR}}|Specifications|g" "$WORKSPACE/CLAUDE.md"
    sed -i "s|{{PLANS_DIR}}|Plans|g" "$WORKSPACE/CLAUDE.md"
    sed -i "s|{{BACKEND_URL}}|http://localhost:3001|g" "$WORKSPACE/CLAUDE.md"
    sed -i "s|{{FRONTEND_URL}}|http://localhost:5173|g" "$WORKSPACE/CLAUDE.md"
    sed -i "s|{{LOGIN_CREDENTIALS}}|admin@example.com / admin123|g" "$WORKSPACE/CLAUDE.md"
    sed -i "s|{{SOURCE_LAYOUT}}|Source/                  # Application source code|g" "$WORKSPACE/CLAUDE.md"
    sed -i "s|{{DOMAIN_CONCEPTS}}|<!-- Define your domain entities here. -->|g" "$WORKSPACE/CLAUDE.md"
    sed -i "s|{{BUILD_COMMANDS}}|# Add your build and test commands here|g" "$WORKSPACE/CLAUDE.md"
    sed -i "s|{{VERIFICATION_GATES}}|# Add your test commands here|g" "$WORKSPACE/CLAUDE.md"
  fi
  # Commit bootstrapped files before creating cycle branch
  git add -A
  git commit -m "chore: bootstrap with claude-ai-OS framework" || true
  git push origin "$GITHUB_BRANCH" || true
  echo "[setup] Framework bootstrapped"
fi

# ── Ensure .gitignore excludes build artifacts ───────────────────────────────
for pattern in ".playwright/" "node_modules/" "*.db-shm" "*.db-wal"; do
  grep -qxF "$pattern" "$WORKSPACE/.gitignore" 2>/dev/null || echo "$pattern" >> "$WORKSPACE/.gitignore"
done
git add .gitignore 2>/dev/null
git diff --cached --quiet || git commit -m "chore: update .gitignore with build artifacts" 2>/dev/null || true

# ── Delete stale remote branch if it exists ──────────────────────────────────
git push origin --delete "cycle/$RUN_ID" 2>/dev/null || true

# ── Create cycle branch ─────────────────────────────────────────────────────
echo "[setup] Creating branch cycle/$RUN_ID..."
git checkout -b "cycle/$RUN_ID"

# ── Push branch ──────────────────────────────────────────────────────────────
git push -u origin "cycle/$RUN_ID"

# ── Install npm dependencies ────────────────────────────────────────────────
for dir in Source/Backend Source/Frontend Source/E2E .; do
  if [ -f "$WORKSPACE/$dir/package.json" ]; then
    echo "[setup] npm install in $dir..."
    (cd "$WORKSPACE/$dir" && npm install)
  fi
done

# ── Prisma generate ─────────────────────────────────────────────────────────
if [ -f "$WORKSPACE/Source/Backend/prisma/schema.prisma" ]; then
  echo "[setup] Running prisma generate..."
  (cd "$WORKSPACE/Source/Backend" && npx prisma generate)
fi

echo "[setup] Workspace ready — branch cycle/$RUN_ID"
