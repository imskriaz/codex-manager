# Workspace completion goal

## Current requested work — 2026-11-10

Complete all eight items before delivery:

1. Add “Create new project” to the Workspace and Tasks project dropdowns, with a name and parent-folder modal.
2. Fix standalone account-switch feedback and refresh, automatic recovery, and manual Play.
3. Fix missing image previews in live and saved conversations.
4. Render mirrored questions and answers once.
5. Fix standalone reauthentication failing because CancellationTokenSource is unavailable.
6. Polish workspace tabs and use accessible icon action buttons, including Save.
7. Open valid linked project files on Windows while preserving project and symlink boundaries.
8. Match Account Center to the compact dashboard cards, with aligned actions, card state backgrounds, side-by-side quota bars, and a narrow-container fallback.

Delivery gates: focused tests, the full regression suite, build and read-only responsive browser checks at the local dashboard, verified VSIX installation, commit and push on main. No publication is authorized. All eight items are implemented, verified, and installed locally. This evidence is included in the delivery commit on main; the final response reports commit/push confirmation.

Current evidence for `1.7.8-pre.1`:

- Focused corrections passed: 40 question/modal/path tests, 66 recovery/dashboard tests, and 34 live-history/question/mobile tests. The new project storage, image hydration, Node OAuth adapter, and private Play cases are also included in the full suite.
- Final production compilation passed (`output/request-package-clean.log`). Packaging including the Account Center addition and VSIX dependency verification passed (`output/request-package-eight-items.log`).
- Read-only desktop (1440px) and mobile (390px) browser checks passed with no console errors or page overflow (`output/request-ui-clean.log`). Both project dropdown modals, keyboard focus, cancellation, project-file reading, and the icon Save control were checked. Screenshots and timings are in `output/workspace-request-ui/`.
- Account Center passed 88 focused layout tests (`output/request-account-center-focused.log`) and six viewport/container checks with light/dark screenshots and no console errors (`output/request-account-center-final.log`). Narrow layouts retain identity space and visible percentages; normal widths keep actions aligned and quotas side by side.
- `npm run verify` passed with zero lint errors and both TypeScript checks (`output/request-verify-final.log`). Existing lint warnings remain.
- VSIX installation succeeded (`output/request-install.log`, exit 0), and VS Code reports `imskriaz.codex-manager@1.7.8-pre.1`. Installed CSS, authentication adapter, project service and question-domain hashes match the verified workspace build.
- Final full regression passed: 261 files, 3,371 tests, exit 0, 749.58 seconds (`output/request-full-eight-items.log` and `.exit`). Earlier incomplete runs and corrected failures are superseded by this run.
- Real reboot and live provider OAuth authorization are not exercised by these checks. Running standalone processes need a restart to load the installed build. No release or deployment was requested or published.

## Historical workspace goals and evidence

Objective: end to end fix all gaps and support in workspace, including UI/UX parity, compact layout, performance, resource use, and verification. A passing subset does not complete this goal.

## Tasks and verification gates

