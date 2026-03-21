param(
    [string]$Repository = 'https://github.com/BieleckiLtd/JkMonitorV2',

    [string]$ReleaseTag = 'dev-latest',

    [string]$Destination = (Join-Path $HOME 'jkmonitor')
)

$ErrorActionPreference = 'Stop'

$appRoot = Join-Path $Destination 'app'
$localDotnetRoot = Join-Path $Destination '.dotnet'
$localDotnet = Join-Path $localDotnetRoot 'dotnet.exe'
$appPort = 5074
$appBindUrl = "http://0.0.0.0:$appPort"
$appLocalUrl = "http://127.0.0.1:$appPort"
$assetName = 'jkmonitor-backend-win-x64.zip'
$installScript = Join-Path $env:TEMP 'dotnet-install-jkmonitor-runtime.ps1'
$envPath = Join-Path $Destination 'jkmonitor.env'
$taskName = 'JK Monitor'

function Write-Section([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor DarkYellow
}

function Write-Info([string]$Text) {
    Write-Host $Text -ForegroundColor Cyan
}

function Write-Success([string]$Text) {
    Write-Host $Text -ForegroundColor Green
}

function Write-WarningText([string]$Text) {
    Write-Host $Text -ForegroundColor Yellow
}

function Write-Muted([string]$Text) {
    Write-Host $Text -ForegroundColor DarkGray
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
    Copy-IfExists (Join-Path $SourceRoot '.dotnet') (Join-Path $PreserveRoot '.dotnet')

    foreach ($fileName in 'appsettings.Local.json', 'appsettings.Development.Local.json', 'appsettings.Production.Local.json') {
        Copy-IfExists (Join-Path $SourceRoot "app\$fileName") (Join-Path $PreserveRoot "app\$fileName")
    }
}

function Restore-PreservedState([string]$PreserveRoot, [string]$DestinationRoot) {
    if (-not (Test-Path $PreserveRoot)) {
        return
    }

    if (Test-Path (Join-Path $PreserveRoot '.dotnet')) {
        Remove-Item -Path (Join-Path $DestinationRoot '.dotnet') -Recurse -Force -ErrorAction SilentlyContinue
        Copy-Item -Path (Join-Path $PreserveRoot '.dotnet') -Destination (Join-Path $DestinationRoot '.dotnet') -Recurse -Force
    }

    foreach ($fileName in 'appsettings.Local.json', 'appsettings.Development.Local.json', 'appsettings.Production.Local.json') {
        $sourcePath = Join-Path $PreserveRoot "app\$fileName"
        if (Test-Path $sourcePath) {
            New-Item -ItemType Directory -Path (Join-Path $DestinationRoot 'app') -Force | Out-Null
            Copy-Item -Path $sourcePath -Destination (Join-Path $DestinationRoot "app\$fileName") -Force
        }
    }
}

function Get-DotnetCommand {
    $globalDotnet = Get-Command dotnet -ErrorAction SilentlyContinue
    if ($globalDotnet) {
        try {
            $runtimes = & $globalDotnet.Source --list-runtimes 2>$null
            if ($runtimes -match '^Microsoft\.AspNetCore\.App 10\.') {
                return $globalDotnet.Source
            }
        }
        catch {
        }
    }

    if (Test-Path $localDotnet) {
        try {
            $runtimes = & $localDotnet --list-runtimes 2>$null
            if ($runtimes -match '^Microsoft\.AspNetCore\.App 10\.') {
                return $localDotnet
            }
        }
        catch {
        }
    }

    return $null
}

function Install-LocalRuntime {
    Write-Section 'Installing local ASP.NET Core runtime'
    New-Item -ItemType Directory -Path $localDotnetRoot -Force | Out-Null
    Invoke-WebRequest -Uri 'https://dot.net/v1/dotnet-install.ps1' -OutFile $installScript
    & powershell -ExecutionPolicy Bypass -File $installScript -Channel '10.0' -Runtime 'aspnetcore' -InstallDir $localDotnetRoot -Architecture 'x64'

    if (-not (Test-Path $localDotnet)) {
        throw 'Local ASP.NET Core runtime installation did not produce dotnet.exe.'
    }
}

function Get-PrimaryIpAddress {
    try {
        return Get-NetIPAddress -AddressFamily IPv4 |
            Where-Object {
                $_.IPAddress -notlike '127.*' -and
                $_.IPAddress -notlike '169.254.*' -and
                $_.PrefixOrigin -ne 'WellKnown'
            } |
            Sort-Object InterfaceMetric, SkipAsSource |
            Select-Object -ExpandProperty IPAddress -First 1
    }
    catch {
        return $null
    }
}

function Get-AccessUrl {
    $ipAddress = Get-PrimaryIpAddress
    if ([string]::IsNullOrWhiteSpace($ipAddress)) {
        return $appLocalUrl
    }

    return "http://${ipAddress}:$appPort"
}

function Write-EnvironmentFile([string]$EnvironmentName) {
    @(
        "ASPNETCORE_ENVIRONMENT=$EnvironmentName"
        "ASPNETCORE_URLS=$appBindUrl"
    ) | Set-Content -Path $envPath -Encoding UTF8
}

function Write-StartScript {
    $startScriptPath = Join-Path $Destination 'start.ps1'
    @'
$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$appRoot = Join-Path $scriptRoot 'app'
$localDotnet = Join-Path $scriptRoot '.dotnet\dotnet.exe'
$envPath = Join-Path $scriptRoot 'jkmonitor.env'
$appEnvironment = 'Development'
$appUrls = 'http://0.0.0.0:5074'

if (Test-Path $envPath) {
    foreach ($line in Get-Content $envPath) {
        if ($line -match '^(?<key>[^=]+)=(?<value>.*)$') {
            switch ($Matches['key']) {
                'ASPNETCORE_ENVIRONMENT' { $appEnvironment = $Matches['value'] }
                'ASPNETCORE_URLS' { $appUrls = $Matches['value'] }
            }
        }
    }
}

$globalDotnet = Get-Command dotnet -ErrorAction SilentlyContinue
$dotnetCommand = $null

if ($globalDotnet) {
    try {
        $runtimes = & $globalDotnet.Source --list-runtimes 2>$null
        if ($runtimes -match '^Microsoft\.AspNetCore\.App 10\.') {
            $dotnetCommand = $globalDotnet.Source
        }
    }
    catch {
    }
}

if (-not $dotnetCommand -and (Test-Path $localDotnet)) {
    $dotnetCommand = $localDotnet
}

if (-not $dotnetCommand) {
    throw 'No compatible ASP.NET Core 10 runtime was found.'
}

Push-Location $appRoot
try {
    $env:ASPNETCORE_ENVIRONMENT = $appEnvironment
    $env:ASPNETCORE_URLS = $appUrls
    & $dotnetCommand '.\JkMonitor.Backend.dll'
}
finally {
    Pop-Location
}
'@ | Set-Content -Path $startScriptPath -Encoding UTF8
}

function Test-IsAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Register-Autostart {
    $startScriptPath = Join-Path $Destination 'start.ps1'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScriptPath`""

    if (Test-IsAdministrator) {
        $trigger = New-ScheduledTaskTrigger -AtStartup
        $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
        return 'Windows auto-start is configured to run at system startup.'
    }

    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
    return 'Windows auto-start is configured for your user sign-in. Run the terminal as Administrator if you want startup before sign-in.'
}

function Stop-ExistingJkMonitor {
    try {
        $listeners = Get-NetTCPConnection -State Listen -LocalPort $appPort -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique

        foreach ($processId in $listeners) {
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
            if ($processInfo -and $processInfo.CommandLine -match 'JkMonitor\.Backend') {
                Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
            }
        }
    }
    catch {
    }
}

function Start-JkMonitorNow {
    $startScriptPath = Join-Path $Destination 'start.ps1'
    Start-Process -FilePath 'powershell.exe' -ArgumentList "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$startScriptPath`"" -WindowStyle Hidden | Out-Null
}

$normalizedRepository = Get-NormalizedRepository $Repository
$assetUrl = "https://github.com/$normalizedRepository/releases/download/$ReleaseTag/$assetName"
$tempRoot = Join-Path $env:TEMP ("jkmonitor-release-install-{0}" -f ([Guid]::NewGuid().ToString('N')))
$archivePath = Join-Path $tempRoot $assetName
$extractPath = Join-Path $tempRoot 'extract'
$preservePath = Join-Path $tempRoot 'preserve'
$accessUrl = Get-AccessUrl

New-Item -ItemType Directory -Path $tempRoot, $extractPath, $preservePath -Force | Out-Null

try {
    Write-Section 'JK Monitor release bootstrap'
    Write-Muted "Repository: $normalizedRepository"
    Write-Muted "Release tag: $ReleaseTag"
    Write-Muted "Destination: $Destination"

    Write-Section 'Downloading release artifact'
    Write-Info 'Fetching the published Windows build from GitHub Releases.'
    Invoke-WebRequest -Uri $assetUrl -OutFile $archivePath

    Write-Section 'Extracting release artifact'
    Write-Info 'Unpacking the application files.'
    Expand-Archive -Path $archivePath -DestinationPath $extractPath -Force

    Write-Section 'Preparing installation folder'
    if (Test-Path $Destination) {
        Write-WarningText 'Existing installation found. Preserving local config and cached runtime.'
        Preserve-ExistingState -SourceRoot $Destination -PreserveRoot $preservePath
        Stop-ExistingJkMonitor
        Start-Sleep -Milliseconds 500
        Remove-Item -Path $Destination -Recurse -Force
    }

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Move-Item -Path (Join-Path $extractPath 'win-x64') -Destination $appRoot
    Restore-PreservedState -PreserveRoot $preservePath -DestinationRoot $Destination
    Write-StartScript

    Write-Section 'Checking ASP.NET Core runtime'
    $dotnet = Get-DotnetCommand
    if (-not $dotnet) {
        Install-LocalRuntime
        $dotnet = Get-DotnetCommand
    }

    if (-not $dotnet) {
        throw 'A compatible ASP.NET Core 10 runtime is required to run this published build.'
    }

    Write-Section 'Preparing first run'
    Write-Info 'Starting in simulator mode so the web UI is available immediately.'
    @'
{
  "Monitor": {
    "Storage": {
      "Provider": "None",
      "ConnectionString": ""
    }
  }
}
'@ | Set-Content -Path (Join-Path $appRoot 'appsettings.Development.Local.json') -Encoding UTF8
    Write-EnvironmentFile -EnvironmentName 'Development'

    Write-Section 'Configuring auto-start'
    $autostartMessage = Register-Autostart
    Write-Muted $autostartMessage

    Write-Section 'Starting JK Monitor'
    Start-JkMonitorNow
    Write-Success "Local access URL: $appLocalUrl"
    Write-Success "LAN access URL: $accessUrl"
    Write-Muted 'Tip: Ctrl+Click usually opens the URL directly from Windows Terminal.'
    Write-Muted 'Use the Setup panel in the app later when you are ready to switch to real hardware.'
}
finally {
    Remove-Item -Path $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}