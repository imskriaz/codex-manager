# 1.4.3 completion checklist

## Domain roles, startup recovery and task polish (`1.4.3-pre.4`)

- Reuse the workspace Agent panel inside task Agents. Keep main model first,
  compact roster/selection tabs, in-panel transcripts, refresh feedback,
  retained messages on failure and offline fallback. Fence late requests on
  panel replacement; shared boards cannot invoke native agent reads.

- Additional task audit: grouped-session matches were filtered out by root-only
  board rendering. Show matching sessions directly during search, preserve the
  same query in List, clear on Escape/context changes, and focus the initiating
  component’s input. Remove repeated PC names, normalize card controls, and
  reduce padding in every details tab. Wrap only when controls cannot fit.

- Task Activities now use one shared compact timeline for owner/public boards.
  Filter reasoning, compaction, empty events, and failed/declined/interrupted
  tool attempts; retain messages, successful/live actions, changes, session
  errors, and permitted latest-page comments. Preserve original transcript
  order and never invent displayed timestamps. System/Project controls are
  single-line tabs with hover counts and the same height as the view tabs.

- Latest user override restores quota recording after the earlier explicit stop
  request. Record changed quota samples in both hosts asynchronously, restore
  retention controls, move the token toggle/check gap into Usage log, and use
  a confirmed standard action to clear only the selected PC’s quota history.
  Keep verified token history and credentials untouched by quota clearing.

- The first full regression found a rare existing collision between random
  base64url tokens and legacy-token detection (2,282 tests passed, one failed).
  Keep strict legacy rotation and resample generated tokens that match that
  format, so new credentials cannot force another migration/restart. Add a
  deterministic random-source fixture for the collision.

- Live proof confirms that the configured domain reaches this PC. The other PC
  was reported updated from 1.4.2 to pre.3; it is still absent from the local peer
  snapshot. Found a real local blocker: peer signing/relay keys were disabled by
  account Auto Sync even with the dashboard and WS Cross System enabled.
- Separate peer authentication from optional encrypted account synchronization,
  preserving password verification, tamper checks and vault/claim boundaries.
  Reconcile the latest domain after pending host checks, including old-domain
  failures. Only the proven domain host prepares the detached relay.
- Native recovery logs show file-read timeouts before startup verification
  finished. Retry those read-only checks at most three times within the existing
  deadline, preserve recovery on failure, and cancel when the home changes.
  Do not retry editor dispatch or turns in response to unconfirmed results.
- Blend System/Project controls with view tabs, move the board menu last, and
  balance task header padding. Keep compact small-screen controls and shared UI.
- Retain a bounded account label in existing daily-usage SQLite headers, preserve
  it across legacy writes, capture it before credential removal, and mask it in
  history. Do not retain tokens or re-enable removed accounts. Previously
  anonymous history cannot recover an unknown name from its hashed identity.
- Verification: all 2,284 tests across 191 files pass in one isolated full run
  (287.95 seconds), after fixing the legacy-token collision found by the first
  run. Focused task/public checks (88), history/action checks (188), recovery
  checks (81), and relay checks (26) pass. Both TypeScript targets compile;
  lint reports zero errors and 3,194 warnings.
- Browser checks pass at six viewport sizes for all task views/tabs and search,
  quota-history controls/confirmation/failure, usage/account masking, and sharing.
  Final task checks include agent switching, failed refresh, offline/reconnect,
  late agent results and no unnecessary roster history reads. Shared workspace
  agent selection passes at desktop/mobile without adding another workspace tab.
  Dark phone task checks and owner/public rich history checks also pass.
  Read-only live desktop/mobile checks pass (phone load 2,103 ms, reconnect OK).
- VSIX: `codex-manager-1.4.3-pre.4.vsix`, 4,041,371 bytes.
  SHA-256: `582f6ee47492f590710f6924fb38c5a9b921df51cc970d7bd9a31ab71580da88`.
  Archive manifest/runtime/UI/CSS match the workspace; source, tests and output
  logs are excluded. Dependency layout verification passes. VSCE retains its
  existing extension-bundling warning (1,397 archive files).
- Packaging is verified. Physical two-PC/reload
  verification stays open; the live extension is older than this build. No new
  build has been installed or published by the agent. Preserve the broader goal,
  including native archive/delete queue cleanup and follow-up verification of
  live main-session metadata while task details remain open.

## Queue, refresh-notice and auth clarification (`1.4.3-pre.3`)

- The latest valid Codex login remains authoritative, including after removal of
  its Manager entry. Clarify this in the README and extend repository regression
  coverage through import races, the next successful import, removal/recreation
  and partial auth-file writes. Import never writes older credentials to Codex.

- The completion audit found that equal-priority dispatch truncated its selected
  group to eight entries. The runner now dispatches the priority group using
  eight concurrent startup checks and available capacity under the existing
  30-turn limit. Unclaimed overflow stays queued. Capacity is part of the change
  signature and slot release wakes the runner without a new polling loop.
- Combine cancellation from registration disposal, queue lease and configuration.
  Recheck home/configuration/capacity before claims; retain uncertain claims with
  an explicit warning instead of replaying them. Accepted native work retains its
  existing separation from startup cancellation.
- The reported confirmed-action/list-refresh warning was dropped by both notice
  paths. Manual results now use the shared toast controller; automatic mutation
  acknowledgements stay quiet. No notice block is added to the session list or
  transcript. Browser fixtures check a single dismissible warning, its lifetime,
  no inline duplicate and no automatic toast.
- Preserve the full release goal. This follow-up does not prove physical two-PC
  behavior, cold native recovery or publication. Native archive/delete queue
  preference cleanup needs a separate targeted audit; an absent session with an
  uncertain durable claim must never be silently treated as safe to replay.
- Verification: all 2,269 tests across 190 files pass in one isolated full run
  (250.98 seconds); 301 focused checks across 12 files also pass. Both TypeScript
  targets compile. Lint has zero errors and 3,180 warnings.
- Six-size queue UI checks pass, including the toast-only partial-success warning,
  lifetime, dismissal and quiet automatic acknowledgements. Rich public board,
  retry/offline/storage/revocation checks pass at desktop and phone widths.
