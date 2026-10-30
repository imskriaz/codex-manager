# Workspace completion goal

Objective: end to end fix all gaps and support in workspace, including all UI/UX and verification work. A passing subset does not complete this goal.

## Tasks and verification gates

| Area | Required behavior and evidence | Current state |
| --- | --- | --- |
| Session creation | Desktop/mobile New Chat, selected project, first response, stale catalogue, deep link and reload | Real flows passed individually; final installed run pending |
| Conversation actions | Reply, steer with turn fence, Stop, duplicate request handling, interrupted non-goal play/resume | Reply/duplicate/reload verified; live steering still needs an owned app-server turn in the current provider run |
| Session lifecycle | Rename, fork, archive, restore, delete, missing/archived handling | Rename verified; remaining real checks open |
| Goals and automation | Create/display/complete/pause/resume goals; preserve existing Auto Resume behavior | Regression and real verification pending |
| Session/message parity | User/assistant, reasoning, plans, tools, commands, changes, images, attachments, approvals/questions, collaboration, errors, compaction, usage | Parser/render coverage exists; full parity audit and final UI verification open |
| Files | Browse/refresh/open/edit/save/delete; image/Markdown previews; links; stale revision, missing/escaping path, binary/large files | Conflict/path guards verified; final real UI run pending |
| Terminal | Create/select/control/input/resize/clear/cancel/close; streaming, snapshot/reload, ownership and reconnect | Real cancellation/ownership passed; streaming/reload open |
| Git/worktrees | Status/diff/history, stage/unstage/discard, staged commit, fetch/pull/push, branches, merge/abort, stash lifecycle; linked worktree isolation | Real Git fixture coverage exists; linked-worktree and final browser verification open |
| GitHub | Auth/missing auth, lists/details, comments, issues/PR actions/checks/workflows, confirmed mutation outcomes | Fixture/service coverage exists; real authenticated remote verification unavailable until a disposable remote is configured |
| Reviews and Agents | Turn/branch changes, diffs, child creation/list/transcript/refresh and empty/error states | Final real UI run pending |
| UI/UX Pro Max | Every workspace screen: desktop/mobile, light/dark, no overflow, visible loading/running feedback, accessible icons/focus/dialogs, preserved drafts and clear outcomes | Spinner/draft/route/flyout/settings fixes implemented; full responsive matrix green |
| Failure handling | Offline/stale/missing/partial/reconnect/retry/duplicate/queue-full/storage-full/reboot/timeout/failure; no blind replay or lost edits | Focused coverage expanded; full regression pending |
| Performance | Immediate manual actions, bounded optional work, lazy panels, hidden-tab idle behavior, bounded streams/queues and cleanup | Existing lazy-panel checks; transport cleanup hardened; final timing/resource checks pending |
| Delivery | Focused tests → full regression → verify → VSIX → install → installed real UI/action run → commit all intended files → push main | In progress; no public publication authorized |

## Evidence rules

- Record exact commands/results and artifact paths; distinguish real provider/UI checks from fixtures and service tests.
- A failure caused by a prerequisite remains unverified until rerun successfully.
- Preserve and inspect errors; never weaken assertions to make an unsupported or inconclusive action appear successful.
- Only mutate disposable test sessions/repositories/files during real action checks.
- Do not claim real cross-PC, GitHub writes, alternate OS, reboot, or storage exhaustion coverage without executing it or explicitly identifying the unverified limitation.

## Latest evidence

- Focused transport/composer/layout checks: 84 tests passed.
- Full Vitest regression: 209 files and 2,581 tests passed in 406.62s.
- Production build/type checks passed for the current source; maintenance navigator exposes 9 cleanup/inspection operations.
- Full responsive matrix passed at 1440, 1024, 768, 390, 320, and 844x390, including running-session overflow, settings layout, maintenance confirmations/results, clipboard fallback, and system log flows.
- Browser notification subscribe/registered/conflict/denied/cancelled/storage-failure/timeout fixtures passed; offline dashboard/task-board/reconnect checks passed.
- Installed live UI smoke passed at 1440/390 (68 sessions, 31 child sessions, 4 messages, reconnect passed).
- Installed live actions passed desktop/mobile New Chat, lost acknowledgment reload, rename/reply, files, terminal ownership/stream/cancel/reload, offline/reconnect, and fork/archive cleanup. Steering remains provider-sensitive: the current run can keep a real command active but the host rejects the follow-up as not owned; Git confirmation and authenticated remote/peer/reboot/storage-exhaustion cases remain explicitly unverified.
- Earlier installed responsive read-only smoke: desktop 1160 ms, mobile 584 ms; both reconnect checks passed.
- Installed real New Chat, first response, rename and reply passed individually. Full action run still has failures and is not a completion gate yet.
- Current work is committed and pushed on `main` at `79161bb`. Active installed prerelease source: `1.6.0-pre.26`.
- Verified VSIX: `codex-manager-1.6.0-pre.25.vsix` was installed before the final goal evidence-only update; rebuild/install `pre.26` is the final delivery gate.
