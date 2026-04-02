$ErrorActionPreference = 'Stop'

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptRoot

$postgresVersion = '17.9-2'
$postgresMajor = '17'
$timescaleVersion = '2.26.0'

$postgresDownloadUrl = 'https://sbp.enterprisedb.com/getfile.jsp?fileid=1260117'
$timescaleDownloadUrl = 'https://github.com/timescale/timescaledb/releases/download/2.26.0/timescaledb-postgresql-17-windows-amd64.zip'

$installRoot = Join-Path $env:LOCALAPPDATA 'PostgreSQL'
$downloadsRoot = Join-Path $installRoot 'downloads'
$postgresArchivePath = Join-Path $downloadsRoot "postgresql-$postgresVersion-windows-x64-binaries.zip"
$postgresRoot = Join-Path $installRoot $postgresVersion
$pgsqlRoot = Join-Path $postgresRoot 'pgsql'
$postgresBinRoot = Join-Path $pgsqlRoot 'bin'
$postgresLibRoot = Join-Path $pgsqlRoot 'lib'
$postgresShareExtensionRoot = Join-Path $pgsqlRoot 'share\extension'
$timescaleArchivePath = Join-Path $downloadsRoot "timescaledb-postgresql-$postgresMajor-windows-amd64-$timescaleVersion.zip"
$timescaleExtractRoot = Join-Path $installRoot "timescaledb-$timescaleVersion-pg$postgresMajor"

$postgresExePath = Join-Path $postgresBinRoot 'postgres.exe'
$initDbPath = Join-Path $postgresBinRoot 'initdb.exe'
$pgCtlPath = Join-Path $postgresBinRoot 'pg_ctl.exe'
$pgIsReadyPath = Join-Path $postgresBinRoot 'pg_isready.exe'
$psqlPath = Join-Path $postgresBinRoot 'psql.exe'
$createdbPath = Join-Path $postgresBinRoot 'createdb.exe'
$dropdbPath = Join-Path $postgresBinRoot 'dropdb.exe'
$pgDumpPath = Join-Path $postgresBinRoot 'pg_dump.exe'
$pgRestorePath = Join-Path $postgresBinRoot 'pg_restore.exe'
$pgConfigPath = Join-Path $postgresBinRoot 'pg_config.exe'
$timescaleSetupPath = Join-Path $timescaleExtractRoot 'timescaledb\setup.exe'

$postgresStateRoot = Join-Path $env:LOCALAPPDATA 'FluxMonitor\postgresql'
$postgresDataRoot = Join-Path $postgresStateRoot 'data'
$postgresLogPath = Join-Path $postgresStateRoot 'postgresql.log'
$migrationDumpPath = Join-Path $postgresStateRoot 'fluxmonitor-repo-local.backup'
$ensureLogPath = Join-Path $postgresStateRoot 'ensure-local-postgres.log'
$backendLocalSettingsPath = Join-Path $repoRoot 'src\FluxMonitor.Backend\appsettings.Development.Local.json'

$targetHost = '127.0.0.1'
$targetPort = 5432
$sourcePort = 5433
$postgresUser = 'postgres'
$postgresDatabase = 'fluxmonitor'
$connectionString = "Host=$targetHost;Port=$targetPort;Database=$postgresDatabase;Username=$postgresUser"

$repoLocalPgCtlPath = Join-Path $repoRoot ".tools\postgresql\$postgresVersion\pgsql\bin\pg_ctl.exe"
$repoLocalDataRoot = Join-Path $repoRoot '.artifacts\postgresql\data'
$repoLocalLogPath = Join-Path $repoRoot '.artifacts\postgresql\postgresql.log'

function Write-Section([string]$Message) {
    Write-Host ''
    Write-Host $Message -ForegroundColor Cyan
}

function Write-Step([string]$Message) {
    Ensure-Directory $postgresStateRoot
    $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $ensureLogPath -Value "[$timestamp] $Message" -Encoding ASCII
}

function Ensure-Directory([string]$Path) {
    if (-not (Test-Path $Path)) {
        New-Item -ItemType Directory -Force -Path $Path | Out-Null
    }
}

