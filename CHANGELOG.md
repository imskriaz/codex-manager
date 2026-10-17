# Changelog

## 1.3.5-pre2

- Remove usage-chart message overlays and badges; keep diagnostics and retries in Graph settings. Silence token-history and unverified-session read toasts.
- Default Automatic token history to off, place it last in Automation, and add a persisted 1-minute to 1-day collection gap for successful and failed checks, respecting provider retry delays.

## 1.3.5-pre1

- Show the account dashboard at the home URL, redirect old dashboard bookmarks to home, and use `/workspace/<session-id>` for chats while preserving old bookmarks and remote-device links.

## 1.3.4

- Keep recoverable daily usage check failures in logs instead of showing them as dashboard or push notices.

## 1.3.3

- Read verified absolute token counts from daily analytics, consolidate accounts into a VS Code + Other stacked chart, and exclude legacy percentage values from token totals.
- Reposition chart tooltips when their size changes and keep them within the viewport.
- Reuse the bounded local transcript index during session list and chat opens, while invalidating on Codex state changes.
- Stable repackaging of the audited dashboard, reload recovery, chart persistence, zero-token tooltip filtering, logging, and non-blocking operation fixes.

- Hide accounts with zero tokens in chart tooltips while preserving totals and missing-data indicators.
- Remember chart mode, time ranges, and period navigation on this device across reloads. Show each day's combined token total above its per-account usage, including missing and stale data.
- Keep dashboard startup responsive when local session discovery, desktop app detection, credential reads, or optional usage-history saving is slow. Return a retryable error instead of leaving the state endpoint pending indefinitely.
- Resolve restored conversation editors before closing all existing Codex session tabs, then reopen saved active and quota-paused goal sessions sequentially. Preserve unsaved tabs and durable recovery on cancellation, timeout, or failure.
- Capture tab and sidebar goal recovery directly before reload instead of scanning the entire running-session history within the short reload budget.
- Close Codex conversation tabs, extra Codex panels, and restored Codex Manager duplicates before managed reloads; seal eligible recovery before tab-close events can replace it.

- Keep the newest diagnostic records when downloads hit their count or byte limit, and avoid rebuilding account state while polling the log console.
- Keep notices short and plain, and send recoverable background failures to logs while automatic retries continue quietly.

## 1.3.2

- Preserve restored Codex custom documents during Auto Resume to avoid editor-load races, focus each recovered conversation, and restore the dashboard without stealing focus.
- Add a live diagnostic console with recent retained history, automatic retry, and log downloads.

- Nest connection controls inside Web Dashboard, remove the CLI path control, give desktop restart and parallel accounts equal width, and move reload beside Auto Resume.

- Capture running sidebar goals even without a conversation tab. Add shared log levels, redacted recent-log downloads, host-run correlation, and detailed capture/filter/restore decisions.

- Make all dashboard settings compact with short, plain descriptions and remove stretched cards with empty space. Keep warnings and action results readable.