- Read-only real-host checks load 341 sessions, exclude 230 children from the
  parent list, render 22 messages and reconnect at 1440/390px without runtime
  errors (initial loads 1,225/584 ms). No real turns or account mutations were sent.
- Review VSIX builds with bundled runtime dependencies; manifest/runtime assets
  match the current build and source/test/output folders are excluded. Artifact
  `codex-manager-1.4.3-pre.3.vsix`: 4,035,154 bytes; SHA-256
  `6ee2ec7f1eaa6e1b747920208aa4639ddc7251035c1e3a22b9d3052e3ae6549b`.
  Not installed or published. Physical cross-PC validation remains open: the
  missing PC was reported on 1.4.2 and the user is updating it to pre.2.

## Current usage and workspace follow-up (`1.4.3-pre.2`)

- Bind Codex OAuth logins from auth-file events and existing reconciliation.
  Empty-vault sign-ins and failed startup imports retry; changed credentials
  update their matching account. The latest valid Codex login is authoritative,
  including when its saved Manager entry was removed. Preserve incomplete token
  writes, revalidate import snapshots under the existing credential lock, skip
  optional profile work during auth import, and never rewrite the observed login.
  Respect automation ownership before quota reads; no new polling loop/cache.

- Restore short informational feedback across dashboard, session and workspace
  actions. Token renewal and setting writes acknowledge confirmed completion;
  warnings/failures/cancellations retain their actual outcome. Info dismisses in
  three seconds, other levels in ten, without adding conversation blocks.
- Add session-only Hide from boards and searchable Hidden sessions → Restore.
  Save visibility in existing SQLite task rows with revision/idempotency guards.
  Preserve native activity, archive state, parent and classification. Keep hidden
  rows out of every task view, public board/comments and direct public reads.
  Offline/conflicted/unconfirmed writes preserve the last confirmed state.

- Reproduced an unreadable-history failure before and after a successful guarded
  token refresh. HTTP 200 rows had verified daily totals but optional credit-only
  clients omitted token counts; reject invalid numbers without rejecting safe totals.
- Both account details and dashboard usage use one scoped loader, guarded token
  renewal where enabled, one HTTP 401 recovery, cancellation, bounded waits and
  persisted cooldowns. Preserve saved history, show the actual safe failure and
  allow explicit retry. Never switch accounts or consume reset credits for usage.
- Persist only verified VS Code token counts from new responses. Keep daily rows
  across account disabling/removal and retention-setting changes, querying selected
  date windows from SQLite. Stop recording new quota snapshots; retain existing
  legacy records. Count removed-account history and use account colors/legend.
- Replace the task header with System and Project dropdowns plus counts and view
  tabs on one track; compact icon search and active-label-only views on narrow
  screens, stacking the context and tools only when needed. Add task Agents with
  the main model first and Overview environment metadata under existing access
  boundaries. Use shared dialogs for task retry/discard confirmations.
- Put the collapsed-sidebar logo in each content header's layout, retain the
  user's sidebar visibility when opening tasks, remove the separate status-filter
  icon, and move status/column choices to the board menu. Hide Idea by default,
  retain its tasks, and persist valid nonempty column selections with storage-error
  feedback. Public submissions remain Idea tasks under existing permissions.
- Honor the configured all-account refresh cadence independently of pre-switch
  safety refresh. Keep overlap, disabled-setting, ownership and manual-action guards.
- Apply consistent compact dialog headers, controls, actions, focus, danger styling
  and selection spacing. Preserve keyboard focus, Escape/backdrop handling and
  explicit outcomes. Current verification is recorded below.

### Current review verification (`1.4.3-pre.2`, 2026-10-22)

- All 2,256 tests across 190 files pass in one isolated full run (262.48 seconds).
  Focused checks cover native auth import/update/retry/races, legacy identity,
  token renewal outcomes, toast lifetimes, hidden-session persistence/retry,
  shared-board read restrictions, tags, usage recovery and refresh scheduling.
- Six-size responsive checks pass for board/context controls, hide/restore,
  native drag-and-drop, session actions, inspector tabs, share controls, account
  tools, dialogs and settings. Tags and VS Code-only/account-colored charts pass
  all six sizes. Token refresh success, three-second info dismissal and longer
  error retention also pass at six sizes.
- Read-only desktop/mobile host checks load 341 session records, exclude 230
  child rows from the parent list, render two messages in the selected chat and
  reconnect. Initial loads take 1,292 ms and 638 ms. These checks send no turns
  or account mutations. Notification permission/retry/failure checks and cold
  offline dashboard/task reload, reconnect and worker-upgrade checks pass.
- With the user's authorization, one real failing Usage details account was
  retried, its token refreshed once, and the request retried. Renewal succeeded
  but did not fix the parser failure. The corrected loader accepted 21 provider
  days; merging retained rows left 29 saved daily points. New rows contain only
  verified VS Code counts; existing legacy rows were retained. No account switch
  or reset credit was used.
- Both TypeScript targets compile. Lint reports zero errors and 3,179 warnings.
  Review VSIX `1.4.3-pre.2` builds successfully, bundles all runtime dependencies,
  and contains no source/test/output folders. SHA-256:
  `de743f90b274ab27bad8bad126667c17537273a03898172f113eba4f428b3d31`.
  Final desktop/mobile host smoke and six-size token-feedback checks pass.
- Installation/publication and physical two-PC/live-sign-in verification remain
  separate gates. This review build does not close the broader release checklist.
  Work remains on main with the seven existing stashes preserved.

## Tag restoration review (`1.4.3-pre.2`)

- Account menu → Tags opens the compact editor in both account views. Tags sit
  after subscription days on one line; the first label and an overflow count
  retain access to all labels through the tooltip/editor.
- Restore existing saved tags, tag-aware search, and a persistent toolbar filter.
  Save to the selected system using the existing account index/manager.sqlite;
  do not add a separate cache, background query timer, or credential export field.
- Restore the header masking icon and replace its former More entry with Tags.
  Add a searchable manager with tag/account counts, filter, rename/merge, label
  removal, and group enable/disable. Freeze system scope, confirm reviewed
  membership, preserve credentials/ownership checks, retain partial outcomes,
  and bound native/group timeouts without automatically replaying mutations.
