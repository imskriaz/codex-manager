import type { DashboardUsageSample, DashboardDailyUsageCacheEntry, DashboardUsageGraphQuery, DashboardUsageGraphData, DashboardUsageSummary } from "../domain/dashboard/types";
import type { SqliteStateStore } from "./sqliteState";

const initialized = new WeakSet<SqliteStateStore>();
export function initializeUsageStorage(store:SqliteStateStore):void {
  if (initialized.has(store)) return;
  store.database.exec(`CREATE TABLE IF NOT EXISTS usage_samples (
    account_id TEXT NOT NULL,at REAL NOT NULL,hourly REAL,weekly REAL,review REAL,PRIMARY KEY(account_id,at)
  ); CREATE INDEX IF NOT EXISTS usage_by_time ON usage_samples(at);
  CREATE TABLE IF NOT EXISTS daily_usage(account_id TEXT PRIMARY KEY,fetched_at REAL NOT NULL,data TEXT NOT NULL);`);
  store.database.exec(`CREATE TABLE IF NOT EXISTS daily_usage_points (
    account_id TEXT NOT NULL,date TEXT NOT NULL,fetched_at REAL NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account_id,date)
  ); CREATE INDEX IF NOT EXISTS daily_usage_by_date ON daily_usage_points(date,account_id);`);
  if (!store.get("migrations", "daily-usage-points-v1")) store.transaction(() => {
    store.database.exec(`INSERT OR IGNORE INTO daily_usage_points(account_id,date,fetched_at,data)
      SELECT account_id,json_extract(point.value,'$.date'),fetched_at,point.value
      FROM daily_usage,json_each(daily_usage.data,'$.usage.points') AS point
      WHERE json_type(point.value,'$.date')='text'`);
    store.set("migrations", "daily-usage-points-v1", true);
  });
  if (!store.get("migrations", "daily-usage-header-v1")) store.transaction(() => {
    store.prepare("UPDATE daily_usage SET data=json_set(data,'$.usage.points',json('[]'))").run();
    store.set("migrations", "daily-usage-header-v1", true);
  });
  store.watchTable("usage_samples","usage");
  store.watchTable("daily_usage","usage");
  store.watchTable("daily_usage_points","usage");
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
  return store.prepare("SELECT account_id FROM daily_usage ORDER BY fetched_at DESC").all().map(row => readDailyUsageRow(store, String(row["account_id"]))!);
}

export function readDailyUsageRow(store: SqliteStateStore, accountId: string): DashboardDailyUsageCacheEntry | undefined {
  initializeUsageStorage(store);
  const row = store.prepare("SELECT data FROM daily_usage WHERE account_id=?").get(accountId);
  if (!row) return;
  const entry = JSON.parse(String(row["data"])) as DashboardDailyUsageCacheEntry;
  if (entry.accountId !== accountId) throw new Error("Stored daily usage identity does not match its account key.");
  entry.usage.points = store.prepare("SELECT data FROM daily_usage_points WHERE account_id=? ORDER BY date DESC LIMIT 90").all(accountId)
    .reverse().map(point => JSON.parse(String(point["data"])) as DashboardDailyUsageCacheEntry["usage"]["points"][number]);
  return entry;
}

/** Retain only a display label in an existing usage header; credentials stay in the account vault. */
export function retainDailyUsageAccountLabel(store: SqliteStateStore, accountId: string, accountLabel: string): void {
  if (!accountLabel.trim() || accountLabel.length > 320 || /[\u0000-\u001f\u007f]/.test(accountLabel)) throw new Error("The usage account label is invalid.");
  initializeUsageStorage(store);
  store.prepare("UPDATE daily_usage SET data=json_set(data,'$.accountLabel',?) WHERE account_id=? AND json_extract(data,'$.accountLabel') IS NOT ?")
    .run(accountLabel, accountId, accountLabel);
}

