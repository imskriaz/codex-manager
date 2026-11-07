# Workspace speed and realtime reliability plan

## Scope and current behavior

The mobile browser workspace already provides the conversation list, transcript,
reasoning and tool details, composer, prompts, files, terminals, Git, reviews and
agents. Its compact layout uses labeled icons, collapsible activity, responsive
dialogs and follow-latest scrolling. Preserve those controls, readable text,
keyboard focus, drafts and browser-local queue ownership.

This implementation removes avoidable recovery and render work using the existing
protocol. It does not promise zero network latency. Do not add another delta
protocol, revision-dependent React keys, server-owned composer queues or queue
write coalescing: each would add a second contract without measured need.

## Implementation checklist

| Area | Change | Completion assertion |
| --- | --- | --- |
| Startup/reconnect | In `src/services/webDashboardServer.ts`, `sendRealtimeSnapshot` replays bounded live state, access events and prompts before awaiting dashboard state; cap the state wait at five seconds. | A hung/failed state build emits a warning without closing the usable socket; a closed client receives no late snapshot. |
| Startup listener | In `media/webview/browserHost.js`, retain the latest 30 session live states and latest prompts only until the dashboard listener is ready. | Early live activity replays once, remains bounded, and releases after mount or authentication loss. A different source snapshot clears old startup state. |
| Connection reuse | Reuse `connectingSocket`, `reconnectTimer` and `snapshotInFlight`; preserve healthy/connecting sockets on focus and online events. Share overlapping manual retries. | One handshake and one snapshot fetch; one manual retry outcome. Existing ten-second handshake timeout and 500 ms–5 s retry backoff remain bounded. |
| Transport pressure | Reject sends above the existing server's 4 MiB browser transport pressure threshold. | The initiating action receives an immediate failure saying it was not sent. No automatic HTTP fallback or mutation replay; explicit retry works after drain. |
| Incremental activity | Reuse `dashboard:codex-session-live`, bounded full tails, `streamId`, `sequence`, device identity and truncation. In `webview-src/dashboard/main.tsx`, ignore rejected terminal events before requesting history. | Duplicate, obsolete and out-of-order frames cannot revoke current authority or trigger duplicate completion refreshes. |
| History reads | Use `hasCurrentCliLiveHistory` in `webview-src/dashboard/cliSessionLiveState.ts` to skip redundant running history reads only after initial history is loaded and current complete authoritative live state exists. | Missing history, changed project/turn/device, truncated/absent/disconnected authority and explicit refresh retain recovery reads; accepted completion refreshes saved history. |
| Render work | Preserve unchanged session object and array identities during message-only updates. Sort the live registry only when trimming beyond 30 sessions. | Status transitions still update rows. Composer identity, draft, focus and queue lock survive token updates. |
| Diagnostics | Correct `socketMs`, `firstLiveMs` and `reconnectMs` in `browserHost.js`; summarize finite samples in `tools/check-live-ui.mjs`. | First socket open stays fixed; first live means a session event, not a notice; reconnect measures the last completed transport recovery, including manual retry. |
| Node storage policy | Remove unused synthetic `globalStorageUri` in `src/node.ts`. | `test/storageRoot.test.ts` passes; storage stays at the shared root. |

Existing send/steer, Stop, resume, file and terminal actions already bypass broad
snapshots. Keep their immediate pending feedback and request-scoped outcomes.
Stop confirmation means the request was accepted, not that the turn has ended.
No optional discovery, snapshot or recovery wait may gate these manual actions.

The browser queue remains exclusively browser-owned through `navigator.locks`.
Persisted dispatch and Send now reorder writes remain commit barriers. Storage
failure must retain the draft/queue and prevent an unsafe send. No optimistic
success or automatic replay follows an unknown mutation outcome.

## Failure and compatibility contract

Keep existing full-tail validation and timestamp/stream/sequence acceptance;
this change introduces no protocol or persisted-schema migration. List
`realtimeRevision` continues to fence owner-scoped list responses; it is not a
live-stream sequence. Browser `sourceGeneration` continues to fence action
results after a snapshot identifies a different system; it is not a process
boot ID and does not claim same-device reboot detection.

- Offline, expired authentication, socket close and lost acknowledgement keep
  their current explicit offline/unconfirmed states and no-blind-replay rules.
- Missing, stale or corrupt cache falls back to existing list/history/state
  requests; it never becomes authority for sending or steering.
- Partial/truncated or unavailable live history retains disk history recovery.
  Quiet sessions do not need to emit a new event for the socket to remain usable.
- Snapshot timeout/failure preserves live activity and displayed data, emits a
  warning, and allows Refresh dashboard to retry. Late completion does not send
  an extra snapshot after the bounded attempt has ended.
- Focus and online notifications do not abandon pending actions on healthy
  sockets. Actual close still reports unknown outcomes and reconnects once.
