# Agent Guidance

## Workflow Routing

- Treat a plain request such as `publish`, `deploy`, `release`, or `push and update the device` as a request to run the repository publish workflow end-to-end.
- Use `skills/publish.md` as the workflow definition.
- Prefer `scripts/publish.ps1` on Windows.
- Prefer `scripts/publish.sh` on Linux and macOS.

## Publish Defaults

- Publish from `dev`.
- Check `git status` first.
- If there are local changes and the user did not supply a commit message, generate a sensible default commit message and continue.
- If there are no local changes, do not create an empty commit.
- After a push, wait 120 seconds before checking for the updated `dev-latest` release artifact.
- Use `git` for commit and push, and use the public GitHub HTTP API to observe the release artifact.
- Do not ask the user to run `gh auth login` or require the GitHub CLI for this workflow.
- Deploy by SSH to `pi@jk.local` and run the published artifact installer from GitHub.
- Verify `fluxmonitor.service` is active and `http://127.0.0.1:5074/api/health` responds on the device.

## Safety Rules

- Do not hard reset the branch during publish.
- If the current branch is not `dev`, stop and explain the mismatch instead of moving commits across branches automatically.
- Do not ask the user to perform manual publish steps unless push or SSH access genuinely fails.