export function upsertDailyUsageRow(store: SqliteStateStore, entry: DashboardDailyUsageCacheEntry, cutoff?: string): void {
  initializeUsageStorage(store);
  store.transaction(() => {
    const previous = store.prepare("SELECT fetched_at,json_extract(data,'$.accountLabel') AS account_label FROM daily_usage WHERE account_id=?").get(entry.accountId);
    if (previous && Number(previous["fetched_at"]) > entry.fetchedAt) return;
    const retained = !entry.accountLabel && typeof previous?.["account_label"] === "string" ? { ...entry, accountLabel: previous["account_label"] } : entry;
    store.prepare(`INSERT INTO daily_usage(account_id,fetched_at,data) VALUES(?,?,?) ON CONFLICT(account_id)
      DO UPDATE SET fetched_at=excluded.fetched_at,data=excluded.data WHERE daily_usage.data!=excluded.data`)
      .run(entry.accountId, entry.fetchedAt, JSON.stringify({ ...retained, usage: { ...entry.usage, points: [] } }));
    const write = store.prepare(`INSERT INTO daily_usage_points(account_id,date,fetched_at,data) VALUES(?,?,?,?)
      ON CONFLICT(account_id,date) DO UPDATE SET fetched_at=excluded.fetched_at,data=excluded.data
      WHERE excluded.fetched_at>=daily_usage_points.fetched_at AND daily_usage_points.data!=excluded.data`);
    for (const point of entry.usage.points) write.run(entry.accountId, point.date, entry.fetchedAt, JSON.stringify(point));
    if (cutoff) store.prepare("DELETE FROM daily_usage_points WHERE date<?").run(cutoff);
    else if (cutoff === undefined) {
      // Legacy imports retain their existing thirty-point bound.
      store.prepare(`DELETE FROM daily_usage_points WHERE account_id=? AND date NOT IN
        (SELECT date FROM daily_usage_points WHERE account_id=? ORDER BY date DESC LIMIT 30)`).run(entry.accountId, entry.accountId);
    }
  });
}

export function appendUsageRows(store: SqliteStateStore, samples: readonly DashboardUsageSample[], cutoff: number): void {
  initializeUsageStorage(store);
  store.transaction(() => {
    const latest = store.prepare("SELECT at,hourly,weekly,review FROM usage_samples WHERE account_id=? ORDER BY at DESC LIMIT 1");
    const write = store.prepare("INSERT INTO usage_samples(account_id,at,hourly,weekly,review) VALUES(?,?,?,?,?) ON CONFLICT(account_id,at) DO NOTHING");
    let changed = false;
    for (const sample of samples) {
      const previous = latest.get(sample.accountId);
      if (previous && (Number(previous["at"]) >= sample.at || (Number(previous["at"]) >= cutoff &&
        ["hourly", "weekly", "review"].every(key => previous[key] === (sample[key as "hourly" | "weekly" | "review"] ?? null))))) continue;
      write.run(sample.accountId, sample.at, sample.hourly ?? null, sample.weekly ?? null, sample.review ?? null);
      changed = true;
    }
    if (Number.isFinite(cutoff)) store.prepare("DELETE FROM usage_samples WHERE at<?").run(cutoff);
    if (changed) store.prepare("DELETE FROM usage_samples WHERE rowid IN (SELECT rowid FROM usage_samples ORDER BY at DESC,account_id LIMIT -1 OFFSET 10000)").run();
  });
}

export function mergeUsageRows(store: SqliteStateStore, samples: readonly DashboardUsageSample[]): void {
  initializeUsageStorage(store);
  store.transaction(() => {
    const write = store.prepare(`INSERT INTO usage_samples(account_id,at,hourly,weekly,review) VALUES(?,?,?,?,?)
      ON CONFLICT(account_id,at) DO UPDATE SET hourly=excluded.hourly,weekly=excluded.weekly,review=excluded.review
      WHERE hourly IS NOT excluded.hourly OR weekly IS NOT excluded.weekly OR review IS NOT excluded.review`);
    for (const sample of samples) write.run(sample.accountId, sample.at, sample.hourly ?? null, sample.weekly ?? null, sample.review ?? null);
    store.prepare("DELETE FROM usage_samples WHERE rowid IN (SELECT rowid FROM usage_samples ORDER BY at DESC,account_id LIMIT -1 OFFSET 10000)").run();
  });
}

export function readUsageSummary(store: SqliteStateStore): DashboardUsageSummary {
  initializeUsageStorage(store);
  return { revision: store.revision("usage"), count: Number(store.prepare("SELECT COUNT(*) AS count FROM usage_samples").get()?.["count"] ?? 0) };
}

