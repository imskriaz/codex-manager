# Changelog

## 1.0.3

- Made account enable/disable, additions/imports, removals, credential replacements, reauthorization, and token-refresh settings durable encrypted-sync triggers.
- Coalesced background VS Code Settings Sync writes for five minutes, persisted pending work, and added bounded retry backoff without coupling realtime peer heartbeats to durable sync.
- Kept signed WebSocket presence authoritative while connected and increased offline detection to three missed heartbeats.
- Simplified account ownership labels and made realtime peer claims more dependable.
- Keep the workspace session rail on Active by default when returning to the session list.
- Ensure Active and Archive tabs remain mutually exclusive.
- Run CLI session monitoring only while a browser workspace viewer is present; account-only pages stay idle.
- Ignore hidden browser tabs when maintaining the workspace viewer lease.

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