- Queue-full, storage-full, ownership loss and reload keep existing durable
  fences. Backpressure rejects before transport send; it does not clear drafts.
- Same-device host reboot, real remote latency, sustained storage exhaustion and
  long-run memory pressure require separate environmental verification. Existing
  stream replacement and persisted-queue tests are simulations, not reboot proof.

## Verification and delivery

Finish the implementation audit before starting tests. Changed implementation
paths are those listed above, plus `src/domain/dashboard/types.ts` formatting;
update only their associated tests, this plan, `WORKSPACE-GOAL.md`, changelog,
`package.json` and root `package-lock.json`. Use no new dependencies.

1. Focused tests: `test/browserHost.test.ts`,
   `test/browserRealtimeRecovery.test.ts`, `test/cliSessionLiveState.test.ts`,
   `test/webDashboardSessionLive.test.ts`, `test/storageRoot.test.ts`,
   `test/cliSessionsLayout.test.ts`, and `test/cliMessageQueue.test.ts`.
   Cover shared retries, startup replay, bounded buffers, unchanged row identity,
   missing/truncated/stale authority, completion ordering and failed snapshot
   delivery. Retain existing lost-ack, cache, ownership and durable-queue tests.
2. Run the full regression suite, then `npm run verify` and production compile.
   Keep complete logs and actual exit codes; interrupted runs are not passes.
3. Run responsive fixture checks at all six existing sizes in light/dark themes,
   plus notification/offline fixtures. Require no horizontal overflow, accessible
   icon names, visible feedback, readable text and keyboard focus.
4. Run read-only `tools/check-live-ui.mjs --workspace-assets` against the required
   local host. Capture desktop/mobile screenshots, runtime errors, offline
   recovery and timing samples. Do not create sessions or send messages.
5. This slice increments `1.7.3-pre.5` once to `1.7.3-pre.6`; a concurrent
   access-profile slice advances to `1.7.3-pre.7`, and the toolbar style slice to
   `1.7.3-pre.8`. Preserve all changelog entries and synchronize manifest/lock versions. Package and verify
   the final agreed snapshot, install it in local VS Code, commit intended
   changes directly on `main`, then push. Do not publish tags or releases.
6. Record exact results and remaining environment limits in `WORKSPACE-GOAL.md`.
   Workspace client assets against the running host do not prove that the host
   process has reloaded the newly installed extension.

## Measurement limits and next profiling pass

`loadMs` in the live smoke script measures navigation to a visible dashboard.
The host timings start at bridge initialization: `socketMs` ends at its first
socket open; `firstLiveMs` ends at the first session event and is absent for quiet
hosts; `reconnectMs` ends at socket open after a recovery start. Reconnect timing
does not measure accepted transcript recovery. The script navigates again, so
its load sample and final bridge timings may come from different documents.
Two viewport samples provide smoke evidence only, even when p50/p95 are printed.

For performance acceptance, take at least 30 warm-cache and 30 cold-cache runs
separately on the same hardware/browser and fixed session fixture; record host
version, cache condition and sample count. Add navigation-to-usable-transcript,
action-acknowledgement and recovery-to-accepted-state timings before claiming
budgets. Provisional targets are 500 ms cached usable workspace, 1 s first session
event on an available local socket, and same-frame local pending feedback.
A 3 s reconnect target applies only to immediate healthy-host recovery, not the
maximum 5 s backoff after repeated failures. These targets are not measured gains.

Only after profiling shows a remaining cost: extract stable memoized component
boundaries without changing component keys, consider completed-history
virtualization while preserving the live tail, or specify a new catch-up protocol
with retention, timeout and full-refresh fallback. Keep queue coalescing deferred
unless its commit barriers and failure propagation can be proven equivalent.

## Combined access-profile delivery

The user authorized including the concurrent access-profile fix after
verification. Its scope is `src/domain/codexSessionAccess.ts`,
`src/services/codexSessionResume.ts` and their six access/app-server/native tests.
Full explicitly selects `:danger-full-access` for session creation, resumed
turns and settings changes. Confirmation compares both effective mode and
selected profile; unchanged approval settings remain unchanged. Restricted modes
retain their sandbox policy. Starting a new turn fails visibly when the selected
profile cannot be confirmed or its recovery record cannot be persisted.

Audit the parser, sync/native confirmation callers and persistence first; then
run the access-focused tests before restarting the full combined regression.
Keep the superseded in-progress regression log, but do not count it as a pass.
Package/install/commit the verified combined `pre.8` snapshot; live read-only
checks do not claim to exercise a real access mutation.

The user assigned final verification and delivery to another active task. This
task leaves implementation and focused results in the shared main checkout and
does not duplicate that owner's jobs. See `output/workspace-speed-handoff.md`
for the interrupted regression failure and required production asset rebuild.
