# Operation behavior in 1.4.1

Local work does not require an available shared dashboard host. Manual and automatic account switching read committed local ownership records, write local credentials, and persist the selection. Shared claim confirmation and cleanup run afterward. Unconfirmed ownership retries quietly in background diagnostics; HTTP 401, an incompatible endpoint, an offline host, or slow confirmation cannot prevent the local switch. Known foreign ownership still reports a conflict, and required local credential and storage checks still apply.

No pending action disables the entire dashboard or all controls on an account. Only the action already running is disabled. Backend locks reject conflicting mutations promptly; duplicate session requests reuse their result. Optional discovery, recovery, profile enrichment, quota checks after import, and sync follow-up use existing bounded waits or background work. A failed service cannot make an operation requiring that service succeed: its initiating UI reports failure, cancellation, or an unknown outcome, while unrelated controls remain available.

## Dashboard operation inventory

Cross-window coordination lives in `src/utils/crossWindowOperations.ts` and the shared SQLite store. Locks cover one Codex home, account, canonical file, or Git common directory; unrelated resources remain independent. Token renewal rereads Secret Storage after acquiring its account lease and checks the original credentials before saving. Credentials stay in Secret Storage; shared read keys are hashed and result caches contain no OAuth tokens.

Quota, reset-credit, profile, subscription, and local session discovery share compatible reads. Provider admission allows two requests across local hosts, including at most one bulk request, with shared pacing and server cooldown. Individual read cancellation leaves other consumers running. Read caches are bounded and expendable; failed cache writes preserve completed results. Failed mutations remain visible and retain required storage and authorization checks.

Session catalogues persist bounded metadata in SQLite, with detailed transcript reads limited to recent or requested conversations. Reloads can show saved history immediately while stale activity is rechecked in the background. Explicit Refresh waits for a fresh scan; failed scans preserve saved history, and mutation generations reject older results. Unused snapshots expire after seven days. Transient storage startup failures receive bounded retries; persistent failures leave recovery commands available without replacing the database.

Dashboard and Command Palette account batches use `src/application/accounts/batch.ts` for deduplication, pacing, and per-account outcomes. Browser login/logout updates share one session-list lease. OAuth exchanges retain a single-use marker across restarts, and duplicate callback completion saves and notifies once. Reset-credit generations reject snapshots that began before redemption; uncertain redemption remains fenced until verified. File revision checks and writes share a canonical path lease; Git add/commit/push share the canonical common-directory lease.

Every action in `DashboardActionName` is listed below. “Required work” describes what must actually finish before success can be reported; none of these actions globally blocks the dashboard.

