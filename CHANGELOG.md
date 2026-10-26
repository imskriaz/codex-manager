# Changelog

## 1.5.6

- Restore tab-first Auto Resume by default for goals and non-goal sessions, continue goals without a new prompt, and send “Continue if not completed” only for interrupted non-goal chats through the ready official owner. No private server or unsupported goal-activation calls.
- Retry temporary startup IPC disconnects within the readiness deadline; retain failed and uncertain recovery without duplicate sends.
- Keep quota, capacity, and system-interrupted paused goals eligible while respecting explicit Pause, Stop, completion, and session policies. Preserve already running owners at startup.
- Improve recovery-path, readiness, goal-transition, Stop, and native-turn diagnostics; synchronize native session names and preserve compact per-reset actions.

## 1.5.6-pre.7

- Trace Auto Resume's background owner, forced tab, and fallback tab paths separately, including readiness timing, recovery outcomes, and retained failures.
- Log observed goal transitions with their observation interval and unknown actor, and distinguish Manager goal/Stop requests from confirmed changes and later native turn completion.

## 1.5.6-pre.6

- Resume only through a verified ready official Codex owner, with a nested Open VS Code option and tab fallback before sending a continuation.
- Remove Manager's private app-server transport. Unsupported official API actions report an error instead of starting a second writer.
- Follow native session names when Codex revises them and avoid counting idle recovery as a resumed turn.

## 1.5.6-pre.3

- Keep Manager titles synchronized when the native Codex server renames a session.

## 1.5.6-pre.2

- Keep reset rows compact by showing only the reset icon and count.

## 1.5.6-pre.1

- Retry transient empty Auto Resume startup discovery before consuming saved recovery, and tolerate Windows PID inspection permission errors during live-session capture.
- Add per-account Reset actions and replace the internal `codex_rate_limits` label with Reset ID.

## 1.5.5

- Restore the compact Auto Resume icon toggle for running sessions, with distinct play/pause states. Hide resume-policy controls on idle sessions; use a clock-and-list queue icon, priority badges, and a visible warning for unconfirmed queue starts.
- Use the existing session-count position for startup status, then show only the running count once ready. Remove the separate status badge and redundant server-status card from the session popover.

- Consolidate Tools into Storage Management with storage summaries, project heatmap data, and one compact operation surface. Keep server status, running-session Auto Resume controls, and existing queue priorities compact.
- Resume saved Codex work in the background through the existing native/app-server path without opening conversation editor windows or waiting for the Codex sidebar. The app-server initialize handshake remains the readiness check; existing tab cleanup and per-session state checks remain active. Open a conversation manually when you want its editor.

## 1.5.4

- Open reset details and require confirmation only for irreversible reset or cleanup actions; ordinary reloads start immediately.
- Clear accepted workspace messages and restore them after failed or uncertain delivery.
- Open every Settings > Tools action in a larger modal, enumerate all native Codex storage databases, and rate-limit duplicate Auto Resume startup warnings.

## 1.5.3

- Wait for the main Codex sidebar startup trace before Auto Resume opens conversation tabs. Use a visible three-minute fallback when readiness cannot be confirmed, and retain recovery on an explicit sidebar startup failure or cancellation.

- Close all existing Codex conversation and panel tabs before a VS Code reload so restored tabs cannot race Auto Resume into duplicates.

## 1.5.2

- Add Codex UI startup diagnostics and a fresh-panel recovery action to Settings > Tools for native renderer startup failures.
- Make archive cleanup independent of goal storage and native renderer IPC, with targeted archive and writer-lock checks before deletion.
- Delete selected child conversations before their parents to prevent native cascade deletion races during cleanup.

## 1.5.1

- API testing checks the bearer token and shows only allowed operations and host projects, with formatted, bounded JSON responses. Host-wide `refreshAll` permission is covered directly; unavailable scope checks report retryable errors instead of misleading permission failures.
- Flyouts follow the clicked control across scroll, resize, dynamic content, and the mobile keyboard; menus flip above when needed and stay within the visible viewport, with nested menus above their parent surfaces.
- Make Locked account badges open the shared Unlock action in both list and card layouts, keeping failed unlocks visible and disabling offline actions.
- Forward signed remote switch/reload/Auto Resume notices and warnings to browser/PWA push with their existing system names, bounded reconnect replay, duplicate rejection, and passive remote notices. Reject stale or duplicate session completion updates before notifying.

