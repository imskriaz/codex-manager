# 1.4.3 completion checklist

This checklist preserves the full active release goal and later user requests.
An unchecked item needs implementation, review, or current verification; it is
not a claim that the feature is absent. Do not mark the overall goal complete
while required checks remain open. Published artifacts record their verified
scope; publication does not close outstanding hardware or runtime checks.

## Repository inventory (2026-10-20)

### Follow-up evidence (2026-10-21)

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
  sessions as tasks/subtasks, arbitrary hierarchy, moving back to board, cycle
  checks, search and cross-project/system boundaries.
- [ ] Verify drag/drop from sidebar, within board and onto parent tasks; expose
  understandable outcomes where activity determines a session's column.
  Known follow-up: nested task cards currently bubble drops to the root group;
  add a drop target per card and exercise actual sidebar/board/nested drags.
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
