# Publish Skill

Use this skill when the user asks to publish, deploy, release, push and update the device, or otherwise ship the current repository state.

This skill is a direct match for short prompts such as `publish`.

## Intent

Complete the publish flow end-to-end without handing work back to the user:

1. Check `git status`.
2. If there are local changes, stage them, generate a sensible commit message when the user did not provide one, commit, and push to `origin/dev`.
3. If there are no local changes, skip commit creation and continue with the current remote state.
4. After a push, wait 120 seconds.
5. Confirm that the `dev-latest` Linux release artifact is available from GitHub Releases.
6. SSH to `pi@jk.local` and run the GitHub release installer.
7. Verify the deployed service is healthy.

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

## Expected Verification

Run on the Raspberry Pi:

```bash
sudo systemctl is-active jkmonitor.service
curl -fsS http://127.0.0.1:5074/api/health
```

## Notes

- Do not stop at commit or push.
- Do not publish by building directly on the Pi when release artifacts already exist.
- Prefer the release artifact deployment path over source deployment.
- Do not require `gh` or ask the user to log into the GitHub CLI for this workflow.
- Use public GitHub HTTP APIs to observe the release artifact unless authenticated access is explicitly required.
- If the current branch is not `dev`, stop and explain the mismatch instead of resetting the branch.