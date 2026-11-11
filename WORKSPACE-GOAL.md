# Workspace completion goal

## Account Center/version follow-up — 2026-11-11

Keep version `1.7.9` as explicitly requested. The earlier dashboard was compiled before the final manifest version changed and still embedded `1.7.9-pre.1`. Rebuild and verify the actual displayed version, and add a packaging assertion against stale bundled versions. Keep Account Center to Search and More, remove Add, and move existing display options into More. Verify, install, restart the existing standalone host with recovery capture, then commit and push main. The user explicitly requested end-to-end verification and GitHub Release `1.7.9` with the verified VSIX. The final scope also includes a separate folder picker, silent informational changes, warning/error toasts instead of action banners, persistent opened subagent tabs within each workspace/task and message-preserving refreshes.

## Final 1.7.9 release verification

- Full regression passed: 267 files, 3,486 tests, exit 0, 812.38 seconds (`output/release-179-regression-complete.log` and `.exit`). Earlier interrupted runs and stale fixture assertions are superseded.
- Final production compile and verification passed (`output/release-179-build-complete.log`, `output/release-179-verify-complete.log`); lint has zero errors and existing warnings.
- Mobile and desktop Account Center checks passed, including Search/More, account actions, offline and duplicate guards, child-menu and Settings Escape, and desktop resize persistence/storage-warning toast. Six viewport/container layout checks and dark/light screenshots passed. Workspace inspector, task agent tabs, incoming message retention, folder picker, and direct transcript errors passed responsive browser checks.
- The account-switch recovery scheduler no longer applies the previous account’s retry delay or pending quota refresh to a freshly verified replacement. Missing, disabled, unauthorized, stale and exhausted accounts still defer; interrupted work is durably retained.
- VSIX packaging, dependency/layout checks and 17 runtime/dashboard file comparisons passed. SHA-256: `34f0ae21d60ec7e0d0696bd696b38c66fde2b6bdac1adb4aa2148a392eff9b1b`. Local installation passed and the installed files match the verified archive (`output/release-179-installed-integrity.json`).
- The running standalone host serves the installed build. A real browser check displays `v1.7.9` with zero console errors in 2.05 seconds. Live discovery returned eight distinct models with reasoning options and no fallback warning (`output/release-179-version-live.log`, `output/release-179-live-discovery.json`). A duplicate launcher attempt was safely rejected because the current host already owned the port; the verified existing host remained available.
- Real standalone end-to-end project creation passed: browse/select a disposable parent, duplicate-name failure shown as a mobile toast, silent success, selected project, persistence after reload, and no Codex turn started. Only the exact disposable project registry row and temporary folders were cleaned (`output/release-179-e2e-live.log`).
- Live quota exhaustion, actual storage exhaustion and a real account-switch recovery timing experiment were not induced. Failure and recovery branches have regression coverage. Commit/push and GitHub release confirmation are recorded in the final response.

## Earlier 1.7.9 verification (superseded by final release build)

The requested slice covers quiet standalone recovery deferral without usable quota, directly visible session/capacity errors, live model discovery, empty project visibility and folder browsing, and compact Account Center Add/More controls. Project creation stays in the existing project pickers. Preserve existing recovery behavior and the earlier unfinished 1.7.8 changes. The user explicitly requested version `1.7.9`. The later explicit release request and final verification above take precedence over this earlier pass.