function Wait-ForDatabase([int]$Port, [int]$TimeoutSeconds = 60) {
    for ($attempt = 0; $attempt -lt $TimeoutSeconds; $attempt++) {
        if (Test-DatabaseReady -Port $Port) {
            return
        }

        Start-Sleep -Seconds 1
    }

    throw "PostgreSQL did not become ready on ${targetHost}:$Port."
}

function Test-DatabaseReady([int]$Port) {
    if (-not (Test-Path $pgIsReadyPath)) {
        return $false
    }

    & $pgIsReadyPath -h $targetHost -p $Port -d postgres *> $null
    return $LASTEXITCODE -eq 0
}

function Ensure-PostgresArchive() {
    if (Test-Path $postgresArchivePath) {
        return
    }

    Write-Section 'Downloading PostgreSQL Windows binaries'
    Ensure-Directory $downloadsRoot
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $postgresDownloadUrl -OutFile $postgresArchivePath
}

function Ensure-PostgresBinaries() {
    if (Test-Path $postgresExePath) {
        return
    }

    Ensure-PostgresArchive

    Write-Section 'Extracting PostgreSQL Windows binaries'
    if (Test-Path $postgresRoot) {
        Remove-Item $postgresRoot -Recurse -Force
    }

    Ensure-Directory $postgresRoot
    Expand-Archive -Path $postgresArchivePath -DestinationPath $postgresRoot -Force

    if (-not (Test-Path $postgresExePath)) {
        throw "PostgreSQL extraction did not produce $postgresExePath."
    }
}

function Ensure-TimescaleArchive() {
    if (Test-Path $timescaleArchivePath) {
        return
    }

    Write-Section 'Downloading TimescaleDB Windows package'
    Ensure-Directory $downloadsRoot
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -Uri $timescaleDownloadUrl -OutFile $timescaleArchivePath
}

