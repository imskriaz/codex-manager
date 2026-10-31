# Workspace completion goal

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

- Focused Auto Resume/settings regression: five files and 144 tests passed, including recovery readiness, retained failures, shutdown capture, and ignoring the retired background preference. Result: `output/release-1.6.0-removal-focused.log`.
- Auto Resume recovery remains on the official VS Code conversation-tab path; shutdown capture is bounded to 1.25 seconds and preserves the existing recovery queue when the host closes too quickly. The prior experimental background path and setting are removed.
- `node tools/check-responsive-ui.mjs`: all six viewports passed (1440x1000, 1024x768, 768x1024, 390x844, 320x667, 844x390), including light/dark send contrast, one copy action, compact usage, top-layer menus, keyboard actions, and spinner replacement while hovering an open menu. Log: `output/release-1.6.0-responsive.log`; screenshots: `%TEMP%/codex-manager-ui-check`.
- Browser notification subscribe/registered/conflict/denied/cancelled/storage-failure/timeout and offline/task-board/reconnect fixture checks passed during workspace verification.
- Full regression passed after removal: 209 files and 2,584 tests in 1,215.98 seconds, using `npm test -- --testTimeout 90000 --hookTimeout 90000`. Result: `output/release-1.6.0-removal-regression.log`. Earlier interrupted/timeout runs do not count as verification.
- Production verification passed: full lint (0 errors; existing style warnings), webview typecheck, and extension TypeScript build. Result: `output/release-1.6.0-removal-verify.log`.
- Verified `codex-manager-1.6.0.vsix` packaged and installed, and the running host reloaded to 1.6.0. Desktop/mobile smoke and reconnect passed at 2,211/2,177 ms; all settings tabs omit Resume in background. Logs: `output/release-1.6.0-removal-package.log`, `output/release-1.6.0-removal-install.log`, `output/release-1.6.0-removal-live-ui.log`, and `output/release-1.6.0-setting-removal-ui.log`.
- Installed real actions passed all 29 checks in a separate disposable project, including desktop/mobile New Chat, replies, lost acknowledgement, steering/Stop, duplicate requests, child agents, goals, files/conflicts/previews, shared terminals/ownership/reload, Git/stash/local remote operations, Reviews/Agents, session lifecycle, reconnect, account filters, and cleanup. Log: `output/release-1.6.0-removal-live-actions-final.log`; receipt: `output/release-1.6.0-live-actions-final.json`. Prior fixture CRLF and metadata-render timing failures are retained separately; content and project assertions remain strict.
- External limits: issue/PR/workflow writes, real remote peers, linked worktrees on alternate hosts, actual reboot, storage exhaustion, alternate operating systems, and long-run memory pressure are not claimed as live-tested. GitHub release publication is verified separately from issue/PR/workflow support.
