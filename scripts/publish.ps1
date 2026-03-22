[CmdletBinding()]
param(
    [string]$CommitMessage,

    [string]$RemoteName = 'origin',

    [string]$Branch = 'dev',

    [string]$ReleaseTag = 'dev-latest',

    [string]$DeviceHost = 'pi@jk.local',

    [string]$Repository,

    [int]$WaitSeconds = 120,

    [int]$ArtifactTimeoutSeconds = 600,

    [int]$PollSeconds = 15,

    [switch]$SkipArtifactWait,

    [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host $Text -ForegroundColor Cyan
}

function Write-Info([string]$Text) {
    Write-Host $Text -ForegroundColor DarkGray
}

function Require-Command([string]$CommandName) {
    if (-not (Get-Command $CommandName -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $CommandName"
    }
}

function Invoke-GitCapture([string[]]$Arguments) {
    $output = & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }

    return $output
}

function Invoke-GitChecked([string[]]$Arguments) {
    & git @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

function Ensure-GitIdentity {
    $userName = (& git config user.name 2>$null | Select-Object -First 1)
    $userEmail = (& git config user.email 2>$null | Select-Object -First 1)

    if ([string]::IsNullOrWhiteSpace($userName) -or [string]::IsNullOrWhiteSpace($userEmail)) {
        throw 'git user.name and user.email must be configured before publish.'
    }
}

function Get-NormalizedRepository([string]$RepositoryInput, [string]$Remote) {
    $candidate = $RepositoryInput

    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = (Invoke-GitCapture @('remote', 'get-url', $Remote) | Select-Object -First 1).Trim()
    }

    if ($candidate -match '^https://github\.com/(?<repo>[^/]+/[^/]+?)(?:\.git)?/?$') {
        return $Matches['repo']
    }

    if ($candidate -match '^git@github\.com:(?<repo>[^/]+/[^/]+?)(?:\.git)?$') {
        return $Matches['repo']
    }

    if ($candidate -match '^ssh://git@github\.com/(?<repo>[^/]+/[^/]+?)(?:\.git)?/?$') {
        return $Matches['repo']
    }

    if ($candidate -match '^[^/]+/[^/]+$') {
        return $candidate
    }

    throw "Unsupported repository value '$candidate'. Use 'owner/repo' or a GitHub URL."
}

function Get-DefaultCommitMessage([string[]]$ChangedFiles) {
    $normalizedFiles = $ChangedFiles |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_.Trim().Replace('\', '/') }

    if ($normalizedFiles.Count -eq 0) {
        return 'chore: publish current changes'
    }

    if (($normalizedFiles | Where-Object { $_ -notmatch '^(AGENTS\.md|README\.md|skills/|scripts/)' }).Count -eq 0) {
        return 'chore: refine publish automation'
    }

    if (($normalizedFiles | Where-Object { $_ -notmatch '^src/backend/JkMonitor\.Backend/frontend/' }).Count -eq 0) {
        return 'feat: update frontend'
    }

    if (($normalizedFiles | Where-Object { $_ -notmatch '^tests/' }).Count -eq 0) {
        return 'test: update backend tests'
    }

    return 'chore: publish current changes'
}

function Invoke-GitHubApi([string]$RepositorySlug, [string]$Path) {
    $headers = @{
        Accept = 'application/vnd.github+json'
        'User-Agent' = 'JkMonitorV2-publish-script'
    }

    return Invoke-RestMethod -Uri "https://api.github.com/repos/$RepositorySlug$Path" -Headers $headers
}

function Wait-ForReleaseAsset(
    [string]$RepositorySlug,
    [string]$Tag,
    [string]$AssetName,
    [DateTimeOffset]$UpdatedAfter,
    [int]$TimeoutSeconds,
    [int]$PollIntervalSeconds
) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)

    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        try {
            $release = Invoke-GitHubApi -RepositorySlug $RepositorySlug -Path "/releases/tags/$Tag"
            $asset = @($release.assets) | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1

            if ($asset) {
                $assetUpdatedAt = [DateTimeOffset]::Parse($asset.updated_at)
                if ($assetUpdatedAt -ge $UpdatedAfter) {
                    Write-Info "Release asset '$AssetName' updated at $assetUpdatedAt."
                    return
                }
            }
        }
        catch {
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    }

    throw "Timed out waiting for GitHub release asset '$AssetName' on tag '$Tag'."
}