| Area | Required behavior and evidence | Current state |
| --- | --- | --- |
| Session creation | Desktop/mobile New Chat, selected project, first response, stale catalogue, deep link and reload | Real disposable-project flows passed |
| Conversation actions | Reply, steer with turn fence, Stop, duplicate request handling, interrupted non-goal play/resume | Real steering/Stop, duplicate, reload, and resume/play coverage passed |
| Session lifecycle | Rename, fork, archive, restore, delete, missing/archived handling | Real rename plus fork/archive/restore/delete passed |
| Goals and automation | Create/display/complete/pause/resume goals; preserve existing Auto Resume behavior | Auto Resume uses the official Codex conversation-tab path after restart, with bounded shutdown capture and retained recovery on failure. Actual reboot remains unverified |
| Session/message parity | User/assistant, reasoning, plans, tools, commands, changes, images, attachments, approvals/questions, collaboration, errors, compaction, usage | Parser/render coverage plus real transcript, approval, child-agent, image/Markdown, change, and compact usage UI checks passed |
| Files | Browse/refresh/open/edit/save/delete; image/Markdown previews; links; stale revision, missing/escaping path, binary/large files | Real edit/conflict/delete/path/image/Markdown flows passed |
| Terminal | Create/select/control/input/resize/clear/cancel/close; streaming, snapshot/reload, ownership and reconnect | Real create/stream/cancel/ownership/reload and reconnect flows passed |
| Git/worktrees | Status/diff/history, stage/unstage/discard, staged commit, fetch/pull/push, branches, merge/abort, stash lifecycle; linked worktree isolation | Installed Windows branch/switch/merge/rename/delete, stage/unstage/discard, stash/apply/drop, fetch/pull/push, commit, and local-remote flows passed in a disposable repository; linked-worktree and remote-provider cases remain external limits |
| GitHub | Auth/missing auth, lists/details, comments, issues/PR actions/checks/workflows, confirmed mutation outcomes | Fixture/service coverage exists. GitHub release authentication is available; issue/PR/workflow mutations are not live-tested against a disposable remote |
| Reviews and Agents | Turn/branch changes, diffs, child creation/list/transcript/refresh and empty/error states | Real Reviews/Agents tabs, child transcript, and empty-state checks passed |
| UI/UX Pro Max | Every workspace screen: desktop/mobile, light/dark, no overflow, visible loading/running feedback, accessible icons/focus/dialogs, preserved drafts and clear outcomes | Compact hover/focus row menus, same-slot spinner replacement, compact turn usage, General dashboard zoom controls, settings/layout, dialogs, focus, light/dark, and all six responsive sizes passed |
| Failure handling | Offline/stale/missing/partial/reconnect/retry/duplicate/queue-full/storage-full/reboot/timeout/failure; no blind replay or lost edits | Real stale-session, lost-ack reload, conflict/path, duplicate, offline/reconnect, timeout and failure checks passed; storage exhaustion, reboot, and alternate host remain external limits |
| Performance and resources | Immediate manual actions, bounded optional work, lazy panels, hidden-tab idle behavior, bounded streams/queues, compact rendering, and cleanup | Lazy/deferred panels, bounded app-server/terminal queues, same-slot status rendering, cleanup, and responsive timing checks passed; long-run memory and reboot/storage pressure remain external limits |
| Delivery | Focused tests → full regression → verify → VSIX → install → installed real UI/action run → commit all intended files → push main | Stable `1.6.0` passed local verification and installed-host checks. Publication requires clean pushed main, matching release tag, and verified VSIX/checksum downloads |

## Evidence rules

- Record exact commands/results and artifact paths; distinguish real provider/UI checks from fixtures and service tests.
- A failure caused by a prerequisite remains unverified until rerun successfully.
- Preserve and inspect errors; never weaken assertions to make an unsupported or inconclusive action appear successful.
- Only mutate disposable test sessions/repositories/files during real action checks.
- Do not claim real cross-PC, GitHub writes, alternate OS, reboot, or storage exhaustion coverage without executing it or explicitly identifying the unverified limitation.

## Latest evidence

### Current combined prerelease: 1.7.3-pre.8

- The floating auditor uses the complete compact mobile browser workspace,
  including conversation switching, tool arguments/results, composer, prompts,
  workspace tools and latest-message scrolling. Existing responsive coverage
  exercises the floating window and independent drafts.
- Realtime recovery now replays activity/prompts before a bounded dashboard
  snapshot; focus/online preserve healthy sockets, repeated retries share work,
  startup live replay is bounded and released, and transport pressure reports
  an immediate unsent action failure. Unchanged session rows retain identity,
  complete authoritative live history avoids redundant reads, and rejected
  terminal frames cannot trigger completion refreshes.
- The user authorized the concurrent access-profile fix in this delivery. Full
  selects its explicit permission profile across creation/resume/settings, checks
  effective permissions and profile together, and fails a new turn if recovery
  storage cannot save the confirmed choice.
- Focused realtime/storage/queue/layout checks: 7 files, 154 tests passed in
  25.13 seconds (`output/pre6-focused.log`). Access/owner/action checks: 7 files,
  396 tests passed in 60.96 seconds (`output/pre7-access-focused.log`).
- The initial combined regression was superseded after scope expanded; its log
  is retained as `output/pre6-regression-superseded.log` and is not a pass.
  The subsequent regression reported one encrypted-sync recovery failure before
  interruption; its exact final error was not printed. Preserve
  `output/pre7-regression.log` and diagnose it in the final owner's run.
- `npm run verify` passed with exit 0 (`output/pre7-verify.log` and `.exit`):
  lint had 0 errors and 4239 warnings, and both TypeScript checks passed.
