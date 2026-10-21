# 1.4.3 completion checklist

This checklist preserves the full active release goal and later user requests.
An unchecked item needs implementation, review, or current verification; it is
not a claim that the feature is absent. Do not mark the overall goal complete
while required checks remain open. Published artifacts record their verified
scope; publication does not close outstanding hardware or runtime checks.

## Repository inventory (2026-10-20)

### Follow-up evidence (2026-10-21)

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
- Public views refresh on focus, reconnect, visibility and explicit Refresh;
  a continuously focused public page still needs a scoped live event channel.
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
- Seven stashes remain preserved. Their changed source files exist in current
  code except the retired announcement service; full semantic equivalence is
  still unproven. No stash was blindly applied or deleted.

- One worktree: the current checkout on `main`.
- No local branches unmerged into `main` at inventory time.
- The baseline VSIX was installed, committed and pushed on `main`, and its
  GitHub Release artifact/tag were verified. Follow-up delivery is recorded with
  its verification results; it does not close the broader runtime checks above.
- Seven preserved stashes need a semantic audit against current code. Keep them
  intact; do not apply old version/lockfile changes over the release.

| Stash | Preserved work | Audit status |
| --- | --- | --- |
| 0 | Usage graph reads, caches, aggregation, storage, and chart UI | Pending comparison |
| 1 | 1.2.6 preview, sharing/project bindings, isolation, import, sorting/header | Pending comparison |
| 2 | Same patch ID as stash 1, preserved after storage cleanup | Duplicate verified; retain intact |
| 3 | Overlapping 15-file patch preserved during announcement removal | Pending comparison |
| 4 | SQLite migration, recording, storage, relay, diagnostics, sorting/header | Pending comparison |
| 5 | Earlier SQLite migration plus sharing/isolation/import work | Pending comparison |
| 6 | Auto Sync, native recovery, manual scheduling and cross-window coordination | Pending comparison |

All newly exported source symbols from these stashes exist in their current
files; this is preliminary inventory evidence, not a semantic equivalence proof.
Also audit preserved untracked snapshots: `dailyTokenUsage.ts` in stash 0;
`extensionIsolationFailure.test.ts` and `workbenchShutdown.test.ts` in stash 5;
and `webDashboardPeerDomain.test.ts` in stash 6. These files now exist in the
checkout and must be compared before declaring the stashes fully covered.

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
- [ ] Verify settings and stacked dialogs do not steal typing focus during
  background updates, preserve keyboard navigation and restore focus on close.
- [ ] Replace avoidable UI polling with state/file/live/reconnect/focus events;
  finish auditing remaining maintenance, public-share and server reconciliation
  loops. Preserve timeout/cancellation and required automation schedules.
- [ ] Verify removal of unnecessary pulse/transition effects.
- [ ] Verify pinned account footer, system switching/remote identity, compact
  sidebar, separate tool context bar, queue menu placement and title actions.
- [ ] Verify distinct Sync and Refresh icons throughout the dashboard.
- [ ] Suppress the requested stale refresh/history notices and retire confirmed
  missing sessions without losing drafts or hiding transient errors.
- [ ] Verify donation links and USD 11 suggestion.
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
- [ ] Verify right task panel, combined Activities, comments, conversation-shared
  files (not a project tree) and recorded changes with live updates. Messages
  and tool activity share Activities; Git history was removed by later request.
- [ ] Verify public project permission modal, shared features, submissions,
  comments, expiry, revocation, embedding and server-side authorization.
- [ ] Verify public board/task rendering matches rich workspace presentation.

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
- [ ] Run focused regressions after implementation, then the full regression
  suite; fix failures without weakening behavior checks.
- [ ] Run lint and both TypeScript checks. Review all intended diffs.
- [ ] Run read-only local dashboard, responsive, public UI, console and timing
  smoke checks; record any unavailable real-device/cross-PC verification.
- [ ] Consolidate CHANGELOG/README/features/SEO under the requested 1.4.3 version;
  keep package and lockfile synchronized and omit personal deployment details.
- [ ] Build verified VSIX; install as previously requested; commit intended files
  on main and push. Report any required step that fails.
- [ ] Publish/update the authorized 1.4.3 GitHub Release with the verified VSIX;
  verify the release/tag/artifact match the delivered commit.
