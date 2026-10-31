# Workspace completion goal

Objective: end to end fix all gaps and support in workspace, including UI/UX parity, compact layout, performance, resource use, and verification. A passing subset does not complete this goal.

## Tasks and verification gates

| Area | Required behavior and evidence | Current state |
| --- | --- | --- |
| Session creation | Desktop/mobile New Chat, selected project, first response, stale catalogue, deep link and reload | Real disposable-project flows passed |
| Conversation actions | Reply, steer with turn fence, Stop, duplicate request handling, interrupted non-goal play/resume | Real steering/Stop, duplicate, reload, and resume/play coverage passed |
| Session lifecycle | Rename, fork, archive, restore, delete, missing/archived handling | Real rename plus fork/archive/restore/delete passed |
| Goals and automation | Create/display/complete/pause/resume goals; preserve existing Auto Resume behavior | Real goal completion/display and Auto Resume controls passed; existing Auto Resume behavior retained |
| Session/message parity | User/assistant, reasoning, plans, tools, commands, changes, images, attachments, approvals/questions, collaboration, errors, compaction, usage | Parser/render coverage plus real transcript, approval, child-agent, image/Markdown, change, and compact usage UI checks passed |
| Files | Browse/refresh/open/edit/save/delete; image/Markdown previews; links; stale revision, missing/escaping path, binary/large files | Real edit/conflict/delete/path/image/Markdown flows passed |
| Terminal | Create/select/control/input/resize/clear/cancel/close; streaming, snapshot/reload, ownership and reconnect | Real create/stream/cancel/ownership/reload and reconnect flows passed |
| Git/worktrees | Status/diff/history, stage/unstage/discard, staged commit, fetch/pull/push, branches, merge/abort, stash lifecycle; linked worktree isolation | Real disposable repository stage/diff/commit/local-remote push passed; linked-worktree and remote-provider cases remain external limits |
| GitHub | Auth/missing auth, lists/details, comments, issues/PR actions/checks/workflows, confirmed mutation outcomes | Fixture/service coverage exists; real authenticated remote verification unavailable until a disposable remote is configured |
| Reviews and Agents | Turn/branch changes, diffs, child creation/list/transcript/refresh and empty/error states | Real Reviews/Agents tabs, child transcript, and empty-state checks passed |
| UI/UX Pro Max | Every workspace screen: desktop/mobile, light/dark, no overflow, visible loading/running feedback, accessible icons/focus/dialogs, preserved drafts and clear outcomes | Compact hover/focus row menus, same-slot spinner replacement, compact turn usage, settings/layout, dialogs, focus, light/dark, and all six responsive sizes passed |
| Failure handling | Offline/stale/missing/partial/reconnect/retry/duplicate/queue-full/storage-full/reboot/timeout/failure; no blind replay or lost edits | Real stale-session, lost-ack reload, conflict/path, duplicate, offline/reconnect, timeout and failure checks passed; storage exhaustion, reboot, and alternate host remain external limits |
| Performance and resources | Immediate manual actions, bounded optional work, lazy panels, hidden-tab idle behavior, bounded streams/queues, compact rendering, and cleanup | Lazy/deferred panels, bounded app-server/terminal queues, same-slot status rendering, cleanup, and responsive timing checks passed; long-run memory and reboot/storage pressure remain external limits |
| Delivery | Focused tests → full regression → verify → VSIX → install → installed real UI/action run → commit all intended files → push main | In progress for `1.6.0-pre.27`; no public publication authorized |

## Evidence rules

- Record exact commands/results and artifact paths; distinguish real provider/UI checks from fixtures and service tests.
- A failure caused by a prerequisite remains unverified until rerun successfully.
- Preserve and inspect errors; never weaken assertions to make an unsupported or inconclusive action appear successful.
- Only mutate disposable test sessions/repositories/files during real action checks.
- Do not claim real cross-PC, GitHub writes, alternate OS, reboot, or storage exhaustion coverage without executing it or explicitly identifying the unverified limitation.

## Latest evidence

- Focused transport/composer/layout checks: 70 layout/accessibility tests passed after compact row-menu changes; encrypted sync passed 52/52.
- Full Vitest regression: 209 files and 2,581 tests passed in 370.36s with one worker.
- Production build/type checks passed for the current source; maintenance navigator exposes 9 cleanup/inspection operations.
- Full responsive matrix passed at 1440, 1024, 768, 390, 320, and 844x390, including running-session overflow, settings layout, maintenance confirmations/results, clipboard fallback, and system log flows.
- Browser notification subscribe/registered/conflict/denied/cancelled/storage-failure/timeout fixtures passed; offline dashboard/task-board/reconnect checks passed.
- Installed live UI smoke passed at 1440/390 (68 sessions, 31 child sessions, 4 messages, reconnect passed).
- Real live actions against a fresh disposable Git repository nested under `output/live-actions-project-*` passed desktop/mobile New Chat, lost acknowledgment reload, rename/reply, steering with turn fence and Stop, duplicate send, child-agent transcript, goal completion, files/conflicts/delete/path/image/Markdown, terminal ownership/stream/cancel/reload, Git stage/diff/commit/local-remote push, Reviews/Agents, fork/archive/restore/delete, offline/reconnect, and account filters.
- The responsive run now verifies compact three-dot row menus, same-slot running spinner replacement, contextual Stop/Start-or-Resume/queue/archive/delete actions, compact turn usage, and all six viewport sizes. Browser notification and offline/reconnect fixtures also passed.
- Earlier installed responsive read-only smoke: desktop 1160 ms, mobile 584 ms; both reconnect checks passed.
- Installed real New Chat, first response, rename and reply passed individually. Full action run still has failures and is not a completion gate yet.
- Verified `codex-manager-1.6.0-pre.27.vsix` packaged and installed; the installed real action matrix passed. Commit and push are the remaining delivery gates.
- External limits remain: authenticated GitHub mutations, real remote peers, reboot recovery, storage exhaustion, and alternate operating systems cannot be executed in this host; they are not claimed as verified.