- Look up goals for visible sessions directly so large goal histories cannot hide their status. Verify goal-only capture and restore with native goal storage, including quota-limited parents, paused goals, archived sessions, sub-agents, and failed storage.
- Keep pending shared-account confirmation and background retry failures out of desktop, dashboard, and push notifications. Preserve background retries, diagnostics, known ownership conflicts, and explicit sync failures.
- Build 1.3.2 as a stable VSIX without prerelease or preview metadata.
- Coordinate account credentials, token renewal, provider request budgets, browser sessions, OAuth completion, file edits, and Git mutations across local windows through shared SQLite leases. Share compatible quota, credit, profile, subscription, and local-session reads; use one batch runner. Preserve newer credentials and metadata, reject stale reset-credit snapshots, and retain completed reads when their optional result cache cannot be saved.
- Reduce the automatic token-history gap to one hour, preserve provider retry delays, and collect missing account history when the token chart loads.
- Show VS Code token usage only, add a one-day range alongside seven and thirty days, and open a compact account-usage tooltip from the chart total and account colors.
- Switch accounts locally without waiting for the shared claim host, while ownership confirmation retries quietly in the background. Retain known ownership conflicts and local storage checks. Continue independent claim cleanup after a failed confirmation, and distinguish HTTP 401 authentication rejection from an unsupported endpoint.
- Keep unrelated dashboard and account-card controls available during pending operations; disable only the action already running. Document the complete operation inventory and its required dependencies in OPERATIONS.md.
- Retry optional WebSocket connections quietly, without live-channel warning banners or reconnect notices. Preserve explicit action failures and host-unavailable recovery.
- Keep compact chart menus within the viewport, show account quota usage and last check times, and add per-account and bulk token-history refresh with bounded concurrency and visible results. Enable automatic token history by default while preserving explicit choices, and move quota and token retention controls into Data & Sync.
- Close the VS Code dashboard tab before reload recovery storage can stall, preserve its reopen state where available, and restore it after cancelled or failed reloads.
- Return expired browser sessions to sign-in with a terminal result for pending actions and no automatic replay. Distinguish incompatible shared claim hosts from browser login failures during account switching.
- Push committed claim changes over authenticated peer connections, refresh claim views across local windows, and read the current registry when sending peer snapshots. Retain reconciliation for reconnects and missed events.
- Let manual operations interrupt optional background ownership and sync waits. Bound VS Code Settings Sync acknowledgement, share pending sync commands, and retain unsynchronized changes after cancellation or timeout.

## 1.3.1

- Store account metadata, quota and token history, recovery snapshots, session statistics, and cross-window coordination in indexed SQLite rows. Keep only visible graph ranges and required runtime data in memory, write changed rows incrementally, and share committed changes between hosts.
- Migrate legacy databases, JSON, logs, and recovery snapshots into `~/.codex/manager.sqlite` and `manager_logs.sqlite`. Verify committed copies before removing retired storage, preserve unknown recovery data, and retain sources when storage errors or older hosts prevent a safe move.
- Consolidate saved daily token usage across accounts. Add optional collection when the current account loads, limited to one attempt per account every 24 hours, with saved history retained after failed or incomplete checks.
- Redesign quota and token charts with matching heights, linear scales, grouped account bars, and keyboard and touch tooltips showing exact values, daily totals, and history freshness. Let the desktop chart fill the account column height and keep stacked charts compact. Keep saved data visible during loading or failure and remove continuous chart animations.
- Reduce account validation copies, stream legacy migration, and query recent session state without loading historical turns. Avoid rebuilding snapshots after read-only queries, pause workspace inspection and viewer heartbeats on the dashboard, and retain runtime caches and recovery records.
- Recover quota-interrupted parents and usage-limited goals after native running status stops. Transfer Auto Resume snapshots atomically into SQLite, preserve peer captures and recovery during storage or Codex home changes, and save eligible open tabs without scanning unrelated sessions.
- Wait for restored conversation tabs with bounded cancellation and timeout handling. Preserve unacknowledged captures during reload and retry incomplete recovery safely.
- Bound shared-conversation refresh storage, preserve revocation, serialize writes across hosts, and save session/project bindings in one transaction. Retain retryable failed batches and discard stale cache completions.
- Reject account claims before isolated-window startup completes. Place accounts claimed by another online PC after other accounts in dashboard sorts and the automatic queue.
- Keep account card plan, reset credit, device, and subscription expiry on one line, with long device names shortened. Remove the retired announcements feature and redundant eligibility and import wrappers.
- Fix activation with VS Code's frozen settings object, update runtime and packaging dependencies, run the packaged relay script directly, and use the Windows startup registry instead of generated launchers. Package VSIX builds as extension pre-releases.

## 1.2.23

