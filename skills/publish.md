# Publish Skill

Use this skill when the user asks to publish, deploy, release, push and update the device, or otherwise ship the current repository state.

This skill is a direct match for short prompts such as `publish`.

## Intent

Complete the publish flow end-to-end without handing work back to the user:

1. Check `git status`.
2. If there are local changes, stage them, generate a sensible commit message when the user did not provide one, commit, and push to `origin/dev`.
3. If there are no local changes, skip commit creation and continue with the current remote state.
4. After a push, start polling GitHub Releases immediately and re-check every 30 seconds until the updated artifact appears.
5. Confirm that the `dev-latest` Linux release artifact is available from GitHub Releases and capture its published checksum.
6. SSH to `pi@fm.local`, or retry through `pi@fm-ssh.fluxmonitor.com` via Cloudflare Access SSH if the device is not reachable on the local network, confirm GitHub still serves that exact checksum for the release tag, and run the GitHub release installer with the expected checksum pinned.
7. Verify the installer recorded the same checksum on the device, and verify the deployed service is healthy and reports the expected release tag and source revision in `api/health`.

## Source Of Truth

- Windows implementation: `./scripts/publish.ps1`
- Linux or macOS implementation: `./scripts/publish.sh`
- Build workflow: `.github/workflows/publish-backend.yml`
- Device update path: `scripts/install-from-release.sh`

## Expected Remote Deploy Command

Run this on the Raspberry Pi after the artifact is available:

```bash
wget -qO- https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-release.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 dev-latest
```

The release installer is also the update path. Do not branch to a separate source-based deploy flow unless the user explicitly asks for it.

When SSH from the local network is unavailable, use the Cloudflare Access fallback:

```bash
ssh pi@fm-ssh.fluxmonitor.com -o ProxyCommand="cloudflared access ssh --hostname %h"
```

Known remote host aliases:

```bash
ssh pi@fmzero-ssh.fluxmonitor.com -o ProxyCommand="cloudflared access ssh --hostname %h"
ssh pi@fm-ssh.fluxmonitor.com -o ProxyCommand="cloudflared access ssh --hostname %h"
```

## Expected Verification

Run on the Raspberry Pi:

```bash
sudo systemctl is-active fluxmonitor.service
curl -fsS http://127.0.0.1:5074/api/health
```

The publish flow should also confirm that `~/FluxMonitor/release-info.env` contains the same SHA-256 checksum as the GitHub release artifact that was observed after the push.
The runtime health payload should expose build metadata so publish can confirm the restarted app is serving the expected release tag and source revision.

## Notes

- Do not stop at commit or push.
- Do not publish by building directly on the Pi when release artifacts already exist.
- Prefer the release artifact deployment path over source deployment.
- Do not require `gh` or ask the user to log into the GitHub CLI for this workflow.
- Use public GitHub HTTP APIs to observe the release artifact unless authenticated access is explicitly required.
- Prefer the LAN SSH target first, but do not treat mDNS reachability failure as a hard stop until the Cloudflare Access SSH fallback has been tried.
- If the current branch is not `dev`, stop and explain the mismatch instead of resetting the branch.
