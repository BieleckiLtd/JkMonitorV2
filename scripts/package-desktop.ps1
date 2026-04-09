param()

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$desktopRoot = Join-Path $repoRoot "src\FluxMonitor.Desktop"
$nodeModulesPath = Join-Path $desktopRoot "node_modules"

Push-Location $desktopRoot
try {
    if (-not (Test-Path $nodeModulesPath)) {
        npm ci
    }

    npm run dist:win
}
finally {
    Pop-Location
}
