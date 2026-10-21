import { createHash } from "crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isDeepStrictEqual } from "util";
import { hasAccountRows, readAccountIndex } from "./sqliteAccounts";
import { isManagedStatePath, SqliteStateStore } from "./sqliteState";
import { initializeUsageStorage, readUsageRows, readDailyUsageRows } from "./sqliteUsage";
import { pruneSessionCache } from "./sqliteSessions";
import { compactManagerDatabase } from "./databaseMaintenance";
import { pruneManagerCache } from './managerCache';
export { pruneManagerLogRows } from "./logRetention";

export async function maintainManagerDatabases(store: SqliteStateStore): Promise<void> {
  cleanupManagerStorage(store);
  pruneManagerCaches(store);
  await compactManagerDatabase(store.file);
  const logs = path.join(path.dirname(store.file), "manager_logs.sqlite");
  const info = await fs.lstat(logs).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
  if (!info?.isFile() || info.isSymbolicLink()) return;
  const preference = store.get<{text?: string}>("files", "logging-settings.json");
  let days = 3;
  try {
    const policy = JSON.parse(preference?.text ?? "{}") as { retentionDays?: unknown } | null;
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return;
    const value = policy.retentionDays;
    if (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 30) days = value;
  }
  catch { return; } // Preserve diagnostics when their saved policy cannot be read.
  await compactManagerDatabase(logs, { days, now: new Date() });
}

/** Short SQL-only sweeps of expendable Manager state; recovery and unknown namespaces stay intact. */
export function pruneManagerCaches(store: SqliteStateStore, now = Date.now()): void {
  pruneSessionCache(store, now);
  try { pruneManagerCache(store, now); }
  catch (error) { console.warn('[codexManager] optional read cache cleanup deferred', error); }
  store.transaction(() => {
    store.prepare("DELETE FROM state WHERE namespace='shared-reads' AND (CASE WHEN json_valid(value) THEN COALESCE(json_extract(value,'$.completedAt'),0) NOT BETWEEN ? AND ? ELSE 1 END)").run(now - 60_000, now + 5_000);
    store.prepare("DELETE FROM state WHERE namespace='once-operations' AND (CASE WHEN json_valid(value) THEN json_type(value) NOT IN ('integer','real') OR json_extract(value,'$') NOT BETWEEN ? AND ? ELSE 1 END)").run(now - 10 * 60_000, now + 60_000);
  });
}

/** Remove retired data and proven duplicate archives; unknown recovery bytes stay intact. */
export function cleanupManagerStorage(store: SqliteStateStore): { retired: number; duplicates: number } {
  let retired = 0, duplicates = 0;
  // Initialize lazy schemas before the cleanup transaction can roll back.
  if (store.get("migrations","usage-rows-v1") || store.get("migrations","daily-usage-rows-v1")) initializeUsageStorage(store);
  return store.transaction(() => {
    for (const key of store.keys("files")) {
      if (key === "announcements" || key.startsWith("announcements/")) {
        store.set("files",key,undefined); retired++;
      }
    }
    for (const key of store.keys("legacy-database-conflicts")) {
      let entry: unknown;
      try { entry = JSON.parse(key); } catch { continue; }
      if (Array.isArray(entry) && entry.length === 2 && entry[0] === "files" && typeof entry[1] === "string" && (entry[1] === "announcements" || entry[1].startsWith("announcements/"))) {
        store.set("legacy-database-conflicts",key,undefined); retired++;
      }
    }
    for (const key of store.keys("legacy-files")) {
      let record: { path?:string; sha256?:string; base64?:string } | undefined;
      try { record = store.get("legacy-files",key); } catch { continue; }
      if (!record || typeof record.path !== "string" || typeof record.base64 !== "string") continue;
      const bytes = Buffer.from(record.base64,"base64");
      if (createHash("sha256").update(bytes).digest("hex") !== record.sha256) continue;
      if (record.path.startsWith("announcements/") || record.path === "always-online-server.js" || record.path.startsWith("cross-window-operations-v1/")) {
        store.set("legacy-files",key,undefined); retired++; continue;
      }
      if (!isManagedStatePath(record.path)) continue;
      const current = record.path === "accounts-index.json" && hasAccountRows(store)
        ? { text:JSON.stringify(readAccountIndex(store)) } : store.get<{text:string|null}>("files",record.path);
      if (current && (current.text === null || current.text === bytes.toString("utf8") || equalJson(current.text,bytes.toString("utf8")))) {
        store.set("legacy-files",key,undefined); duplicates++;
      }
    }
    for (const [key,marker,read] of [
      ["codexManager.dashboardUsageHistory.v1","usage-rows-v1",()=>readUsageRows(store)],
      ["codexManager.dashboardDailyUsageCache.v1","daily-usage-rows-v1",()=>readDailyUsageRows(store)]
    ] as const) {
      if (!store.get("migrations",marker)) continue;
      const previous = store.get("legacy-state",key);
      if (previous !== undefined && equalJson(JSON.stringify(previous),JSON.stringify(read()))) {
        store.set("legacy-state",key,undefined); duplicates++;
      }
    }
    return { retired,duplicates };
  });
}

function equalJson(left:string,right:string):boolean {
  const parse = (text:string):unknown => {
    const value = JSON.parse(text) as unknown;
    if (Array.isArray(value) && value.every((row:unknown)=>row && typeof row === "object" && typeof (row as Record<string,unknown>)["accountId"] === "string"))
      return (value as Array<Record<string,unknown>>).sort((a,b)=>JSON.stringify([a["accountId"],a["at"],a["fetchedAt"]]).localeCompare(JSON.stringify([b["accountId"],b["at"],b["fetchedAt"]])));
    return value;
  };
  try { return isDeepStrictEqual(parse(left),parse(right)); }
  catch { return false; }
}