- Suppress the generic cross-PC sync notice when no sync transport is available.
- Suppress the routine local-history reconnect notice and keep session discovery retries at a shared 30-second minimum.
- Release cross-PC account claims after 30 minutes without a sync heartbeat when the owning PC is offline, while connected peers remain authoritative.
- Keep dashboard snapshots responsive while cached credentials refresh in the background, bound slow expired-token account switches, and move optional vault, relay, document, and push startup work off the critical path.
- Prevent session inspection timeouts caused by sequential native status checks and premature Windows lock-probe deadlines.
- Keep session history readable when running state cannot be verified, show the inspection error, and require a successful retry before sending or changing the session.

- Nest workspace controls under Web Dashboard with dependent visibility, pair the host and domain cards and the CLI path and desktop restart cards, and give parallel window accounts a full-width row.
- Group reset, session waiting, auto resume, and refresh-before-switch settings in a responsive two-column grid inside Automatic Account Switching.

## 1.2.22

- Share on-demand Codex session checks between Auto Resume, Wait for running sessions, indicators, and explicit session actions. Account switching now joins duplicate requests, recovers abandoned locks, and cancels optional startup recovery and renewal before manual actions.
- Close cross-PC peer sockets and settle unconfirmed work when the shared domain changes; ignore stale responses and resend encrypted state after relay reconnection.
- Use the configured Cloudflared HTTPS origin for cross-PC WebSockets, disable peer connections without a valid domain, and retain local dashboard WebSockets independently.
- Simplify Auto Sync settings, claim only the current account by default, and release stale saved-account claims. Keep WebSocket changes real time and batch VS Code Settings Sync writes with a configurable gap.
- Save eligible open Codex tabs without scanning unrelated running sessions. Keep automatic save failures in diagnostics and retry quietly without desktop or browser push notifications.
- Keep refresh-all work parallel with manual actions and retain bounded network request handling.
- Keep account card metadata on one line and prevent mobile search inputs from zooming on focus.
- Fix overview quota percentages on compact mobile panels and tighten narrow-screen spacing for controls, metrics, and account cards.

## 1.2.21

- Deliver dashboard switch and reload results before restarting, apply automatic reload in isolated windows, and allow reload retries for already-selected accounts.
- Keep automatic selection moving past unanswered reload prompts. Respect running-session safety when inspection fails, and report cancelled or failed reloads as pending account changes.
- Save and close the existing dashboard before session capture; reopen one panel after reload or failed recovery, and keep manually closed dashboards closed.
- Bound optional reload preparation to one 500 ms budget and persist account selection before reload. Refresh known expired credentials before applying them.
- Refresh expired quota countdowns even when periodic polling is disabled. Retry still-zero provider snapshots with backoff and reuse successful post-reset checks.
- Replay early browser snapshots when the UI becomes ready, preventing startup from getting stuck on Loading.

- Bound optional profile, initial quota, dashboard snapshot, desktop restart, session discovery, and Git status work so completed manual actions can report promptly.
- Refresh subscription details and evaluate quota automation without holding manual refresh completion. Keep reset verification and account ownership checks required.
- Report provider errors accurately in single and batch refreshes; preserve successful chat and Git actions when follow-up reads fail.
- Keep unrelated dashboard controls usable during sync, exports, and quota batches. Reject offline browser actions immediately and warn about unknown outcomes before retrying timed-out requests.
- Preserve concurrent account edits during profile refresh and keep Command Palette errors visible during overlapping dashboard requests.

## 1.2.20

- Prioritize manual Auto Select when it overlaps a background session wait, without duplicating account mutations.
- Let manual Reload interrupt optional preparation and notification waits already started by automatic reload.
- Keep manual and account-change reloads moving when session preservation fails or times out, with a warning about incomplete recovery. Preserve saved recovery and cancel late capture results.
- Run manual Auto Select without the automatic running-session wait, and allow dashboard Reload when no account is selected.
- Recover from Windows PowerShell initialization failures during writer inspection with a bounded hidden-window retry.
- Revalidate account identity, quota, ownership, and automation settings after session inspection so delayed checks cannot override newer choices.
- Re-evaluate automatic account switching immediately when its settings or thresholds change, so cached quota state takes effect without waiting for the next refresh interval.
- Ignore and remove the tracked `docs` folder from the extension repository.
- Update the MIT copyright attribution to imskriaz.

