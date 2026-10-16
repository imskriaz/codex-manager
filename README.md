# Codex Manager

Codex Manager is a local-first Visual Studio Code extension and secure browser dashboard for managing Codex accounts, quotas, sessions, automation, and remote VS Code windows from desktop or mobile.

It is an independent, community project. It is not an official OpenAI product.

## What it provides

| Area | What you can do |
| --- | --- |
| Accounts and quota | Add OAuth accounts, import `auth.json`, restore backups, compare 5-hour/weekly/review usage, and see reset times and history. |
| Switching and automation | Switch manually or by quota thresholds, wait for every running session before switching, resume eligible conversations, and keep automatic switching safe when inspection is unavailable. |
| Sessions and goals | See all running parent sessions across projects and PCs, keep list order stable, inspect transcripts, view native goals above the composer, start/stop/fork turns, and continue from another VS Code window. |
| Remote dashboard | Open the password-protected dashboard from any desktop or mobile browser through HTTPS and Cloudflare Tunnel. Live WebSocket updates, PC labels, session counts, account claims, and remote actions stay in one interface. |
| Sync and claims | Authenticate peer connections, sync encrypted account state, reserve only the current account on a PC, and show which PC owns a claim. VS Code Settings Sync remains the durable fallback. |
| Notifications and PWA | Subscribe per device to major switches, reloads, failures, and completed sessions; send a delivery test; install the dashboard as a PWA; and recover to an offline shell while the host is unavailable. |
| Sharing and workspace | Create expiring read-only conversation links, browse project files, review Git changes, run project terminals, and keep actions visibly successful, cancelled, or failed. |
| Privacy and diagnostics | Keep credentials local, redact persistent logs, enforce bounded requests, and expose no account controls through a share link. |

Use the dashboard settings for feature descriptions and configuration defaults.

## Support development

To donate, open [Xoom for Bangladesh (BDT)](https://www.xoom.com/en-us/usd/send-money/transfer?countryCode=BD&destinationCurrencyCode=BDT), sign in with your PayPal account, enter your donation amount, choose **Mobile Wallet → bKash**, and send to **Codex Manager** at `01628301525`. Review Xoom’s fee and exchange rate before confirming.

## See it in action

The screenshots below use representative, privacy-safe data so you can preview the main surfaces before installing.

![Codex Manager desktop dashboard showing PC selector, quota overview, session rail, and account cards](media/docs-dashboard.png)

*Desktop dashboard — compare PC status, quota health, account cards, and session access at a glance.*

![Codex Manager mobile dashboard with compact quota and account controls](media/docs-mobile.png)

*Mobile dashboard — use the same account, session, notification, and remote controls in a compact touch layout.*

![Codex Manager mobile session workspace with goal strip and activity timeline](media/docs-session-mobile.png)

*Mobile session workspace — read the conversation, follow activity, review changes, and keep the native goal visible above the composer.*

![Codex Manager settings control center](media/docs-settings.png)

*Settings — configure appearance, dashboard access, automation, sync, and workspace features in one place.*

![Codex Manager workspace Files tool](media/docs-workspace.png)

*Workspace — keep sessions and project files together, with full-height tabs for Files, Reviews, and Terminal.*

## Requirements

- VS Code 1.101 or newer.
- Node.js 22.13 or newer for the optional detached relay.
- A working Codex installation and a writable `CODEX_HOME` (the default Codex location is used when `CODEX_HOME` is not set).
- Node.js 22.13 or newer when building and testing from source.
- A signed-in VS Code Settings Sync account for optional cross-PC claim checks.
- `cloudflared` only when publishing the browser dashboard outside the local machine.

## Install

### Marketplace

Install **Codex Manager** from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=imskriaz.codex-manager).

### VSIX

Download a release VSIX, then run **Extensions: Install from VSIX...** in VS Code. From a terminal:

```bash
code --install-extension codex-manager-<version>.vsix
```

### Build from source

```bash
git clone https://github.com/imskriaz/codex-manager.git
cd codex-manager
npm ci
npm run compile
```

Press `F5` in VS Code to open an Extension Development Host. Use `npm test` and `npm run verify` before distributing a build. Packaging is intentionally not part of the normal setup flow; run `npm run package` only when you are preparing a VSIX.

## First run

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **Codex Manager: Add Account via OAuth** and finish the browser login. For an already configured Codex installation, use **Import Current auth.json** instead.
3. Open the Codex Manager dashboard from the status-bar item or **Codex Manager: Show Quota Summary**.
4. Select an account and run **Switch Account**. The extension updates the machine-wide Codex `auth.json`; restart the Codex desktop app when prompted.
5. Use **Refresh Quota** after login or account changes. Enable scheduled refresh only if you want background requests.

Every user-started action ends with a visible success, warning, cancellation, or failure message. If an action fails, open **Codex Manager: Open Persistent Logs** and include the operation ID when reporting it.

