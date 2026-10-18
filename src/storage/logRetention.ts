import type { SqliteStateStore } from "./sqliteState";

export function logRetentionCutoff(days: number, now: Date): string {
  if (!Number.isInteger(days) || days < 1 || days > 30 || !Number.isFinite(now.getTime())) throw new Error("Invalid log retention policy.");
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86_400_000).toISOString();
}

/** Share these exact SQL statements with background workers; payloads never enter JavaScript. */
export function managerLogCleanupStatements(days: number, now: Date): Array<{ sql: string; params: string[] }> {
  const cutoff = logRetentionCutoff(days, now);
  return [
    { sql: "DELETE FROM state WHERE namespace='logs' AND key<?", params: [cutoff] },
    { sql: `DELETE FROM state WHERE namespace='logs' AND key NOT IN (
      SELECT key FROM (SELECT key,SUM(record_bytes) OVER (ORDER BY key DESC ROWS UNBOUNDED PRECEDING) AS bytes
        FROM (SELECT key,length(CAST(value AS BLOB)) AS record_bytes FROM state WHERE namespace='logs' ORDER BY key DESC LIMIT 10000)) WHERE bytes<=33554432
    )`, params: [] },
    { sql: "DELETE FROM state WHERE namespace='legacy-files' AND key LIKE 'logs/codex-manager-%' AND substr(key,20,10)<?", params: [cutoff.slice(0, 10)] },
    { sql: `DELETE FROM state WHERE namespace='legacy-files' AND key LIKE 'logs/codex-manager-%' AND key NOT IN (
      SELECT key FROM (SELECT key,SUM(length(CAST(value AS BLOB))) OVER (ORDER BY key DESC ROWS UNBOUNDED PRECEDING) AS bytes
        FROM state WHERE namespace='legacy-files' AND key LIKE 'logs/codex-manager-%') WHERE bytes<=33554432
    )`, params: [] }
  ];
}

export function pruneManagerLogRows(store: SqliteStateStore, days: number, now = new Date()): void {
  const statements = managerLogCleanupStatements(days, now);
  store.transaction(() => { for (const { sql, params } of statements) store.prepare(sql).run(...params); });
}
