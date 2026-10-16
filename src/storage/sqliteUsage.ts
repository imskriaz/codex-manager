import type { DashboardUsageSample, DashboardDailyUsageCacheEntry } from "../domain/dashboard/types";
import type { SqliteStateStore } from "./sqliteState";

const initialized = new WeakSet<SqliteStateStore>();
export function initializeUsageStorage(store:SqliteStateStore):void {
  if (initialized.has(store)) return;
  store.database.exec(`CREATE TABLE IF NOT EXISTS usage_samples (
    account_id TEXT NOT NULL,at REAL NOT NULL,hourly REAL,weekly REAL,review REAL,PRIMARY KEY(account_id,at)
  ); CREATE INDEX IF NOT EXISTS usage_by_time ON usage_samples(at);
  CREATE TABLE IF NOT EXISTS daily_usage(account_id TEXT PRIMARY KEY,fetched_at REAL NOT NULL,data TEXT NOT NULL);`);
  store.watchTable("usage_samples","usage");
  store.watchTable("daily_usage","usage");
  initialized.add(store);
}

export function readUsageRows(store:SqliteStateStore):DashboardUsageSample[] {
  initializeUsageStorage(store);
  return store.prepare("SELECT * FROM usage_samples ORDER BY at,account_id").all().map(row=>({
    accountId:String(row["account_id"]),at:Number(row["at"]),hourly:row["hourly"] === null ? undefined : Number(row["hourly"]),
    weekly:row["weekly"] === null ? undefined : Number(row["weekly"]),review:row["review"] === null ? undefined : Number(row["review"])
  }));
}

export function replaceUsageRows(store:SqliteStateStore,samples:readonly DashboardUsageSample[],legacyKey:string,onlyIfMissing=false):void {
  initializeUsageStorage(store);
  const keys = new Set(samples.map(sample=>JSON.stringify([sample.accountId,sample.at])));
  store.transaction(()=>{
    if (onlyIfMissing && store.get("migrations","usage-rows-v1")) return;
    for (const row of store.prepare("SELECT account_id,at FROM usage_samples").all()) {
      if (!keys.has(JSON.stringify([row["account_id"],row["at"]])))
        store.prepare("DELETE FROM usage_samples WHERE account_id=? AND at=?").run(String(row["account_id"]),Number(row["at"]));
    }
    const write = store.prepare(`INSERT INTO usage_samples(account_id,at,hourly,weekly,review) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id,at) DO UPDATE SET hourly=excluded.hourly,weekly=excluded.weekly,review=excluded.review
      WHERE hourly IS NOT excluded.hourly OR weekly IS NOT excluded.weekly OR review IS NOT excluded.review`);
    for (const sample of samples) write.run(sample.accountId,sample.at,sample.hourly ?? null,sample.weekly ?? null,sample.review ?? null);
    finishMigration(store,legacyKey,"usage-rows-v1");
  });
}

export function readDailyUsageRows(store:SqliteStateStore):DashboardDailyUsageCacheEntry[] {
  initializeUsageStorage(store);
  return store.prepare("SELECT data FROM daily_usage ORDER BY fetched_at DESC LIMIT 64").all().map(row=>JSON.parse(String(row["data"])) as DashboardDailyUsageCacheEntry);
}

export function replaceDailyUsageRows(store:SqliteStateStore,entries:readonly DashboardDailyUsageCacheEntry[],legacyKey:string,onlyIfMissing=false):void {
  initializeUsageStorage(store);
  const ids = new Set(entries.map(entry=>entry.accountId));
  store.transaction(()=>{
    if (onlyIfMissing && store.get("migrations","daily-usage-rows-v1")) return;
    for (const row of store.prepare("SELECT account_id FROM daily_usage").all()) {
      if (!ids.has(String(row["account_id"]))) store.prepare("DELETE FROM daily_usage WHERE account_id=?").run(String(row["account_id"]));
    }
    const write = store.prepare(`INSERT INTO daily_usage(account_id,fetched_at,data) VALUES(?,?,?) ON CONFLICT(account_id)
      DO UPDATE SET fetched_at=excluded.fetched_at,data=excluded.data WHERE excluded.fetched_at>=daily_usage.fetched_at AND (daily_usage.data!=excluded.data OR daily_usage.fetched_at!=excluded.fetched_at)`);
    for (const entry of entries) write.run(entry.accountId,entry.fetchedAt,JSON.stringify(entry));
    finishMigration(store,legacyKey,"daily-usage-rows-v1");
  });
}

function finishMigration(store:SqliteStateStore,legacyKey:string,marker:string):void {
  const legacy = store.get("global",legacyKey);
  if (legacy !== undefined && !store.get("migrations",marker)) store.set("legacy-state",legacyKey,legacy);
  store.set("global",legacyKey,undefined);
  store.set("migrations",marker,true);
}
