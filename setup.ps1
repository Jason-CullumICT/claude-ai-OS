#Requires -Version 5.1
<#
.SYNOPSIS
    claude-ai-OS Bootstrap Script (PowerShell)
    Copies the template structure into a target project directory and customizes placeholders.

.DESCRIPTION
    Bootstraps a project with Level 5 AI maturity practices.
    Supports interactive mode (default) and non-interactive mode.

.PARAMETER TargetDirectory
    Path to the project to bootstrap.

.PARAMETER Name
    Project name (default: directory name).

.PARAMETER Description
    Project description (default: "An AI-first, spec-first project").

.PARAMETER BackendUrl
    Backend URL (default: http://localhost:3001).

.PARAMETER FrontendUrl
    Frontend URL (default: http://localhost:5173).

.PARAMETER Credentials
    Login credentials (default: "admin@example.com / admin123").

.PARAMETER Stack
    Tech stack preset: node-react, go-react, python-react, custom (default: node-react).

.PARAMETER Force
    Overwrite existing files without prompting.

.PARAMETER NonInteractive
    Skip prompts entirely, use defaults.

.EXAMPLE
    # Interactive (default):
    .\setup.ps1 C:\projects\my-app

    # Non-interactive with options:
    .\setup.ps1 C:\projects\my-app -Name "My App" -Stack go-react -NonInteractive

    # Force overwrite:
    .\setup.ps1 C:\projects\my-app -Name "My App" -Force
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$TargetDirectory,

    [Alias("n")]
    [string]$Name,

    [string]$Description,

    [string]$BackendUrl = "http://localhost:3001",

    [string]$FrontendUrl = "http://localhost:5173",

    [string]$Credentials,

    [ValidateSet("node-react", "go-react", "python-react", "custom")]
    [string]$Stack,

    [switch]$Force,

    [switch]$NonInteractive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Paths ---
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$TemplateDir = Join-Path $ScriptDir "templates"

# Resolve target to absolute path
$TargetDirectory = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($TargetDirectory)

# Default project name to directory basename
if (-not $Name) {
    $Name = Split-Path -Leaf $TargetDirectory
}

# --- Detect interactive mode ---
$Interactive = -not $NonInteractive
# If running in a non-interactive host (piped, ISE background, etc.), disable prompts
if ($Interactive -and (-not [Environment]::UserInteractive)) {
    $Interactive = $false
}

# --- Helper: prompt with default ---
function Read-WithDefault {
    param(
        [string]$Prompt,
        [string]$Default
    )

    if (-not $Interactive) {
        return $Default
    }

    if ($Default) {
        $result = Read-Host "? $Prompt [$Default]"
        if ([string]::IsNullOrWhiteSpace($result)) { return $Default }
        return $result
    }
    else {
        return Read-Host "? $Prompt"
    }
}

# --- Banner ---
Write-Host ""
Write-Host "claude-ai-OS Bootstrap" -ForegroundColor Cyan
Write-Host "======================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Project directory: $TargetDirectory"
Write-Host ""

# --- Interactive prompts ---
if ($Interactive) {
    $Name = Read-WithDefault "Project name" $Name

    if (-not $Description) {
        $Description = Read-WithDefault "Project description" "An AI-first, spec-first project"
    } else {
        $Description = Read-WithDefault "Project description" $Description
    }

    $BackendUrl = Read-WithDefault "Backend URL" $BackendUrl
    $FrontendUrl = Read-WithDefault "Frontend URL" $FrontendUrl

    if (-not $Credentials) {
        $Credentials = Read-WithDefault "Login credentials" "admin@example.com / admin123"
    } else {
        $Credentials = Read-WithDefault "Login credentials" $Credentials
    }

    if (-not $Stack) {
        Write-Host ""
        Write-Host "  Tech stack presets configure Build & Test commands and verification gates."
        Write-Host "  Options: node-react, go-react, python-react, custom" -ForegroundColor DarkGray
        Write-Host ""
        $Stack = Read-WithDefault "Tech stack" "node-react"
    } else {
        $Stack = Read-WithDefault "Tech stack (node-react, go-react, python-react, custom)" $Stack
    }

    Write-Host ""
}
else {
    # Non-interactive defaults
    if (-not $Description) { $Description = "An AI-first, spec-first project" }
    if (-not $Credentials) { $Credentials = "admin@example.com / admin123" }
    if (-not $Stack) { $Stack = "node-react" }
}

# Validate tech stack
$validStacks = @("node-react", "go-react", "python-react", "custom")
if ($Stack -notin $validStacks) {
    Write-Warning "Unknown tech stack '$Stack', falling back to 'custom'"
    $Stack = "custom"
}

# --- Generate preset content ---
$SpecsDir = "Specifications"
$PlansDir = "Plans"

switch ($Stack) {
    "node-react" {
        $SourceLayout = @"
Source/
  Backend/               # Node/Express API server
  Frontend/              # React/Vite web UI
  Shared/                # Shared TypeScript types across layers
"@

        $BuildCommands = @"
| Component | Build / Install | Test |
|-----------|----------------|------|
| Backend | ``cd Source/Backend && npm install`` | ``npm run test`` |
| Frontend | ``cd Source/Frontend && npm install`` | ``npm run test`` |

<!-- Add more rows for your stack: -->
<!-- | E2E Tests | ``cd Source/E2E && npm install`` | ``npx playwright test`` | -->

Type checks: ``npx tsc --noEmit`` in Backend and Frontend directories.

<!-- Add project-specific build notes: -->
<!-- Prisma: schema at Source/Backend/prisma/schema.prisma. Run ``npx prisma generate`` on fresh checkout. -->
"@

        $VerificationGates = @"
# Traceability Enforcer (MANDATORY for Level 5 Maturity)
python3 tools/traceability-enforcer.py

# Backend
cd Source/Backend && npm run test && npx tsc --noEmit

# Frontend
cd Source/Frontend && npm run test && npx tsc --noEmit

# Add your gates here -- every component must have a verification command
"@
    }

    "go-react" {
        $SourceLayout = @"
Source/
  API/                   # Go API server
  Frontend/              # React/Vite web UI
  Shared/                # Shared TypeScript types for frontend
"@

        $BuildCommands = @"
| Component | Build / Install | Test |
|-----------|----------------|------|
| API (Go) | ``go build ./...`` | ``go test ./... -v`` |
| Frontend | ``cd Source/Frontend && npm install`` | ``npm run test`` |

<!-- Add more rows for your stack: -->
<!-- | CLI Tools | ``go build ./cmd/...`` | ``go test ./cmd/... -v`` | -->

Type checks: ``npx tsc --noEmit`` in the Frontend directory.

<!-- Add project-specific build notes: -->
<!-- Go modules: run ``go mod tidy`` after adding dependencies. -->
"@

        $VerificationGates = @"
# Traceability Enforcer (MANDATORY for Level 5 Maturity)
python3 tools/traceability-enforcer.py

# Go API
go build ./... && go test ./... -v

# Frontend
cd Source/Frontend && npm run test && npx tsc --noEmit

# Add your gates here -- every component must have a verification command
"@
    }

    "python-react" {
        $SourceLayout = @"
Source/
  Backend/               # Python/FastAPI server
  Frontend/              # React/Vite web UI
  Shared/                # Shared TypeScript types for frontend
"@

        $BuildCommands = @"
| Component | Build / Install | Test |
|-----------|----------------|------|
| Backend | ``cd Source/Backend && pip install -r requirements.txt`` | ``pytest`` |
| Frontend | ``cd Source/Frontend && npm install`` | ``npm run test`` |

<!-- Add more rows for your stack: -->
<!-- | Worker | ``cd Source/Worker && pip install -r requirements.txt`` | ``pytest`` | -->

Type checks: ``mypy Source/Backend/`` for backend, ``npx tsc --noEmit`` for frontend.

<!-- Add project-specific build notes: -->
<!-- Virtual env: run ``python -m venv .venv && .venv\Scripts\activate`` on fresh checkout. -->
"@

        $VerificationGates = @"
# Traceability Enforcer (MANDATORY for Level 5 Maturity)
python3 tools/traceability-enforcer.py

# Backend
cd Source/Backend && pytest && mypy .

# Frontend
cd Source/Frontend && npm run test && npx tsc --noEmit

# Add your gates here -- every component must have a verification command
"@
    }

    "custom" {
        $SourceLayout = @"
Source/
  # TODO: Add your source directories here
  # Backend/             # API server
  # Frontend/            # Web UI
  # Shared/              # Shared types across layers
"@

        $BuildCommands = @"
| Component | Build / Install | Test |
|-----------|----------------|------|
| <!-- TODO --> | ``TODO`` | ``TODO`` |

<!-- Add rows for each component in your stack. Examples: -->
<!-- | Backend | ``cd Source/Backend && npm install`` | ``npm run test`` | -->
<!-- | Frontend | ``cd Source/Frontend && npm install`` | ``npm run test`` | -->
<!-- | Go API | ``go build ./...`` | ``go test ./... -v`` | -->
<!-- | Python API | ``pip install -r requirements.txt`` | ``pytest`` | -->

<!-- Type checks: ``npx tsc --noEmit`` in Backend and Frontend directories. -->

<!-- Add project-specific build notes here -->
"@

        $VerificationGates = @"
# Traceability Enforcer (MANDATORY for Level 5 Maturity)
python3 tools/traceability-enforcer.py

# TODO: Add verification gates for each component
# Example:
# cd Source/Backend && npm run test && npx tsc --noEmit
# cd Source/Frontend && npm run test && npx tsc --noEmit
"@
    }
}

$DomainConcepts = @"
<!-- Delete the examples in the HTML comments above and replace this line with your domain concepts. -->
<!-- Use the format: - **Entity** -- description of what it is and why it matters -->
"@

# --- Print configuration summary ---
Write-Host "Setting up files..." -ForegroundColor Yellow
Write-Host ""
Write-Host "  Project name:    $Name"
Write-Host "  Description:     $Description"
Write-Host "  Backend URL:     $BackendUrl"
Write-Host "  Frontend URL:    $FrontendUrl"
Write-Host "  Credentials:     $Credentials"
Write-Host "  Tech stack:      $Stack"
Write-Host ""

# --- Helper: copy file with overwrite protection ---
function Copy-SafeFile {
    param(
        [string]$Source,
        [string]$Destination
    )

    $destDir = Split-Path -Parent $Destination
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    if ((Test-Path $Destination) -and (-not $Force)) {
        Write-Host "  [SKIP] $Destination (already exists, use -Force to overwrite)" -ForegroundColor DarkGray
        return
    }

    Copy-Item -Path $Source -Destination $Destination -Force
    Write-Host "  [CREATE] $Destination" -ForegroundColor Green
}

# --- Helper: copy template and replace all placeholders ---
function Copy-AndReplace {
    param(
        [string]$Source,
        [string]$Destination
    )

    $destDir = Split-Path -Parent $Destination
    if (-not (Test-Path $destDir)) {
        New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }

    if ((Test-Path $Destination) -and (-not $Force)) {
        Write-Host "  [SKIP] $Destination (already exists, use -Force to overwrite)" -ForegroundColor DarkGray
        return
    }

    # Read template content
    $content = Get-Content -Path $Source -Raw -Encoding UTF8

    # Single-line replacements
    $content = $content -replace [regex]::Escape('{{PROJECT_NAME}}'), $Name
    $content = $content -replace [regex]::Escape('{{PROJECT_DESCRIPTION}}'), $Description
    $content = $content -replace [regex]::Escape('{{BACKEND_URL}}'), $BackendUrl
    $content = $content -replace [regex]::Escape('{{FRONTEND_URL}}'), $FrontendUrl
    $content = $content -replace [regex]::Escape('{{LOGIN_CREDENTIALS}}'), $Credentials
    $content = $content -replace [regex]::Escape('{{SPECS_DIR}}'), $SpecsDir
    $content = $content -replace [regex]::Escape('{{PLANS_DIR}}'), $PlansDir

    # Multi-line replacements
    $content = $content -replace [regex]::Escape('{{SOURCE_LAYOUT}}'), $SourceLayout
    $content = $content -replace [regex]::Escape('{{BUILD_COMMANDS}}'), $BuildCommands
    $content = $content -replace [regex]::Escape('{{VERIFICATION_GATES}}'), $VerificationGates
    $content = $content -replace [regex]::Escape('{{DOMAIN_CONCEPTS}}'), $DomainConcepts

    # Write with UTF-8 no BOM
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Destination, $content, $utf8NoBom)

    Write-Host "  [CREATE] $Destination" -ForegroundColor Green
}

# --- Create directory structure ---
Write-Host "Creating directory structure..."
$dirs = @(
    "Teams\TheATeam\learnings",
    "Teams\TheFixer\learnings",
    "Teams\TheInspector\learnings",
    "Teams\Shared",
    "tools",
    "Plans\phase-signals",
    "Plans\_template",
    "Specifications",
    "Source"
)
foreach ($dir in $dirs) {
    $fullPath = Join-Path $TargetDirectory $dir
    if (-not (Test-Path $fullPath)) {
        New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
    }
}

# --- Copy and customize CLAUDE.md ---
Write-Host ""
Write-Host "Setting up CLAUDE.md..."
$templateFile = Join-Path $TemplateDir "CLAUDE.md.template"
if (Test-Path $templateFile) {
    Copy-AndReplace $templateFile (Join-Path $TargetDirectory "CLAUDE.md")
}
else {
    Write-Error "CLAUDE.md.template not found in $TemplateDir"
    exit 1
}

# --- Copy team files ---
Write-Host ""
Write-Host "Setting up Teams..."

# TheATeam
foreach ($file in Get-ChildItem -Path (Join-Path $TemplateDir "Teams\TheATeam") -Filter "*.md" -ErrorAction SilentlyContinue) {
    Copy-SafeFile $file.FullName (Join-Path $TargetDirectory "Teams\TheATeam\$($file.Name)")
}

# TheFixer
foreach ($file in Get-ChildItem -Path (Join-Path $TemplateDir "Teams\TheFixer") -Filter "*.md" -ErrorAction SilentlyContinue) {
    Copy-SafeFile $file.FullName (Join-Path $TargetDirectory "Teams\TheFixer\$($file.Name)")
}

# TheInspector (copy .md and .yml files)
foreach ($file in Get-ChildItem -Path (Join-Path $TemplateDir "Teams\TheInspector") -Include "*.md","*.yml" -ErrorAction SilentlyContinue) {
    Copy-SafeFile $file.FullName (Join-Path $TargetDirectory "Teams\TheInspector\$($file.Name)")
}

# Shared
foreach ($file in Get-ChildItem -Path (Join-Path $TemplateDir "Teams\Shared") -Filter "*.md" -ErrorAction SilentlyContinue) {
    Copy-SafeFile $file.FullName (Join-Path $TargetDirectory "Teams\Shared\$($file.Name)")
}

# .gitkeep for learnings
"" | Out-File -FilePath (Join-Path $TargetDirectory "Teams\TheATeam\learnings\.gitkeep") -NoNewline -Encoding ascii
"" | Out-File -FilePath (Join-Path $TargetDirectory "Teams\TheFixer\learnings\.gitkeep") -NoNewline -Encoding ascii
"" | Out-File -FilePath (Join-Path $TargetDirectory "Teams\TheInspector\learnings\.gitkeep") -NoNewline -Encoding ascii

# --- Copy tools ---
Write-Host ""
Write-Host "Setting up tools..."
foreach ($file in Get-ChildItem -Path (Join-Path $TemplateDir "tools") -File -ErrorAction SilentlyContinue) {
    Copy-SafeFile $file.FullName (Join-Path $TargetDirectory "tools\$($file.Name)")
}

# --- Copy Plans ---
Write-Host ""
Write-Host "Setting up Plans..."
foreach ($file in Get-ChildItem -Path (Join-Path $TemplateDir "Plans\phase-signals") -Filter "*.md" -ErrorAction SilentlyContinue) {
    Copy-SafeFile $file.FullName (Join-Path $TargetDirectory "Plans\phase-signals\$($file.Name)")
}
foreach ($file in Get-ChildItem -Path (Join-Path $TemplateDir "Plans\_template") -Filter "*.md" -ErrorAction SilentlyContinue) {
    Copy-SafeFile $file.FullName (Join-Path $TargetDirectory "Plans\_template\$($file.Name)")
}

# --- Summary ---
Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Bootstrap Complete!" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Created in: $TargetDirectory"
Write-Host ""
Write-Host "  Files created:" -ForegroundColor Green
Write-Host "    CLAUDE.md (customized for `"$Name`", stack: $Stack)"
Write-Host "    Teams\TheATeam\     (feature implementation pipeline)"
Write-Host "    Teams\TheFixer\     (bug fix / refactor pipeline)"
Write-Host "    Teams\TheInspector\ (system health audit - security, quality, perf, chaos)"
Write-Host "    Teams\Shared\       (shared agent roles)"
Write-Host "    tools\           (pipeline dashboard, traceability enforcer)"
Write-Host "    Plans\           (phase signals, plan templates)"
Write-Host ""
Write-Host "  Still needs your attention:" -ForegroundColor Yellow
Write-Host "    - CLAUDE.md: Fill in `"Key Domain Concepts`" section with your domain entities"
Write-Host "    - CLAUDE.md: Add any MCP tool references you use"
Write-Host "    - CLAUDE.md: Customize Architecture Rules for your specific tech stack"
if ($Stack -eq "custom") {
    Write-Host "    - CLAUDE.md: Fill in Build & Test table and verification gates"
    Write-Host "    - CLAUDE.md: Update Repository Layout with your source directories"
}
Write-Host "    - CLAUDE.md: Add extra Dev Environment rows (database, Redis, etc.)"
Write-Host "    - Teams\: Customize role files for your project's modules"
Write-Host "    - Teams\TheInspector\inspector.config.yml: (optional) Override auto-discovered settings"
Write-Host "    - Specifications\: Add your domain specifications"
Write-Host "    - Plans\: Create your first feature plan"
Write-Host ""