| Operations | Required work and failure behavior |
| --- | --- |
| `switch`, automatic selection | Local identity, known ownership, current selection, valid credentials, auth write and durable selection. Remote confirmation retries quietly in the background. Expired credentials still require successful renewal or reauthorization. |
| `unloadAuth`, `reloadPrompt` | Local auth removal or the requested VS Code reload. Recovery preparation is bounded; reload failure retains queued state and reports the outcome. |
| `addAccount`, `reauthorize`, `prepareOAuthSession`, `cancelOAuthSession`, `startOAuthAutoFlow`, `completeOAuthSession` | Requested OAuth flow and credential storage. Consent, cancellation and provider errors remain visible. Optional quota/profile/sync follow-up cannot keep a saved account pending indefinitely. |
| `importCurrent`, `inspectCurrentAuth`, `completeOnboarding` | Read/validate local auth, save imported data or onboarding preference. Optional network enrichment is bounded. |
| `remove`, `batchRemove` | Confirmation and local durable removal. Missing accounts and partial batches report their actual results. |
| `toggleAccountEnabled`, `enableAllValid`, `disableAll`, `setAccountQueuePriority`, `setAccountTokenRefreshEnabled`, `setAutoSwitchLock`, `dismissHealthIssue` | Local metadata and required ownership/storage checks. Remote cleanup of current-only claims is deferred. Conflicts and failed writes report immediately. |
| `refresh`, `refreshAll`, `batchRefresh`, `refreshToken`, `resyncProfile`, `batchResyncProfile`, `getResetCredits`, `getDailyUsage` | Requested provider data or token renewal. Offline/timeouts report failures; batches preserve per-account failures. Other local work remains available. |
| `consumeResetCredit` | Provider redemption and verification with a durable intent fence. Uncertain results require reconciliation before another redemption. |
| `getUsageGraph` | Local saved history query. Missing history is empty; failed reads remain errors. |
| `details`, `openDashboard`, `openWebDashboard`, `openNetworkLogs`, `openExternalUrl` | Open the requested view, log or validated URL. Local navigation does not require sync. |
| `shareTokens`, `exportBackup`, `exportAuthFile`, `downloadJsonFile`, `copyText` | Local serialization, credential access, file/clipboard write or download. Write failure remains visible; no remote claim is required. |
| `restoreFromBackup`, `restoreFromAuthJson`, `previewImportSharedJson`, `importSharedJson` | Validate local input and durably save requested imports/restores. Corruption and storage errors cannot be reported as success. |
| `setPrivacyMode`, `setCrossPcSyncEnabled` | Persist the requested preference. Other controls remain available during settings propagation. |
| `configureEncryptedSync`, `syncNow`, `setEncryptedSyncRegistryOverride` | Validate the password/override and complete the explicitly requested sync work. Sync failure affects this action, not local switching or unrelated operations. |
| `refreshView` | Read-only state refresh with an existing deadline and visible failure/fallback. Reconnect never replays mutations. |
| `openNewCodexWebview`, `openCodexCliSession` | Open the requested local session/view, retaining required session checks. |
| `setCodexSessionGoalStatus` | Explicit Pause or Resume of an existing parent goal in its recorded project. Confirm the native status, preserve paused goals during automatic recovery, and report incomplete native window recovery visibly. |
| `listCodexCliSessions`, `getCodexCliSessionMessages`, `getCodexSubAgentMessages` | Requested local session/history reads with bounded discovery and visible unavailable state. |
| `startCodexCliSession`, `sendCodexCliSessionMessage`, `steerCodexCliSessionTurn`, `cancelCodexCliSessionTurn`, `respondCodexServerRequest` | Requested runtime turn, steering, cancellation or approval response. Stream progress; preserve request deduplication, turn/ownership checks and real terminal results. Other actions remain available. |
| `renameCodexCliSession`, `forkCodexCliSession`, `archiveCodexCliSession`, `unarchiveCodexCliSession`, `deleteCodexCliSession` | Required session mutation; optional post-mutation discovery is bounded and warns without turning a completed mutation into a failure. |
| `previewMaintenance`, `getMaintenancePage`, `inspectMaintenanceStorage` | Read-only Codex inventory, bounded search and paging, project checks, conversation sizes, and native database health. Expired previews and unavailable storage remain visible. |
| `runMaintenance`, `getMaintenanceStatus`, `cancelMaintenance` | Confirm a preview on the selected system, then process only its reviewed selection in the background. Protect running work, unselected descendants, changed snapshots, and required native ownership. Duplicate requests reuse their job; progress reports partial failures and uncertain outcomes after a host restart. |
| `viewLogs`, `downloadLogs`, `clearLogs` | Read or download redacted System Log records in the requesting host, or clear saved manager logs. Disabling logging clears history and prevents queued stale writes from restoring it. |
| `getWorkspaceEnvironment`, `listWorkspaceFiles`, `readWorkspaceFile`, `listWorkspaceTerminals` | Requested local inspection/read. Missing paths, permissions and timeouts report their actual outcome. |
| `saveWorkspaceFile`, `deleteWorkspaceFile` | Validated path, revision/confirmation and local write/delete. Preserve original data on failed atomic saves. |
| `createWorkspaceTerminal`, `focusWorkspaceTerminal`, `runWorkspaceTerminalCommand`, `cancelWorkspaceTerminalCommand` | Requested terminal action, streamed output and cancellation result. An unavailable runtime affects this action only. |
| `commitWorkspaceChanges`, `pushWorkspaceBranch` | Requested Git operation. Push requires its remote; commit requires local Git. Optional later inspection cannot turn a successful operation into a failed result. |

Dashboard setting updates and executable path pick/clear messages persist the requested setting and report errors in their initiating dashboard. `dashboard:ready` and saved usage-history messages refresh/persist their own state; they do not queue manual actions behind discovery.

