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

function Get-InstallerTempBase([string]$DestinationPath) {
    $candidates = [System.Collections.Generic.List[string]]::new()
    $parentPath = Split-Path -Path $DestinationPath -Parent

    while (-not [string]::IsNullOrWhiteSpace($parentPath) -and -not (Test-Path $parentPath)) {
        $nextPath = Split-Path -Path $parentPath -Parent
        if ($nextPath -eq $parentPath) {
            break
        }

        $parentPath = $nextPath
    }

    if (-not [string]::IsNullOrWhiteSpace($parentPath)) {
        $candidates.Add($parentPath)
    }

    if (-not [string]::IsNullOrWhiteSpace($HOME)) {
        $candidates.Add($HOME)
    }

    if (-not [string]::IsNullOrWhiteSpace($env:TEMP)) {
        $candidates.Add($env:TEMP)
    }

    foreach ($candidate in $candidates | Select-Object -Unique) {
        if ([string]::IsNullOrWhiteSpace($candidate) -or -not (Test-Path $candidate)) {
            continue
        }

        try {
            $probePath = Join-Path $candidate ('.fluxmonitor-write-test-' + [guid]::NewGuid().ToString('N'))
            New-Item -ItemType Directory -Path $probePath -Force | Out-Null
            Remove-Item -Path $probePath -Recurse -Force

            $installerBase = Join-Path $candidate '.fluxmonitor-installer'
            New-Item -ItemType Directory -Path $installerBase -Force | Out-Null
            return $installerBase
        }
        catch {
        }
    }

    throw 'Unable to find a writable working folder for the installer.'
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

function Copy-FirstExisting([string[]]$Sources, [string]$Target) {
    foreach ($source in $Sources) {
        if (-not (Test-Path $source)) {
            continue
        }

        Copy-IfExists -Source $source -Target $Target
        return
    }
}

function Preserve-ExistingState([string]$SourceRoot, [string]$PreserveRoot) {
    Copy-IfExists -Source (Join-Path $SourceRoot '.dotnet') -Target (Join-Path $PreserveRoot '.dotnet')

    $currentBackendPath = 'src\FluxMonitor.Backend'
    $legacyBackendPath = 'src\backend\FluxMonitor.Backend'

    foreach ($fileName in @('notifications.json', 'appsettings.Local.json', 'appsettings.Development.Local.json', 'appsettings.Production.Local.json')) {
        Copy-FirstExisting `
            -Sources @(
                (Join-Path $SourceRoot (Join-Path $currentBackendPath $fileName)),
                (Join-Path $SourceRoot (Join-Path $legacyBackendPath $fileName))
            ) `
            -Target (Join-Path $PreserveRoot (Join-Path $currentBackendPath $fileName))
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
$tempBase = Get-InstallerTempBase -DestinationPath $Destination
$tempRoot = Join-Path $tempBase ("FluxMonitor-install-" + [guid]::NewGuid().ToString('N'))
$zipPath = Join-Path $tempRoot 'repo.zip'
$extractPath = Join-Path $tempRoot 'extract'
$preservePath = Join-Path $tempRoot 'preserve'

Write-Host "Working folder: $tempRoot" -ForegroundColor DarkGray

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