- Replace the separate indefinite manual-selection pause with the existing visible 15-minute Auto Switch lock. More → Unlock resumes selection, lock expiry triggers a retry even when periodic refresh is off, and other windows read the current lock before switching. Retired pause metadata no longer blocks accounts.

- Restore recently viewed system lists before paint while IndexedDB refreshes; bound the memory cache, preserve device isolation, invalidate removed data, and reject older responses after newer realtime updates.
- Retain saved board content while its tab is hidden and restore recently viewed project boards before paint, without reusing another system's board.
- Share composer and project discovery, limit folder checks and storage waits, and avoid unrelated project discovery before starting work in an already authorized project.
- Run independent workspace Git reads together without optional index locks. Report failed remote or change-total inspections instead of showing false empty results.
- Use the same action-route status in native and browser dashboards. Keep cached remote data on disconnect and avoid native view refreshes for unchanged heartbeats.
- Open chat file links in the workspace Files panel, including native paths, file URLs and line references. Keep normal web links external and preserve project containment checks.
- Add a dashboard version badge, compact draft recovery and running-session controls, and refreshed documentation screenshots for browser management across connected PCs. Present Workspace and Auto Resume without experimental labels.

- Authenticate dashboard interest in detached relay signatures consistently with current clients; reject malformed or tampered targets while retaining legacy peers. Show cached peers as disconnected when no action route exists.
- Read large transcript snapshots in bounded 1 MB chunks and coalesce simultaneous reads, preserving byte limits, partial reads, fixed snapshot boundaries, and the five-second storage deadline.

- Close previous Codex Manager tabs before reopening or restoring a dashboard, then create one fresh panel. Preserve other editors, reject dirty tabs and failed cleanup, coalesce concurrent opens, and keep recovery pending after failures.

### Included from 1.4.4-pre.1

- Rename Auto Sync to Sync and Claim. Stop claim creation, pending markers and claim advertisements while disabled, recheck the setting after asynchronous work, and release this PC’s prior legacy and verified current-account claims without acquiring new ones. Preserve uncertain cleanup for retry.
- Align the collapsed sidebar logo across mobile dashboard, board, welcome and conversation headers, with consistent control sizing and centered artwork.
- Load session sidebars and task board/list batches on scroll, retaining filtering, keyboard access and bounded initial rendering.
- Return token lists with confirmed API mutations, reject repeated creation request IDs without persisting token text, keep project scopes on the owning host, and show bounded pending/error/recovery states in the API dialog.
- Replace the detached relay diagnostics page with a quiet startup screen, bounded automatic handover recovery and an offline retry state. Keep the workspace loading screen visible and stop session discovery from delaying dashboard state.
- Default new session sidebars to compact list view, preserve saved view choices and remove the remote-system information banner.
- Default new project links to Never Expire while retaining timed expiry choices, permissions, revocation and storage limits. Existing timed links keep their expiry.
- Keep history readable when a recorded project folder is missing. Report folder availability in Environment without pretending Git is verified or redirecting commands to another folder.

## 1.4.3

- Replace the command-log terminal panel with a shared pseudoterminal and xterm screen: native/browser shell parity for newly created shared terminals, ANSI and cursor handling, interactive input, screen restoration, sequence-fenced input, control handoff, resize, find, copy, rename and split views. Keep unsupported native-screen attachment explicit and do not cache or replay terminal input.
- Expand Git into staged/working changes, diffs, paged history, branch and stash tools, fetch, fast-forward pull and push. Reject stale snapshots, preserve conflicts and deduplicate confirmed operations.
- Add host-authenticated GitHub pull requests, issues, Actions and release panels, with detail views and confirmed writes. Keep credentials host-only, validate origin repositories, fence PR merge heads and release revisions, retain partial read warnings and report uncertain confirmations without replay.

- Use a focused New task dialog with title, description, stage and attachments. Add attachments to comments, including attachment-only comments. Store payloads under the owning manager's `manager/attachments` folder beside its database; board responses and SQLite hold metadata only. Reuse session upload validation, retain offline drafts, support bounded on-demand preview/download, and enforce shared Files/Comments permissions. Reject invalid drafts before filesystem writes, recheck permissions after uploads, and clean up unreferenced failed uploads without removing confirmed files.
- Keep small-screen task search inside the toolbar with an explicit close action that preserves the filter; Escape clears it. Size the project tab to its name.