/** Bound the renderer's working set; the database keeps the authoritative history. */
export function queryUsageRows(store: SqliteStateStore, query: DashboardUsageGraphQuery, tokenCutoff = 0): DashboardUsageGraphData {
  initializeUsageStorage(store);
  const result: DashboardUsageGraphData = { ...query, history: [], dailyUsageCache: [], truncated: false };
  if (query.mode === "quota") {
    const rows = store.prepare(`SELECT * FROM usage_samples WHERE at>=? AND at<=?
      UNION ALL SELECT sample.* FROM usage_samples AS sample JOIN
      (SELECT account_id,MAX(at) AS at FROM usage_samples WHERE at<? GROUP BY account_id) AS previous
      ON sample.account_id=previous.account_id AND sample.at=previous.at ORDER BY at DESC,account_id LIMIT 10001`)
      .all(query.from, query.to, query.from);
    result.truncated = rows.length > 10_000;
    result.history = rows.slice(0, 10_000).reverse().map(row => ({ accountId: String(row["account_id"]), at: Number(row["at"]),
      hourly: row["hourly"] === null ? undefined : Number(row["hourly"]), weekly: row["weekly"] === null ? undefined : Number(row["weekly"]),
      review: row["review"] === null ? undefined : Number(row["review"]) }));
    const oldest = store.prepare("SELECT MIN(at) AS at FROM usage_samples").get()?.["at"];
    if (typeof oldest === "number") result.oldestAt = oldest;
  } else {
    const entries = new Map<string, DashboardDailyUsageCacheEntry>();
    for (const row of store.prepare("SELECT account_id,fetched_at,json_extract(data,'$.accountLabel') AS account_label FROM daily_usage ORDER BY account_id").all()) {
      const accountId = String(row["account_id"]);
      entries.set(accountId, { accountId, ...(typeof row["account_label"] === "string" ? {accountLabel: row["account_label"]} : {}), fetchedAt: Number(row["fetched_at"]), usage: { days: 30, points: [] } });
    }
    const rows = store.prepare("SELECT account_id,data FROM daily_usage_points WHERE date>=? AND date<? ORDER BY date DESC,account_id LIMIT 10001")
      .all(new Date(Math.max(query.from, tokenCutoff)).toISOString().slice(0, 10), new Date(query.to).toISOString().slice(0, 10));
    result.truncated = rows.length > 10_000;
    for (const row of rows.slice(0, 10_000).reverse()) entries.get(String(row["account_id"]))?.usage.points.push(JSON.parse(String(row["data"])) as DashboardDailyUsageCacheEntry["usage"]["points"][number]);
    result.dailyUsageCache = [...entries.values()];
    const oldest = store.prepare("SELECT MIN(date) AS date FROM daily_usage_points WHERE date>=?").get(new Date(tokenCutoff).toISOString().slice(0, 10))?.["date"];
    if (typeof oldest === "string") result.oldestAt = Date.parse(`${oldest}T00:00:00Z`);
  }
  return result;
}

export function replaceDailyUsageRows(store:SqliteStateStore,entries:readonly DashboardDailyUsageCacheEntry[],legacyKey:string,onlyIfMissing=false):void {
  initializeUsageStorage(store);
  const ids = new Set(entries.map(entry=>entry.accountId));
  store.transaction(()=>{
    if (onlyIfMissing && store.get("migrations","daily-usage-rows-v1")) return;
    for (const row of store.prepare("SELECT account_id FROM daily_usage").all()) {
      if (!ids.has(String(row["account_id"]))) {
        store.prepare("DELETE FROM daily_usage WHERE account_id=?").run(String(row["account_id"]));
        store.prepare("DELETE FROM daily_usage_points WHERE account_id=?").run(String(row["account_id"]));
      }
    }
    for (const entry of entries) {
      upsertDailyUsageRow(store, entry);
    }
    finishMigration(store,legacyKey,"daily-usage-rows-v1");
  });
}

function finishMigration(store:SqliteStateStore,legacyKey:string,marker:string):void {
  const legacy = store.get("global",legacyKey);
  if (legacy !== undefined && !store.get("migrations",marker)) store.set("legacy-state",legacyKey,legacy);
  store.set("global",legacyKey,undefined);
  store.set("migrations",marker,true);
}
