# Workspace speed and realtime reliability plan

## Goal

Make the workspace feel immediate while keeping state trustworthy when the
connection, session owner, browser tab, or local storage changes.

The current code already has useful safety fences: WebSocket reconnect with
backoff, snapshot revision checks, bounded action maps, live session events,
durable message queues, and explicit unknown or unconfirmed states. The main
cost is that several paths still rebuild broad state or wait for a full action
round trip before the interface can show local progress.

## Findings from the current code

- `media/webview/browserHost.js` keeps one in-flight snapshot and reconnects with
  500 ms to 5 s backoff. It correctly drops stale snapshots by revision, but a
  reconnect can still wait for a full `/api/state` response before all derived
  dashboard views settle.
- `src/services/webDashboardServer.ts` builds and sends broad snapshots for
  many actions. Session list and transcript actions are already excluded from
  the immediate snapshot path, but the remaining state payload is still larger
  than a workspace view needs.
- Session live updates are pushed over WebSocket and merged in the webview, but
  transcript reads and session-list reads remain separate requests. A selected
  workspace can therefore render a stale list while its live turn is current.
- `webview-src/dashboard/cliSessionsModal.tsx` renders the sidebar, transcript,
  composer, queue, and workspace rail in one component tree. Realtime messages
  can invalidate more of this tree than the changed session requires.
- `webview-src/dashboard/cliMessageQueue.ts` writes queue state before dispatch,
  prevents blind replay after timeout, and now supports Send now ordering. Queue
  and Steer are per-composer settings; Queue deliberately waits for the active
  turn to finish, while Steer uses the verified turn fence.
- The host already suspends some work in hidden tabs and uses bounded timers,
  but there is no single measured budget for first workspace paint, first live
  event, action acknowledgement, or reconnect recovery.

## Implementation phases

### 1. Measure before changing behavior

Add lightweight development diagnostics around:

- navigation to workspace,
- snapshot request and response size,
- session list and transcript request duration,
- first WebSocket open and first live session event,
- action sent, action acknowledged, and action outcome confirmed,
- reconnect start, socket open, snapshot accepted, and stale snapshot dropped.

Record p50/p95 values in the existing UI check output. Keep the diagnostics
disabled in production or sample them at a low rate. Set budgets before
optimizing: first usable workspace under 500 ms from cached state, first live
event under 1 s when the socket is available, local send/queue feedback in the
same frame, and reconnect recovery under 3 s on a healthy local host.

### 2. Make selected workspace data incremental

Introduce a small workspace-scoped realtime payload containing only:

- the selected session status and current turn,
- changed transcript items or a bounded live tail,
- queue and prompt changes for that session,
- a monotonic session revision and source system ID.

Keep the broad dashboard snapshot for startup and settings. On a selected
workspace, apply the incremental payload first and request a transcript refresh
only when the revision gap, truncation marker, or source change says it is
needed. Never merge an older payload over a newer live revision.

Files to inspect together: `src/services/webDashboardServer.ts`,
`src/domain/dashboard/types.ts`, `src/domain/codexSessionLive.ts`,
`webview-src/dashboard/cliSessionLiveState.ts`, and
`media/webview/browserHost.js`.

### 3. Reduce render work without hiding state

Split the large session page at stable boundaries:

- session sidebar keyed by session-list revision,
- transcript keyed by selected session and message revision,
- composer and queue keyed by composer scope,
- workspace tools keyed by project and active tab.

Memoize only these boundaries and keep the existing local feedback behavior.
Do not virtualize the transcript until measurements show large histories are a
real cost; if needed, virtualize only completed activity while preserving the
live tail, keyboard focus, and question anchors.

### 4. Make manual actions locally immediate

Use the existing durable queue and optimistic local state for visible intent:

- show a queued or steering row immediately after the local fence is saved,
- keep the composer draft independent from the action result,
- show the exact pending, confirmed, failed, cancelled, or unconfirmed state,
- reconcile with the owner echo or action result before removing the local row.

Extend this pattern to refresh, stop, resume, file reads, and terminal controls
where the current UI waits for a broad snapshot. Never claim completion from a
local optimistic state alone.

### 5. Tighten realtime recovery

Keep the current backoff and no-blind-replay rules, then add:

- a single reconnect coordinator so visibility, offline, socket-close, and
  manual retry cannot start overlapping probes;
- a bounded stale-data banner that names the last accepted revision/time;
- a delta catch-up request after reconnect before falling back to a full state
  snapshot;
- explicit source-generation fencing for actions and live events after account
  or host changes;
- a test for a socket that opens, drops during an action, and returns an
  acknowledgement from the old generation.

### 6. Storage and queue pressure

Measure IndexedDB write latency and queue bytes. Keep the current hard limits,
but coalesce adjacent queue writes and surface a warning before the hard limit.
Send now must remain a reorder operation until its durable write succeeds; Queue
must never dispatch while a verified turn is running; Steer must include the
expected turn ID and fail closed when it changes.

### 7. Verification matrix

Focused tests should cover:

- cached workspace paint followed by a newer live delta,
- stale snapshot after a newer delta,
- reconnect during send, stop, steer, refresh, and transcript load,
- duplicate socket opens and overlapping manual retries,
- source/account change with late action results,
- Queue and Steer mode across reload, offline, full storage, timeout, and
  completed-turn transitions,
- Send now reordering before and after reconnect,
- large transcript rendering and bounded live-tail trimming.

Then run the full regression suite, lint, webview typecheck, extension build,
VSIX packaging, local VSIX installation, and the read-only local UI checks at
`http://127.0.0.1:39875`. Record timings and any unverified external cases in
`WORKSPACE-GOAL.md`.

## Risks and limits

- Smaller deltas can hide a missed event if revision fencing is incomplete;
  every delta needs a gap or truncation signal and a full-refresh fallback.
- Memoization can preserve stale callbacks if scope keys are wrong; tests must
  switch sessions and devices while actions are pending.
- Optimistic controls can mislead users if success is shown before owner
  confirmation; use pending language until the result or transcript echo.
- Actual reboot, storage exhaustion, remote peer latency, and long-run memory
  pressure remain environment-dependent and must be reported separately from
  local fixture results.

## Proposed order

Measure first, then incremental selected-session events, then render boundaries,
then optimistic manual actions, then reconnect and storage pressure tuning.
Re-run the same timing and failure matrix after each phase so a faster path does
not quietly weaken delivery or recovery guarantees.

## Compact workspace plan

Keep the existing mobile layout as the source of truth and reduce density in
small, reversible steps:

1. Keep the conversation title, connection state, and primary action visible;
   move secondary actions into labeled icon buttons with tooltips and
   accessible names. Never remove the text alternative from an icon-only
   control.
2. Keep one compact session row per conversation: status icon, two-line title
   and project metadata, then time. Use the existing search and project groups
   instead of repeating context in every row.
3. Keep transcript activity collapsed by default, with a clear activity glyph,
   status, and short summary. Open tool arguments, results, command output, and
   file changes on demand; preserve copy, keyboard focus, and the live tail.
4. Keep the Composer to two rows on a phone: message field, attachment, model,
   access, and send/stop. Place less-used settings behind the existing
   anchored popover and keep the input at readable text size.
5. Measure each change at 320, 390, 768, and 1440 pixels in light and dark
   themes. The acceptance bar is no horizontal scroll, 44px touch targets,
   visible focus, readable labels, and no loss of error or pending states.

The compact pass should delete repeated decoration before shrinking type. Body
text stays at a readable size; density comes from spacing, grouping, and icon
placement. Virtualize only completed transcript activity after profiling shows
that the live tail needs it.