- Validate 10 unique labels of 24 characters, preserve drafts on failure/timeout,
  confirm durable writes, reject concurrent replacements, and accept identical
  retries without duplicate changes. Keep late acknowledgements system-scoped
  and protect confirmed tags from older snapshots. Offline saves stay disabled.
- Current regression and responsive results are recorded below. Physical-PC,
  live sign-in, installation and publication checks remain separate release gates.

Recovery follow-up: accepted queue requests are now consumed once rather than
retained for replay on subsequent status events. Non-goal recovery checks the
transcript again after native startup and before sending a continuation, and
reports idle when completion wins the race. Explicit user messages remain
available after completion. Startup/reload restoration and background state
recording remain separate. The reported message on the other PC has not been
matched to a specific log event; it is not attributed to either recovery or a
live test without that evidence.

Verification: 270 focused service/UI-layout tests and 134 caller/recovery checks
pass, including a regression distinguishing provider acceptance from completion
before send. All 2,162 tests across 182 files pass. Both TypeScript targets build;
lint reports zero errors and 2,997 warnings. Six responsive queue checks pass,
including reduced visual-viewport bounds, top-layer placement, keyboard focus,
priority validation, queue-full and disconnect/reconnect handling. These checks
use intercepted browser actions and temporary session stores, without sending
messages to either real PC. The preceding full run exposed an outdated caller
mock; it was corrected to signal provider acceptance, and a separate no-send
assertion was added before the passing final regression run.

This checklist preserves the full active release goal and later user requests.
An unchecked item needs implementation, review, or current verification; it is
not a claim that the feature is absent. Do not mark the overall goal complete
while required checks remain open. Published artifacts record their verified
scope; publication does not close outstanding hardware or runtime checks.

## Repository inventory (2026-10-20)

### Follow-up evidence (2026-10-21)

- Event/history follow-up adds on-demand Git history in the existing Git tab:
  50-row pages retain a fixed revision while new commits arrive. Commit diffs
  stay scoped to the selected project; malformed refs and unavailable commits
  fail explicitly. History survives failed refreshes and live reads are disabled
  offline. The preview retains one history page and one bounded commit diff.
  Broader GitHub integration remains pending.
- Maintenance progress no longer polls every two seconds, and search no longer
  uses a debounce timer. Bounded lifecycle/progress events carry job revisions
  through the authenticated peer channel. The UI rejects foreign, stale and
  malformed updates, preserves cancellation/terminal results, checks status on
  reopen/reconnect, and can recover a lost start reply by preview token without
  resending cleanup. Old hosts retain explicit Refresh status. Slow sockets are
  disconnected instead of accumulating unbounded progress buffers.
  The first browser run found duplicate preview IDs in its fixture; fixture
  previews/jobs now use unique IDs, matching the native service.
- Current review build is `1.4.3-pre.1`; installation and publication remain
  pending. No real cleanup, session turn, account switch or Git mutation is
  used by this follow-up's browser checks. Temporary repositories cover real
  history paging and commit diffs. Physical two-PC progress, accepted-write host
  restart and the other existing release gates remain unverified.

- Workspace inspector follow-up replaces the Environment flyout with a fixed
  first Env tab and one header visibility toggle. Git is closable; the plus
  follows the open tabs. Env uses a compact tool list with Git, recorded edits,
  unsaved drafts, observed terminals, agent counts/status and direct agent access.
  Session rows retain two compact lines, and goal/queue controls use slim rows
  with small unboxed pause/resume controls. Phone session targets remain larger.
  Native terminal profiles and close controls stay in Terminal. Closed terminal
  acknowledgements update the dashboard immediately. Inspector content is bounded
  to its panel track and the remaining mobile viewport height.
  The project session list is rebuilt as a dense flat hierarchy with single-row
  system/project headings, one project collapse control, inline counts and minimal
  indentation. Grouped session metadata shows status/time instead of repeating
  the system/project context; selection no longer stacks card outlines.
  Secondary row actions use small borderless controls beside metadata. Optional
  subscription offers yield to active sidebar/modal flows and remain available
  after those flows close; action warnings and errors are not suppressed.
- Inspector reads are fenced by project/system, context generation and replacement
  request. Commit and file drafts survive tab closure, project navigation and
  failures; late save acknowledgements preserve newer edits and advance their
  base revision. Existing commit/push/compare actions are exposed through Git;
  NUL-delimited status preserves renamed and unusual filenames. Status and commits
  are scoped to the selected subproject, preserving staged work elsewhere.
  New UI checks intercept all mutations; they do not send messages, run real
  terminal commands, switch accounts, or commit user projects on either PC.
- Inspector verification: 196 focused checks, 49 updated layout checks and 48
  encrypted-sync recovery checks pass. The final full suite passes all 2,167
  tests across 183 files. Both TypeScript targets and the production bundle build;
  lint reports zero errors and 3,031 style warnings. Six inspector sizes pass,
  including Git close/reopen, project-scoped drafts and stale replies, concurrent
  save edits, revision conflicts, untracked-directory navigation, terminal close,
  keyboard flyouts, inspector Escape/focus restoration and offline/reconnect.
  Closed Settings markup retains a layout box, so Escape/Tab guards now check
  computed visibility as well as layout. Hidden dialogs no longer block the
  inspector or mobile sidebar keyboard controls.
  Six broader workspace/settings/board
  sizes and public desktop/mobile checks pass; seven notification scenarios also
  verify that an active modal hides the optional offer and closing it restores it.
  Desktop/mobile light and dark inspector/sidebar screenshots were reviewed.
  An earlier full run used an outdated metadata-markup assertion; it was updated
  for grouped status/time. A concurrent verification run timed out in an unchanged
  encrypted-sync fixture and cascaded into the next case. The isolated 48 checks
  and final full run pass without changing their assertions or timeouts.
- Final read-only live checks using workspace assets load 341 real sessions,
  identify 230 child sessions, open saved conversation content and reconnect at
  desktop/mobile sizes without runtime errors. Initial host connection measured
  716 ms / 603 ms. No chat creation or messages were requested. The packaged-asset
  phone workspace and desktop/mobile public checks also pass.