- Keep one system switcher in the sidebar, with a count badge only for multiple systems. Remove duplicate board/dashboard selectors, expose useful task metadata directly beneath titles, and reclaim the info-button space.
- Tighten conversation title/project spacing, restore the workspace tools close button, and keep the right sidebar closed on welcome and new-chat screens.
- Stop obsolete session-list refreshes from keeping controls disabled or replacing newer results with timeout errors. Remove the persistent checking-status block, show one appropriate automation control per sidebar session, and report manual flyout refresh results through the same feedback path as sidebar refresh.
- Use stable system IDs for local browser caches, drafts, task boards and offline changes. Keep unverified legacy drafts for explicit recovery instead of automatically assigning them to the current PC. Reject late confirmations when the browser origin changes host.
- Retire saved queue entries after confirmed native archive/delete actions, preserve uncertain claims, and report bookkeeping failures without replaying the native mutation. Keep open task metadata current without overwriting edits.

### 1.4.3-pre.5

- Keep browser sessions and Account Center scoped to the selected system. Persist local and remote account read views separately in IndexedDB, release inactive remote catalogues from the visible state, and retain the selected PC across reload, history navigation, and temporary discovery loss. Hide disabled accounts from switching choices.
- Treat peer heartbeat session lists as partial updates, including older relays. Preserve the complete cached catalogue and composer metadata until an authoritative read confirms changes; fence delayed cache writes and stale restores.
- Keep discovery heartbeats responsive while session indexing is slow, reuse the last completed standby view, and send active parent sessions and running agents rather than archived history. Allow a short reconnect grace without letting repeated old signed heartbeats keep a disconnected PC online.
- Preserve a session’s folder when starting a chat from a project missing from the catalogue; reset the project context on system changes without deleting saved drafts.
- Improve System/Project tab alignment, readable compact session titles, centered empty workspaces, and menu access around toasts. Give Tasks its own pulse icon so it differs from the session-list control.

### 1.4.3-pre.4

- Keep agent details in the task’s Agents tab, using the same compact agent selector and transcript panel as the workspace sidebar. Preserve messages on failed refresh, isolate task/system requests, and keep shared boards read-only.
- Fix live task search for grouped sessions and keep the same filter in Board/List. Remove repeated PC names from cards, normalize action icons, tighten all task-details tabs, and keep compact headers on one row when space allows.
- Present task Activities as a compact timeline shared by owner and public boards, with messages, useful actions, changes, and permitted comments. Hide thinking and failed tool attempts in this view while preserving the full session conversation and session-level errors. Keep System and Project selectors single-line beside the view tabs, with counts on hover.

- Restore quota-change recording and retention controls at the user’s updated request. Put the token-history toggle and interval inside Usage log. Confirm quota-history clearing, send it to the selected system, retain failure feedback, and refresh the graph only after confirmation. Background recording does not block dashboard rendering.

- Prevent a rare relay restart loop when a newly generated admin token resembles the legacy timestamp/hostname format; keep strict legacy-token rotation.
- Authenticate WS Cross System with the shared dashboard password independently of account Auto Sync. Keep encrypted account vault synchronization disabled when requested; converge host preparation to the latest configured domain after an in-flight check.
- Retry read-only startup recovery verification within its existing deadline, cancel when the home changes, and preserve unconfirmed work without replaying editor opens or turns.
- Match System and Project selectors to the task view tabs, balance header padding, and place the actions menu last.
- Retain account names with token history after account removal while deleting credentials; preserve labels through legacy writes and apply privacy masking to historical accounts.

### 1.4.3-pre.3

- Clarify and verify that Manager follows the latest valid Codex login, restores a missing saved entry, and retries with the new login after an import race without writing authentication back to Codex.

- Dispatch equal-priority queue entries beyond the first eight without waiting for the first batch of turns to finish. Bound startup checks and existing live-turn capacity, retain overflow in its original priority, and wake on slot release without a new polling loop.
- Cancel unconfirmed queued startup when its operation lease is lost, integration is disabled, the home changes, or the host disposes. Keep uncertain claims visible for review and preserve accepted work.
- Show confirmed session-action/list-refresh warnings as one dismissible toast, without adding a session or transcript block. Keep automatic acknowledgements quiet.

### 1.4.3-pre.2

- Automatically bind Codex OAuth sign-ins and reauthorizations, including an empty vault and retry after temporary storage failure. Treat the latest valid Codex login as authoritative, restoring its saved entry if missing; preserve partial-file credentials, recheck the auth snapshot before importing, and never rewrite Codex authentication during import. Match legacy workspace identity consistently.

