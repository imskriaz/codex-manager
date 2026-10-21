# 1.4.3 completion checklist

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
  API limits, broader Git/GitHub tools and final inline maintenance-workspace
  interaction checks. The inspector follow-up implements fixed Env, core Git,
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
| Remaining loops | Legacy share and recovery-page polling removed in this follow-up. Presence is a lease heartbeat; quota refresh follows configured schedules. Active maintenance progress still polls and needs a scoped event path across peers. | Maintenance/peer event follow-up |

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