- The inspector VSIX builds and passes dependency-layout verification. The local
  `output/1.4.3/codex-manager-1.4.3.vsix` is 4,011,550 bytes, SHA-256
  `b9a774f6c3665b58b5d7b0d3e098f711e62e9366999037f520f4626b3070c76b`.
  Its manifest and root lock remain 1.4.3, and it excludes the terminal prototype,
  unused xterm dependencies and local output artifacts. This follow-up is not
  installed or published as a completed release; the live gates below remain open.
- PandaCode reference review requested: inspected its board renderer/styles,
  conversation/board screenshots, design, GitHub/worktree, saved changes, terminal,
  attachments and team documentation. Candidate improvements include shared
  workspace surfaces, on-demand task panels, compact activity/approval rows,
  keyboard project selection, GitHub-linked tasks, bounded incremental caches and
  real terminal lifecycle handling. Selective source reuse is authorized with
  README credit, retaining its license and any required fork/About attribution.
  This checkpoint uses it as a design reference; no PandaCode source is imported.
  The feature inventory does not add every external feature to scope. Existing browser,
  cross-PC, public-sharing, hierarchy and metadata-only drag requirements remain.
- Latest queue/archive follow-up: 97 focused tests and all 2,145 tests across
  181 files pass. Both TypeScript targets compile. Six queue viewport checks pass,
  covering top-layer hit testing, no layout shift, matching 16px action icons,
  keyboard navigation, invalid/custom priorities, save/remove, queue-full errors
  and disconnect/reconnect. Desktop/mobile dark screenshots were reviewed.
  The complete six-size workspace/settings/board UI harness also passes after
  these changes. Final lint reports zero errors and 2,989 style warnings.
  Archive cleanup now shares one lazily opened native process per job, bounded
  to the selected session IDs and original home, and closes it on completion or
  failure. Running-session checks and per-session leases remain mandatory.
  Real archive deletion throughput has not been benchmarked against user data.
  The VSIX was rebuilt from locked dependencies and passes dependency-layout
  verification. Version stays 1.4.3 in both manifests; the 4,004,179-byte local
  checkpoint excludes the unused terminal prototype/dependencies. The final
  recovery follow-up rebuild is 4,004,660 bytes (SHA-256
  `aa6564b85ce82a5275624596fc11f864faf40adb3564b6091b626528bd79be1c`).
  This checkpoint is not a completed or newly published release.
- Account-warning/share follow-up is verified: all six account-warning browser
  checks and six share-dialog checks pass, including stale callbacks, origin-PC
  affinity, reset cancellation, password confirmation, malformed responses,
  timeout, offline/reconnect, permissions and revocation. Rich public session
  and project views pass at desktop/mobile sizes. These are intercepted browser
  actions; no real account was switched or real archive deleted during checks.
- The unfinished terminal-renderer prototype is preserved locally under ignored
  `output/1.4.3/terminal-prototype`; it is not wired into this build. Its unused
  dependency additions were removed. Fixed Env and core Git tabs are implemented
  in the inspector follow-up above. Full native terminal rendering parity and
  broader Git/GitHub tools remain open; this checkpoint does not claim them.
- Active goal revised: prioritize Auto Resume/queue scheduling, task/public sharing,
  cache/offline/reconnect/storage reliability, cross-PC WebSockets, compact UI and
  1.4.3 documentation. Dashboard layout remains excluded except the explicitly
  requested account-warning fix: remove Later and keep account selection in the
  browser. Account prompts now carry structured choices and origin system IDs;
  peer actions collect prompts instead of opening native account UI. Browser
  choices dismiss the mirrored native callback and retain browser password/reset
  confirmation flows. Current verification is recorded above.
- Confirmed UI/UX scope: the main account dashboard stays unchanged. The audit
  includes session headers/transcripts/composers and action flows; both sidebars;
  every right-sidebar tab and flyout; all Board/List/Gantt/Calendar views and task
  panels; all workspace/board forms, dialogs and menus; session/project share
  dialogs and public screens; Settings, API, About and System Tools. Review
  keyboard/focus behavior, context/draft preservation, narrow/dark layouts,
  feedback, pending actions, cancellation and failure recovery as well as styling.
- Share-dialog redesign includes common link/copy controls, explicit
  content/access/expiry summaries, editable permission check-all, inline revoke
  review, pending-close protection, initiating-dialog outcomes, and incomplete
  response/clipboard/offline/timeout handling. Earlier test counts below predate
  this redesign; current focused and full verification is recorded above.
- Share-menu follow-up removes standalone Share buttons from session and board
  headers. Their icon-only three-dot triggers open labeled sharing actions, with
  busy/offline guards and public permission restrictions preserved. Six responsive
  share-menu checks and desktop/mobile public checks pass; 70 focused tests pass.
  Both TypeScript targets compile. All 2,140 tests across 181 files pass; lint
  reports zero errors and 2,976 warnings. The VSIX build and dependency-layout
  check pass. This package is a local review artifact; the remaining workspace
  redesign has not been installed or published as a completed release.
- Remaining workspace redesign work includes terminal renderer integration/native
  API limits, broader Git/GitHub tools. Maintenance event and inline-panel checks are
  recorded in the current follow-up above. The inspector follow-up implements fixed Env, core Git,
  right-sidebar visibility and aligned tool selection. These additions and the
  broader pending UI work are not represented by the previously published artifact;
  do not treat a share-menu or inspector check as release completion.
- Latest screenshot follow-up removes the inline offline confirmation in favor
  of a dismissible toast, hides empty subtask counts, reduces card gaps/heights,
  and compacts shared modal, task, API and sharing spacing. Mobile title clearance
  now has an explicit logo-bounds assertion. Verification is being refreshed.
- Dialog follow-up unifies Settings, account, API, sharing, About and task-detail
  surfaces; splits API token identity/scope from permissions; fixes stretched
  sharing checkboxes; and reuses the dialog shell for session sharing with pending
  close protection. Task details now use aligned context/parent controls and a
  compact comment composer. Layout, keyboard and outcome verification is pending.
- Current workspace follow-up: 197 focused tests and all 2,140 tests across
  181 files pass. Both TypeScript targets compile; lint reports zero errors
  and 2,955 existing style warnings. All six responsive sizes and public
  desktop/mobile checks pass, including actual drag/drop, custom archive/restore,
  shared-screen permission gates, rich activity and retry/reload lifecycle cases.
  Read-only live/offline reload/reconnect and worker-update checks also pass.
  Physical two-PC switching and cold reboot recovery remain unverified.