- Restore informational action feedback, including token refresh and saved settings, as three-second toasts. Keep warnings/errors visible for ten seconds, preserve cancellation and partial-failure messages, and keep background reads quiet. Show session/workspace feedback above the UI without inserting conversation blocks.
- Add session-only Hide from boards and a searchable Hidden sessions dialog with Restore. Persist visibility in SQLite with revision checks and safe retries, preserve session work/grouping/state, and exclude hidden sessions and their comments from shared boards.

- Recover Usage details from valid provider rows with incomplete optional client counts. Share guarded credential renewal and a single rejected-token retry across views; preserve saved data and show actionable failures with explicit retry.
- Log only verified VS Code token counts from new responses. Retain saved history after account removal or disabling, stop new quota snapshots, query retained daily rows by date, and color the token graph by account.
- Honor all-account refresh intervals independently of pre-switch safety checks. Compact the task header with System/Project counts and responsive view tabs; add main/subagent details and Overview environment metadata. Unify confirmation and selection dialog spacing and replace native task confirmations. Place the collapsed-sidebar logo inside content headers, preserve sidebar visibility, and put status/column choices in the board menu with Idea hidden by default.

- Restore account tags in the account actions menu with a compact editor, validation, durable acknowledgements, conflict protection, and preserved drafts after failure or timeout. Show tags beside subscription days without wrapping, summarize overflow, and add a persistent tag filter and tag-aware search in both account views. Keep edits scoped to the selected system.
- Restore the privacy icon to the header. More → Tags opens a searchable tag manager with account counts, filtering, rename/merge, removal of labels, and guarded enable/disable actions. Confirm group changes, preserve other labels/accounts, enforce credential and ownership checks, and report partial or unconfirmed outcomes without replay.

### 1.4.3-pre.1

- Subscribe to the browser's selected system on demand. Load its sessions once, then share file-change events without recurring session scans. Signed target subscriptions do not wake unrelated PCs or propagate peer demand; switching, closing, hiding, disconnecting, or expiring viewers releases monitoring. Keep lightweight authenticated presence for discovery and account ownership.

- Correct cross-PC relay discovery when aggregates include the receiving PC; validate the full aggregate before applying it and retain newer peer data across delayed replies. Route remote session catalogs, workspace reads, and actions to their PC; replace only that PC's session rows, push changed peer sessions immediately, and keep browser caches/catalogs scoped by system. Revalidate after the browser handshake and reconnect.
- Keep manually selected empty-quota accounts selected across reloads. A manual selection with available quota resumes automatic switching; uncertain quota waits for verification. Recheck the hold before automatic switching and reset-credit redemption.
- Show account identity and system in the sidebar footer, put the System selector first in Account Center, and keep browser session navigation in the browser. Omit the Running Sessions footer in browsers.
- Show transcript actions in a horizontal hover/focus overlay without an ellipsis or reserved height, and tighten paragraph spacing. Use single-line project session rows with time on the right; only verified running sessions animate project counts as running / total. Paused and blocked goals show Play; explicit blocked-goal resume keeps the native confirmation and failure guards.

- Add on-demand project Git history with 50-row pages anchored to a stable revision, author/date/hash metadata, and scoped commit diffs. Preserve loaded history after failed refreshes and disable live reads offline.
- Replace Tools' recurring status and search timers with bounded progress events, explicit search, and catch-up reads on reopening or reconnecting. Recover lost start acknowledgements by preview token without replaying cleanup; fence stale/foreign progress, retain cancellation, and cap peer progress buffering.

### Earlier 1.4.3 build
- Replace the Environment flyout with a fixed first Env tab and one header toggle for the right inspector. Add a compact Git tab for branch/status, changed files, commit, push review and comparison; keep terminal profiles in Terminal and tool selection in a floating menu.
- Keep Git closable, place the add button immediately after open tabs, and summarize every inspector tool in Env's aligned list, including agent status and unsaved file drafts. Compact session rows and goal/queue strips, including smaller unboxed pause controls, without shrinking phone session touch targets.
- Rebuild the project session hierarchy as a flat, dense tree: single-row system/project headings, one collapse control per project, inline counts, minimal indentation and status/time below each title. Remove duplicated project/system metadata, stacked selection cards and tree-divider clutter.
- Apply terminal-close acknowledgements immediately and exclude the disposed terminal while VS Code updates its native list. Keep inspector content inside its width and mobile viewport height.
- Keep optional notification-subscription prompts behind active sidebars and modal flows so they cannot cover account controls; retain action errors and warnings.
- Keep inspector responses and drafts scoped to their project and system. Reject replies from an earlier context or replaced read, retain commit/file drafts through failures, and advance file revisions only after an acknowledged save without dropping newer edits. Clear terminal drafts on accepted streaming starts.
- Parse bounded NUL-delimited Git status so renamed files and names with spaces/newlines remain accurate. Limit status and commits to the selected subproject, retaining staged work elsewhere in the repository.