- Full regression passed: 262 files and 3,449 tests, exit 0, 1,133.68 seconds (`output/fix-179-regression-release.log` and `.exit`). Earlier incomplete runs and the corrected text-scaling failure are superseded by this run.
- Focused recovery, quota, capacity, model, project and UI checks passed. The final project subset passed 124 tests; the final typography/layout/error subset passed 91 tests. `npm run verify` passed with zero lint errors and existing warnings; the final production compile passed (`output/fix-179-verify-final.log`, `output/fix-179-build-picker-only.log`).
- Read-only desktop/mobile picker and error checks passed at the required local dashboard, including zero sessions, folder navigation/selection, cancellation, directly visible capacity/errors and retained debug details. Account Center passed six viewport/container checks with light/dark screenshots and no console errors or horizontal overflow. Evidence: `output/fix-179-picker-*-ui.log`, `output/fix-179-session-errors-*.log`, `output/fix-179-account-release-ui.log`, `output/fix-179-ui/`.
- The compiled standalone services discovered eight live models without a saved-catalog warning and browsed the actual project directory without creating a session or project (`output/fix-179-live-services.json`).
- The final `codex-manager-1.7.9.vsix` passed runtime/dependency verification. Its manifest and 13 runtime/dashboard files match the workspace build. SHA-256: `d08c5187fb5a873b4d37458a0350e84c9b934fba0b7aa73ae0c66abb8ae7424c` (`output/fix-179-package-release.log`, `output/fix-179-vsix-integrity.json`).
- VSIX installation succeeded, exit 0; VS Code reports `imskriaz.codex-manager@1.7.9`. Six installed runtime/dashboard hashes match the verified workspace build (`output/fix-179-install.log`, `output/fix-179-installed-version.log`, `output/fix-179-installed-integrity.json`). Existing standalone processes still need a restart to load the update. The delivery commit includes this evidence; the final response records commit/push confirmation.
- A broader mobile message smoke check still fails on the existing hidden missing-agent warning; the focused requested error-display checks pass. The failing log remains `output/fix-179-errors-mobile-complete-final.log`. Live provider quota exhaustion, actual reboot and real storage exhaustion were not exercised.

## Urgent follow-up — 2026-11-10

- Release 1.7.8 is explicitly requested. Complete the final edge-case audit in standalone and VS Code, all verification, fresh packaging, local installation and reload, then commit/push main and publish the GitHub Release with the verified VSIX. Publication remains gated on those results.
- Final added scope: one compact API workspace with no tab split, key creation beside token entry, key-management header button/modal, selected endpoint field below Model ID, three balanced panels, header Send icon and separate Details modal. Include permission-aware proxy testing/model discovery and a confirmed-429 trigger that selects a verified replacement even when quota inspection is stale or unavailable. Reuse existing endpoints and token/project restrictions; no new external service or session creation. Earlier VSIX builds are superseded until this UI, 429 behavior and serialized capacity expiry are verified and packaged again.

- Reload the installed standalone host and verify automatic recovery using real runtime events.
- Preserve the main dashboard as it was in 1.7.7. Match only Account Center to the supplied small-screen account-card layout, with readable typography and compact actions/quotas.
- Reload of `1.7.8-pre.1` completed: standalone ready at 07:05:14 UTC; automatic continuation accepted at 07:05:18 UTC; recovery reported one attempted, one continued, zero failures. Evidence: `output/urgent-reload-first-success.json`.
- Account Center corrections include the final requested 24px action controls, shorter cards, one search/icon toolbar row, no Saved Accounts title, a single-row footer, and automatic closing only after the selected system reports a different active account. The earlier full run was cancelled when this scope was added; fresh focused/browser checks and a final full run precede packaging, installation, reload, main commit/push and the authorized release.
- Standalone starts and continuations must confirm and save Full access, overriding stale restricted session defaults. Auto approve defaults to On; a separate Message settings toggle persists explicit On/Off choices across later turns. Confirmed sandbox/approval execution failures use the existing bounded durable recovery queue, without toast prompts, duplicate replay, or overriding Stop/paused/completed work.
- The local workspace `.codex/config.toml` now requests Full access and approvals never for future sessions. Current thread restrictions and managed host policy still take precedence; local configuration is not included in the public package.
- Follow-up scope: align sidebar/composer Play; audit standalone Capacity tagging, retry/switch coordination, durable expiry and ownership. Keep API proxy calls session-free and normal calls free of quota checks; verify error-triggered checks and bounded retries after confirmed account changes.
- Earlier full run completed with 3 Git workflow timeouts and one stale toggle assertion. The corrected toggle and unchanged Git assertions pass in isolation (116 checks) with a bounded 60-second test allowance; the longest Git workflow took 54.3 seconds. New Play/capacity/API changes require fresh focused/full verification and a rebuilt VSIX before installation.

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
