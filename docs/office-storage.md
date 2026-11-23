# Office storage

Set `codexManager.officeDatabaseProvider` to `postgres` and supply the connection in `codexManager.officePostgresUrl`. The PostgreSQL role needs permission to create tables in its database. The connection remains a local host setting and is omitted from dashboard responses.

PostgreSQL is authoritative for non-master Office identities, conversations and retained deleted conversations, turn requests and revisions, usage, sign-ins, notification subscriptions, audit and proxy request logs, diagnostic records attributed to users, memory, recommendations, preferences, schedules, saved projects, integrations, and file-history metadata. Workspace files, uploads, saved versions and Trash contents remain in their owned filesystem folders; their existing path and authorization checks still apply.

The master identity, shared host configuration and credentials, native master conversations, master audit records, and master diagnostic records remain local. The master can sign in and use local conversations while PostgreSQL is unavailable. Management actions that need user records report a storage error.

On first use, migration runs in a driver thread. User writes are rejected with a retry notice until copying and verification finish; master actions stay available. A recovery JSON export is saved next to the local Manager database before copying. Existing PostgreSQL user membership is preserved when upgrading the earlier users-only backend. Other conflicting PostgreSQL records stop migration and preserve the local source.

Migration commits its completion marker in PostgreSQL before retiring copied SQLite records. A restart does not reimport deleted records. A concurrent legacy host changing local records stops cleanup for review. After migration, selecting SQLite is rejected rather than reviving stale users or conversations; changing to another PostgreSQL database requires migrating that database first. Connection failures never redirect user writes to SQLite. A timed-out write can be unconfirmed, so refresh before retrying it.

For PostgreSQL integration verification, compile the extension, set `CODEX_MANAGER_TEST_POSTGRES_URL` to an administrator connection, and run `npx vitest run test/officePostgres.test.ts`. Tests create randomly named databases and remove only those databases; they do not use the application's database.
