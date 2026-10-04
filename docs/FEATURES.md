# Features and settings

This is the practical reference for Codex Manager. Settings are available in **File → Preferences → Settings**, by searching `codexManager`, or from the dashboard’s Settings panel.

## Account management

### Add an account

Use **Codex Manager: Add Account via OAuth**. The extension opens the Codex authorization page, receives the callback locally, validates the response, and stores the account token in VS Code SecretStorage. If the callback cannot reach VS Code, paste the callback URL into the dialog.

### Import and restore

- **Import Current auth.json** saves the account currently used by Codex.
- **Restore Accounts from auth.json** reads a selected Codex credential file.
- **Restore Accounts from Backup** reads the extension’s backup format.
- **Restore Accounts from Shared JSON** reads an export made on another computer.

Exports contain account metadata and encrypted/token material needed for the selected format. Treat every export as a credential and store it privately.

### Switch and remove

Select an account and run **Switch Account**. The extension atomically updates the active Codex `auth.json` and can restart the Codex desktop app. A claimed account remains manually selectable; Codex Manager asks for the shared password, enables Rescue on that PC, and completes the explicit switch. While Rescue is active, foreign claims are warning-only and enabled accounts resume automation and scheduled quota refresh immediately. **Remove Account** deletes the saved account after confirmation; it does not revoke the provider session.

## Quota and automation

The dashboard shows remaining 5-hour, weekly/monthly, and code-review windows, reset times, subscription data, and usage history.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `autoRefreshMinutes` | `15` | Refresh every saved account (`0` disables). Range: 1–60 minutes. |
| `autoRefreshCurrentMinutes` | `1` | Refresh only the active account (`0` disables). Range: 1–60 minutes. |
| `usageHistoryRetentionDays` | `7` | Keep quota history for 1–90 days. |
| `quotaWarningEnabled` | off | Notify when the active account falls below warning thresholds. |
| `quotaWarningThreshold` | `10%` | 5-hour warning threshold, 0–90% in 1% steps. |
| `quotaWarningWeeklyThreshold` | `1%` | Weekly warning threshold, 0–90% in 1% steps. |
| `autoSwitchEnabled` | off | Switch when the active account reaches a configured threshold. |
| `autoSwitchHourlyThreshold` | `5%` | 5-hour switching threshold, 0–20%. |
| `autoSwitchWeeklyThreshold` | `0%` | Weekly switching threshold, 0–20%. |
| `autoSwitchRefreshAllBeforeSwitchEnabled` | off | Refresh candidates before recommending a switch. |
| `autoSwitchReloadWindowEnabled` | off | Reload the VS Code window after an automatic switch. |
| `autoResetEnabled` | off | Use an eligible reset credit when every enabled account is out of quota. |
| `autoResetWeeklyThreshold` | `0%` | Weekly quota limit for reset-credit automation. |

Auto queue uses the same policy in account selection, the dashboard, and the picker. Fresh, capable starred accounts rank first, followed by urgent quota expiry and balanced remaining capacity. Equal capacity favors the account least recently selected. The current account stays selected while its quota remains above the configured switching thresholds; credits and reset reserves never override an exhausted main window. Missing, stale, failed, malformed, and pending-reset snapshots require verification before selection.

Usable reset reserves and their expiry affect ordering only when both Auto Switch and Auto Reset are on. Expired or rejected credits do not count. Reset automation runs only when no capable replacement exists, verifies the latest reset snapshot before consumption, and checks restored quota before selecting the account. A durable request fence prevents a timeout, failed refresh, or restart from blindly consuming another credit. Refresh quota to reconcile an uncertain outcome. Auto Resume and Auto Reload have independent controls; turning Auto Reload off retains the account change without restarting VS Code.

## Codex desktop and CLI

Set `codexAppPath` or `codexCliPath` only when automatic detection cannot find your installation. `codexCliPath` accepts an executable or launcher script; `CODEX_CLI_PATH` is also supported.

Enable `cliIntegrationEnabled` to read local CLI indexes/transcripts on demand. Workspace inspection reads bounded JSONL transcript snapshots directly and never starts a Codex App Server or resumes a thread merely to display it. Active partial records are deferred until complete, and large histories are read from a bounded tail. **Open in Codex** is a separate explicit action. The extension stores tab metadata and session/project IDs, not conversation content.

