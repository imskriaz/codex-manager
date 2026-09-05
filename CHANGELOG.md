# Changelog

## 1.1.5-pre1

- Open the selected account's reauthorization dialog even when no current account is loaded, and hide the inline add-account form while the dialog is open.
- Keep the normal Add Account title when there is no reauthorization target, including with Privacy Mode enabled.

## 1.1.4

- Add an on/off Cross-PC sync toggle in Data Sync, enabled by default, while preserving saved off choices across restarts and keeping first-run setup available.
- Run real VS Code Settings Sync passes from both dashboard hosts and apply newly downloaded vaults while VS Code remains open, so accounts and refreshed credentials converge across PCs without a restart.
- Merge realtime peer vaults instead of selecting a whole vault by PC wall-clock time, preserving concurrent account and credential changes.
- Keep newly received accounts disabled until explicitly enabled on that PC, and prefer server-issued token freshness when device clocks disagree.
- Keep encrypted-sync password entry inside the dashboard, pass in-screen rescue passwords through the VS Code command boundary, and extend the dashboard wait window for complete download/upload passes.
- Keep the vault password and Rescue setting device-local: users enter the same password value separately on each PC, while each PC controls Rescue independently.

## 1.1.3

- Synchronize Privacy Mode across the browser dashboard, VS Code dashboard, and account details, with visible success or failure feedback.
- Show the selected account email in the reauthorization dialog title while preserving the standard add-account title for other entry points.
- Expand the manual OAuth callback field into a multiline editor with a full-width submit action.
- Fence reset credits rejected as ineligible by provider credit ID so they disappear from the dashboard and automatic reset queue without affecting future credits.
- Turn the current-account switch slot into an unload action with a reload icon, while keeping account loading available for other saved accounts.
- Order automatic-queue candidates by capability first so quota-exhausted, invalid, or foreign-claimed accounts stay last without disturbing the remaining priority order.
- Remove the Onboard entry from the More actions menu, show percentage values beside metric labels, and keep reset credits available through compact icon-and-count controls.
- Deliver quota issues through notifications instead of account-card warning badges, and keep the status bar focused on the running account with a Codex Manager fallback.
- Keep local account startup available when optional encrypted sync initialization fails.
- Hide dependent automation controls while their parent toggle is disabled.
- Streamline account add choices with vertical Authorization Link, JSON File, and Import Current alternatives.
- Keep the unloaded status bar useful, with guidance for reading and loading saved accounts.
- Make Add, Sync, Refresh, and More the fixed overview actions; add Set Password and Onboard to More and hide inapplicable bulk actions.
- Respect the auto-reload setting for manual account switches and keep background automation independent of open dashboard tabs.

## 1.1.1

- Preserve cross-PC claim and automatic-switch lock metadata when realtime peer quota snapshots arrive.
- Keep list-view account type and lock badges visible without changing grid-view badges.
- Keep dashboard password labels aligned with configuration state and route missing-password Sync actions through the dashboard modal.
- Use one shared password across PCs for encrypted vault and WebSocket claim signing; browser sync never opens a VS Code password prompt.

## 1.1.0

- Keep the experimental Workspace setting specific to each PC.
- Ask whether to unload the current Codex auth after disabling its account, and automatically unload it after restart when postponed.
- Place dashboard popouts, dialogs, and toast feedback on a consistent elevation scale so feedback remains visible.
- Show each unchanged low-quota VS Code warning only once until the quota recovers or its threshold changes.

## 1.0.9

- Render the `/dash` center dashboard above the workspace conversation layer while preserving both workspace side panels.
- Keep collapsed PC groups packed together at the top of the session rail.
- Keep the left rail visible on `/dash`, hide the right tools panel on dashboard and New Chat surfaces, and reopen tools for selected desktop chat sessions.
- Keep `/dash` session, presence, environment, and terminal data live through the same workspace-shell lifecycle as chat routes.
- Preserve array/object command payloads and show command names, tool arguments, results, working directories, and output in expanded activity details.

## 1.0.8

- Keep each grid-card account name and its badges on one header row, with the current-account badge before the account-type badge.
- Keep the browser workspace's left session rail and right tools panel visible on `/dash`, with the dashboard filling the center panel.

