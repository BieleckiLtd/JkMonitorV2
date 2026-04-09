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

    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    npm run dev
}
finally {
    Pop-Location
}