### Compact task workspace and public parity

- Use compact, full-height task columns with two-line cards, subtask counts, floating actions and information, and functional Board, List, Gantt, and Calendar views. Read dates and durations from observed session runs in the existing manager.sqlite database; show unavailable historical duration explicitly.
- Move cards between columns to change board classification only. Moving never starts, pauses, resumes, or stops Codex; execution controls stay explicit. Archive and restore custom tasks independently, preserving session children and their running work. Custom tasks remain top-level containers; their New subtask action creates a session with its initial prompt as the description.
- Render public project links with the main TaskBoard and task-detail code, conditionally restricting operations to the link's permissions. Reuse the session header and grouped transcript for public session links, hide both sidebars and private controls, and include tool calls, arguments, output, edits and images on newly created full-activity links. Existing message-only links keep their original grant. Local full-activity links bind their original source home instead of uploading and repeatedly persisting large transcript snapshots.
- Remove the saved-history availability block from the conversation; retain actual history loading and action errors.
- Move session and project sharing into their icon-only three-dot action menus. Keep sharing unavailable during conflicting work or offline project access, and omit private sharing from public views.
- Redesign both share dialogs with content/access/expiry summaries, shared link-copy controls, editable permission check-all, and in-place revoke confirmation. Keep pending actions visible, preserve focus and choices, and report clipboard, offline, timeout, authentication and incomplete-response failures in the initiating dialog.
- Keep task action feedback in a dismissible toast without inserting board or detail rows. Tighten two-line cards, omit empty subtask counts, reserve mobile logo clearance, and compact modal headers, task details, API tables and sharing controls.
- Unify dialog typography, surfaces and action rows; split token creation into identity/project scope and operation permissions. Keep sharing checkboxes next to their descriptions. Use the common dialog shell for session links and preserve pending-request close protection. Reorganize task details with aligned properties, contextual conversation access and a compact comment composer.

### Sessions, recovery, and workspace

- Keep account-warning choices in the browser dashboard, including warnings returned by another PC. Remove the warning's Later button, preserve the originating system for switching and reset confirmation, and dismiss mirrored native choices without opening a VS Code account picker.
- Record verified native sessions and goals in SQLite in the background while the dashboard is closed. Keep running counts stable during partial discovery, preserve newer activity under recording-queue pressure, and retain recovery across reloads, storage contention, and unconfirmed starts.
- Resume eligible recorded interruptions and unfinished active goals after native readiness is verified. Respect explicit Pause actions and exclude archived, child, completed, blocked, and budget-limited work. Treat model-capacity failures as interruptions and preserve provider errors until a later successful turn.
- Keep a user Stop durable across delayed recording and reloads so it cannot be mistaken for recoverable interruption work; an explicit resume or new message clears that suppression.
- Add per-session Auto Resume and queue controls to the Running Sessions flyout. Global Auto Resume supplies the default; each session can opt in or out independently. Deferred sessions wait for other active work, follow positive numeric priorities, and start equal priorities together in bounded groups. Durable claims prevent blind replay after an uncertain start or restart.
- Consume accepted queue requests once so later status updates cannot send another continuation. Recheck the saved turn after native startup and before recovery starts; completed work stays idle, while explicit new user messages remain available. Auto Resume restoration runs at startup or reload, independently of status recording.
- Keep priority controls in a viewport-bounded top-layer flyout, beside the session list where space permits. Standardize session action icons, provide priority presets and custom-number validation, preserve keyboard focus, and distinguish queue creation from priority editing.
- Reuse one scoped Codex app-server connection throughout archive cleanup, restore and goal cleanup instead of starting a process for every item. Retain per-session locks, running-state checks, selection/home restrictions, bounded concurrency and explicit failure reporting; close the process when the job finishes.
- Update externally changed session titles and retire temporary rename overrides after native confirmation. Reapply current preferences to cached lists across windows.
- Validate closed-project paths asynchronously for files, terminals, and Git operations. Preserve symlink containment, file revisions, ownership checks, cancellation, and timeout safeguards. Automatically create a terminal in the session project when the selected terminal has a different or unverifiable folder.

