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
| Git/worktrees | Status/diff/history, stage/unstage/discard, staged commit, fetch/pull/push, branches, merge/abort, stash lifecycle; linked worktree isolation | Disposable branch/switch/merge/rename/delete, stage/unstage/discard, stash/apply/drop, fetch/pull/push, commit, and local-remote flows are covered. Installed Windows stash rerun is a release gate; linked-worktree and remote-provider cases remain external limits |
| GitHub | Auth/missing auth, lists/details, comments, issues/PR actions/checks/workflows, confirmed mutation outcomes | Fixture/service coverage exists. GitHub release authentication is available; issue/PR/workflow mutations are not live-tested against a disposable remote |
| Reviews and Agents | Turn/branch changes, diffs, child creation/list/transcript/refresh and empty/error states | Real Reviews/Agents tabs, child transcript, and empty-state checks passed |
| UI/UX Pro Max | Every workspace screen: desktop/mobile, light/dark, no overflow, visible loading/running feedback, accessible icons/focus/dialogs, preserved drafts and clear outcomes | Compact hover/focus row menus, same-slot spinner replacement, compact turn usage, General dashboard zoom controls, settings/layout, dialogs, focus, light/dark, and all six responsive sizes passed |
| Failure handling | Offline/stale/missing/partial/reconnect/retry/duplicate/queue-full/storage-full/reboot/timeout/failure; no blind replay or lost edits | Real stale-session, lost-ack reload, conflict/path, duplicate, offline/reconnect, timeout and failure checks passed; storage exhaustion, reboot, and alternate host remain external limits |
| Performance and resources | Immediate manual actions, bounded optional work, lazy panels, hidden-tab idle behavior, bounded streams/queues, compact rendering, and cleanup | Lazy/deferred panels, bounded app-server/terminal queues, same-slot status rendering, cleanup, and responsive timing checks passed; long-run memory and reboot/storage pressure remain external limits |
| Delivery | Focused tests → full regression → verify → VSIX → install → installed real UI/action run → commit all intended files → push main | Stable `1.6.0` release explicitly requested; verification and GitHub release delivery in progress |

## Evidence rules

- Record exact commands/results and artifact paths; distinguish real provider/UI checks from fixtures and service tests.
- A failure caused by a prerequisite remains unverified until rerun successfully.
- Preserve and inspect errors; never weaken assertions to make an unsupported or inconclusive action appear successful.
- Only mutate disposable test sessions/repositories/files during real action checks.
- Do not claim real cross-PC, GitHub writes, alternate OS, reboot, or storage exhaustion coverage without executing it or explicitly identifying the unverified limitation.

## Latest evidence

- Focused recovery regression: six files and 292 tests passed, including stale orphaned turns, explicit pause/stop, cancellation, ownership conflicts, account-home changes, exact empty-input rejection fallback, and no replay after uncertain acceptance. Command and result: `output/release-1.6.0-recovery-final.log`.
- Auto Resume recovery remains on the official VS Code conversation-tab path; shutdown capture is bounded to 1.25 seconds and preserves the existing recovery queue when the host closes too quickly. The prior experimental background path and setting are removed.
- `node tools/check-responsive-ui.mjs`: all six viewports passed (1440x1000, 1024x768, 768x1024, 390x844, 320x667, 844x390), including light/dark send contrast, one copy action, compact usage, top-layer menus, keyboard actions, and spinner replacement while hovering an open menu. Log: `output/release-1.6.0-responsive.log`; screenshots: `%TEMP%/codex-manager-ui-check`.
- Browser notification subscribe/registered/conflict/denied/cancelled/storage-failure/timeout and offline/task-board/reconnect fixture checks passed during workspace verification.
- The final full regression attempt encountered five 30-second Git integration test timeouts. Failures are preserved in `output/release-1.6.0-regression-host-timeouts.log`; a rerun with a longer test-harness deadline is pending. Assertions and production deadlines are unchanged.
- Final production checks, VSIX packaging/installation, installed real action rerun, commit/push, and GitHub release publication remain delivery gates. The active local host has been reloaded to 1.6.0; the final recovery changes require a fresh verified package.
- External limits: issue/PR/workflow writes, real remote peers, linked worktrees on alternate hosts, actual reboot, storage exhaustion, alternate operating systems, and long-run memory pressure are not claimed as live-tested. GitHub release publication is verified separately from issue/PR/workflow support.