- Browser transport/share follow-up is verified by those checks: HTTP fallback now shares
  duplicate/capacity guards, newer live snapshots fence older reads, missing
  confirmations report uncertain outcomes, and local results arrive after caller
  registration. Legacy shares use scoped invalidations and recovery screens
  recheck on events. Server expiry/auth, stale/partial reads, bounded queues,
  offline drafts and cleanup remain required. Active maintenance progress and
  presence/configured quota schedules are separate remaining loop audit items.
- Commit `64af1fe` was pushed and installed. Its stable 1.4.3 release/tag and
  3,985,973-byte VSIX were verified; SHA-256
  `53f06196174a5d6ed4ace68b4d0e72ac43940cda95a69285a49299c69a6f9688`.
  That delivered artifact predates the current browser follow-up.


- Attachment follow-up: 80 focused checks and all 2,109 tests across 178 files
  pass. Both TypeScript targets pass; lint has zero errors and 2,871 style
  warnings. Complete supported text-upload snapshots survive display truncation
  and live updates; new length-delimited upload records preserve literal nested
  markers while older records remain readable. Lightweight Files entries preview
  uploads without filesystem reads. Missing/unsupported images retain metadata
  and report unavailable. Final VSIX packaging and dependency checks pass.
- Local image reads are sequential and failed decoding consumes the page budget.
  Regression coverage checks peak concurrency and bounded invalid-image reads.
  The transcript cache's existing 8 MiB budget includes the new attachment fields;
  live snapshots and browser cache limits remain in effect.
- All six responsive sizes pass attachment/image previews and stale file-read
  rejection. Public desktop/mobile checks cover Files permissions, visible
  read-only preview failures/retries, open-image retention across live updates,
  partial history failure, preview replacement/cleanup, and archived subtasks in Completed. Real installed
  offline reload/reconnect and workspace-worker update checks pass. Read-only
  live browser checks load 341 sessions and reconnect, measured at 1,188/1,210 ms.
- API/offline follow-up: 2,099 tests across 177 files pass. Real HTTP routing
  checks cover operation-only state exclusion, multiple project scopes, session
  ownership, remote targets, cross-origin requests, invalid/revoked/disabled
  tokens, and ungranted global settings. Both TypeScript targets pass; lint has
  zero errors and 2,857 existing style warnings.
  The 1.4.3 VSIX and dependency-layout checks pass. UI verification scripts are
  excluded from the production package; three required runtime tools remain.
- All six responsive sizes, public desktop/mobile, and seven notification
  scenarios pass. The activity refresh fixture now holds the intended view,
  avoiding a late cached Files response consuming the Activities hold.
- A disposable real-browser context cold-loads the installed dashboard and task
  board offline, reconnects over WebSocket, sends no mutations, and verifies
  that Cache Storage excludes private API responses. A real HTTP/browser
  fixture using the current workspace worker verifies newer-version asset
  requests, a failed required asset, retention of the old controller/cache, and
  cold offline fallback after that failed update. Browser storage-full and
  malformed-cache paths remain covered by focused regressions.
- The delivered baseline is commit `04812a6` on `main`; that follow-up
  fixes manual Stop recovery, cached per-session overrides, floating queue
  controls, distinct Auto Resume states, and public task permission/lifecycle
  gaps. Their verification is recorded below; the broader live gates remain open.
- The latest sharing audit protects pending idea/comment edits, prevents duplicate
  sends, preserves retry identities across reloads, and uses a new identity for
  edited retries. Offline controls disable immediately, revoked boards cannot
  reappear through search, and legacy message-only links exclude tool fields.
- Desktop/mobile sharing checks cover failed/retried submissions, reload,
  duplicate submit, background refresh during a pending write, storage-full
  drafts, offline controls, and revocation. Focused task/share/API tests: 25 pass.
- Final follow-up regression: 174 files / 2,067 tests pass; both TypeScript
  targets pass, and lint reports zero errors with 2,837 existing style warnings.
  Packaging and VSIX dependency validation pass. Read-only live browser checks
  load 341 sessions, reconnect successfully, and connect in 978 ms / 588 ms.
- Public views now use a scoped event channel while visible, with focus,
  reconnect and explicit Refresh fallbacks. Streams expose invalidations only;
  all content still passes permission checks. Connections and buffers are
  bounded; expiry, revocation, disconnect and shutdown release subscriptions.
- Focused stream, sharing, board and viewer checks pass, including real HTTP
  streaming, cross-connection SQLite edits/revocation, 30-day timer bounds,
  duplicate/slow viewers and revocation during an in-flight browser read.
  Task details merge the recorded live turn using the conversation viewer's
  existing reconciliation; older pages and source-home isolation are preserved.
- Final event-stream build: 175 files / 2,080 tests pass. Both TypeScript
  targets and VSIX layout checks pass; lint has zero errors and 2,854 style
  warnings. All six responsive sizes and public desktop/mobile checks pass.
  Read-only live reconnect passes with 341 sessions and one connected system.
- Workspace Files now exposes older conversation-file pages. Task refreshes
  coalesce events received during an active read, and partial live results stay
  visible when saved history warns. All six responsive sizes verify these paths.
- Cache follow-up: 55 focused checks and all 2,090 tests across 176 files pass.
  Both TypeScript targets pass; lint has zero errors and 2,857 style warnings.
  All six responsive sizes and public desktop/mobile checks pass. Read-only
  live checks load 341 sessions and reconnect at both sizes; connection measured
  1,657 ms / 1,621 ms while regression and responsive checks also ran.
  The stable 1.4.3 VSIX and its dependency-layout verification also pass.
- Focused recovery/queue/task verification: 223 tests across 10 suites pass.
  Follow-up logging/Stop verification: 53 tests across 2 suites pass.
- Both TypeScript targets and production compilation pass. Lint has zero
  errors (the repository still has style warnings).
- Full regression: 174 test files and 2,066 tests pass. The previous failure
  used a fixed log timestamp outside the current retention window; its fixture
  now freezes one instant from the current test run instead.