function Assert-ReleaseAssetExists([string]$RepositorySlug, [string]$Tag, [string]$AssetName) {
    $release = Invoke-GitHubApi -RepositorySlug $RepositorySlug -Path "/releases/tags/$Tag"
    $asset = @($release.assets) | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1

    if (-not $asset) {
        throw "Release tag '$Tag' does not contain asset '$AssetName'."
    }
}

Require-Command git

$repositorySlug = Get-NormalizedRepository -RepositoryInput $Repository -Remote $RemoteName
$currentBranch = (Invoke-GitCapture @('branch', '--show-current') | Select-Object -First 1).Trim()

if ($currentBranch -ne $Branch) {
    throw "Publish expects branch '$Branch'. Current branch is '$currentBranch'."
}

$statusLines = @(Invoke-GitCapture @('status', '--porcelain=v1')) |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) }

$pushedChanges = $false
$pushStartedAt = [DateTimeOffset]::UtcNow

Write-Step 'Checking repository state'
if ($statusLines.Count -eq 0) {
    Write-Info 'Working tree is clean. Skipping commit and push.'
}
else {
    Write-Info 'Local changes detected. Staging files.'
    Invoke-GitChecked @('add', '--all')

    $stagedFiles = @(Invoke-GitCapture @('diff', '--cached', '--name-only')) |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
        ForEach-Object { $_.Trim() }

    if ($stagedFiles.Count -eq 0) {
        Write-Info 'Nothing remained staged after git add.'
    }
    else {
        Ensure-GitIdentity

        if ([string]::IsNullOrWhiteSpace($CommitMessage)) {
            $CommitMessage = Get-DefaultCommitMessage -ChangedFiles $stagedFiles
            Write-Info "Generated commit message: $CommitMessage"
        }

        Write-Step 'Creating commit'
        Invoke-GitChecked @('commit', '-m', $CommitMessage)

        Write-Step "Pushing to $RemoteName/$Branch"
        $pushStartedAt = [DateTimeOffset]::UtcNow
        Invoke-GitChecked @('push', $RemoteName, $Branch)
        $pushedChanges = $true
    }
}

if ($pushedChanges) {
    Write-Step "Waiting $WaitSeconds seconds before artifact check"
    Start-Sleep -Seconds $WaitSeconds

    if (-not $SkipArtifactWait) {
        Write-Step 'Waiting for updated GitHub release artifact'
        Wait-ForReleaseAsset `
            -RepositorySlug $repositorySlug `
            -Tag $ReleaseTag `
            -AssetName 'jkmonitor-backend-linux-arm64.tar.gz' `
            -UpdatedAfter $pushStartedAt.AddSeconds(-5) `
            -TimeoutSeconds $ArtifactTimeoutSeconds `
            -PollIntervalSeconds $PollSeconds
    }
}
elseif (-not $SkipArtifactWait) {
    Write-Step 'Checking current GitHub release artifact'
    Assert-ReleaseAssetExists -RepositorySlug $repositorySlug -Tag $ReleaseTag -AssetName 'jkmonitor-backend-linux-arm64.tar.gz'
}

if ($SkipDeploy) {
    Write-Info 'Skipping SSH deploy because -SkipDeploy was specified.'
    return
}

Require-Command ssh

$remoteScript = @"
set -euo pipefail
wget -qO- https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-release.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 $ReleaseTag
sleep 5
sudo systemctl is-active jkmonitor.service
curl -fsS http://127.0.0.1:5074/api/health
"@

Write-Step "Deploying to $DeviceHost"
$remoteScript | & ssh -o StrictHostKeyChecking=no $DeviceHost 'bash -s'
if ($LASTEXITCODE -ne 0) {
    throw "SSH deploy failed with exit code $LASTEXITCODE."
}

Write-Step 'Publish workflow completed'