## 1.2.19

- Open Auto Resume sessions sequentially with per-window focus and settle time; a slow window no longer blocks or drops later sessions, and failed windows remain queued for retry.
- Allow workspace tools to use existing Codex project folders that are not open in VS Code, avoiding repeated dashboard errors while preserving path validation.
- Polish public read-only share pages with responsive conversation cards, snapshot metadata, and mobile-friendly typography; expand README coverage and refreshed desktop/mobile screenshots for remote use.
- Permit secure dashboard WebSockets explicitly and reconnect stale mobile connections after network changes, returning from suspension, or manual retry. Tighten mobile session title and metadata spacing.
- Keep remote PCs visible in the picker when their session catalog arrives before peer presence metadata.
- Polish browser notification cards, add provider-confirmed test notifications, standardize mobile text, and keep account search/filter/view controls on one row with one clear button.

- Hide the desktop overview account-details block on small screens while retaining usage, quotas, and actions.
- Compact small dashboard headers: remove the empty top spacer, use the logo as the left sidebar button, and omit the unrelated right floating workspace toggle.
- Add explicit, expiring, revocable read-only conversation snapshot links that work without dashboard sign-in.

- Add **Claim only the current account** with authenticated shared-host ownership checks, serialized switching, fenced releases, and PC labels. Preserve queued claims through conflicting sync updates.
- Restore only verified running parent conversations across projects, preserve distinct native tabs, and use native runtime state to distinguish idle conversations from retained writer handles.
- Discover concurrent running sessions from shared local evidence, including duplicate transcripts and sessions without writer locks or complete indexes, and keep browser and VS Code counts consistent.
- Add the always-visible **Wait for running sessions** setting under Auto Switch. Wait for confirmed active sessions, then switch after completion; continue with a warning when inspection fails or times out.
- Offer browser notification subscription on page load, mirror major VS Code switches and reloads to subscribed devices in parallel, support mobile notification actions, and automatically recover the installed PWA after offline use.
- Show native goal objectives, status, and elapsed time above the composer on desktop and mobile. Anchor running spinners on the right without hover movement and hide them while row actions are visible.
- Keep session order stable across refreshes, remove completion ticks and project plus buttons, group sidebar controls, list all available projects for new chats, and repair delete confirmation sizing and contrast.
- Refresh newly installed settings contributions through a full VS Code reload when required.
- Hide the redundant header overflow menu on desktop while retaining mobile actions.
- Confirm realtime vault delivery only after the receiving PC applies it, and reject stale or conflicting claim updates.
- Group changelog entries by release and normalize license formatting while preserving the MIT terms and attribution.

## 1.2.18

- Capture open Codex conversation tabs synchronously before managed reloads so the old tabs can be closed and resumed reliably.
- Drain bounded diagnostic queues through flush() without mutating the active write promise while it settles.
- Correct running-session detection and auto-resume selection for long turns, completed conversations with retained writer locks, and partial or duplicate transcript events.
- Serialize dashboard usage persistence across VS Code and browser surfaces, reject future-dated cache entries, and make history appends linear for large datasets.
- Keep provider deadlines active through response bodies, bound stalled browser actions and cache transactions, and preserve completed actions when dashboard refresh fails.
- Recover from storage and refresh failures, reject malformed credentials and preferences, and preserve window account isolation through initialization and disposal.
- Report relay launch and shutdown failures accurately, handle subprocess stream errors, and stop failed batches after active work settles.
- Avoid excessive diagnostic-redaction work for long values and serialize overlapping window account lifecycle operations.
- Bound transcript retention and diagnostic write queues, reduce live-stream serialization, and avoid redundant transcript polling after session-list updates.
- Ensure running-session spinners render visibly in compact and mobile lists.