### Project tasks and sharing

- Add project Kanban with **Idea, Planned, Running, Completed**, enabled by default. Store custom tasks, discovered sessions, and comments in indexed Manager SQLite tables with revision checks and idempotent retries.
- Keep custom tasks on the top-level board and group session subtasks beneath them, or return a session to the board. Preserve session identity and history; grouped sessions appear once. Reject cycles, cross-project parents, missing tasks, and conflicting edits.
- Open task details in a right panel for combined Activities, conversation files, and recorded changes. Keep archived sessions in Completed with an additional Archive filter. Read tabs on demand, keep history pages bounded, preserve saved views when refreshes fail, and push committed task/comment updates to connected dashboards.
- Include uploaded text snapshots and conversation images in task Files alongside recorded edits. Preserve complete supported text uploads before display truncation, preview attachments without filesystem lookups, and keep saved attachment hydration through partial live updates. Reject stale preview responses and show unavailable files explicitly.
- Hydrate local conversation images sequentially within the page budget so concurrent buffers cannot multiply memory use. Count failed image decoding against the read budget to bound disk work as well as successful previews.
- Apply Files permission to public attachment/image previews, omit upload contents from public message text, and reject unlisted or unavailable attachments without falling back to project files. Keep saved views and open image viewers during live updates or partial history failures, and clean up viewers on task close/revocation. Version public assets so an older worker cannot serve a stale renderer.
- Create expiring public project links with selectable activity, conversation file, change, comment, and submission permissions. Visitors can submit ideas and comment when allowed. Revoke project links and enforce permissions on the server. A separate embedding permission enables iframe integration with the same access rules.
- Preserve public submission drafts and retry identities across reloads; use a new identity for edited retries. Prevent duplicate submissions and edits during pending writes, disable offline actions immediately, and keep revoked boards cleared after search or filtering.
- Update focused public boards and activity from scoped change events. Recheck permissions on every content read, close expired/revoked streams, coalesce bursts and overlapping refreshes, and release hidden/offline viewers. Bound connections and slow-client buffers without adding browser polling.

- Make nested task cards their own drop targets, reject cyclic grouping, and catch up once when task-board changes arrive during a pending read. Preserve sidebar drag identity and revision checks.
- Update legacy conversation shares through bounded event streams with expiry, revocation, slow-viewer limits and hidden/offline cleanup. Recovery screens recheck on focus, reconnect and return events instead of polling.

### API and offline behavior

- Prevent slow HTTP reads from replacing newer live snapshots. Bound and deduplicate HTTP fallback actions alongside WebSocket actions; report missing confirmations and network failures as uncertain outcomes without replaying writes.
- Add optional dashboard API access, off by default. Manage multiple named tokens in a compact table with a separate creation modal, scope them to selected projects or all projects, check all permissions and uncheck individual operations, revoke tokens, browse operations, and test requests in the browser dashboard. Store token hashes and filter every scoped request and result.
- Require the state permission for appended dashboard snapshots even when an API token covers all projects; an operation-only token receives its action result without unrelated dashboard state.
- Cache the data-free browser shell and bounded saved read views for offline reload. Reconcile task drafts and comments on reconnect with stable request IDs and visible conflict review. Preserve unsynced outbox entries when storage fills; never silently evict them.
- Disable live-only actions offline. Session execution, terminal commands, filesystem and Git mutations, account changes, tokens, and public links are never queued for later execution.
- Keep a working offline worker when an update cannot save its required shell assets. Let explicitly newer asset versions reach the network instead of serving an older controlling worker's bundle. Read only queued outbox entries during sync, and tolerate malformed or future-dated read-cache rows without deleting drafts.

### Dashboard and account automation