## Commands

Open the Command Palette and search for `Codex Manager`.

| Command | Use |
| --- | --- |
| Add Account via OAuth | Authorize and save a new account. |
| Import Current auth.json | Save the account currently used by Codex. |
| Switch Account | Write a saved account to the active Codex credential file. |
| Refresh Quota / Refresh All Quotas | Refresh one account or every enabled account. |
| Restore Accounts from Backup | Restore the extension’s native backup format. |
| Restore Accounts from auth.json | Import accounts from a Codex credential file. |
| Restore Accounts from Shared JSON | Import a JSON export created on another machine. |
| Remove Account | Delete a saved account after confirmation. |
| Open Details | Show account identity, subscription, quota, and usage history. |
| Open Codex Home | Open the configured `CODEX_HOME` folder. |
| Show Quota Summary | Open the VS Code dashboard. |
| Keyboard Shortcuts & Help | View dashboard shortcuts and help. |
| Open Latest Session in VS Code | Open the newest local CLI session. |
| Sync Cross-PC Claims Now | Synchronize encrypted account ownership claims using the shared password configured in General. |
| Open Persistent Logs | View the latest 1,000 redacted diagnostic records from SQLite. |

## Browser dashboard and Cloudflare

The browser dashboard is disabled by default and listens on `http://127.0.0.1:39875` when enabled. In the dashboard Settings:

1. Turn on **Web dashboard**.
2. Set the shared **Password** in General; remote dashboard login and optional cross-PC claim checks use that same password.
3. If the dashboard must remain available after VS Code closes, turn on **Always-online WebSocket host** on one always-on PC.
4. For a public HTTPS address, set **Cloudflared domain** to the final URL (for example `https://codex.example.com`) and configure the tunnel to forward to `http://127.0.0.1:39875`.

Read Cloudflare’s [Tunnel overview](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/), [downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/), [remotely-managed tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/), and [Quick Tunnels guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) first.

Cloudflare Tunnel exposes the dashboard’s HTTPS and secure WebSocket endpoints. It does **not** expose raw MQTT/TCP; devices that use MQTT still need a separately reachable broker. Install the same stable VSIX on every PC that should appear in the PC picker; the dashboard cannot discover a PC whose extension host is offline or running an older build.

### Remote and mobile workflow

1. Install Codex Manager on each PC and enable CLI integration where sessions should be visible.
2. Configure the same dashboard password and Cloudflare HTTPS domain on the participating PCs.
3. Open the dashboard on desktop or mobile. The PC picker shows online devices, their session totals, and the selected device’s account view.
4. Enable **Browser notifications** on each device if you want switch, reload, failure, completion, or action prompts delivered while the page is closed.
5. Use **Install app** or **Add to Home Screen** on mobile for a standalone PWA. The offline page preserves the shell and reconnects when the host returns; authenticated data and actions still require a live host.

The dashboard’s session count is based on parent conversations and native runtime state. Child-agent rows and retained idle writer handles are excluded, so the count represents turns that are actually running.

## Settings

All settings use the `codexManager.*` namespace. The dashboard explains each control and its configuration defaults.

Important combinations:

- **CLI integration** enables dashboard session discovery and controls. It does not perform automatic CLI resume.
- **Encrypted sync** uses authenticated peer WebSockets when available and VS Code Settings Sync as its durable cross-PC fallback. Use the same password value on each machine; the password is never uploaded by the extension.
- **Automatic switching** is off by default. Set the hourly control on only if the 5-hour window should affect switching and status-bar warnings.
- **Always-online host** is optional and requires cross-PC claim checks before it can relay signed peer state.
- **Cloudflared domain** is the canonical HTTPS origin for cross-PC WebSocket connections. Cross-PC connections require a valid domain; local dashboard WebSockets work without one. The `cloudflared` process and DNS route are managed by you.

## Privacy and security

- Account tokens remain in local VS Code SecretStorage and the Codex credential file. Password-encrypted recovery records are stored in `~/.codex/manager.sqlite`. They are not sent to a Codex Manager server.
- Account metadata, settings, session recovery, usage history, and other extension state share that SQLite database, using WAL and full synchronous commits. Existing state is migrated without deleting its source files. VS Code Settings remains the editing interface and stays synchronized with SQLite. Process locks, diagnostic logs, Codex-owned files, and browser offline caches keep their platform formats.
- Auto Sync synchronizes encrypted account IDs and PC ownership claims through VS Code Settings Sync and authenticated peer connections. **Full cross-PC account sync** is a separate setting and defaults off, so account sessions and tokens stay local unless the user explicitly enables it. Usage, quota data, and schedules are never synchronized. Sync Cross-PC Claims Now forces a download/merge/upload pass for the enabled sync mode.
- The browser dashboard is local-only until enabled. Never expose port `39875` without the shared password and HTTPS access control.
- Persistent logs redact tokens and account identifiers and retain the current UTC day plus the previous two days.
- Review the [MIT License](LICENSE) and only manage accounts you own or are authorized to use.