## 1.2.17

- Keep the mobile dashboard header on one row with secondary actions under a compact overflow menu.
- Preserve two-line session list rows when hover actions appear.
- Ensure running-session spinners render visibly in compact and mobile lists.

## 1.2.16

- Fix live session reconciliation and writer-lock handling so running state, spinners, and composer locking stay accurate.
- Keep message actions compact and click-driven, remove the redundant active badge, and add Ctrl/Cmd+mouse-wheel zoom for VS Code webviews.

## 1.2.15

- Detect an actively held Codex writer lock on Windows, keep the running spinner authoritative, and reject sends while another writer owns the session.
- Keep session titles and project metadata on two stable lines when hover actions appear, center destructive delete confirmations in the workspace, and keep Codex question answers in a focused modal. Message actions now open from a compact click target instead of hover.
- Require active transcript evidence for leftover writer locks, restore the composer after completed live turns, retain renamed session titles, and dismiss approvals when their turn stops or the request expires.
- Route duplicate terminal names by stable IDs, reject closed selections, and make uncertain status after a host restart explicit. Invalidate cached browser assets when the installed build changes.
- Keep terminal Stop controls active until execution finishes, recover bounded terminal activity after browser reload or reconnection, and prevent duplicate or delayed output from restarting completed commands. Settle closed, interrupted, timed out, and broken terminal streams visibly.
- Extend real browser checks to mobile chat creation and disposable file, terminal, session, and Git actions.
- Make Compare branch fetch the actual Git diff against the upstream or local base, with bounded previews, empty states, and retry. Preserve the turn review view and use an icon for scrolling to the latest terminal output.
- Prevent stale session project paths from being reused by new chats; new sessions now choose only currently open workspace folders.
- Fit mobile session headers into two compact title/meta rows with status and a single actions menu. Remove the duplicate Sessions button and compact composer, goal, and live status rows while preserving their controls.
- Keep browser session links compact by resolving the project from the session record; legacy project query links are cleaned up when opened.
- Tighten mobile workspace spacing across the session rail, transcript, composer, tool panels, and tabs while preserving touch targets and horizontal scrolling.
- Add a direct empty-state new-chat action so compact browser layouts can start a session without opening the hidden sidebar first.
- Keep Environment and workspace tools single-surface on compact screens, move Agents into Environment, make file image previews open in a lightbox, clear deleted editors, and keep stale terminal/session state from showing a false running spinner.
- Redesign the Codex chat workspace with compact transcript grouping, inline tool details, scrollable code and diff surfaces, copy controls, image previews, completed-turn summaries, and compact session metadata.
- Remove routine browser success toasts while keeping actionable failures, reconnect status, and storage or send warnings visible in context.
- Keep live session state authoritative across delayed history/list responses so completed turns cannot reappear as running; align PC, quota, search, and filter counts with the rows they display.
- Improve reconnect, stale, duplicate, agent, goal, attachment, retry, and image handling across browser and VS Code views.

## 1.2.14