- Keep Settings tabs in one row. On narrow screens, show the active label and other tabs as icons. Compact task, account, API, notification, and Running Sessions surfaces, with bounded columns and ellipsized titles.
- Suppress the redundant post-action session-refresh notice and live-history display-limit banner. Remove confirmed missing conversations from the browser list/cache while retaining drafts and transient read failures.
- Stop hidden task-view polling, avoid unchanged board/detail cache writes and rerenders, load static detail tabs on demand, and cache unchanged native title indexes. Preserve fast live activity refresh and offline drafts.
- Move shared read results into an indexed, bounded `manager_cache` table in `manager.sqlite`: at most 128 entries / 16 MiB, 2 MiB per entry, and 60-second expiry. Query one payload at a time without retaining completed results in memory. Cache failures preserve source results and never authorize writes or alter durable work.
- Keep refresh events received during a task read and coalesce them into one follow-up read. Show useful partial live activity when saved history warns, and expose older conversation-file pages in task details.
- Pin the sidebar account footer, separate identity/system selection from compact navigation, keep the system switcher visible, and remove the redundant Live badge. Reuse rich workspace messages in public shares with permission checks for conversation files.
- Improve account Auto Queue ordering and credential checks. Add **Allow auto reset** per account: after all eligible accounts exhaust weekly quota, opted-in accounts can reset even with global Auto Reset off. Auto Switch, ownership, fresh quota, valid credits, and uncertain-outcome checks still apply; selection prefers the largest reserve, then earliest expiry.
- Open donation links in the requesting browser and use USD 11 as the suggested amount.
- Allow manual OAuth callback submission while the automatic listener waits, retain duplicate-submit protection after listener failures, and keep interruption-paused capacity goals in recovery snapshots.
- Prefix browser push titles with the originating system name and preserve session subjects in mobile notifications. Refresh task/session views from state, live, reconnect and focus events instead of independent browser polling; load System Log on demand and avoid refocusing dialogs during background renders.

## 1.4.1

- Track fresh completion events when native goals resume themselves during editor loading, without sending a duplicate prompt or claiming control of the native turn.
- Prevent backdrop pointer-down dismissal and modal click-through, including stacked dialogs and touch input. Keep pointer drags from dismissing a dialog accidentally, contain keyboard shortcuts, and preserve focus when dialogs reopen.
- Exclude routine dashboard, transcript, workspace, console and relay-health polling from System Log, remove duplicate request auditing and successful backup/render/refresh-sweep noise, and record recovery snapshots only when their session selection changes. Preserve meaningful actions and failures, and honor logging changes from other windows without overwriting them.
- Move session catalogues to individual SQLite rows, remove confirmed deleted-session cache entries, and preserve newer scans and pending recovery. Query shared-cache metadata, token points, account recovery candidates, and log byte limits directly in SQLite instead of deserializing bulk snapshots. Bound live-recording memory and reduce retained transcript caches.
- Automatically prune expired Manager caches and diagnostics, cap noisy logs at 10,000 records or 32 MiB, and reclaim unused Manager database space in bounded background maintenance. Preserve accounts, credentials, settings, unknown recovery data, and native Codex conversations and goals; defer busy storage safely.
- Run large diagnostic purges outside the extension host after startup, so old logs cannot hold up Codex loading. Apply retention and byte budgets directly to console/export queries before loading selected records.
- Stop browser-initiated native-owner turns through the verified owning window using the accepted turn ID, coalesce duplicate Stop requests, and report unconfirmed or changed-turn outcomes without blind retries.
- Enable Automatic token history by default while preserving explicit Off choices. Keep default account switching thresholds at 5% for the 5-hour quota and 0% for weekly/monthly quota.
- Add a compact Tools tab with dedicated Codex management dialogs: search and select archived conversations, restore or delete selected archives, clear conversations or goals, and remove inactive shell snapshots older than seven days. Preview the selected system, confirm deletion, preserve running work and unselected children, and report progress, cancellation, and partial failures.
- Add read-only tools to find missing project folders, rank large conversation files, and check native Codex databases. Keep existing dashboard features in their original locations.
- Use App Server for all composers and session lifecycle operations. Remove the Workspace connection choice and migrate retired CLI selections automatically.
- Resume opened native conversations through their verified owner connection. Use native goal continuation without a user prompt, or exactly `Continue if not completed` for eligible interrupted non-goal sessions. Keep uncertain requests for verification instead of blindly resending.
- Wait for late native session owners before continuing, avoiding competing writers during tab startup. Preserve active goals and verify committed goal state after a native writer conflict before continuing.
- Rediscover native readiness after a cached not-loaded snapshot, accept the resumed owner's fresh revision sequence, and keep opening tabs pinned during status-cache pressure. Reject turn dispatch while a known owner is still loading.
- Allow cold native tabs up to 40 seconds to become ready within bounded 45-second open and 60-second recovery budgets. Manual native actions cancel optional startup restoration while retaining queued work. Reload the full VS Code window when Codex is installed so native webviews reconnect cleanly.
- Limit automatic recovery to verified running sessions and their saved unfinished work. Keep paused goals paused with either goal-only setting; exclude idle goal history. Add compact Pause and Resume goal controls beside the goal in browser chats, with confirmed status changes and visible failures.
- Return confirmed goal Pause/Resume results immediately without waiting for unrelated session discovery or replacing their success message with a refresh warning.
- Make startup recovery optional background work after the dashboard loads. Persist bounded recovery IDs, titles, recorded projects, and timestamps in SQLite; prune stale runtime caches without losing pending work or token statistics.
- Resolve each session's recorded project automatically for workspace actions across closed projects, worktrees, and remote systems. Normalize native Windows paths and preserve explicit project and terminal ownership checks.
- Rename the existing connection control to WS Cross System and add a working toggle. Remove Keep connections online; prepare the detached relay only when a fresh host proof confirms the configured tunnel reaches this system.
- Repair browser notification registration quietly after login or key changes, rotating only this browser's subscription when needed.
- Wait for opened Codex conversations to finish loading before recovery continues, with a short pause between automatic opens and retained recovery when readiness cannot be confirmed. Honor native restore flags even while transcripts remain in archive folders.
- Use current local conversation titles for completion and recovery notifications; keep session IDs out of notification titles when metadata is unavailable.
- Replace diagnostic log settings with System Log and a dated console: level summaries, expandable details, filters, follow-bottom scrolling, and Download and Clear actions inside the dialog. Turning logging off clears saved manager logs and prevents stale writers from restoring old entries.
- Keep browser downloads in the requesting browser and open running-session View actions in its browser workspace.
- Open external links on the requesting browser's device, report blocked pop-ups locally, and keep native continuation completion notifications connected to the session title lookup.
- Keep older project conversations in the browser session list beyond the previous global 200-session cutoff. Read older native entries from local metadata while limiting detailed transcript reads.
- Cache project/session metadata in Manager SQLite across reloads, refresh stale activity in the background, and invalidate old scans after session changes. Bound retained cache entries and expire unused history snapshots automatically.
- Retry transient storage startup failures before giving up. Keep a compact recovery screen and command access available when storage still cannot open, with reload, copied diagnostic details, and guidance for unsupported runtimes; preserve all existing database files.
- Redesign More with compact groups, aligned icons, a single-line Mask control, keyboard navigation, and a scrollable mobile layout. Remove Show All Sessions from More and keep the dashboard link in the sessions flyout.
- Verify Lock and Unlock storage changes before reporting success. Keep background discovery and project failures quiet while explicit actions retain visible failures and retry guidance.

