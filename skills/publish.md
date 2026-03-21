# Publish Skill

Use this skill when the user asks to publish, deploy, or release the current repository changes.

## Intent

Complete the full publish flow end-to-end without handing work back to the user:

1. Ensure the repo is on `dev`.
2. Commit current changes with the user-provided message, or use a sensible default.
3. Push to `origin/dev`.
4. Wait for the `publish-backend` GitHub Actions workflow to finish successfully.
5. Wait for the `dev-latest` release artifact to exist.
6. SSH to `pi@jk.local` and update from the published GitHub release artifact.
7. Verify the deployed service is healthy.

## Source Of Truth

- Executable implementation: `./scripts/publish.sh`
- Build workflow: `.github/workflows/publish-backend.yml`
- Device update path: `scripts/install-from-release.sh`

## Expected Remote Deploy Command

Run this on the Raspberry Pi after the workflow completes:

```bash
wget -qO- https://raw.githubusercontent.com/BieleckiLtd/JkMonitorV2/dev/scripts/install-from-release.sh | bash -s -- https://github.com/BieleckiLtd/JkMonitorV2 dev-latest
```

## Expected Verification

Run on the Raspberry Pi:

```bash
sudo systemctl is-active jkmonitor.service
curl -f http://127.0.0.1:5074/api/health
```

## Notes

- Do not stop at commit or push.
- Do not publish by building directly on the Pi when release artifacts already exist.
- Prefer the release artifact deployment path over source deployment.
- If a tool environment blocks `gh` or HTTP checks, use an available alternative, but keep driving the workflow to completion.