## Troubleshooting

- **No accounts appear after reinstall:** enter the same shared Password so Codex Manager can unlock the encrypted account records in `~/.codex/manager.sqlite`. Existing data under `~/.codex-manager` is migrated automatically and the old folder is removed only after verification. See [storage and migration](STORAGE.md).
- **Quota refresh fails:** run **Refresh Quota**, check your network/proxy settings, and inspect **Open Persistent Logs** for the operation ID.
- **Switch did not affect Codex:** close/restart the Codex desktop app or enable the extension’s app-restart setting. Verify the active `auth.json` in **Open Codex Home**.
- **Browser dashboard cannot connect:** confirm Web dashboard is enabled, the shared Password is configured in General, and the Cloudflare route points to `http://127.0.0.1:39875`.
- **Sessions are missing:** enable CLI integration, verify the configured Codex CLI path, and confirm the Codex session index exists.

## Documentation map

- [`CHANGELOG.md`](CHANGELOG.md) — human-focused notes for the current release.

## License

Codex Manager is available under the [MIT License](LICENSE). The project was originally based on [codex-manager](https://github.com/wannanbigpig/codex-manager).


### Session-aware switching and current-account claims

Auto Resume captures all local running parent conversations across projects and restores each as a persistent native Codex tab. The optional active-goals filter still applies.

**Wait for running sessions** under Automation delays Auto Switch and automatic resets until every local turn finishes. If session inspection fails or times out, automatic switching waits with a warning and retries. Manual account switching remains available immediately.

**Claim all accounts** under Data & sync is off by default, so Auto Sync reserves only the account currently selected on this PC and frees every other saved account. Turn it on to claim every enabled saved account. Configure the same shared HTTPS dashboard domain and password on every PC. The shared host confirms ownership before credentials change; disconnected PCs keep their current claim until they reconnect and release it. Account cards show the owning PC.

Browser conversations show the saved native Codex goal above the composer, including its objective, state, and elapsed time. This remains available when the goal creation event has scrolled out of the message history.

### Browser notifications and PWA

In the browser dashboard, open General settings and choose **Enable notifications** on each device. Major account changes, warnings, failures, completed sessions, and available notification actions use background Web Push. Delivery requires the dashboard host and network to be available; subscriptions are local to that host and expire after 30 days unless renewed. Logging out revokes that login's subscriptions.

Use **Install app** where available, or your browser's **Add to Home Screen** option. On iPhone and iPad, open the installed Home Screen app before enabling notifications. The offline recovery screen reconnects automatically after a host restart. Account data and actions require a live authenticated connection; notifications never automatically repeat an uncertain action.

Browser notification setup appears when an unsubscribed device opens the HTTPS dashboard. Choose **Enable notifications**, then allow the browser permission prompt. You can also use **Settings → General → Browser notifications & installed app**. Major Codex Manager notices in VS Code, including account switches and reloads, are mirrored to subscribed devices; delivery attempts run in parallel and are drained before managed reloads.

Choose **Send test notification** in those settings to test all subscribed devices. The result reports push-service acceptance and failures; confirm receipt on your phone, since the browser and OS control notification display.

Running counts, Auto Resume capture, and the wait-before-switch preference share session verification. Native runtime status overrides retained writer handles, so loaded idle conversations do not count as running. New chat lists existing local Codex projects, and session positions remain stable through background refreshes.

### Shared session checks

Session inspection is demand-driven. Overlapping consumers share bounded running-session snapshots and matching per-session status reads; cancelling one consumer does not cancel the others, while the last cancellation stops the scan.

| Consumer | Required condition | Check |
| --- | --- | --- |
| Wait for running sessions | Auto Switch and Wait for running sessions enabled | All local running session IDs |
| Auto Resume at managed reload | Auto Switch and Auto Resume enabled | Recent verified running IDs (up to 30 seconds old), otherwise a fresh check; then goal filter |
| Auto Resume tab autosave | Auto Switch and Auto Resume enabled | Running open parent tabs, saved to SQLite when session checks complete; optional active-goal filter |
| Auto Resume restore | Saved recovery exists and both toggles enabled | Saved IDs and goal filter |
| Running indicators and workspace lists | Dashboard/session view requests status | Per-session native/transcript status |
| Explicit session actions | A session command needs ownership | Per-session status |

Manual account switching and ownership renewal do not request session inspection. Turning Auto Resume off clears saved recovery once and stops future checks.

Browser Share creates an explicit read-only snapshot link. Anyone with its token can view the conversation messages without signing in; it grants no dashboard access. Links expire after 30 days. Create a replacement or use **Revoke shared link** to invalidate the previous link. New messages require a new snapshot.
