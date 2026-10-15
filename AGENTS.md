# Project instructions

- Recap intended changes, verification, and commit/release implications before acting.
- Use `http://127.0.0.1:39875` for read-only local UI smoke checks, responsive screenshots, console checks, and performance timing after dashboard changes.
- User initiated actions must surface success, warning, cancellation, or failure in the initiating UI. Preserve errors and add regression coverage when completion or timeout behavior changes.
- Start manual actions immediately. Optional background work, session discovery, recovery capture, and automation waits must not block them; use bounded waits and visible fallback warnings. Retain required authorization, ownership, and data integrity checks, and report conflicts promptly.
- Render dashboard failures in both the VS Code webview and browser dashboard; show Command Palette failures in VS Code notifications. Background work may log quietly; explicit actions must report failures and inconclusive outcomes.
- For tracked changes, run relevant verification, build a VSIX, commit all intended files, and push the branch. Report any verification, packaging, commit, or push failure. Do not install or deploy unless requested.
- Increment the extension prerelease number exactly one step per change and synchronize `package.json` with root `package-lock.json`, unless the user explicitly requests a version.
- Keep developer specific domains, hostnames, personal URLs, and identifying deployment details out of public documentation and manifest descriptions.
- When the user explicitly requests a release, publish the requested GitHub Release with the verified VSIX attached. If GitHub authentication or tooling is unavailable, report that blocker.
- Publish tags, releases, Marketplace updates, or deployments only when explicitly requested; a version bump or local VSIX alone does not authorize publication. Never claim delivery after a failed required step.
- Work directly on `main`; do not create, switch to, or deliver changes from another branch unless the user explicitly asks.
