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

Select an account and run **Switch Account**. The extension atomically updates the active Codex `auth.json` and can restart the Codex desktop app. **Remove Account** deletes the saved account after confirmation; it does not revoke the provider session.

## Quota and automation

The dashboard shows remaining 5-hour, weekly/monthly, and code-review windows, reset times, subscription data, and usage history.

| Setting | Default | Meaning |
| --- | ---: | --- |
| `autoRefreshMinutes` | `15` | Refresh every saved account (`0` disables). Range: 1–60 minutes. |
| `autoRefreshCurrentMinutes` | `1` | Refresh only the active account (`0` disables). Range: 1–60 minutes. |
| `usageHistoryRetentionDays` | `7` | Keep quota history for 1–90 days. |
| `hourlyQuotaControlEnabled` | off | Let the 5-hour window drive status-bar warnings and switching. |
| `quotaWarningEnabled` | off | Notify when the active account falls below warning thresholds. |
| `quotaWarningThreshold` | `10%` | 5-hour warning threshold, 0–90% in 1% steps. |
| `quotaWarningWeeklyThreshold` | `1%` | Weekly warning threshold, 0–90% in 1% steps. |
| `autoSwitchEnabled` | off | Switch when the active account reaches a configured threshold. |
| `autoSwitchHourlyThreshold` | `5%` | 5-hour switching threshold, 0–20%. |
| `autoSwitchWeeklyThreshold` | `0%` | Weekly switching threshold, 0–20%. |
| `autoSwitchRefreshAllBeforeSwitchEnabled` | off | Refresh candidates before recommending a switch. |
| `autoSwitchReloadWindowEnabled` | off | Reload the VS Code window after an automatic switch. |
| `autoResetEnabled` | off | Use an eligible reset credit when every enabled account is out of quota. |
| `autoResetWeeklyThreshold` | `1%` | Weekly quota limit for reset-credit automation. |

Candidates are ranked by remaining 5-hour quota, then weekly quota, with subscription expiry used to break ties. Automation is off by default and should be enabled deliberately.

## Codex desktop and CLI

Set `codexAppPath` or `codexCliPath` only when automatic detection cannot find your installation. `codexCliPath` accepts an executable or launcher script; `CODEX_CLI_PATH` is also supported.

Enable `cliIntegrationEnabled` to read local CLI indexes/transcripts on demand. Workspace inspection reads bounded JSONL transcript snapshots directly and never starts a Codex App Server or resumes a thread merely to display it. Active partial records are deferred until complete, and large histories are read from a bounded tail. **Open in Codex** is a separate explicit action. The extension stores tab metadata and session/project IDs, not conversation content.

## Encrypted sync

1. Sign in to VS Code Settings Sync on each machine.
2. Enable `encryptedSyncEnabled` or run **Configure Encrypted Session Sync**.
3. Enter the same passphrase on every machine, then run **Sync Sessions Now**.

The vault is encrypted before it is written to Settings Sync. The passphrase is not uploaded. Disable sync on a machine to stop it participating; local accounts remain available.

Add/import, removal, reauthorization, enable/disable, credential replacement, and token-refresh setting changes mark the encrypted vault for a durable sync. Background changes are coalesced for five minutes and retried with bounded backoff so routine activity does not exhaust VS Code Settings Sync requests. Signed WebSocket peer updates remain realtime and fall back to signed HTTP heartbeats; quota refreshes, account switching, usage, schedules, and heartbeat traffic never request a durable sync.

## Browser dashboard

Set `webDashboardEnabled` to start the local dashboard at `http://127.0.0.1:39875`. Run **Set Web Dashboard Password** before sharing it. `webDashboardAlwaysOnlineEnabled` keeps a detached relay on one always-on PC after VS Code closes; it requires encrypted sync and does not execute account actions by itself.

`cloudflaredDomain` records the HTTPS hostname you configured. It does not install or start Cloudflare. See [`CLOUDFLARE.md`](CLOUDFLARE.md).

## Appearance and diagnostics

- `dashboardTheme`: `auto`, `dark`, or `light`.
- `displayLanguage`: English (`en`).
- `quotaGreenThreshold` and `quotaYellowThreshold`: dashboard color bands.
- `debugNetwork`: sanitized request diagnostics in the **Codex Manager Network** output channel.

All explicit commands and dashboard actions report a terminal result. **Open Persistent Logs** opens redacted JSONL logs, retained for three UTC days and correlated with operation/trace IDs.