- Stream live Codex responses, tools, plans, diffs and usage into the shared browser/VS Code workspace. Add fenced active-turn steering, reconnect recovery, bounded peer delivery, and reload-safe drafts without automatically resending uncertain requests.
- Add **Resume goal sessions only**, enabled by default under Auto Switch and Auto Resume. Check active goals before capture and reopening; retain recovery when goal storage cannot be read.
- Keep account cards responsive with natural height and two main quota rows, move plan badges into card footers, and remove the redundant Current badge in cards. Keep table presentation unchanged.
- Save open parent conversations continuously and restore them after ordinary VS Code restarts. Preserve failed recovery until native tabs actually open.
- Refresh Auto Resume by closing previous Codex conversation tabs, then reopening only saved sessions. Preserve file editors and unsaved drafts, and bound retries, storage writes, restoration time, and duplicate requests.
- Make Auto Resume depend on Auto Switch, hide its control while Auto Switch is off, and retain the saved child preference.
- Restore previously open Codex Manager dashboard tabs after ordinary restarts using native VS Code webview persistence. Closed dashboards stay closed; restored and manually opened panels are deduplicated.
- Share account queue ordering across automation, the dashboard, and pickers. Prefer capable starred accounts, retain the current account while usable, balance equal-capacity selection, and verify stale or failed quota before switching.
- Count only usable, nonexpired reset credits when Auto Switch and Auto Reset are enabled. Persist reset attempts before consumption, prevent duplicate redemption after timeouts or restarts, and verify restored quota.
- Respect automation setting dependencies and ownership, recheck preferences before switching or reloading, recover bounded scheduler failures, and reject stale or conflicting peer quota.
- Remove the obsolete 5-hour Quota Control setting; 5-hour quota data is always included in automatic quota handling.
- Auto-resume supports running parent sessions after supported reloads, with an optional goal filter and continued sub-agent exclusion.
- Redesign the composer with a compact single-line draft that grows while typing and shrinks after clearing, plus a settings popover for model, reasoning, and access.
- Include eligible running parent sessions in the workspace, normalize Windows extended paths, and exclude sub-agents.
- Keep delayed archive, delete, rename, restore, and fork results scoped to their original chat; invalidate the correct device cache without disrupting another conversation.
- Show interrupted message/agent loading on connection loss instead of silently clearing its waiting state.
- Keep the session menu within narrow mobile viewports when toolbar actions wrap, with full-width touch targets and scrollable overflow.
- Honor the machine App Server transport despite legacy workspace overrides and acknowledge accepted new chats without extra list/catalog refreshes.
- Preserve chat/device identity in routes, requests, agent data, and message caches; ignore late responses after navigation and cache reads superseded by live messages.
- Recover from unavailable browser storage and aborted cache transactions without leaving background cache operations waiting.
- Keep composer drafts and attachments separate for each chat, device, and new-chat project. Late file reads and send completion update the originating draft.
- Avoid redundant agent-read success toasts covering the mobile composer; retain failure and cancellation feedback.
- Restore code-block copying with visible success/failure feedback, open Markdown links separately, and defer offscreen message images.
- Ignore malformed App Server protocol messages, preserve early turn completions, and report interrupted startup or rejected Stop requests accurately.
- Show the selected next-turn model, reasoning effort, and access mode while the composer is locked by another process.
- Keep Search full-width, balance sidebar action icons, and replace Active/Archive tabs with one toggle. Add a remembered compact chat-list view alongside collapsed Projects; search shows matching chats immediately. Move connection notices to the bottom-right.
- Open newly created chats as soon as Codex accepts them, stream the first response, allow Stop, and report interrupted transports immediately.
- Reopen eligible running parent sessions after Reload or automatic switching, scoped to the current workspace when project metadata is available. Skip sub-agents.
- Keep disabled accounts loaded across reloads and restarts. Authentication is unloaded only when the user explicitly chooses Unload.
- Keep session discovery available during slow app-server initialization using bounded local history reads, shared in-flight refreshes, and automatic retry. Launch JavaScript Codex shims correctly inside the VS Code extension host.
- Recover stalled browser handshakes, replay early connection state to the mounted UI, and catch up after offline/online and visibility changes.
- Refresh selected chat messages directly from local transcripts, including idle sessions that start running elsewhere, and resume polling after returning online or reopening the page.
- Separate sub-agents from the parent chat list and open their messages in Agent tabs in the right sidebar.
- Avoid repeated Markdown parsing and quadratic sidebar membership checks during message polling.
- Handle Windows workspace path casing correctly and inspect only open projects automatically when viewing historical chats.
- Improve sidebar readability with separate project names and paths, a wider default rail and duplicate-project protection. Hide empty projects, collapse populated projects by default, and show running counts without extra path rows.
- Polish responsive browser workspace and dashboard layouts, mobile sidebar focus and scrolling, touch controls, safe areas, and reduced motion.
- Consolidate right-panel tool and terminal creation into one plus menu and keep project expansion controls stable on hover.
- Keep message actions compact and floating, revealed on hover or keyboard/touch focus without adding message height.
- Add image and text/code attachments, message and code copying, quoting, edit-and-resend drafts, and retry prompts. Preserve drafts and attachments after failed sends.
- Treat shared-account windows as one unit when parallel accounts are off: switching schedules reloads across affected windows, with auth reconciliation recovering missed file events.
- Share quota refresh and encrypted sync leases in both window modes; reuse recent background maintenance instead of repeating network calls.
- Remove the global Background Token Refresh setting. Token refresh follows each account’s own control.
- Remove the Codex default surface setting. Workspace enablement and transport configure the embedded chat; explicit Open in Codex remains available.