- Responsive checks pass at 1440x1000, 1024x768, 768x1024, 390x844, 320x667,
  and 844x390, including queue panel bounds and distinct Auto Resume shapes.
  Public task checks pass at 1440px and 390px, including permissions and revocation.
- A real browser session reached completion without runtime errors. The local
  state endpoint currently reports one connected system, so physical two-PC
  discovery, switching, and phone delivery are still unverified.
- Final read-only live checks pass with 341 real sessions and browser reconnect
  at desktop/mobile sizes; host connection measured 821 ms / 575 ms. The final
  VSIX builds successfully and its dependency layout check passes.
- Real cold reboot/capacity recovery, live account reset, live cross-project API
  denial, share embedding/expiry, and browser storage exhaustion still need
  runtime evidence. Passing fixtures do not close those hardware/live gates.
- Seven stashes remain preserved. Source behavior and preserved untracked files
  have been compared with current implementations and regression coverage.
  Incorporated and intentionally superseded work is recorded below; no stash
  was blindly applied or deleted.

- One worktree: the current checkout on `main`.
- No local branches unmerged into `main` at inventory time.
- The baseline VSIX was installed, committed and pushed on `main`, and its
  GitHub Release artifact/tag were verified. Follow-up delivery is recorded with
  its verification results; it does not close the broader runtime checks above.
- Seven preserved stashes have been semantically reviewed. Keep them intact;
  old version/lockfile changes must not overwrite the requested release.

| Stash | Preserved work | Audit status |
| --- | --- | --- |
| 0 | Usage graph reads, caches, aggregation, storage, and chart UI | Incorporated; current verified-token units, bounded SQL queries and configurable refresh supersede older cache behavior |
| 1 | 1.2.6 preview, sharing/project bindings, isolation, import, sorting/header | Incorporated; project bindings now use short SQLite transactions; old preview/styles superseded |
| 2 | Same patch ID as stash 1, preserved after storage cleanup | Duplicate source patch reviewed with stash 1; retained |
| 3 | Overlapping 15-file patch preserved during announcement removal | Same substantive source patch as 1/2; reviewed and retained |
| 4 | SQLite migration, recording, storage, relay, diagnostics, sorting/header | Incorporated; current bounded recording, source validation and notification batching supersede older implementations |
| 5 | Earlier SQLite migration plus sharing/isolation/import work | Incorporated with 1/4; shutdown snapshot identical, isolation fixture uses current initializer |
| 6 | Auto Sync, native recovery, manual scheduling and cross-window coordination | Incorporated; cancellation, SQLite leases and stale-response guards supersede old file locks and unconditional disconnects |

The comparison followed behavior and callers, including replaced implementations,
rather than relying only on matching filenames or exported symbols:

- Usage: `dashboardUsageHistory`, `sqliteUsage`, `dailyTokenUsage` and graph UI
  retain indexed range/source reads, stale-response guards and bounded retention.
  Coverage: `usageQueries`, `dailyTokenUsage`, `dailyUsageResponse`,
  `dashboardUsageHistory`, and `usageGraph` suites. Stash 0's untracked service
  is superseded by verified units, abortable reads and cooldown-aware refresh.
- Sharing/isolation: conversation share bounds, fail-closed missing window slots,
  foreign-claim sorting and project-binding transactions remain in current code.
  Existing share, account sorting, header and window-account-mode suites cover
  them. Retired announcements and old preview versions/styles stay removed.
- Storage: migration validates sources, conflicts and bytes before cleanup;
  SQLite recording batches bounded newer states and preserves retries. Current
  storage migration, recording, SQLite context, persistence, logging, registry
  and relay tests retain these behaviors. Stash 5's shutdown fixture is identical;
  its isolation fixture differs only by the current retrying initializer.
- Scheduling: current `manualActionScheduling`, `crossWindowOperations`,
  `accountQuotaRefresh`, `codexSessionRunningState`, `codexNativeSessionStatus`,
  `encryptedSyncCurrentAccount` and `codexSessionAutoResume` suites cover shared
  demand, cancellation, bounded waits/queues, dead-owner recovery, local-first
  switching and retained recovery. Normal/forced duplicate account switches now
  intentionally join one auth write; active native sessions intentionally remain
  observed with the dashboard closed. Both supersede older stash behavior.
- Stash 6's untracked peer-domain fixture is covered and extended by current
  `webDashboardPeerDomain` checks for multi-system aggregation, relay failures,
  malformed peers and stale generation replies.

Current cache work moves optional shared results into indexed `manager_cache`
rows with expiry and byte/count caps. It retains authoritative leases and recovery
separately and removes the completed-result memory map. Cache failures preserve
fresh source results. Focused cache/failure/cross-process checks and the complete
2,090-test regression pass; this does not close the physical/runtime gates above.

## Latest requested interactive workspace (implemented and verified)

- Match the provided workspace reference: compact header/toolbar, full-height
  columns, neutral borders, one-line titles and two-line session metadata rows.
- Keep icon/title/system metadata left and project picker/search/actions right;
  move secondary controls into floating menus that never shift board content.
- Add functional Board, List, Gantt and Calendar tabs with shared task details,
  search, status filters, recorded run dates and durations.
- Latest user instruction supersedes start/stop-on-drop: column moves change classification only and never start, pause, resume or stop Codex. Preserve explicit Start/Resume/Stop controls, revision conflicts and uncertain-start fences. Custom tasks support Idea, Planned, Running, Completed, and independent archive/restore; their children keep running.
- Persist run start metadata in existing `session_turns` rows in manager.sqlite;
  query timing metadata only, retain it after transcript compaction, and show
  missing historical duration explicitly. No second transcript database/cache.