function Install-TimescalePackage() {
    $controlFilePath = Join-Path $postgresShareExtensionRoot 'timescaledb.control'
    $libraryPath = Join-Path $postgresLibRoot "timescaledb-$timescaleVersion.dll"
    if ((Test-Path $controlFilePath) -and (Test-Path $libraryPath)) {
        return
    }

    Ensure-TimescaleArchive

    Write-Section 'Installing TimescaleDB files into PostgreSQL'
    if (Test-Path $timescaleExtractRoot) {
        Remove-Item $timescaleExtractRoot -Recurse -Force
    }

    Ensure-Directory $timescaleExtractRoot
    Expand-Archive -Path $timescaleArchivePath -DestinationPath $timescaleExtractRoot -Force

    if (-not (Test-Path $timescaleSetupPath)) {
        throw "TimescaleDB extraction did not produce $timescaleSetupPath."
    }

    Push-Location (Split-Path -Parent $timescaleSetupPath)
    try {
        & $timescaleSetupPath '-pgconfig' $pgConfigPath '-no-tune' '-wait-before-exit=false'
        if ($LASTEXITCODE -ne 0) {
            throw "TimescaleDB setup exited with code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path $controlFilePath)) {
        throw "TimescaleDB setup did not produce $controlFilePath."
    }
}

function Initialize-PostgresCluster() {
    if (Test-Path (Join-Path $postgresDataRoot 'PG_VERSION')) {
        return
    }

    Write-Section 'Initializing PostgreSQL cluster'
    if (Test-Path $postgresDataRoot) {
        Remove-Item $postgresDataRoot -Recurse -Force
    }

    Ensure-Directory $postgresStateRoot
    & $initDbPath -D $postgresDataRoot -U $postgresUser -A trust -E UTF8

    if (-not (Test-Path (Join-Path $postgresDataRoot 'postgresql.conf'))) {
        throw 'PostgreSQL cluster initialization failed.'
    }
}

function Set-ConfigValue([string]$ConfigPath, [string]$Pattern, [string]$Replacement) {
    $content = Get-Content $ConfigPath -Raw
    $updated = if ($content -match $Pattern) {
        [regex]::Replace($content, $Pattern, $Replacement)
    }
    else {
        $lineEnding = if ($content -match "`r`n") { "`r`n" } else { "`n" }
        $normalized = $content.TrimEnd("`r", "`n")
        if ([string]::IsNullOrEmpty($normalized)) {
            $Replacement + $lineEnding
        }
        else {
            $normalized + $lineEnding + $Replacement + $lineEnding
        }
    }

    if ($updated -ne $content) {
        Set-Content -Path $ConfigPath -Value $updated -Encoding ASCII
        return $true
    }

    return $false
}

function Set-ClusterConfiguration() {
    $configPath = Join-Path $postgresDataRoot 'postgresql.conf'
    $changed = $false
    $changed = (Set-ConfigValue -ConfigPath $configPath -Pattern "(?m)^#?\s*listen_addresses\s*=.*$" -Replacement "listen_addresses = 'localhost'") -or $changed
    $changed = (Set-ConfigValue -ConfigPath $configPath -Pattern "(?m)^#?\s*port\s*=.*$" -Replacement "port = $targetPort") -or $changed
    $changed = (Set-ConfigValue -ConfigPath $configPath -Pattern "(?m)^#?\s*shared_preload_libraries\s*=.*$" -Replacement "shared_preload_libraries = 'timescaledb'") -or $changed
    return $changed
}

function Start-PostgresCluster([bool]$RestartIfRunning = $false) {
    Ensure-Directory $postgresStateRoot

    if (Test-DatabaseReady -Port $targetPort) {
        if (-not $RestartIfRunning) {
            return
        }

        Write-Section 'Restarting PostgreSQL cluster'
        & $pgCtlPath -D $postgresDataRoot -l $postgresLogPath restart | Out-Null
        Wait-ForDatabase -Port $targetPort
        return
    }

    Write-Section 'Starting PostgreSQL cluster'
    & $pgCtlPath -D $postgresDataRoot -l $postgresLogPath start | Out-Null
    Wait-ForDatabase -Port $targetPort
}

function Invoke-ScalarQuery([int]$Port, [string]$Database, [string]$Sql) {
    $output = & $psqlPath -X -h $targetHost -p $Port -U $postgresUser -d $Database -tAc $Sql 2>$null
    if ($LASTEXITCODE -ne 0) {
        return $null
    }

    return ($output | Out-String).Trim()
}

function Get-DatabaseTableCount([int]$Port, [string]$Database) {
    $value = Invoke-ScalarQuery -Port $Port -Database $Database -Sql "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema');"
    $count = 0
    if ([int]::TryParse($value, [ref]$count)) {
        return $count
    }

    return 0
}

function Test-DatabaseExists([int]$Port, [string]$Database) {
    return (Invoke-ScalarQuery -Port $Port -Database 'postgres' -Sql "SELECT 1 FROM pg_database WHERE datname='$Database';") -eq '1'
}

function Ensure-ApplicationDatabase() {
    if (Test-DatabaseExists -Port $targetPort -Database $postgresDatabase) {
        return
    }

    Write-Section "Creating '$postgresDatabase' database"
    & $createdbPath -h $targetHost -p $targetPort -U $postgresUser $postgresDatabase
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to create database '$postgresDatabase'."
    }
}

function Start-RepoLocalClusterIfNeeded() {
    if (Test-DatabaseReady -Port $sourcePort) {
        return $true
    }

    if (-not (Test-Path $repoLocalPgCtlPath) -or -not (Test-Path (Join-Path $repoLocalDataRoot 'PG_VERSION'))) {
        return $false
    }

    Write-Section 'Starting existing repo-local PostgreSQL for migration'
    & $repoLocalPgCtlPath -D $repoLocalDataRoot -l $repoLocalLogPath start | Out-Null

    for ($attempt = 0; $attempt -lt 60; $attempt++) {
        if (Test-DatabaseReady -Port $sourcePort) {
            return $true
        }

        Start-Sleep -Seconds 1
    }

    throw "Repo-local PostgreSQL did not become ready on ${targetHost}:$sourcePort."
}