## 1.2.12

- Show the existing reauthentication icon for saved accounts with Refresh Failed in both card and table layouts.
- Prevent Settings Sync request storms by merging downloaded vaults locally, ignoring equivalent peer snapshots, and batching background writes. Report sync suspension with restart guidance.

## 1.2.11

- Remove the duplicate standalone token-refresh failure line from saved account cards.
- Clear stale token-refresh failures after a valid access token is restored and retry transient dashboard refresh failures after a bounded cooldown.

## 1.2.10

- Fixed Auto Select so dashboard-capable accounts with stale quota snapshots are refreshed before reporting that no account is available.
- Improved the mobile browser workspace layout and moved remote sign-out into the account avatar menu.
- Simplified workspace session transports to App Server and CLI, removed the experimental WebSocket option, and made the selected transport authoritative.
- Updated App Server session operations to use supported thread and turn methods without silently falling back to CLI.

## 1.2.8

- Keep new Codex sessions and activity visible while session indexes catch up.
- Recover startup when another VS Code window owns account auth synchronization.
- Defer startup account reconciliation when another VS Code window owns the nested index save instead of leaving the extension status in an error state.
- Register contributed commands before fallible startup work so quota summary remains callable.
- Keep dashboard and extension-host restart commands available throughout activation, including while encrypted sync is still starting.
- Automatically refresh the extension host once after installation or update so command registrations become active without manual Developer commands.

## 1.2.7

- Keep the current account first in Saved Accounts regardless of quota state or the selected sort order.

## 1.2.5

- Allow manual cross-PC sync to use VS Code Settings Sync when it is active even if VS Code does not expose its signed-in account through the extension authentication API.
- Prevent duplicate Settings Sync requests from the Data settings panel while a sync is running, and show the pending state in the initiating dashboard.
- Keep Reload available in the account More menu at all times so the active account can always be reapplied to the current VS Code window.

## 1.2.4

- Route the overview Sync action through password configuration only when the shared password is missing; otherwise run encrypted cross-PC synchronization directly. Password setup and password changes remain available through their dedicated controls.

## 1.2.3

- Show a red account-card background only when the primary weekly or monthly quota is exhausted. An empty 5-hour quota alone no longer colors the entire card.

## 1.2.2

- Keep each resolved `CODEX_HOME` on its own active saved account while preserving the shared account vault, migrating the former global selection, and preventing one home from overwriting another home's selection.
- Use the configured automatic-switch quota thresholds consistently for both the Over quota filter/count and red account-card treatment.
- Keep quota-warning switch actions compact by showing only the destination email address.
- Present 5-hour, weekly, monthly, code-review, and named additional quotas with the correct window identity across dashboard and account-details surfaces.
- Remove account tags from dashboard controls, details, filtering, mutations, exports, and synchronization while continuing to accept older stored files that contain legacy tag fields.
- Try one automatic refresh of an expired access token while building account cards, so valid refresh credentials recover before the reauthorization control is shown in both the VS Code and browser dashboards.
- Prevent repeated dashboard renders from retrying the same failed refresh token indefinitely, while preserving the reauthorization state when recovery fails.

## 1.2.0

