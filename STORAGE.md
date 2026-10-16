# Manager storage and migration

Codex Manager stores its durable data in the canonical user home directory, independent of an isolated window's `CODEX_HOME`:

| Location | Contents |
| --- | --- |
| `~/.codex/manager.sqlite` | Account metadata and rotating backups; encrypted account recovery; preferences; global/workspace state; usage, conversations, and session recovery; account claims; operation leases; relay configuration and PID; maintenance markers; legacy recovery archives. |
| `~/.codex/manager_logs.sqlite` | Redacted diagnostic records and imported legacy diagnostics, with configurable UTC-day retention. Created when logging is enabled or legacy storage is migrated. |
| `auth.json` | Codex's required credential file. Isolated Codex windows require their own native home and credential file. |

Both databases use WAL, full synchronous commits, and a 100 ms storage-lock timeout. SQLite may create `-wal` and `-shm` companions while connections are open; these are part of the databases and must not be removed manually. Tokens continue to use OS-backed VS Code SecretStorage; password-encrypted recovery stays in `manager.sqlite`.

Manager-owned JSON, JSONL, PID, lock-owner, copied relay-script, and startup-launcher files are no longer written during normal extension operation. Open Persistent Logs shows the latest 1,000 records in an editor buffer without exporting a disk file. Dashboard preference changes write SQLite and notify local consumers immediately; other windows observe changes within 250 ms. Existing VS Code preferences are imported, and explicit edits in VS Code's Settings editor are still accepted. Settings Sync retains its transport for encrypted synchronization data.

Codex itself owns its configuration, session transcripts, attachments, caches, and databases. Those files are not manager storage and are left intact. Explicit user exports, edited workspace files, and temporary CLI image inputs are also outside managed persistence.

## Account and session rows

Accounts use one primary-keyed row per account, with indexes for enabled queue order and update time. Account changes, scoped active-account selections, and rotating recovery snapshots commit together. Concurrent windows merge independent changes before saving; single-account lookups read directly by ID. Quota history uses `(account_id, at)` rows and daily usage uses one row per account, preventing duplicate samples and stale daily responses from replacing newer data. Existing aggregate records convert automatically on first use.

Running-turn recovery uses `running_turns`. Live updates use `session_turns`, indexed by home, device, session, and account; native running checks use `session_status`. One shared connection reuses prepared statements and one change poll per host; committed topic revisions notify settings, account, usage, and live-session subscribers across windows. Rolled-back and unchanged writes do not notify. Snapshots and native status changes batch in one transaction every 250 ms, retain at most 128 pending turns during contention, and retry storage errors. Queue overflow reports a warning. Turn/token totals remain queryable; display messages, diffs, and plans are compacted after five minutes. Codex retains the full transcript. Restarted or rebooted hosts recover snapshots as disconnected until checked, and native status expires after 30 seconds. Optional discovery shares a 30-second SQLite result across windows, updates it when known native status changes, and never gates manual actions. Credentials use one in-flight read per account, with invalidation on SecretStorage events so late reads cannot refill a stale cache. Subscribers and timers are disposed with their owning hosts.

Account attribution is captured when a managed turn starts, so switching accounts does not reassign a running turn. Native or remote turns whose account cannot be established retain an unknown account rather than guessing. These tables record only sessions observed by the manager; past native transcripts are not imported as historical account statistics.

Example read-only queries:

```sql
SELECT id, email, enabled, queue_priority FROM accounts ORDER BY position;
SELECT account_id, COUNT(*) AS turns, SUM(total_tokens) AS tokens
FROM session_turns GROUP BY account_id;
SELECT account_id, at, hourly, weekly FROM usage_samples ORDER BY at DESC LIMIT 100;
```

## Existing-user migration

The extension runs migration before account actions become available:

1. Find the former `~/.codex-manager` folder. Fresh installations skip this step.
2. Check the old database schema and integrity. Require older extension hosts and detached relays to release their connections and leases before proceeding.
3. Import committed database rows into `manager.sqlite`, retaining newer destination changes. Existing deletion markers stay authoritative over stale JSON files.
4. Import legacy managed JSON for file-only installations. Store every leftover file, including unknown files and incomplete recovery snapshots, as a byte-for-byte SQLite archive. Import JSONL diagnostics into `manager_logs.sqlite`; incomplete lines remain in the archive.
5. Verify committed archives and check that the source file set and contents have not changed. Move any native isolated Codex homes under `.codex`, remap stored paths, and replace an existing Windows startup launcher with a registry entry pointing to the packaged relay script.
6. Remove `~/.codex-manager` only after verification. Database transactions, source retention, and import markers allow interrupted migrations to retry without duplicating logs or overwriting subsequent destination edits.

Unreadable, linked, unsupported, oversized, locked, or conflicting sources stop cleanup and report an activation error. Each legacy file is limited to 32 MiB for bounded migration memory. Storage-full and write failures retain source files. Cleanup retries preserve committed rows even after a partially deleted source directory; orphaned database recovery files block deletion. Byte archives retain the original contents, including any native credentials in isolated homes, with the database access protections. Migration does not install the extension or restart applications.

Retired announcements, copied relay code, and obsolete lock-owner archives are removed after migration. Redundant managed-file archives and aggregate usage migration copies are removed only when their contents match the authoritative records; unverified recovery data and account backups remain.

## Audited legacy file inventory

| Former storage files | Destination / treatment |
| --- | --- |
| `codex-manager.sqlite` and its WAL | Recover committed rows into `manager.sqlite`; checkpoint safely before removing the old database. |
| `accounts-index.json`, `accounts-index.backup-*.json` | SQLite managed state; older physical copies are archived. |
| `accounts/*.json`, `encrypted-accounts-vault.json` | Encrypted recovery records in SQLite; preserve deletion markers. |
| `logging-settings.json`, `logs/*.jsonl` | Preferences in `manager.sqlite`; records and original log bytes in `manager_logs.sqlite`. |
| `announcements/*.json` | Retired feature; removed after migration and cleanup. No service, feed, cache, or UI remains. |
| `maintenance-*.json`, `startup-sync-cooldown.json` | SQLite maintenance markers. |
| Running-turn, window-slot, and account-claim JSON | SQLite session recovery and coordination state. |
| `cross-window-operations-v1/**` | Archive obsolete files after checking owners; new operation leases use SQLite. |
| `always-online-relay.json`, `always-online-relay.pid` | SQLite configuration/PID; relay reads the same database. |
| Copied `always-online-server.js`, `*.tmp-*`, unknown leftovers | Preserve bytes in SQLite archives; execute the installed relay script directly. |
| `window-codex-homes-v1/**` | Preserve native Codex runtime files under `.codex`; archive original bytes and remap manager references. |

The rollout is to verify migration and failure cases, run the complete regression suite, build the prerelease VSIX, and commit/push the implementation. Actual migration happens when the new version activates; publishing or installing remains a separate action.