`autoResumeEnabled` captures running parent sessions in the current workspace before Codex Manager Reload or an automatic account-switch reload, independently of CLI integration or goals. Running parent tabs already open in this window are retained across project changes; an empty workspace selects only its open parent tabs. IDs persist in VS Code workspace storage until an actual non-preview official Codex tab exists; already restored tabs are reused. Partial metadata uses transcript evidence, while incomplete parent metadata blocks capture. Fresh capture excludes sub-agents and confirmed archives.

Capture and complete restoration each have a 30-second budget, each storage write has a 5-second budget, and at most 200 distinct pending sessions are accepted. Overflow fails without discarding the existing record. Repeated capture/restore/reload requests join the original operation. The shared reload workflow has a 45-second budget; timed-out commands prevent another restart until their outcome settles. Failed writes retain recovery in the current host; timed-out writes block further writes until they settle. Failed and unattempted tab IDs remain for the next activation. Turning Auto Resume off cancels pending work and clears recovery. VS Code cannot recall an editor command already accepted; uncertain opens retain their IDs and later reuse the actual tab. This reopens conversations; automatic task continuation belongs to Codex. Open parent conversation tabs are also saved as they change, so an ordinary VS Code restart does not require a managed capture. Closed tabs leave this separate snapshot; failed restoration remains in the pending recovery queue. Tracking starts after startup restoration, retries failed storage or incomplete metadata at a bounded rate, and stops on extension shutdown. The last acknowledged snapshot remains intact when discovery, storage, or queue capacity fails.

Acceptance for `1.2.15-pre3`: all 1,022 regression checks pass; lint has zero errors, both TypeScript gates pass, and VSIX layout/dependencies are verified. Three isolated native VS Code launches verified continuous open-tab capture, reopening an official non-preview tab after ordinary exit, replay without duplicates, and closed tabs staying closed after another restart. Dashboard checks pass at six viewports; independent Auto Resume controls, keyboard use, and an isolated settings save/reload round trip pass at four viewports. Primary account preferences were preserved. Evidence stays under ignored `output/`.

The post-1.2.12 change in `f497dca` cleared recovery before discovery; consume-before-open also lost failed opens. Pending recovery now survives both failures. Ordinary restarts additionally use a continuously saved open-tab snapshot, rather than requiring Codex Manager Reload first.

## Encrypted sync

1. Connect the PCs through the authenticated peer WebSocket, or sign in to VS Code Settings Sync for the durable fallback.
2. Set the shared **Password** in General, then enable `encryptedSyncEnabled`.
3. Enter the same password on every machine, then run **Sync Sessions Now**.

The vault is encrypted before it is sent through a peer WebSocket or written to Settings Sync. The password is not uploaded. Reinstall-safe local data is kept outside the extension under `~/.codex-manager`: `accounts-index.json` contains account metadata, and `accounts/<email>.json` contains one independently encrypted account. A corrupt account file is kept unchanged while the remaining accounts recover. Data from the earlier `CODEX_HOME/codex-manager` layout is migrated automatically after the new files are written successfully. Disable sync on a machine to stop it participating; local accounts remain available.

Add/import, removal, reauthorization, enable/disable, credential replacement, and token-refresh setting changes mark the encrypted vault for a durable sync. Background changes are coalesced for five seconds and retried with bounded backoff. When the authenticated peer WebSocket is online, the changed encrypted vault is delivered and merged immediately. Settings Sync remains the durable fallback; newly downloaded vaults are detected and applied while VS Code stays open, and **Sync Sessions Now** forces a download/merge/upload pass. Signed WebSocket peer updates remain realtime; quota refreshes, account switching, usage, schedules, and heartbeat traffic never request a durable sync.

## Browser dashboard

Set `webDashboardEnabled` to start the local dashboard at `http://127.0.0.1:39875`. Set the shared **Password** under General before sharing it; remote dashboard login uses that same password. `webDashboardAlwaysOnlineEnabled` keeps a detached relay on one always-on PC after VS Code closes; it requires encrypted sync and does not execute account actions by itself.

`cloudflaredDomain` records the HTTPS hostname you configured. It does not install or start Cloudflare. See [`CLOUDFLARE.md`](CLOUDFLARE.md).

## Appearance and diagnostics

- `dashboardTheme`: `auto`, `dark`, or `light`.
- `displayLanguage`: English (`en`).
- `quotaGreenThreshold` and `quotaYellowThreshold`: dashboard color bands.
- `debugNetwork`: sanitized request diagnostics in the **Codex Manager Network** output channel.

All explicit commands and dashboard actions report a terminal result. **Open Persistent Logs** opens redacted JSONL logs, retained for three UTC days and correlated with operation/trace IDs.