- Judge token refresh and account health by access-token expiry so an older ID token retained after refresh does not cause repeated refresh attempts or a false expiry warning.

## 1.1.9

- Treat 5-hour quota as zero for sorting when the main weekly quota is exhausted, and place accounts with a missing main quota last.
- Revalidate the selected account's quota thresholds immediately before automatic switching so a concurrent quota update cannot switch into an exhausted account.
- Keep accounts with available quota ahead of exhausted accounts while preserving the selected sorting order inside each group.
- Highlight accounts with an exhausted quota window using a light red background in card and table views.
- Serialize local `auth.json` reads, writes, migrations, and unloads so account switches and background token updates cannot interleave within an extension host.
- Validate auth-file structure and outgoing credentials, retry transient read failures, and recover a fully written private staging file when the canonical file is missing after an interrupted atomic replacement.
- Preserve an existing malformed `auth.json` for diagnosis instead of silently replacing or using it as another account.
- Start encrypted sync restoration and relay handoff concurrently so the dashboard waits only for the slower independent startup step.
- Bound provider request timeouts across queue and rate-limit waits, honor caller cancellation, and stop oversized or incomplete dashboard requests promptly.
- Generate cryptographically random relay admin tokens and rotate older tokens while preserving a safe shutdown path for an existing relay.
- Show clear cancellation and timeout results during onboarding and explicit session refreshes instead of leaving the initiating view waiting.
- Close the matching browser OAuth modal as soon as the authorized account is saved, while slower quota and sync follow-up continues with visible final feedback.

## 1.1.8

- Make `~/.codex-manager` the single cross-platform filesystem root for the live account index, validated backups, encrypted per-account vaults, logs, coordination state, announcements, running-turn journal, and always-online relay files, with one-time migration from the former Codex-home files.
- Prevent update-time index and active-auth corruption by removing truncating Windows copy fallbacks, fsyncing unique temporary snapshots, validating and atomically rotating index backups, recovering completed temporary writes, serializing index writers across windows, and avoiding shutdown-time index writes.
- Recover a damaged account index automatically from healthy encrypted per-account files, and allow OAuth, current-account, and JSON imports to rebuild the index instead of being blocked by the corruption fence.
- Start the OAuth callback listener as soon as the authorization link is created, automatically copy the link while keeping the copy button, and expire unattended listeners after ten minutes.
- Import account JSON directly on Submit without a separate validation step, and report full failures or partial successes clearly. Keep encrypted cross-PC sync and its local-only account-enable behavior intact.

## 1.1.7

- Replace passive VS Code info and warning pop-ups with one discreet status-bar notice that disappears after ten seconds and clears when the extension reloads. Keep errors and actionable prompts visible as native notifications.
- Show one dashboard notice at a time, replacing the previous notice and clearing it after ten seconds or on reload; close matching browser push notifications on replacement, timeout, and reload.
- Replace an unanswered VS Code choice when a newer Codex Manager choice arrives, and clear the VS Code notification center when Codex Manager initiates an extension-host or window reload.

## 1.1.6

- Preserve saved account metadata under `~/.codex-manager` and store every account in its own password-encrypted, email-named file so uninstalling and reinstalling the extension does not discard accounts and one damaged file cannot block recovery of the others.
- Allow explicit switching to foreign-claimed accounts through the shared-password Rescue flow. While Rescue is active, enabled accounts immediately resume automation and scheduled quota refresh despite foreign claims.
- Fall back to authenticated peer WebSockets when VS Code Settings Sync is signed out, including direct encrypted-vault delivery to connected peers.

## 1.1.5

- Keep cross-PC ownership claims active while gating encrypted account and token sharing behind a separate Full cross-PC account sync setting that defaults off; also coordinate background provider work through claims, keep one-minute current-account polling configurable, pace provider requests, honor rate-limit cooldowns, and redact diagnostics.

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
- Keep the extension manifest regression coverage synchronized with the release package metadata.
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