Optional WebSocket reconnects remain automatic and silent. No live-channel warning banner or reconnect notice is shown. HTTP action fallback remains available; explicit action failures, uncertain outcomes, session expiry and an unavailable HTTP host still report their actual result.

## VS Code commands and background work

Registered commands use the same services and native notifications for explicit failures:

- Accounts: `addAccount`, `importCurrentAuth`, `reauthorizeAccount`, `switchAccount`, `autoSelectAccount`, `consumeResetCredit`, `refreshQuota`, `refreshAllQuotas`, `restoreAccountsFromBackup`, `restoreAccountsFromAuthJson`, `restoreAccountsFromSharedJson`, `removeAccount`, `toggleStatusBarAccount`, `toggleAccountEnabled`.
- Navigation: `openDetails`, `openCodexHome`, `showQuotaSummary`, `showShortcuts`.
- Sync: `configureEncryptedSync`, `syncNow`, `setEncryptedSyncRegistryOverride`.

Command names above have the `codexManager.` prefix. Managed reloads allow 500 ms for recovery capture, then up to 8 seconds to close Codex and Manager tabs before reloading. When the official Codex extension is installed, reload the full VS Code window so native webviews recreate their owner connections. Cold native readiness is bounded at 40 seconds, editor opening at 45 seconds, and complete recovery at 60 seconds; discovery/capture retain their existing 30-second bounds. Manual native actions cancel optional startup restoration and keep unfinished recovery queued. Eligible recovery is saved before closing; incomplete capture preserves conversation tabs, and cleanup failures warn while reload continues. Automatic quota/token/history refresh, Settings Sync, peer presence, claim renewal/cleanup and session recovery run independently; manual account changes can interrupt background ownership renewal.

## Failure and recovery limits

Manager storage maintenance starts in the background after 30 seconds and repeats every 30 minutes. It expires short-lived shared-read and authorization caches, stale session status/discovery, and unused session catalogues. Successful complete history reads remove confirmed deleted-session cache entries; missing or unreadable native storage keeps saved history. Pending recovery and active turns are protected. Session catalogues use individual rows, token points have one authoritative row per account/day, and cache eviction/log export byte limits run in SQLite. Live recording queues are capped at 8 MiB; transcript replay caching is capped at 8 MiB.

System Log keeps the configured 1–30 day retention, additionally capped at 10,000 records or 32 MiB; legacy diagnostic archives have a separate 32 MiB cap. Retention starts in a worker after 30 seconds, at day changes, and every 128 writes. Opening the logger never waits for a large purge; console reads immediately filter the retained date range. Export queries calculate byte budgets from keys and sizes before loading selected values. Database maintenance skips locked storage and retries later. It only opens `manager.sqlite` and `manager_logs.sqlite`; native Codex databases are excluded. New databases support incremental space recovery. Older databases are converted only when at least 2 MiB and 20% of pages are free; a full rewrite is deferred above 64 MiB of retained data. Interrupted or storage-full compaction leaves SQLite recovery in control of its original files.

- Offline, HTTP/authentication failure, missing configuration and slow shared hosts: switch locally, log unconfirmed ownership quietly, and retry confirmation in the background. Never fabricate a successful shared claim.
- Reconnect, retry and reboot: reconcile the persisted active account, preserve other live local windows' accounts, and do not replay browser mutations. Claim failure does not undo a completed local switch.
- Stale, missing and partial data: retain saved state where possible; revalidate identity, ownership and revisions before destructive writes. Known foreign ownership reports a conflict.
- Duplicate and queue-full requests: reuse supported pending requests or report the conflict/capacity failure, without disabling unrelated UI.
- Storage-full and failed writes: preserve errors and data-integrity checks. A local credential or account-selection write failure cannot be skipped safely.
- One failed background claim operation does not skip the remaining independent claim confirmations/releases. Signed responses and fencing tokens remain validated.

Without shared confirmation, another PC may acquire the same account before its ownership reaches this PC. This is the tradeoff of allowing local work during shared-host outages. Real cross-PC outages, disk exhaustion and reboot are covered through automated failure simulation where available; live UI checks are read-only.
