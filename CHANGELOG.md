# Changelog

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

