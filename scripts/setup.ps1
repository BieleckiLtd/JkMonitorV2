$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot
$backendPath = Join-Path $repoRoot 'src\backend\FluxMonitor.Backend'
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

function Get-WindowsSerialPorts {
    $ports = @()

    try {
        $ports = Get-CimInstance Win32_SerialPort |
            Sort-Object DeviceID |
            ForEach-Object {
                [pscustomobject]@{
                    PortName = $_.DeviceID
                    Label = if ([string]::IsNullOrWhiteSpace($_.Description)) { $_.DeviceID } else { "$($_.DeviceID) - $($_.Description)" }
                }
            }
    }
    catch {
    }

    if ($ports.Count -eq 0) {
        $ports = [System.IO.Ports.SerialPort]::GetPortNames() |
            Sort-Object |
            ForEach-Object {
                [pscustomobject]@{
                    PortName = $_
                    Label = $_
                }
            }
    }

    return $ports
}

function Select-SerialPort {
    $ports = Get-WindowsSerialPorts

    if ($ports.Count -eq 0) {
        Write-Host 'No COM ports were auto-detected. Falling back to manual entry.' -ForegroundColor Yellow
        $serialPort = Read-Host 'RS485 serial port (example: COM3)'
        if ([string]::IsNullOrWhiteSpace($serialPort)) {
            throw 'A serial port is required for hardware mode.'
        }

        return $serialPort
    }

    Write-Host 'Detected serial ports:' -ForegroundColor DarkGray
    for ($index = 0; $index -lt $ports.Count; $index++) {
        Write-Host "  $($index + 1). $($ports[$index].Label)"
    }
    Write-Host '  M. Enter a port manually'

    while ($true) {
        $selection = Read-Host 'Choose a serial port by number or M'
        if ([string]::IsNullOrWhiteSpace($selection)) {
            $selection = '1'
        }

        $normalized = $selection.Trim().ToLowerInvariant()
        if ($normalized -eq 'm' -or $normalized -eq 'manual') {
            $manualPort = Read-Host 'RS485 serial port (example: COM3)'
            if ([string]::IsNullOrWhiteSpace($manualPort)) {
                Write-Host 'A serial port is required.' -ForegroundColor Yellow
                continue
            }

            return $manualPort
        }

        $choice = 0
        if ([int]::TryParse($selection, [ref]$choice) -and $choice -ge 1 -and $choice -le $ports.Count) {
            return $ports[$choice - 1].PortName
        }

        Write-Host 'Enter a listed number or M for manual entry.' -ForegroundColor Yellow
    }
}

Write-Section 'Flux Monitor setup'
Write-Host 'This script will prepare a local toolchain if needed, require PostgreSQL configuration, guide the startup mode, and launch the app.' -ForegroundColor DarkGray

$dotnet = Get-DotnetCommand
if (-not $dotnet) {
    $install = Read-YesNo 'No compatible .NET 10 SDK was found. Install a local copy into this repository?' $true
    if (-not $install) {
        throw 'A .NET 10 SDK is required to run this repository from source.'
    }

    $dotnet = Install-LocalDotnet
}

$mode = Read-Choice 'Choose startup mode: 1 = simulator, 2 = hardware' @{
    '1' = '1'
    'sim' = '1'
    'simulator' = '1'
    '2' = '2'
    'hw' = '2'
    'hardware' = '2'
} '1'
$environment = 'Development'
$config = @{}

if ($mode -eq '1') {
    Write-Section 'Configuring simulator mode'
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
}
else {
    Write-Section 'Configuring hardware mode'
    $environment = 'Production'
    $serialPort = Select-SerialPort

    $connectionString = Read-Host 'PostgreSQL connection string'
    if ([string]::IsNullOrWhiteSpace($connectionString)) {
        throw 'A PostgreSQL connection string is required.'
    }

    $config['Monitor'] = @{
        SerialBus = @{
            PortName = $serialPort
        }
        Storage = @{
            Provider = 'TimescaleDb'
            ConnectionString = $connectionString
        }
        Devices = @(
            @{
                DeviceId = 'jk-master-01'
                DisplayName = 'Main Battery Rack'
                Protocol = 'jk-rs485'
                RegisterProfile = 'jk-inverter-v15'
                Address = 1
                IsMaster = $true
                PollIntervalMilliseconds = 1000
                Enabled = $true
            }
        )
    }
}

$targetConfig = Join-Path $backendPath "appsettings.$environment.Local.json"
Set-Content -Path $targetConfig -Value (New-Json $config) -Encoding UTF8

Write-Section 'Starting Flux Monitor'
Write-Host "Environment: $environment" -ForegroundColor Green
Write-Host "Opening browser at $appUrl after the backend is ready." -ForegroundColor DarkGray

$browserJob = Start-BrowserWhenReady -TargetUrl $appUrl -ProbeUrl $healthUrl

Push-Location $repoRoot
try {
    $env:ASPNETCORE_ENVIRONMENT = $environment
    & $dotnet run --project '.\src\backend\FluxMonitor.Backend' --launch-profile http
}
finally {
    if ($browserJob) {
        Stop-Job -Job $browserJob -ErrorAction SilentlyContinue | Out-Null
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue | Out-Null
    }

    Pop-Location
}