## 1.0.7

- Apply the freshest account changes and quota snapshots reported by authenticated WebSocket peers while preserving each PC's local account state.
- Refine saved-account cards with compact plan badges and a single-line footer for reset, computer, and subscription details.

## 1.0.6

- Pause active-session transcript polling while the dashboard is hidden, then refresh immediately when it becomes visible again.
- Prevent disposed quota-reset schedulers from recreating timers or performing stale background work.
- Improve account status filtering, quota badge presentation, and reset-credit styling.

## 1.0.5

- Add a Claimed account filter after Disabled and hide status filters whose count is zero.
- Skip accounts claimed by another PC during quota refresh and automatic queue work.
- Improve event-driven automatic queue efficiency.
- Preserve project context when opening linked Codex sessions.
- Keep public documentation free of private deployment details.

## 1.0.4

- Update the extension description to refer to Codex/ChatGPT account management.
- Safely validate Codex resume working directories before starting resumed sessions.
- Keep the extension manifest regression coverage synchronized with the current prerelease package metadata.
- Keep the session sidebar and chat workspace on the canonical root dashboard, while `/dash` opens the account overview.
- Strengthen the blurred backdrop for all dashboard confirmation and input modals.
- Use centered modal dialogs for password entry in the VS Code dashboard.
- Make the root Web Dashboard home show the session sidebar and chat workspace, with the account dashboard available at `/dash`.
- Serve the Web Dashboard home page at the root URL as the canonical entry point.
- Relay authenticated realtime encrypted-vault events across all connected peer PCs, not only the first receiving host.
- Mirror encrypted vault changes over the authenticated realtime peer WebSocket without consuming Settings Sync requests.
- Coalesce durable vault uploads for five seconds, merge incoming snapshots through the normal conflict-safe path, and retry when a competing vault update is detected.
- Keep manual Settings Sync as the receiving-PC fallback and report inconclusive empty-vault background attempts as failures for retry.

## 1.0.3

- Removed blocking Settings Sync and immediate quota/token refresh work from extension activation.
- Fixed a browser workspace feedback loop that generated thousands of repeated environment requests.
- Prevented overlapping peer heartbeat work, bounded HTTP heartbeats, and made relay shutdown deterministic.
- Added uninstall cleanup for the detached Windows Startup relay.
- Made account enable/disable, additions/imports, removals, credential replacements, reauthorization, and token-refresh settings durable encrypted-sync triggers.
- Coalesced background VS Code Settings Sync writes for five minutes, persisted pending work, and added bounded retry backoff without coupling realtime peer heartbeats to durable sync.
- Kept signed WebSocket presence authoritative while connected and increased offline detection to three missed heartbeats.
- Simplified account ownership labels and made realtime peer claims more dependable.
- Keep the workspace session rail on Active by default when returning to the session list.
- Ensure Active and Archive tabs remain mutually exclusive.
- Run CLI session monitoring only while a browser workspace viewer is present; account-only pages stay idle.
- Ignore hidden browser tabs when maintaining the workspace viewer lease.

## 1.0.2

- No separate changelog entry was recorded for this version.

## 1.0.1

Codex Manager now provides a cleaner, more dependable way to manage accounts and work with Codex sessions from VS Code or the browser dashboard.

### Highlights

- A compact, responsive dashboard with balanced account and quota panels.
- A simpler layered account setup flow for OAuth, callback completion, current-account import, and JSON files.
- Clear separation between active and archived Codex sessions.
- Live thinking and tool activity, with completed tool calls grouped into compact expandable summaries.
- Tighter conversation spacing for easier reading without reducing line height.
- Full-height Files and Reviews tabs with wrapped content, clear selection, and polished context menus.
- File actions for opening, copying paths, and confirmed deletion; review actions for opening reviews or source files.
- Real VS Code terminal integration, including running-terminal selection and profile-based terminal creation.
- Visible success, warning, cancellation, and error feedback for user-started actions.

### Reliability

- Improved browser-dashboard reconnect behavior and Cloudflare-hosted login handling.
- Safer workspace file access and more dependable PowerShell command execution on Windows.
- Packaging excludes local browser-test artifacts.

## 1.0.0

- Initial release.

