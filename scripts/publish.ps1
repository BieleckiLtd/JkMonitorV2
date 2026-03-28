[CmdletBinding()]
param(
    [string]$CommitMessage,

    [string]$RemoteName = 'origin',

    [string]$Branch = 'dev',

    [string]$ReleaseTag = 'dev-latest',

    [string]$DeviceHost = 'pi@fm.local',

    [string]$Repository,

    [int]$WaitSeconds = 0,

    [int]$ArtifactTimeoutSeconds = 600,

    [int]$PollSeconds = 30,

    [switch]$SkipArtifactWait,

    [switch]$SkipDeploy
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot
$linuxAssetName = 'fluxmonitor-backend-linux-arm64.tar.gz'

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

    if (($normalizedFiles | Where-Object { $_ -notmatch '^src/backend/FluxMonitor\.Backend/frontend/' }).Count -eq 0) {
        return 'feat: update frontend'
    }

    if (($normalizedFiles | Where-Object { $_ -notmatch '^tests/' }).Count -eq 0) {
        return 'test: update backend tests'
    }

    return 'chore: publish current changes'
}

function Get-GitHubToken {
    if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {
        return $env:GITHUB_TOKEN
    }

    if (-not [string]::IsNullOrWhiteSpace($env:GH_TOKEN)) {
        return $env:GH_TOKEN
    }

    return $null
}

function Get-GitHubHeaders([string]$Accept) {
    $headers = @{
        Accept = $Accept
        'User-Agent' = 'FluxMonitor-publish-script'
    }

    $githubToken = Get-GitHubToken
    if (-not [string]::IsNullOrWhiteSpace($githubToken)) {
        $headers.Authorization = "Bearer $githubToken"
    }

    return $headers
}

function Convert-WebResponseContentToString($Content) {
    if ($Content -is [byte[]]) {
        return [System.Text.Encoding]::UTF8.GetString($Content)
    }

    return [string]$Content
}

function Invoke-GitHubApi([string]$RepositorySlug, [string]$Path) {
    $headers = Get-GitHubHeaders -Accept 'application/vnd.github+json'
    return Invoke-RestMethod -Uri "https://api.github.com/repos/$RepositorySlug$Path" -Headers $headers
}

function Get-ReleaseAsset([string]$RepositorySlug, [string]$Tag, [string]$AssetName) {
    $release = Invoke-GitHubApi -RepositorySlug $RepositorySlug -Path "/releases/tags/$Tag"
    $asset = @($release.assets) | Where-Object { $_.name -eq $AssetName } | Select-Object -First 1

    if (-not $asset) {
        throw "Release tag '$Tag' does not contain asset '$AssetName'."
    }

    return $asset
}

function Get-ReleaseAssetFingerprint([object]$Asset) {
    if (-not $Asset) {
        return $null
    }

    $digest = ''
    if ($null -ne $Asset.digest) {
        $digest = [string]$Asset.digest
    }

    return "$($Asset.id)|$digest|$($Asset.updated_at)"
}

function Try-Get-ReleaseAssetFingerprint([string]$RepositorySlug, [string]$Tag, [string]$AssetName) {
    try {
        $asset = Get-ReleaseAsset -RepositorySlug $RepositorySlug -Tag $Tag -AssetName $AssetName
        return Get-ReleaseAssetFingerprint -Asset $asset
    }
    catch {
        return $null
    }
}

function Get-ReleaseChecksum([string]$RepositorySlug, [string]$Tag, [string]$AssetName) {
    $headers = Get-GitHubHeaders -Accept 'application/octet-stream'
    $checksumAsset = Get-ReleaseAsset -RepositorySlug $RepositorySlug -Tag $Tag -AssetName "$AssetName.sha256"
    $payload = Convert-WebResponseContentToString ((Invoke-WebRequest -Uri $checksumAsset.url -Headers $headers -UseBasicParsing).Content)
    $checksum = ($payload -split '\s+')[0].Trim().ToLowerInvariant()

    if ($checksum -notmatch '^[0-9a-f]{64}$') {
        throw "Release checksum file for '$AssetName' did not contain a valid SHA-256 value."
    }

    return $checksum
}

function Wait-ForReleaseAsset(
    [string]$RepositorySlug,
    [string]$Tag,
    [string]$AssetName,
    [string]$PreviousFingerprint,
    [int]$TimeoutSeconds,
    [int]$PollIntervalSeconds
) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)

    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        try {
            $asset = Get-ReleaseAsset -RepositorySlug $RepositorySlug -Tag $Tag -AssetName $AssetName

            $currentFingerprint = Get-ReleaseAssetFingerprint -Asset $asset
            if ([string]::IsNullOrWhiteSpace($PreviousFingerprint) -or $currentFingerprint -ne $PreviousFingerprint) {
                Write-Info "Release asset '$AssetName' is ready (updated at $($asset.updated_at))."
                return
            }

            Write-Info "Release asset '$AssetName' is unchanged (last updated $($asset.updated_at)). Retrying in $PollIntervalSeconds seconds."
        }
        catch {
            Write-Info "Release asset '$AssetName' is not ready yet. Retrying in $PollIntervalSeconds seconds."
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    }

    throw "Timed out waiting for GitHub release asset '$AssetName' on tag '$Tag'."
}

function Assert-ReleaseAssetExists([string]$RepositorySlug, [string]$Tag, [string]$AssetName) {
    [void](Get-ReleaseAsset -RepositorySlug $RepositorySlug -Tag $Tag -AssetName $AssetName)
}

