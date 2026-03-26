param(
    [string]$Repository = 'https://github.com/BieleckiLtd/JkMonitorV2',

    [string]$Branch = 'dev',

    [string]$Destination = (Join-Path $HOME 'FluxMonitor')
)

$ErrorActionPreference = 'Stop'

function Write-Section([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
}

function Remove-DirectoryIfExists([string]$Path) {
    if (Test-Path $Path) {
        Remove-Item -Path $Path -Recurse -Force
    }
}

function Get-NormalizedRepository([string]$RepositoryInput) {
    $normalized = $RepositoryInput.Trim()

    if ($normalized -match '^https://github\.com/(?<repo>[^/]+/[^/]+)/?$') {
        return $Matches['repo']
    }

    if ($normalized -match '^[^/]+/[^/]+$') {
        return $normalized
    }

    throw "Unsupported repository value '$RepositoryInput'. Use 'owner/repo' or a GitHub URL."
}

function Copy-IfExists([string]$Source, [string]$Target) {
    if (-not (Test-Path $Source)) {
        return
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $Target) -Force | Out-Null
    Copy-Item -Path $Source -Destination $Target -Recurse -Force
}

function Preserve-ExistingState([string]$SourceRoot, [string]$PreserveRoot) {
    $itemsToPreserve = @(
        '.dotnet',
        'src\backend\FluxMonitor.Backend\notifications.json',
        'src\backend\FluxMonitor.Backend\appsettings.Local.json',
        'src\backend\FluxMonitor.Backend\appsettings.Development.Local.json',
        'src\backend\FluxMonitor.Backend\appsettings.Production.Local.json'
    )

    foreach ($relativePath in $itemsToPreserve) {
        $sourcePath = Join-Path $SourceRoot $relativePath
        $targetPath = Join-Path $PreserveRoot $relativePath
        Copy-IfExists -Source $sourcePath -Target $targetPath
    }
}

function Restore-PreservedState([string]$PreserveRoot, [string]$DestinationRoot) {
    if (-not (Test-Path $PreserveRoot)) {
        return
    }

    Get-ChildItem -Path $PreserveRoot -Force | ForEach-Object {
        $targetPath = Join-Path $DestinationRoot $_.Name
        Copy-Item -Path $_.FullName -Destination $targetPath -Recurse -Force
    }
}

function Get-RepositoryZipUrl([string]$Repo, [string]$Ref) {
    return "https://github.com/$Repo/archive/refs/heads/$Ref.zip"
}

$normalizedRepository = Get-NormalizedRepository -RepositoryInput $Repository

Write-Section 'Flux Monitor GitHub bootstrap'
Write-Host "Repository: $normalizedRepository" -ForegroundColor DarkGray
Write-Host "Branch: $Branch" -ForegroundColor DarkGray
Write-Host "Destination: $Destination" -ForegroundColor DarkGray

$zipUrl = Get-RepositoryZipUrl -Repo $normalizedRepository -Ref $Branch
$tempRoot = Join-Path $env:TEMP ("FluxMonitor-install-" + [guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'repo.zip'
$extractPath = Join-Path $tempRoot 'extract'
$preservePath = Join-Path $tempRoot 'preserve'

New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
New-Item -ItemType Directory -Path $extractPath -Force | Out-Null
New-Item -ItemType Directory -Path $preservePath -Force | Out-Null

try {
    Write-Section 'Downloading source archive'
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath

    Write-Section 'Extracting archive'
    Expand-Archive -Path $zipPath -DestinationPath $extractPath -Force

    $sourceRoot = Get-ChildItem -Path $extractPath -Directory | Select-Object -First 1
    if (-not $sourceRoot) {
        throw 'The downloaded archive did not contain a repository root folder.'
    }

    Write-Section 'Preparing installation folder'
    if (Test-Path $Destination) {
        Write-Host 'Existing installation found. Preserving local config and cached toolchain.' -ForegroundColor DarkGray
        Preserve-ExistingState -SourceRoot $Destination -PreserveRoot $preservePath
        Remove-DirectoryIfExists -Path $Destination
    }

    New-Item -ItemType Directory -Path (Split-Path -Parent $Destination) -Force | Out-Null
    Move-Item -Path $sourceRoot.FullName -Destination $Destination
    Restore-PreservedState -PreserveRoot $preservePath -DestinationRoot $Destination

    $setupScript = Join-Path $Destination 'scripts\setup.ps1'
    if (-not (Test-Path $setupScript)) {
        throw 'The repository does not contain scripts\setup.ps1.'
    }

    Write-Section 'Starting guided setup'
    Set-Location $Destination
    & powershell -ExecutionPolicy Bypass -File $setupScript
}
finally {
    Remove-DirectoryIfExists -Path $tempRoot
}