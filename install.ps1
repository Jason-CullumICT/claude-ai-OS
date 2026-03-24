#Requires -Version 5.1
<#
.SYNOPSIS
    claude-ai-OS — Claude Code Environment Installer (PowerShell)

.DESCRIPTION
    Sets up Claude Code with plugins, permissions, status line,
    and the full agent team development framework.

.PARAMETER NonInteractive
    Accept all defaults without prompting.

.PARAMETER SkipPlugins
    Skip plugin installation (for offline/air-gapped setups).

.EXAMPLE
    .\install.ps1
    .\install.ps1 -NonInteractive
    .\install.ps1 -SkipPlugins
#>

[CmdletBinding()]
param(
    [switch]$NonInteractive,
    [switch]$SkipPlugins
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ClaudeDir = Join-Path $env:USERPROFILE ".claude"
$SettingsFile = Join-Path $ClaudeDir "settings.json"

# ── Defaults ──
$EffortLevel = "high"
$DefaultMode = "acceptEdits"
$ColorTheme = "cyan"
$Interactive = -not $NonInteractive

# ── Helpers ──
function Read-WithDefault {
    param([string]$Prompt, [string]$Default)
    if (-not $Interactive) { return $Default }
    $result = Read-Host "? $Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($result)) { return $Default }
    return $result
}

function Write-Ok    { param([string]$Msg) Write-Host "  + $Msg" -ForegroundColor Green }
function Write-Skip  { param([string]$Msg) Write-Host "  o $Msg" -ForegroundColor DarkGray }
function Write-Info  { param([string]$Msg) Write-Host $Msg -ForegroundColor Cyan }
function Write-Warn  { param([string]$Msg) Write-Host $Msg -ForegroundColor Yellow }

# ══════════════════════════════════════════════════════════════
# Step 0: Prerequisites
# ══════════════════════════════════════════════════════════════
Write-Host ""
Write-Info "==========================================="
Write-Info "  claude-ai-OS Installer"
Write-Info "==========================================="
Write-Host ""

# Check Claude Code
$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if ($claudeCmd) {
    $ver = & claude --version 2>$null
    Write-Ok "Claude Code found: $ver"
} else {
    Write-Warn "Claude Code not found. Install it first:"
    Write-Host "  npm install -g @anthropic-ai/claude-code"
    Write-Host "  claude login"
    exit 1
}

# Check jq
$jqCmd = Get-Command jq -ErrorAction SilentlyContinue
if ($jqCmd) {
    Write-Ok "jq found"
} else {
    Write-Warn "jq not found -- status line needs it."
    Write-Host "  winget install jqlang.jq"
}

# Check Node.js
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
    Write-Ok "Node.js found: $(node --version)"
} else {
    Write-Warn "Node.js not found -- plugins require it."
}

# ══════════════════════════════════════════════════════════════
# Step 1: Preferences
# ══════════════════════════════════════════════════════════════
Write-Host ""
Write-Info "-- Configuration --"
Write-Host ""

if ($Interactive) {
    Write-Host "  Permission mode: default (ask), acceptEdits (auto-accept), bypassPermissions (no prompts)"
    $DefaultMode = Read-WithDefault "Permission mode" $DefaultMode

    Write-Host ""
    Write-Host "  Effort level: low, medium, high"
    $EffortLevel = Read-WithDefault "Effort level" $EffortLevel

    Write-Host ""
    Write-Host "  Status line color: cyan, blue, green, orange, teal, lavender, rose, gold, slate, gray"
    $ColorTheme = Read-WithDefault "Status line color" $ColorTheme
}

# ══════════════════════════════════════════════════════════════
# Step 2: Global settings.json
# ══════════════════════════════════════════════════════════════
Write-Host ""
Write-Info "-- Writing global settings --"

if (-not (Test-Path $ClaudeDir)) {
    New-Item -ItemType Directory -Path $ClaudeDir -Force | Out-Null
}

$bashPerms = @(
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
)

