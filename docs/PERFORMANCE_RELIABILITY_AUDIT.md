# Performance and reliability audit

This audit follows account credentials and quota requests through storage, background coordination, dashboard state construction, browser transport, UI persistence, subprocesses, and relay lifecycle. It fixes concrete failure paths at the shared boundaries used by these features.

## Findings and changes

| Area | Failure or performance gap | Change |
| --- | --- | --- |
| Provider requests | The timeout and concurrency slot ended at response headers; a stalled body could wait indefinitely. | Read the complete body within the existing deadline and slot, honor cancellation, and cap buffered responses at 8 MB. |
| Usage persistence | Concurrent read/write operations could overwrite each other; stale saves could replace newer history. Appends searched history once per account. | Serialize writes per storage instance, merge persisted samples, reject invalid/future timestamps, and index the latest sample per account in one pass. Explicit clearing remains supported. |
| Browser actions | WebSocket actions had no completion deadline; stalled HTTP requests could leave pending UI actions indefinitely. | Bound waits, clear timers on completion/disconnect, cap pending socket actions at 128, and explain uncertain timeout outcomes before retrying. |
| Dashboard refresh | Building a snapshot after a successful action could hide the action's result and scheduled reload. Failed workbench refreshes could prevent unchanged-state retries. | Preserve completed results and surface snapshot warnings; fail explicit refresh requests; record refresh signatures only after successful refreshes. |
| Browser storage | Cache writes and invalidations could wait indefinitely. Malformed saved preferences could break rendering. | Abort stalled cache transactions after three seconds and validate saved preference shapes and values. |
| Credentials | One unavailable secret could fail the whole dashboard; missing credentials could appear healthy. | Isolate failures per account, require reauthorization for missing credentials, and validate stored credential objects without exposing their contents. |
| Disk persistence | Disk-full writes could leave partial temporary snapshots behind. | Close and remove partial writes while preserving the live account index and existing rename-recovery behavior. |
| Coordination | Failed initialization stayed rejected forever; future cooldown markers suppressed work after clock rollback. Failed batches returned while other workers still mutated state. | Allow initialization retries, validate cooldown age, stop new work after failure, and await active workers before reporting failure. Remove settled mutex keys. |
| Window isolation | Disabled-mode disposal deleted an existing account home; registry failure could leave an overridden environment. | Persist registration before changing the environment, make initialization/disposal idempotent, and ignore late heartbeat updates after disposal. |
| Session bindings | Malformed stored bindings could crash lookups and failed writes could mutate cached state. Non-Windows paths lost case distinctions. | Validate into a fresh record and preserve filesystem-root and platform-specific path semantics. |
| Subprocess transport | Output-stream errors could become unhandled process errors. | Route stdout/stderr failures through the existing RPC failure and cleanup path. |
| Relay lifecycle | Occupied ports or stale PIDs could be reported as a successful start; unconfirmed shutdowns appeared successful. | Require verified health, handle launch errors, bound health/shutdown response waits, and report unconfirmed shutdowns. |
| Dashboard server | Oversized WebSocket messages and peer errors could disrupt the host. | Limit inbound payloads to 2 MB and handle peer errors. |
| Diagnostics | Long plain diagnostic values caused repeated email-pattern retries and could block the extension host for tens of seconds. | Match email candidates only at their boundaries and cover long valid and malformed candidates. |
| Resource retention | Partial transcript records retained entire read buffers; parsing accumulated discarded messages; live deltas repeatedly serialized all items; logging queued unlimited writes behind slow storage. | Copy partial records, parse into the 250-message window, cap retained transcript payload estimates at 32 MB, track live item bytes incrementally, reuse unchanged snapshots, and cap logging queues at 128 records or 2 MB with a skipped-count warning. |
| Browser background work | Session-list replacements recreated the transcript polling callback, causing extra reads; hidden tabs still dispatched periodic UI ticks. | Read current session metadata from a ref so refresh callbacks stay stable, and suppress hidden-tab ticks. |

## Verification scope

The unchanged-history append benchmark uses 10,000 valid samples and takes the median of 30 calls in Node, comparing the original implementation with the audit implementation. Storage is an in-memory Memento stub, so these timings measure processing rather than disk or provider latency:

| Accounts | Original median | Audit median |
| --- | --- | --- |
| 64 | 27.50 ms | 22.08 ms |
| 512 | 39.21 ms | 18.58 ms |
| 2,000 | 98.95 ms | 15.77 ms |

The implementation removes repeated per-account history copies/searches and a second normalization on unchanged refreshes. Timings depend on the host and workload; they are observations rather than enforced CI thresholds.

Regression cases cover stale and duplicate data, concurrent writes, late responses, body stalls, cancellation, retry after failure, queue capacity, disk-full writes, corrupt or missing storage, clock rollback, disabled and repeated disposal, failed refreshes, failed subprocess launches, and inconclusive relay shutdowns. Existing regression coverage also exercises account switching, OAuth, encrypted sync, session streams, recovery, and dashboard behavior.

Verification results and the packaged artifact are recorded in the delivery response. Live UI checks use the configured local test surface without installing the extension or changing accounts. Automated fault injection simulates reboot-related persistence and recovery; it does not replace testing across actual machine restarts or provider outages. The audit establishes coverage for the identified issues, not a guarantee that every possible failure has been eliminated.