function Migrate-RepoLocalDatabaseIfNeeded() {
    $targetTableCount = Get-DatabaseTableCount -Port $targetPort -Database $postgresDatabase
    if ($targetTableCount -gt 0) {
        return
    }

    if (-not (Start-RepoLocalClusterIfNeeded)) {
        return
    }

    if (-not (Test-DatabaseExists -Port $sourcePort -Database $postgresDatabase)) {
        return
    }

    $sourceTableCount = Get-DatabaseTableCount -Port $sourcePort -Database $postgresDatabase
    if ($sourceTableCount -eq 0) {
        return
    }

    Write-Section "Migrating existing repo-local '$postgresDatabase' database to ${targetHost}:$targetPort"
    Remove-Item $migrationDumpPath -Force -ErrorAction SilentlyContinue

    & $pgDumpPath -h $targetHost -p $sourcePort -U $postgresUser -d $postgresDatabase -Fc -f $migrationDumpPath
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to export the repo-local PostgreSQL database.'
    }

    & $pgRestorePath -h $targetHost -p $targetPort -U $postgresUser -d $postgresDatabase --clean --if-exists --no-owner --no-privileges $migrationDumpPath
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to restore the repo-local PostgreSQL database into the Windows PostgreSQL instance.'
    }
}

function Ensure-TimescaledbAvailable() {
    $available = Invoke-ScalarQuery -Port $targetPort -Database 'postgres' -Sql "SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb';"
    if ($available -ne '1') {
        throw 'TimescaleDB is installed on disk, but PostgreSQL does not report it as an available extension.'
    }
}

function Enable-TimescaledbExtension() {
    if ((Invoke-ScalarQuery -Port $targetPort -Database $postgresDatabase -Sql "SELECT 1 FROM pg_extension WHERE extname = 'timescaledb';") -eq '1') {
        return
    }

    Write-Section "Enabling TimescaleDB in '$postgresDatabase'"
    & $psqlPath -X -v ON_ERROR_STOP=1 -h $targetHost -p $targetPort -U $postgresUser -d $postgresDatabase -c 'CREATE EXTENSION IF NOT EXISTS timescaledb;'
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to enable TimescaleDB in '$postgresDatabase'."
    }
}

function Stop-RepoLocalClusterIfRunning() {
    if (-not (Test-Path $repoLocalPgCtlPath) -or -not (Test-DatabaseReady -Port $sourcePort)) {
        return
    }

    Write-Section 'Stopping repo-local PostgreSQL cluster on port 5433'
    & $repoLocalPgCtlPath -D $repoLocalDataRoot stop -m fast | Out-Null
}

function Write-BackendLocalSettings() {
    $content = @"
{
  "Monitor": {
    "Storage": {
      "Provider": "TimescaleDb",
      "ConnectionString": "$connectionString"
    }
  }
}
"@

    Set-Content -Path $backendLocalSettingsPath -Value $content -Encoding UTF8
}

Write-Step 'Starting ensure-local-postgres run'
Ensure-Directory $postgresStateRoot
Write-Step 'Ensuring PostgreSQL binaries'
Ensure-PostgresBinaries
Write-Step 'Installing TimescaleDB package'
Install-TimescalePackage
Write-Step 'Initializing PostgreSQL cluster'
Initialize-PostgresCluster
Write-Step 'Applying PostgreSQL configuration'
$configurationChanged = Set-ClusterConfiguration
Write-Step "Starting PostgreSQL cluster (restartIfRunning=$configurationChanged)"
Start-PostgresCluster -RestartIfRunning:$configurationChanged
Write-Step 'Ensuring fluxmonitor database exists'
Ensure-ApplicationDatabase
Write-Step 'Migrating repo-local database if needed'
Migrate-RepoLocalDatabaseIfNeeded
Write-Step 'Verifying TimescaleDB availability'
Ensure-TimescaledbAvailable
Write-Step 'Enabling TimescaleDB extension if needed'
Enable-TimescaledbExtension
Write-Step 'Writing backend local settings'
Write-BackendLocalSettings
Write-Step 'Stopping repo-local cluster if still running'
Stop-RepoLocalClusterIfRunning
Write-Step 'Completed ensure-local-postgres run'

$timescaleVersionInstalled = Invoke-ScalarQuery -Port $targetPort -Database $postgresDatabase -Sql "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';"
Write-Host "Windows PostgreSQL ready on ${targetHost}:$targetPort with database '$postgresDatabase' and TimescaleDB $timescaleVersionInstalled." -ForegroundColor Green
