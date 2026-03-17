$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$installer = Join-Path $scriptRoot 'install-from-github.ps1'

if (-not (Test-Path $installer)) {
    throw 'The GitHub installer script was not found next to update.ps1.'
}

& powershell -ExecutionPolicy Bypass -File $installer -Destination $repoRoot