- Sessions begin as standalone tasks. Only session tasks may become children of custom tasks; custom-under-custom and session parents are rejected. Promote legacy invalid links to the board without losing descriptions/comments.
- Use the session initial prompt as its description. The custom task's New subtask action creates and starts a real prompted session, with a durable uncertain-start fence.
- Public project shares now mount the main TaskBoard and task-detail components with permission gates, rather than a second board/details implementation. Public session shares reuse the workspace header and grouped transcript; full-activity grants are explicit for new links, while older links retain message-only access.
- Remove the saved-history inline block. Keep true action failures and history loading separate from transcript text.
- UI/UX Pro Max was installed as a local design skill; the user reference and compact layout requirements remain the design contract.
- Follow-up polish aligns card metadata with subtask counts and uses consistent SVG add/menu/agent icons. Custom archive/restore is independent from native session execution. Local full-activity shares now bind the session/home and load authorized native history without duplicating it in SecretStorage.
- Current verification passes 197 focused tests, all 2,140 tests across 181 files,
  both TypeScript targets and lint with zero errors. All six responsive sizes and
  public desktop/mobile lifecycle checks pass. Actual drags, all four views,
  compact card alignment, custom archive/restore and explicit subtask creation
  are covered. Board moves make no native execution calls and preserve paused goals.
- The browser follow-up's earlier full regression passed 179 files/2,118 tests;
  this predates the latest UI/movement/timing additions and is not release proof.

## Browser operation audit map (2026-10-21)

This is the current audit scope, not a claim that every physical-device action
has passed. Shared transport checks apply to every dashboard action. Mutation
smokes use intercepted fixtures or owned disposable data, never existing work.

| Surface | Paths reviewed / coverage | Remaining live evidence |
| --- | --- | --- |
| Browser bridge | WebSocket and HTTP fallback, auth expiry, reconnect, duplicate/capacity limits, action deadlines, stale snapshots, missing results, no write replay (`browserHost`, failure recovery and timeout suites) | Host restart during an accepted write |
| Sessions / goals | Open/history/live merge, composer drafts/uploads, start/send/stop/resume, queue priorities, goal pause and capacity classification (session/recovery/queue suites and responsive UI) | Cold reboot/capacity recovery and real queue continuation |
| Workspace | Project-scoped tabs, terminal ownership/close, files/read/write revisions, Git checks, stale responses (workspace suites and disposable live harness) | Remote physical PC actions |
| Tasks | Hierarchy/cycle/revision guards, per-card drag targets, sidebar identity, details/attachments, coalesced events, outbox conflicts and storage limits (board suites and responsive UI) | Cross-PC custom task invalidation |
| Sharing | Project permissions/embedding/submissions/comments, legacy scoped streams, expiry/revocation, partial reads, duplicate writes, hidden/offline cleanup (share suites and public UI) | External embedding/expiry with real viewers |
| API | Multi-token project scopes and operation permissions, denial/exposure rules, create table/explorer/test UI, revocation (HTTP and responsive suites) | Runtime remote scoped-token actions |
| Accounts / settings | Immediate dispatch, modal focus retention, OAuth callback coordination, switching/reset ownership, quotas and cancellation (account/settings/OAuth suites and UI fixtures) | Live credit reset and physical OAuth callback |
| Offline / notifications | IndexedDB bounds, task/comment-only outbox, worker upgrade rollback, offline reload/reconnect, system notification titles (cache/worker tests and real read-only browser checks) | Phone push delivery and physical storage exhaustion |
| Remaining loops | Legacy share and recovery-page polling removed in this follow-up. Presence is a lease heartbeat; quota refresh follows configured schedules. Tools now receives bounded, source-bound progress across authenticated peers, with explicit search and catch-up status reads on reopen/reconnect. | Physical two-PC cleanup progress during reconnect |

## Session reliability and automation

- [ ] Audit background session/goal/live recording while dashboard and windows
  are closed; stable discovery and correct titles across devices and reloads.
- [ ] Verify session messages, metadata, goals and renames without blocking native
  app work, retaining newer writes and bounded read/cache resources.
- [ ] Verify real continuation after recovery, excluding archived, completed,
  child, blocked/budget-limited and explicitly paused work.
- [ ] Verify capacity errors as standalone events and completion payloads; keep
  interruption-paused goals durable through capture and restart; prevent
  duplicate starts while a native owner is still active.
- [ ] Verify per-session Auto Resume and global-default behavior in the flyout,
  including the requested enable/disable defaults and per-session overrides.
- [ ] Verify free numeric queue priority selection, equal-priority groups, active-work waits,
  run-until-finished semantics, durable claims and uncertain-outcome handling.
- [ ] Verify account Auto Queue, scoped auto-reset overrides, credit/ownership
  checks, account switching, cancellation and native restart recovery.
- [ ] Verify composer sending, draft preservation and terminal project fallback.

## Dashboard and event-driven updates

- [x] Include API access and Kanban enabled settings in the dashboard state
  signature so changes also push reliably to other open dashboard clients.
- [ ] Verify settings tabs stay one row; narrow screens use the active label and
  other icons. Verify About links and all navigation remain compact/readable.
- [x] Verify settings and stacked dialogs do not steal typing focus during
  background updates, preserve keyboard navigation and restore focus on close.
- [ ] Replace avoidable UI polling with state/file/live/reconnect/focus events;
  finish auditing remaining maintenance, public-share and server reconciliation
  loops. Preserve timeout/cancellation and required automation schedules.
- [ ] Verify removal of unnecessary pulse/transition effects.
- [ ] Verify pinned account footer, system switching/remote identity, compact
  sidebar, separate tool context bar, queue menu placement and title actions.
- [x] Verify distinct Sync and Refresh icons throughout the dashboard.
- [ ] Suppress the requested stale refresh/history notices and retire confirmed
  missing sessions without losing drafts or hiding transient errors.
- [x] Verify donation links and USD 11 suggestion.
- [ ] Verify manual OAuth URL submission alongside a pending automatic listener,
  duplicate clicks, listener failure, retry, cancellation and stale results.
- [ ] Prefix browser and background push titles with the originating system;
  preserve session subjects and system identity in notification action results.

## Project task management and sharing

- [ ] Verify Idea, Planned, Running, Completed plus an additional Archive filter; DB tasks,
  session subtasks under top-level custom tasks, moving back to board, cycle
  checks, search and cross-project/system boundaries.
- [ ] Verify drag/drop from sidebar, within board and onto parent tasks; expose
  understandable classification outcomes independent from native execution.
  Follow-up implemented: session-only parent drop targets, cycle/pending guards and
  coalesced board invalidation. Actual sidebar/board/nested drag checks are added;
  all six responsive fixture checks now pass. Real cross-system gates remain open.
