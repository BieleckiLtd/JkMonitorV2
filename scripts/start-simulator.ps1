$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$env:ASPNETCORE_ENVIRONMENT = 'Development'

Write-Host 'Starting Flux Monitor in simulator mode...' -ForegroundColor Cyan
Write-Host 'The Development configuration uses simulated devices and no database by default.' -ForegroundColor DarkGray

dotnet run --project .\src\FluxMonitor.Backend
