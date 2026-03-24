#!/bin/bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# Setup Workspace — init container that clones the project
# ═══════════════════════════════════════════════════════════

WORKSPACE="${WORKSPACE_DIR:-/workspace}"

echo "═══════════════════════════════════════════"
echo "  Workspace Setup"
echo "═══════════════════════════════════════════"
echo "  Repo:   $GITHUB_REPO"
echo "  Branch: $GITHUB_BRANCH"
echo ""

# Clone if workspace is empty
if [[ ! -f "$WORKSPACE/.git/HEAD" ]]; then
  echo "Cloning repository..."

  # Build clone URL with token if provided
  CLONE_URL="$GITHUB_REPO"
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    # Insert token into HTTPS URL: https://TOKEN@github.com/...
    CLONE_URL=$(echo "$GITHUB_REPO" | sed "s|https://|https://${GITHUB_TOKEN}@|")
  fi

  git clone --branch "$GITHUB_BRANCH" --single-branch "$CLONE_URL" "$WORKSPACE"
  echo "✓ Cloned to $WORKSPACE"
else
  echo "Workspace already initialized — pulling latest..."
  cd "$WORKSPACE"
  git fetch origin "$GITHUB_BRANCH"
  git reset --hard "origin/$GITHUB_BRANCH"
  echo "✓ Updated to latest $GITHUB_BRANCH"
fi

cd "$WORKSPACE"

# Install dependencies if package.json exists in common locations
for dir in "Source/Backend" "Source/Frontend" "Source/E2E" "."; do
  if [[ -f "$WORKSPACE/$dir/package.json" ]]; then
    echo "Installing npm deps in $dir..."
    (cd "$WORKSPACE/$dir" && npm install --production=false 2>/dev/null) || true
  fi
done

# Prisma generate if schema exists
if [[ -f "$WORKSPACE/Source/Backend/prisma/schema.prisma" ]]; then
  echo "Running prisma generate..."
  (cd "$WORKSPACE/Source/Backend" && npx prisma generate 2>/dev/null) || true
fi

# Bootstrap with claude-ai-OS framework if Teams/ doesn't exist
TEMPLATE_DIR="/app/templates"
if [[ ! -d "$WORKSPACE/Teams" ]]; then
  echo "No Teams/ directory found — bootstrapping with claude-ai-OS framework..."
  echo "[debug] Looking for templates at: $TEMPLATE_DIR"
  echo "[debug] Template dir exists: $([ -d "$TEMPLATE_DIR" ] && echo YES || echo NO)"
  echo "[debug] Template dir contents: $(ls "$TEMPLATE_DIR" 2>/dev/null || echo 'EMPTY/MISSING')"

  if [[ -d "$TEMPLATE_DIR/Teams" ]]; then
    cp -r "$TEMPLATE_DIR/Teams" "$WORKSPACE/Teams"
    echo "✓ Teams/ copied"

    # Copy Plans template if not already present
    if [[ ! -d "$WORKSPACE/Plans" ]] && [[ -d "$TEMPLATE_DIR/Plans" ]]; then
      cp -r "$TEMPLATE_DIR/Plans" "$WORKSPACE/Plans"
      echo "✓ Plans/ copied"
    fi

    # Copy tools
    mkdir -p "$WORKSPACE/tools"
    if [[ -d "$TEMPLATE_DIR/tools" ]]; then
      cp -r "$TEMPLATE_DIR/tools/"* "$WORKSPACE/tools/" 2>/dev/null || true
      echo "✓ tools/ copied"
    fi

    # Copy CLAUDE.md template if not present, then replace placeholders
    if [[ ! -f "$WORKSPACE/CLAUDE.md" ]] && [[ -f "$TEMPLATE_DIR/CLAUDE.md.template" ]]; then
      cp "$TEMPLATE_DIR/CLAUDE.md.template" "$WORKSPACE/CLAUDE.md"

      # Replace placeholders using PROJECT_NAME and sensible defaults
      PNAME="${PROJECT_NAME:-my-project}"
      sed -i "s|{{PROJECT_NAME}}|${PNAME}|g" "$WORKSPACE/CLAUDE.md"
      sed -i "s|{{PROJECT_DESCRIPTION}}|AI-managed project. Update this description in CLAUDE.md.|g" "$WORKSPACE/CLAUDE.md"
      sed -i "s|{{SPECS_DIR}}|Specifications|g" "$WORKSPACE/CLAUDE.md"
      sed -i "s|{{PLANS_DIR}}|Plans|g" "$WORKSPACE/CLAUDE.md"
      sed -i "s|{{BACKEND_URL}}|http://localhost:3001|g" "$WORKSPACE/CLAUDE.md"
      sed -i "s|{{FRONTEND_URL}}|http://localhost:5173|g" "$WORKSPACE/CLAUDE.md"
      sed -i "s|{{LOGIN_CREDENTIALS}}|admin@example.com / admin123|g" "$WORKSPACE/CLAUDE.md"

      # Multi-line placeholders — replace with starter content
      sed -i "s|{{SOURCE_LAYOUT}}|Source/                  # Application source code|g" "$WORKSPACE/CLAUDE.md"
      sed -i "s|{{DOMAIN_CONCEPTS}}|<!-- Define your domain entities here. See comments above for examples. -->|g" "$WORKSPACE/CLAUDE.md"
      sed -i "s|{{BUILD_COMMANDS}}|# Add your build and test commands here\n# Example:\n# npm install \&\& npm test|g" "$WORKSPACE/CLAUDE.md"
      sed -i "s|{{VERIFICATION_GATES}}|# Traceability Enforcer\npython3 tools/traceability-enforcer.py\n\n# Add your test commands here\n# npm test|g" "$WORKSPACE/CLAUDE.md"

      echo "✓ CLAUDE.md created from template (placeholders replaced with PROJECT_NAME=${PNAME})"
    fi

    echo "✓ Framework bootstrapped"
  else
    echo "⚠ No templates found at $TEMPLATE_DIR/Teams"
    echo "⚠ Mount templates volume or run setup.sh on the repo first"
  fi
fi

# Configure Claude Code auth via session token
# Claude Code stores OAuth credentials in .credentials.json with a specific schema.
# CLAUDE_SESSION_TOKEN should be the accessToken from 'claude login'.
if [[ -n "${CLAUDE_SESSION_TOKEN:-}" ]]; then
  mkdir -p /root/.claude
  cat > /root/.claude/.credentials.json <<CRED_EOF
{
  "claudeAiOauth": {
    "accessToken": "${CLAUDE_SESSION_TOKEN}",
    "refreshToken": "",
    "expiresAt": 9999999999999,
    "scopes": ["user:inference", "user:profile", "user:sessions:claude_code"],
    "subscriptionType": "team",
    "rateLimitTier": "default_claude_max_5x"
  }
}
CRED_EOF
  chmod 600 /root/.claude/.credentials.json
  echo "✓ Claude session token configured"
else
  echo "⚠ No CLAUDE_SESSION_TOKEN — run 'claude login' inside the container"
fi

echo ""
echo "═══════════════════════════════════════════"
echo "  Workspace ready at $WORKSPACE"
echo "═══════════════════════════════════════════"
