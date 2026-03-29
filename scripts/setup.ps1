$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$backendPath = Join-Path $repoRoot 'src\FluxMonitor.Backend'
$localDotnetRoot = Join-Path $repoRoot '.dotnet'
$localDotnet = Join-Path $localDotnetRoot 'dotnet.exe'
$installScript = Join-Path $env:TEMP 'dotnet-install-FluxMonitor.ps1'
$appUrl = 'http://localhost:5074'
$healthUrl = "$appUrl/api/health"

function Write-Section([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
}

function Get-DotnetCommand {
    $globalDotnet = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($globalDotnet) {
        try {
            $sdks = & $globalDotnet.Source --list-sdks 2>$null
            if ($sdks -match '^10\.') {
                return $globalDotnet.Source
            }
        }
        catch {
        }
    }

    if (Test-Path $localDotnet) {
        return $localDotnet
    }

    return $null
}

function Install-LocalDotnet {
    Write-Section 'Installing local .NET toolchain'
    New-Item -ItemType Directory -Path $localDotnetRoot -Force | Out-Null
    Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installScript
    & powershell -ExecutionPolicy Bypass -File $installScript -Channel '10.0' -InstallDir $localDotnetRoot -Quality 'ga'
    if (-not (Test-Path $localDotnet)) {
        throw 'Local .NET installation did not produce dotnet.exe.'
    }
    return $localDotnet
}

function Read-Choice([string]$Prompt, [hashtable]$Aliases, [string]$DefaultValue) {
    while ($true) {
        $value = Read-Host "$Prompt [$DefaultValue]"
        if ([string]::IsNullOrWhiteSpace($value)) {
            return $DefaultValue
        }

        $normalized = $value.Trim().ToLowerInvariant()

        if ($Aliases.ContainsKey($normalized)) {
            return $Aliases[$normalized]
        }

        Write-Host "Accepted values: $((($Aliases.Keys | Sort-Object -Unique) -join ', '))" -ForegroundColor Yellow
    }
}

function Read-YesNo([string]$Prompt, [bool]$DefaultValue) {
    $defaultText = if ($DefaultValue) { 'Y' } else { 'N' }
    $value = Read-Choice $Prompt @{
        'y' = 'Y'
        'yes' = 'Y'
        'n' = 'N'
        'no' = 'N'
    } $defaultText
    return $value.ToUpperInvariant() -eq 'Y'
}

function New-Json([hashtable]$Data) {
    return ($Data | ConvertTo-Json -Depth 10)
}

function Start-BrowserWhenReady([string]$TargetUrl, [string]$ProbeUrl) {
    return Start-Job -ScriptBlock {
        param($browserUrl, $healthProbe)

        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try {
                $response = Invoke-WebRequest -Uri $healthProbe -UseBasicParsing -TimeoutSec 2
                if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                    Start-Process $browserUrl | Out-Null
                    return
                }
            }
            catch {
            }

            Start-Sleep -Seconds 1
        }
    } -ArgumentList $TargetUrl, $ProbeUrl
}

function Write-InstallAudit {
    param(
        [string]$TargetPath,
        [string]$InstallKind,
        [string]$Repository,
        [string]$Branch,
        [string]$InstalledDestination
    )

    $payload = [ordered]@{
        installKind = $InstallKind
        repository = $Repository
        branch = $Branch
        releaseTag = ''
        assetName = ''
        checksum = ''
        destination = $InstalledDestination
        installedBy = [Environment]::UserName
        installedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
        machineName = [Environment]::MachineName
    }

    $payload | ConvertTo-Json -Depth 5 | Set-Content -Path $TargetPath -Encoding UTF8
}

Write-Section 'Flux Monitor setup'
Write-Host 'This script will prepare a local toolchain if needed, configure PostgreSQL storage, and launch the app without preloading any devices.' -ForegroundColor DarkGray

$dotnet = Get-DotnetCommand
if (-not $dotnet) {
    $install = Read-YesNo 'No compatible .NET 10 SDK was found. Install a local copy into this repository?' $true
    if (-not $install) {
        throw 'A .NET 10 SDK is required to run this repository from source.'
    }

    $dotnet = Install-LocalDotnet
}

$environment = 'Development'
$config = @{}

Write-Section 'Configuring first run'
$connectionString = Read-Host 'PostgreSQL connection string'
if ([string]::IsNullOrWhiteSpace($connectionString)) {
    throw 'A PostgreSQL connection string is required.'
}

$config['Monitor'] = @{
    Storage = @{
        Provider = 'TimescaleDb'
        ConnectionString = $connectionString
    }
}

$targetConfig = Join-Path $backendPath "appsettings.$environment.Local.json"
$auditPath = Join-Path (Join-Path $repoRoot 'src') 'install-audit.json'
$isFirstInstall = -not (Test-Path $targetConfig) -and -not (Test-Path $auditPath)
Set-Content -Path $targetConfig -Value (New-Json $config) -Encoding UTF8
if ($isFirstInstall) {
    Write-InstallAudit `
        -TargetPath $auditPath `
        -InstallKind 'source' `
        -Repository (& git -C $repoRoot remote get-url origin 2>$null) `
        -Branch (& git -C $repoRoot rev-parse --abbrev-ref HEAD 2>$null) `
        -InstalledDestination $repoRoot
}

Write-Section 'Starting Flux Monitor'
Write-Host "Environment: $environment" -ForegroundColor Green
Write-Host "Opening browser at $appUrl after the backend is ready." -ForegroundColor DarkGray
Write-Host 'No devices are preconfigured. Add them from the app after it starts.' -ForegroundColor DarkGray

$browserJob = Start-BrowserWhenReady -TargetUrl $appUrl -ProbeUrl $healthUrl

Push-Location $repoRoot
try {
    $env:ASPNETCORE_ENVIRONMENT = $environment
    & $dotnet run --project '.\src\FluxMonitor.Backend' --launch-profile http
}
finally {
    if ($browserJob) {
        Stop-Job -Job $browserJob -ErrorAction SilentlyContinue | Out-Null
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue | Out-Null
    }

    Pop-Location
}
