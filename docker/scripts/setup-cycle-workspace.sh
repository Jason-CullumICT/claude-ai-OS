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

# ── Clone if workspace is empty ──────────────────────────────────────────────
if [ ! -d "$WORKSPACE/.git" ]; then
  echo "[setup] Cloning $GITHUB_BRANCH into $WORKSPACE..."
  git clone --branch "$GITHUB_BRANCH" --single-branch "$CLONE_URL" "$WORKSPACE"
fi

cd "$WORKSPACE"

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
