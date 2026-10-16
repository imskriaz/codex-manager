import { createHash } from "crypto";
import { isDeepStrictEqual } from "util";
import { hasAccountRows, readAccountIndex } from "./sqliteAccounts";
import { isManagedStatePath, type SqliteStateStore } from "./sqliteState";
import { initializeUsageStorage, readUsageRows, readDailyUsageRows } from "./sqliteUsage";

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
      const rows = read();
      const previous = store.get("legacy-state",key);
      if (previous !== undefined && equalJson(JSON.stringify(previous),JSON.stringify(rows))) {
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