- [ ] Verify right task panel, combined Activities, comments, conversation-shared
  files (not a project tree) and recorded changes with live updates. Messages
  and tool activity share Activities; Git history was removed by later request.
- [ ] Verify public project permission modal, shared features, submissions,
  comments, expiry, revocation, embedding and server-side authorization.
- [ ] Verify public board/task rendering matches rich workspace presentation.
- [x] Finish attachment parity for supported text uploads and conversation images;
  include snapshots and changed paths, enforce public Files permission, retain
  live hydration, and clean up image viewers on task close or link revocation.

## API and offline safety

- [ ] Verify API off/Kanban on defaults, multiple named token table, separate
  create modal, all/selected project checkbox scopes, Check All then individual
  permission exclusions, revocation, explorer and HTTP testing.
- [ ] Verify every granted operation and scoped result, cross-project/system
  denial, invalid/expired tokens and data-exposure boundaries.
- [ ] Verify offline shell reload and browser read caches; reconnect ordering,
  duplicate/idempotent sync, revision conflicts and bounded storage.
- [ ] Queue only task drafts/comments; disable execution, account, file, Git,
  token and sharing mutations offline; retain unsynced work on storage failure.

## Edge cases and release gates

Baseline verified evidence: 174 test files / 2,066 tests pass;
lint reports warnings with zero errors; both TypeScript checks and VSIX
dependency layout checks pass. The six-size responsive run and desktop/mobile
public share run passed. A final responsive repeat additionally checks token
creation and unavailable clipboard handling. Real cross-PC and phone delivery
still need verification. These results do not close the unchecked audit items.

- [ ] Audit normal, offline, stale, missing, partial, reconnect, retry, duplicate,
  queue-full, storage-full, reboot, timeout and failure paths for changes.
- [x] Run focused regressions after implementation, then the full regression
  suite; fix failures without weakening behavior checks.
- [x] Run lint and both TypeScript checks. Review all intended diffs.
- [ ] Run read-only local dashboard, responsive, public UI, console and timing
  smoke checks; record any unavailable real-device/cross-PC verification.
- [ ] Consolidate CHANGELOG/README/features/SEO under the requested 1.4.3 version;
  keep package and lockfile synchronized and omit personal deployment details.
- [ ] Build verified VSIX; install as previously requested; commit intended files
  on main and push. Report any required step that fails.
- [ ] Publish/update the authorized 1.4.3 GitHub Release with the verified VSIX;
  verify the release/tag/artifact match the delivered commit.

## Current review build additions

- Browser-demand cross-device checks: visible browser dashboards advertise signed
  subscriptions for their selected systems. Initial requests load once; file
  events share subsequent changes without recurring session scans. Unselected
  systems remain idle. Standby VS Code instances keep authenticated discovery/ownership
  presence without session scans or account-view builds. Hidden, closed,
  disconnected, and expired viewers release background session monitoring;
  explicit actions remain available. Peer interest does not advertise itself as
  local browser interest. Both PCs need the updated signed protocol for this
  behavior; mixed-version and physical two-PC checks remain release gates.

- Cross-PC discovery: relay aggregates included the receiving PC's own record;
  rejecting that record discarded the whole aggregate. Self records are now
  excluded while validating remote records before applying a complete snapshot.
  Late responses preserve fresher peer data and cannot repopulate a replaced
  connection. Physical two-PC validation remains a release gate: the canonical
  local host currently reports one local system only.
- Manual empty-quota account selections persist per Codex home in the existing
  account index/SQLite header. Automatic selection and credit redemption honor
  the hold; manually selecting an available account releases it. Unknown quota
  remains held until a fresh snapshot verifies the selected account.
- Sidebar account identity/system, System-first Account Center, browser-native
  Running Sessions navigation, and removal of its browser footer are included.
- Transcript actions are horizontal hover/focus overlays with no ellipsis or
  reserved message height. Paragraph spacing is reduced. Project session rows
  use one line for title/time, and project running / total counts animate only
  for verified running sessions. Paused/blocked goal indicators use Play;
  explicit resume still requires native confirmation.
- Further cross-PC audit corrected forced-local session discovery, global list
  replacement by remote replies, loss of remote rows on local realtime updates,
  delayed catalogs leaking across switches, unscoped saved list/catalog records,
  and a startup handshake race that could throttle the first live read. Signed
  changed peer lists now push immediately; unchanged heartbeats do not resend
  them. Remote browser links retain their device, workspace requests use that
  device, and disconnected peers cannot execute live actions.
- Six system-switch browser sizes pass for remote accounts, session lists,
  project catalogs, delayed responses, conversation URLs, workspace routing,
  and target disconnection. These are intercepted UI/transport fixtures, not
  physical two-PC evidence.

### Previous review build verification (`1.4.3-pre.1`, 2026-10-22)

- All 2,196 tests across 185 files pass. The first complete run found two
  outdated source assertions for the shared transcript selector and scoped
  session-opening guard; corrected expectations pass in the complete rerun.
- Both TypeScript targets compile. Lint reports zero errors and 3,101 warnings.
- Six-size system-switch checks verify target subscriptions, hide/show release,
  remote accounts/catalogs/conversations, late replies, and disconnection.
  Desktop/mobile maintenance, Git inspector/history, queue, and public-share
  checks pass. The general six-size responsive matrix also passes.
- Read-only real-host desktop/mobile checks load 341 session records, keep
  230 child sessions out of the parent list, render 22 messages, and reconnect successfully.
  Initial load takes 1,083 ms at desktop width and 606 ms at mobile width.
  These checks send no session messages and change no real accounts or files.
- Standby, unrelated-system interest, multiple viewers, lease expiry, replayed
  or forged subscriptions, and coalesced file changes have focused regressions.
  No recurring session-scan timer remains; connection health and viewer leases
  retain bounded heartbeats.
- Review VSIX `1.4.3-pre.1` builds successfully and passes bundled-dependency
  validation. SHA-256:
  `40e13fb2c7144da6b40f4a7339e220fced4809f0e95ada033f8efcce870f46a7`.
  Installation/publication and physical two-PC verification remain separate;
  this review build does not close those release gates. The repository still
  contains one main worktree and seven preserved stashes.