if (Test-Path $SettingsFile) {
    Write-Warn "  settings.json exists -- merging"
    $settings = Get-Content $SettingsFile -Raw | ConvertFrom-Json

    # Update permissions
    if (-not $settings.permissions) { $settings | Add-Member -NotePropertyName permissions -NotePropertyValue ([PSCustomObject]@{}) }
    $settings.permissions | Add-Member -NotePropertyName allow -NotePropertyValue $bashPerms -Force
    $settings.permissions | Add-Member -NotePropertyName defaultMode -NotePropertyValue $DefaultMode -Force

    # Update other settings
    if ($settings.PSObject.Properties["effortLevel"]) { $settings.effortLevel = $EffortLevel }
    else { $settings | Add-Member -NotePropertyName effortLevel -NotePropertyValue $EffortLevel }

    if ($settings.PSObject.Properties["autoUpdatesChannel"]) { $settings.autoUpdatesChannel = "latest" }
    else { $settings | Add-Member -NotePropertyName autoUpdatesChannel -NotePropertyValue "latest" }

    # Status line
    $statusLine = [PSCustomObject]@{ type = "command"; command = "bash ~/.claude/statusline.sh" }
    if ($settings.PSObject.Properties["statusLine"]) { $settings.statusLine = $statusLine }
    else { $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue $statusLine }

    # VoltAgent marketplace
    if (-not $settings.PSObject.Properties["extraKnownMarketplaces"]) {
        $settings | Add-Member -NotePropertyName extraKnownMarketplaces -NotePropertyValue ([PSCustomObject]@{})
    }
    $voltSource = [PSCustomObject]@{ source = [PSCustomObject]@{ source = "github"; repo = "VoltAgent/awesome-claude-code-subagents" } }
    $settings.extraKnownMarketplaces | Add-Member -NotePropertyName "voltagent-subagents" -NotePropertyValue $voltSource -Force

    $settings | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile -Encoding UTF8
    Write-Ok "Merged into existing settings.json"
} else {
    $settings = [ordered]@{
        permissions = [ordered]@{
            allow = $bashPerms
            defaultMode = $DefaultMode
        }
        statusLine = [ordered]@{
            type = "command"
            command = "bash ~/.claude/statusline.sh"
        }
        enabledPlugins = [ordered]@{}
        extraKnownMarketplaces = [ordered]@{
            "voltagent-subagents" = [ordered]@{
                source = [ordered]@{ source = "github"; repo = "VoltAgent/awesome-claude-code-subagents" }
            }
        }
        effortLevel = $EffortLevel
        autoUpdatesChannel = "latest"
    }
    $settings | ConvertTo-Json -Depth 10 | Set-Content $SettingsFile -Encoding UTF8
    Write-Ok "Created settings.json"
}

# ══════════════════════════════════════════════════════════════
# Step 3: Status line script
# ══════════════════════════════════════════════════════════════
Write-Host ""
Write-Info "-- Installing status line --"

$statuslineSrc = Join-Path $ScriptDir "statusline.sh"
$statuslineDst = Join-Path $ClaudeDir "statusline.sh"

if (Test-Path $statuslineSrc) {
    Copy-Item $statuslineSrc $statuslineDst -Force
    Write-Ok "Installed full statusline.sh"
} else {
    # Embedded minimal version
    @'
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
'@ | Set-Content $statuslineDst -Encoding UTF8
    Write-Ok "Installed minimal statusline.sh"
}

# ══════════════════════════════════════════════════════════════
# Step 4: Install plugins
# ══════════════════════════════════════════════════════════════
if ($SkipPlugins) {
    Write-Host ""
    Write-Skip "Skipping plugin installation (-SkipPlugins)"
} else {
    Write-Host ""
    Write-Info "-- Installing plugins --"

    $officialPlugins = @(
        "context7",
        "superpowers",
        "code-review",
        "commit-commands",
        "feature-dev",
        "code-simplifier",
        "frontend-design",
        "explanatory-output-style"
    )

    foreach ($plugin in $officialPlugins) {
        try {
            & claude plugins install $plugin 2>$null
            Write-Ok $plugin
        } catch {
            Write-Skip "$plugin (may already be installed)"
        }
    }

    Write-Host ""
    Write-Info "-- Installing VoltAgent subagents --"

    $voltPlugins = @(
        "voltagent-lang",
        "voltagent-qa-sec",
        "voltagent-core-dev",
        "voltagent-infra",
        "voltagent-dev-exp",
        "voltagent-domains"
    )

    foreach ($plugin in $voltPlugins) {
        try {
            & claude plugins install "${plugin}@voltagent-subagents" 2>$null
            Write-Ok $plugin
        } catch {
            Write-Skip "$plugin (may already be installed)"
        }
    }
}

# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════
Write-Host ""
Write-Info "==========================================="
Write-Info "  Installation Complete!"
Write-Info "==========================================="
Write-Host ""
Write-Host "  Installed to: $ClaudeDir"
Write-Host ""
Write-Host "  What was configured:" -ForegroundColor Green
Write-Host "    + Global settings (permissions: $DefaultMode, effort: $EffortLevel)"
Write-Host "    + Status line ($ColorTheme theme)"
Write-Host "    + VoltAgent marketplace registered"
if (-not $SkipPlugins) {
    Write-Host "    + $($officialPlugins.Count) official plugins + $($voltPlugins.Count) VoltAgent packs"
}
Write-Host ""
Write-Host "  Next steps:" -ForegroundColor Yellow
Write-Host ""
Write-Host "  1. Bootstrap a project:"
Write-Host "     .\setup.ps1 C:\projects\my-app -Name 'My Project'"
Write-Host ""
Write-Host "  2. Add MCP servers (optional):"
Write-Host "     claude mcp add my-docs --type sse --url https://mcp.example.com"
Write-Host ""
Write-Host "  3. Chrome extension (optional):"
Write-Host "     https://claude.ai/chrome"
Write-Host ""
Write-Host "  4. Start Claude Code:"
Write-Host "     cd C:\projects\my-app; claude"
Write-Host ""
Write-Host "  5. Run a team (dedicated session):"
Write-Host "     claude"
Write-Host "     > Read Teams/TheATeam/team-leader.md and follow it exactly."
Write-Host "     > Task: implement <feature>. Plan file: Plans/<plan>.md"
Write-Host ""