function Wait-ForReleaseChecksum(
    [string]$RepositorySlug,
    [string]$Tag,
    [string]$AssetName,
    [int]$TimeoutSeconds,
    [int]$PollIntervalSeconds
) {
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds)

    while ([DateTimeOffset]::UtcNow -lt $deadline) {
        try {
            return Get-ReleaseChecksum -RepositorySlug $RepositorySlug -Tag $Tag -AssetName $AssetName
        }
        catch {
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    }

    throw "Timed out waiting for release checksum '$AssetName.sha256' on tag '$Tag'."
}

Require-Command git

$repositorySlug = Get-NormalizedRepository -RepositoryInput $Repository -Remote $RemoteName
$currentBranch = (Invoke-GitCapture @('branch', '--show-current') | Select-Object -First 1).Trim()
$currentCommit = (Invoke-GitCapture @('rev-parse', 'HEAD') | Select-Object -First 1).Trim()
$githubToken = Get-GitHubToken
$expectedReleaseSha256 = $null
$previousReleaseAssetFingerprint = Try-Get-ReleaseAssetFingerprint -RepositorySlug $repositorySlug -Tag $ReleaseTag -AssetName $linuxAssetName

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
    if (-not $SkipArtifactWait) {
        if ($WaitSeconds -gt 0) {
            Write-Step "Waiting $WaitSeconds seconds before artifact polling"
            Start-Sleep -Seconds $WaitSeconds
        }

        Write-Step "Waiting for updated GitHub release artifact (polling every $PollSeconds seconds)"
        Wait-ForReleaseAsset `
            -RepositorySlug $repositorySlug `
            -Tag $ReleaseTag `
            -AssetName 'fluxmonitor-backend-linux-arm64.tar.gz' `
            -PreviousFingerprint $previousReleaseAssetFingerprint `
            -TimeoutSeconds $ArtifactTimeoutSeconds `
            -PollIntervalSeconds $PollSeconds
    }
}
elseif (-not $SkipArtifactWait) {
    Write-Step 'Checking current GitHub release artifact'
    Assert-ReleaseAssetExists -RepositorySlug $repositorySlug -Tag $ReleaseTag -AssetName $linuxAssetName
}

Write-Step 'Resolving published release checksum'
$expectedReleaseSha256 = Wait-ForReleaseChecksum `
    -RepositorySlug $repositorySlug `
    -Tag $ReleaseTag `
    -AssetName $linuxAssetName `
    -TimeoutSeconds $ArtifactTimeoutSeconds `
    -PollIntervalSeconds $PollSeconds
Write-Info "Expected Linux release checksum: $expectedReleaseSha256"

if ($SkipDeploy) {
    Write-Info 'Skipping SSH deploy because -SkipDeploy was specified.'
    return
}

Require-Command ssh

$remoteScript = @"
set -euo pipefail
expected_sha256='$expectedReleaseSha256'
repository_slug='$repositorySlug'
release_tag='$ReleaseTag'
asset_name='$linuxAssetName'
expected_source_revision_id='$currentCommit'
export FLUXMONITOR_EXPECTED_RELEASE_SHA256="\$expected_sha256"
export FLUXMONITOR_INSTALL_RUNTIME='y'
export FLUXMONITOR_INSTALL_SERVICE='y'
export FLUXMONITOR_REUSE_EXISTING_CONFIGURATION='1'
wget -qO- https://raw.githubusercontent.com/$repositorySlug/dev/scripts/install-from-release.sh | bash -s -- https://github.com/$repositorySlug \$release_tag
if [ ! -f "\$HOME/fluxmonitor/release-info.env" ]; then
  echo 'The installer did not persist release-info.env.' >&2
  exit 1
fi

set -a
. "\$HOME/fluxmonitor/release-info.env"
set +a

if [[ "\${FLUXMONITOR_RELEASE_SHA256,,}" != "\$expected_sha256" ]]; then
  echo "Installed checksum mismatch on device. Expected \$expected_sha256 but installer recorded \${FLUXMONITOR_RELEASE_SHA256:-missing}." >&2
  exit 1
fi
sleep 5
sudo systemctl is-active fluxmonitor.service
health_json="\$(curl -fsS http://127.0.0.1:5074/api/health)"

if command -v python3 >/dev/null 2>&1; then
  HEALTH_JSON="\$health_json" python3 - "\$release_tag" "\$expected_source_revision_id" <<'PY'
import json
import os
import sys

payload = json.loads(os.environ["HEALTH_JSON"])
build = payload.get("build") or {}
release_tag = build.get("releaseTag")
source_revision_id = build.get("sourceRevisionId")
expected_tag = sys.argv[1]
expected_source_revision_id = sys.argv[2]

if release_tag != expected_tag:
    raise SystemExit(
        f"Runtime release tag mismatch. Expected {expected_tag} but app reported {release_tag!r}."
    )

if source_revision_id != expected_source_revision_id:
    raise SystemExit(
        f"Runtime source revision mismatch. Expected {expected_source_revision_id} but app reported {source_revision_id!r}."
    )
PY
else
  printf '%s\n' "\$health_json" | grep -F "\"releaseTag\":\"\$release_tag\"" >/dev/null 2>&1 || {
    echo "Runtime release tag mismatch. Expected \$release_tag." >&2
    exit 1
  }

  printf '%s\n' "\$health_json" | grep -F "\"sourceRevisionId\":\"\$expected_source_revision_id\"" >/dev/null 2>&1 || {
    echo "Runtime source revision mismatch. Expected \$expected_source_revision_id." >&2
    exit 1
  }
fi
"@

Write-Step "Deploying to $DeviceHost"
$remoteScript | & ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -o StrictHostKeyChecking=no $DeviceHost 'bash -s'
if ($LASTEXITCODE -ne 0) {
    throw "SSH deploy failed with exit code $LASTEXITCODE."
}

Write-Step 'Publish workflow completed'