## 1.3.5

- Open the account dashboard at the home URL and chats under `/workspace/<session-id>`, preserving existing bookmarks and remote-session links.
- Switch systems from the dashboard icon in both the browser and VS Code. Show the system count and hide the icon when only one system is available.
- Show compact running-session rows with their title, system, project, elapsed time, and recorded model; keep goal and thinking details in the tooltip. Count only confirmed running parent sessions and retain interrupted conversations after reload with View or Resume actions for the owning VS Code editor.
- Add Codex, Resume, and Show All Sessions to More, alongside the privacy control. Open all sessions in the browser workspace.
- Keep password configuration in Settings and highlight its icon and Password block until a shared password is set.
- Redesign the sidebar account center with quota meters, system selection, account search, direct account choices, and Dashboard and Settings shortcuts. Keep switching confirmation, offline states, keyboard navigation, and browser sign-out accessible.
- Keep mobile account controls compact with a horizontal quota strip and dense account rows. Fit the panel to the visible viewport as the keyboard opens and preserve drawer focus and navigation in portrait and landscape.
- Continue stopped conversations in their recorded project even when its VS Code folder is closed or native project metadata is unavailable. Preserve the chosen App Server or CLI transport and composer settings, and report missing folders without silently changing projects.
- Keep session discovery on the local index so opening Codex Manager does not start a competing App Server or replay large histories while Codex is loading.
- Open App Server backed conversations from their recorded project folder and fail clearly when that folder is unavailable.
- Keep startup and background session or token-history failures out of toasts. Preserve inline errors, retry controls, diagnostics, and feedback for explicit actions.
- Remove usage-chart message overlays and badges; keep diagnostics and retries in Graph settings.
- Hide accounts without data from daily token tooltips and abbreviate large token totals as K, M, or B, keeping exact values available on hover.
- Default Automatic token history to off, place it last in Automation, and persist a collection interval from one minute to one day for successful and failed checks while respecting provider retry delays.

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