- The user assigned final combined verification and delivery to another active
  task. Only this task's duplicate regression/build runners were stopped; the
  other task's jobs were left running. Production compile was interrupted during
  Vite chunk rendering, so rebuild generated assets before smoke checks or
  packaging. Final regression, production build, UI checks, VSIX/install and
  commit/push remain pending with that owner. Handoff:
  `output/workspace-speed-handoff.md`.
- The combined `pre.9` full regression reached 242 files and 3,147 tests; 3,146
  passed and one source-string assertion failed because the host task made the
  dashboard port environment-configurable. After updating that stale assertion,
  the impacted dashboard/layout suites passed 104/104 tests in 9.53 seconds
  (`output/pre9-followup-focused.log`). Rerun the full suite once more if a
  clean all-pass artifact is required after the final host-reload edits.
- The floating monitor header marked in the supplied screenshot is removed;
  the popup now opens directly into the mobile workspace and closes through its
  window. The quota footer meter passes pointer input through to the existing
  Account Center button so the whole account/quota area opens it together.
- Final webview typecheck passed after the host-reload narrowing fix (`output/pre9-final-webview-typecheck-2.log` and `.exit`); `git diff --check` is clean.
- The performance plan is reconciled with the existing protocol and durable
  queue barriers. EGM reached two consecutive clean review rounds; report:
  `output/goldfish_review_report.md`. This is plan review, not runtime proof.
- Real remote peers, reboot, sustained storage exhaustion, alternate operating
  systems and long-run memory pressure remain unverified. Smoke p50/p95 values
  from two viewports do not establish the provisional performance budgets.

### Historical stable-release evidence

- Focused Auto Resume/settings regression: five files and 144 tests passed, including recovery readiness, retained failures, shutdown capture, and ignoring the retired background preference. Result: `output/release-1.6.0-removal-focused.log`.
- Auto Resume recovery remains on the official VS Code conversation-tab path; shutdown capture is bounded to 1.25 seconds and preserves the existing recovery queue when the host closes too quickly. The prior experimental background path and setting are removed.
- `node tools/check-responsive-ui.mjs`: all six viewports passed (1440x1000, 1024x768, 768x1024, 390x844, 320x667, 844x390), including light/dark send contrast, one copy action, compact usage, top-layer menus, keyboard actions, and spinner replacement while hovering an open menu. Log: `output/release-1.6.0-responsive.log`; screenshots: `%TEMP%/codex-manager-ui-check`.
- Browser notification subscribe/registered/conflict/denied/cancelled/storage-failure/timeout and offline/task-board/reconnect fixture checks passed during workspace verification.
- Full regression passed after removal: 209 files and 2,584 tests in 1,215.98 seconds, using `npm test -- --testTimeout 90000 --hookTimeout 90000`. Result: `output/release-1.6.0-removal-regression.log`. Earlier interrupted/timeout runs do not count as verification.
- Production verification passed: full lint (0 errors; existing style warnings), webview typecheck, and extension TypeScript build. Result: `output/release-1.6.0-removal-verify.log`.
- Verified `codex-manager-1.6.0.vsix` packaged and installed, and the running host reloaded to 1.6.0. Desktop/mobile smoke and reconnect passed at 2,211/2,177 ms; all settings tabs omit Resume in background. Logs: `output/release-1.6.0-removal-package.log`, `output/release-1.6.0-removal-install.log`, `output/release-1.6.0-removal-live-ui.log`, and `output/release-1.6.0-setting-removal-ui.log`.
- Installed real actions passed all 29 checks in a separate disposable project, including desktop/mobile New Chat, replies, lost acknowledgement, steering/Stop, duplicate requests, child agents, goals, files/conflicts/previews, shared terminals/ownership/reload, Git/stash/local remote operations, Reviews/Agents, session lifecycle, reconnect, account filters, and cleanup. Log: `output/release-1.6.0-removal-live-actions-final.log`; receipt: `output/release-1.6.0-live-actions-final.json`. Prior fixture CRLF and metadata-render timing failures are retained separately; content and project assertions remain strict.
- External limits: issue/PR/workflow writes, real remote peers, linked worktrees on alternate hosts, actual reboot, storage exhaustion, alternate operating systems, and long-run memory pressure are not claimed as live-tested. GitHub release publication is verified separately from issue/PR/workflow support.
