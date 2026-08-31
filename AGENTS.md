# UI debugging rule

- Canonical local UI test surface: `http://127.0.0.1:39875`. Use it for read-only browser smoke checks, responsive screenshots, console-error checks, and performance timing after dashboard changes.

# User-Initiated Action Feedback Rule

- Every user-initiated action must reach a visible terminal state: success, warning, cancellation, or failure.
- Never clear a spinner, swallow an exception, or leave a waiting state without telling the user what happened and what they can do next.
- Background work may log quietly, but the same operation run explicitly by a user must surface failures and inconclusive outcomes in the UI that initiated it.
- Dashboard action failures must be returned to the dashboard host and rendered in both the VS Code webview and browser dashboard. Command Palette failures must show a VS Code notification.
- Add or update regression coverage whenever an action's completion, timeout, or error behavior changes.

# Packaging and Push Rule

- After every completed change to tracked project files, run the relevant verification, build a VSIX, commit the complete intended change set, and push the current branch.
- Every prerelease bump must also create a GitHub Release for the matching tag and attach the verified VSIX artifact.
- Treat VSIX packaging, committing, and pushing as part of the normal change workflow; do not wait for a separate request.
- If verification, packaging, committing, or pushing fails, report the concrete failure and do not claim the change was delivered.
- Do not install or deploy the project unless the user explicitly asks for it in the current request.

# Versioning Rule

- Every change that modifies tracked project files must increment the extension prerelease number by exactly one (`preN` to `preN+1`) in `package.json` and keep the root `package-lock.json` version fields synchronized.
- Do not reuse a prerelease number across changes, skip a prerelease number, or leave version metadata unchanged.
