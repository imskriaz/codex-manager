import { randomUUID } from "crypto";
import * as os from "os";
import type { DashboardCliSessionSummary, DashboardCodexSessionLiveState } from "../domain/dashboard/types";
import { isCodexSessionLiveState, isNewerCodexSessionLiveState } from "../domain/codexSessionLive";
import { getCodexHomeStateKey } from "../codex/authFile";
import type { SqliteStateStore } from "./sqliteState";
import type { TrackedCliTurn } from "../services/codexSessionResume";

const instance = randomUUID();
const initialized = new WeakSet<SqliteStateStore>();
const lastPruned = new WeakMap<SqliteStateStore, number>();
const CATALOGUE_NAMESPACE = "session-catalogue";
type SessionCatalogue = { generation: string; checkedAt: number; bootAt: number; invalidated?: boolean; rows: DashboardCliSessionSummary[] };

function catalogueHeader(store: SqliteStateStore, home: string): Omit<SessionCatalogue, "rows"> | undefined {
  initializeSessionStorage(store);
  const value = store.get<SessionCatalogue>(CATALOGUE_NAMESPACE, getCodexHomeStateKey(home));
  if (!value || typeof value.generation !== "string" || !Number.isFinite(value.checkedAt) || !Number.isFinite(value.bootAt) || value.checkedAt > Date.now() + 5_000 || Date.now() - value.checkedAt > 7 * 24 * 60 * 60_000) return undefined;
  if (value.rows !== undefined) {
    if (!Array.isArray(value.rows) || value.rows.length > 30_000 || value.rows.some(row => !validCatalogueRow(row))) return undefined;
    // Migrate the old JSON snapshot once; ordinary metadata checks never load its rows.
    store.transaction(() => {
      store.prepare("DELETE FROM session_catalogue_rows WHERE home=?").run(getCodexHomeStateKey(home));
      const insert = store.prepare("INSERT OR REPLACE INTO session_catalogue_rows(home,session_id,position,generation,data) VALUES(?,?,?,?,?)");
      value.rows.forEach((row, index) => insert.run(getCodexHomeStateKey(home), row.id, index, value.generation, JSON.stringify(row)));
      const { rows: _rows, ...header } = value;
      store.set(CATALOGUE_NAMESPACE, getCodexHomeStateKey(home), header);
    });
  }
  const { rows: _rows, ...header } = value;
  return header;
}

function validCatalogueRow(row: DashboardCliSessionSummary): boolean {
  return Boolean(row && typeof row.id === "string" && /^[a-f0-9-]{36}$/i.test(row.id) && typeof row.title === "string" && row.title.length <= 256 && ["running", "idle", "unknown"].includes(row.status));
}

export function readSessionCatalogue(store: SqliteStateStore, home: string): SessionCatalogue | undefined {
  initializeSessionStorage(store);
  return store.transaction(() => {
  const header = catalogueHeader(store, home);
  if (!header) return undefined;
  const rows = store.prepare("SELECT data FROM session_catalogue_rows WHERE home=? ORDER BY position LIMIT 30000").all(getCodexHomeStateKey(home)).map(row => JSON.parse(String(row["data"])) as DashboardCliSessionSummary);
  if (rows.some(row => !validCatalogueRow(row))) return undefined;
  return { ...header, rows };
  }, "read");
}

export function invalidateSessionCatalogue(store: SqliteStateStore, home: string, preserveHistory = false): string {
  const generation = randomUUID();
  const previous = catalogueHeader(store, home);
  store.transaction(() => {
    if (!preserveHistory) store.prepare("DELETE FROM session_catalogue_rows WHERE home=?").run(getCodexHomeStateKey(home));
    store.set(CATALOGUE_NAMESPACE, getCodexHomeStateKey(home), { generation, checkedAt: preserveHistory ? previous?.checkedAt ?? Date.now() : Date.now(), bootAt: previous?.bootAt ?? Date.now() - os.uptime() * 1000, invalidated: preserveHistory ? previous?.invalidated ?? true : true });
  });
  return generation;
}

export function saveSessionCatalogue(store: SqliteStateStore, home: string, generation: string, rows: DashboardCliSessionSummary[], startedAt: number): void {
  if (rows.length > 30_000) return;
  const key = getCodexHomeStateKey(home);
  store.transaction(() => {
    const previous = catalogueHeader(store, home);
    if (previous?.generation !== generation || (!previous.invalidated && previous.checkedAt > startedAt)) return;
    const write = store.prepare("INSERT INTO session_catalogue_rows(home,session_id,position,generation,data) VALUES(?,?,?,?,?) ON CONFLICT(home,session_id) DO UPDATE SET position=excluded.position,generation=excluded.generation,data=excluded.data WHERE position!=excluded.position OR generation!=excluded.generation OR data!=excluded.data");
    let bytes = 0;
    rows.forEach((row, index) => {
      if (!validCatalogueRow(row)) throw new Error("Invalid session cache row.");
      const data = JSON.stringify(row); bytes += Buffer.byteLength(data);
      if (bytes > 8 * 1024 * 1024) throw new Error("The session cache exceeds its size limit. Previous history was retained.");
      write.run(key, row.id, index, generation, data);
    });
    store.prepare("DELETE FROM session_catalogue_rows WHERE home=? AND session_id NOT IN (SELECT value FROM json_each(?))").run(key, JSON.stringify(rows.map(row => row.id)));
    store.set(CATALOGUE_NAMESPACE, key, { generation, checkedAt: Date.now(), bootAt: Date.now() - os.uptime() * 1000 });
    store.prepare("DELETE FROM state WHERE namespace='session-catalogue' AND key!=? AND key IN (SELECT key FROM state WHERE namespace='session-catalogue' AND key!=? ORDER BY CASE WHEN json_valid(value) THEN json_extract(value,'$.checkedAt') END DESC LIMIT -1 OFFSET 7)").run(key, key);
    store.prepare("DELETE FROM session_catalogue_rows WHERE home NOT IN (SELECT key FROM state WHERE namespace='session-catalogue')").run();
  });
}

export function initializeSessionStorage(store: SqliteStateStore): void {
  if (initialized.has(store)) return;
  store.database.exec("CREATE TABLE IF NOT EXISTS session_catalogue_rows(home TEXT NOT NULL,session_id TEXT NOT NULL,position INTEGER NOT NULL,generation TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(home,session_id)); CREATE INDEX IF NOT EXISTS session_catalogue_order ON session_catalogue_rows(home,position)");
  store.database.exec(`CREATE TABLE IF NOT EXISTS session_turns (
    home TEXT NOT NULL, device_id TEXT NOT NULL, session_id TEXT NOT NULL, stream_id TEXT NOT NULL,
    sequence INTEGER NOT NULL, updated_at REAL NOT NULL, status TEXT NOT NULL, account_id TEXT,
    owner_pid INTEGER NOT NULL, owner_instance TEXT NOT NULL, boot_at REAL NOT NULL,
    input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, total_tokens INTEGER, data TEXT NOT NULL, compacted INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(home,device_id,stream_id)
  ); CREATE INDEX IF NOT EXISTS session_latest ON session_turns(home,device_id,session_id,updated_at DESC);
  CREATE INDEX IF NOT EXISTS session_compaction ON session_turns(compacted,updated_at);
  CREATE INDEX IF NOT EXISTS session_account_stats ON session_turns(account_id,status,updated_at);
  CREATE TABLE IF NOT EXISTS session_status (
    home TEXT NOT NULL, session_id TEXT NOT NULL, status TEXT NOT NULL, checked_at REAL NOT NULL,
    PRIMARY KEY(home,session_id)
  ); CREATE INDEX IF NOT EXISTS session_running ON session_status(home,status,checked_at);
  CREATE INDEX IF NOT EXISTS session_status_fresh ON session_status(home,checked_at);`);
  const columns = new Set(store.prepare('PRAGMA table_info(session_turns)').all().map(row => row['name']));
  if (!columns.has('started_at')) store.database.exec('ALTER TABLE session_turns ADD COLUMN started_at REAL');
  if (!columns.has('turn_id')) store.database.exec('ALTER TABLE session_turns ADD COLUMN turn_id TEXT');
  store.database.exec("CREATE TABLE IF NOT EXISTS running_turns (session_id TEXT PRIMARY KEY,started_at REAL NOT NULL,owner_pid INTEGER,child_pid INTEGER,project_path TEXT NOT NULL,data TEXT NOT NULL)");
  store.watchTable("session_turns","sessions");
  store.watchTable("session_status","session-status");
  store.watchTable("running_turns","sessions");
  initialized.add(store);
}

export function currentSessionAccountId(store: SqliteStateStore, home: string): string | undefined {
  const header = store.get<{ currentAccountId?: string; activeAccountIdsByCodexHome?: Record<string,string>; activeAccountStateVersion?: number }>("account-index", "header");
  return header?.activeAccountStateVersion === 1 ? header.activeAccountIdsByCodexHome?.[getCodexHomeStateKey(home)] : header?.currentAccountId;
}

export function saveSessionLive(store: SqliteStateStore, home: string, state: DashboardCodexSessionLiveState, accountId?: string): boolean {
  if (!isCodexSessionLiveState(state)) throw new Error("Invalid live session state.");
  state = { ...state, sessionId: state.sessionId.toLowerCase(), streamId: state.streamId.toLowerCase() };
  initializeSessionStorage(store);
  const scope = getCodexHomeStateKey(home);
  const device = state.deviceId ?? "";
  return store.transaction(() => {
    const own = store.prepare("SELECT data FROM session_turns WHERE home=? AND device_id=? AND stream_id=?").get(scope,device,state.streamId);
    if (own && !isNewerCodexSessionLiveState(state,JSON.parse(String(own["data"])) as DashboardCodexSessionLiveState)) return false;
    const previous = store.prepare("SELECT data FROM session_turns WHERE home=? AND device_id=? AND session_id=? ORDER BY updated_at DESC LIMIT 1").get(scope,device,state.sessionId);
    const latest = previous ? JSON.parse(String(previous["data"])) as DashboardCodexSessionLiveState : undefined;
    const current = !latest || isNewerCodexSessionLiveState(state,latest);
    if (current) store.prepare("UPDATE session_turns SET status='disconnected',data=json_set(data,'$.status','disconnected') WHERE home=? AND device_id=? AND session_id=? AND stream_id!=? AND status IN ('starting','running')").run(scope,device,state.sessionId,state.streamId);
    const snapshot = !current && (state.status === "running" || state.status === "starting") ? { ...state,status:"disconnected" as const } : state;
    store.prepare(`INSERT INTO session_turns(home,device_id,session_id,stream_id,sequence,updated_at,status,account_id,owner_pid,owner_instance,boot_at,input_tokens,output_tokens,cached_tokens,total_tokens,data,started_at,turn_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(home,device_id,stream_id) DO UPDATE SET
      sequence=excluded.sequence,updated_at=excluded.updated_at,status=excluded.status,
      account_id=COALESCE(session_turns.account_id,excluded.account_id),owner_pid=excluded.owner_pid,owner_instance=excluded.owner_instance,boot_at=excluded.boot_at,
      input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,total_tokens=excluded.total_tokens,data=excluded.data,compacted=0,started_at=COALESCE(session_turns.started_at,excluded.started_at),turn_id=COALESCE(session_turns.turn_id,excluded.turn_id)`)
      .run(scope,device,state.sessionId,state.streamId,state.sequence,state.updatedAt,snapshot.status,accountId ?? null,process.pid,instance,Date.now()-os.uptime()*1000,
        state.tokenUsage?.input ?? null,state.tokenUsage?.output ?? null,state.tokenUsage?.cachedInput ?? null,state.tokenUsage?.total ?? null,JSON.stringify(snapshot), ['starting','running'].includes(state.status) ? state.updatedAt : null, state.turnId ?? null);
    if (!device && current) saveSessionStatus(store,home,state.sessionId,state.status === "running" ? "running" : state.status === "starting" ? "starting" : state.status === "disconnected" ? "unknown" : "idle",state.updatedAt);
    if (Date.now() - (lastPruned.get(store) ?? 0) > 60_000) {
      // Codex owns full transcripts; retain durable turn statistics after the replay window.
      store.prepare("UPDATE session_turns SET compacted=1,data=json_set(json_remove(data,'$.diff','$.plan'),'$.messages',json('[]'),'$.truncated',json('true')) WHERE compacted=0 AND status NOT IN ('starting','running') AND updated_at < ?").run(Date.now()-5*60_000);
      lastPruned.set(store,Date.now());
    }
    return true;
  });
}

export function saveSessionStatus(store: SqliteStateStore, home: string, id: string, status: "starting" | "running" | "idle" | "unknown", at = Date.now()): void {
  initializeSessionStorage(store);
  const scope = getCodexHomeStateKey(home);
  id = id.toLowerCase();
  store.transaction(() => {
    const result = store.prepare(`INSERT INTO session_status(home,session_id,status,checked_at) VALUES(?,?,?,?)
      ON CONFLICT(home,session_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at WHERE excluded.checked_at >= session_status.checked_at AND (excluded.status!=session_status.status OR excluded.checked_at>=session_status.checked_at+1000)`).run(scope,id,status,at) as { changes: number };
    const cached = store.get<Discovery>("session-discovery",scope);
    if (!result.changes || !cached || !Array.isArray(cached.ids) || at < cached.startedAt) return;
    if (status === "unknown") {
      if (cached.ids.includes(id)) store.set("session-discovery",scope,undefined);
      return;
    }
    const running = status === "running" || status === "starting";
    if (cached.ids.includes(id) === running) return;
    const ids = running ? [...cached.ids,id] : cached.ids.filter(value=>value!==id);
    store.set("session-discovery",scope,{ ...cached,ids });
  });
}

type Discovery = { ids:string[]; startedAt:number; checkedAt:number; bootAt:number };
/** Expire caches, not transcripts, recovery queues, or durable token statistics. */
export function pruneSessionCache(store: SqliteStateStore, now = Date.now()): void {
  initializeSessionStorage(store);
  store.transaction(() => {
    store.prepare("DELETE FROM session_status WHERE rowid IN (SELECT rowid FROM session_status WHERE checked_at < ? OR checked_at > ? LIMIT 256)").run(now - 24 * 60 * 60_000, now + 60_000);
    store.prepare("DELETE FROM state WHERE namespace='session-discovery' AND key IN (SELECT key FROM state WHERE namespace='session-discovery' AND json_valid(value) AND (json_extract(value,'$.checkedAt') < ? OR json_extract(value,'$.checkedAt') > ?) LIMIT 256)").run(now - 30_000, now + 5_000);
    store.prepare("DELETE FROM state WHERE namespace='session-catalogue' AND NOT json_valid(value)").run();
    store.prepare("DELETE FROM state WHERE namespace='session-catalogue' AND (COALESCE(json_type(value,'$.checkedAt'),'null') NOT IN ('integer','real') OR json_extract(value,'$.checkedAt') < ? OR json_extract(value,'$.checkedAt') > ?)").run(now - 7 * 24 * 60 * 60_000, now + 5_000);
    store.prepare("DELETE FROM session_catalogue_rows WHERE home NOT IN (SELECT key FROM state WHERE namespace='session-catalogue')").run();
    store.prepare("UPDATE session_turns SET compacted=1,data=json_set(json_remove(data,'$.diff','$.plan'),'$.messages',json('[]'),'$.truncated',json('true')) WHERE rowid IN (SELECT rowid FROM session_turns WHERE compacted=0 AND status NOT IN ('starting','running') AND updated_at < ? LIMIT 128)").run(now - 5 * 60_000);
  });
}

/** Only a successful complete discovery may confirm these IDs as deleted. */
export function removeDeletedSessionCache(store: SqliteStateStore, home: string, ids: readonly string[], generation?: string, startedAt = Date.now()): void {
  if (!ids.length) return;
  initializeSessionStorage(store);
  store.transaction(() => {
    if (generation) {
      const current = catalogueHeader(store, home);
      if (current?.generation !== generation || current.checkedAt > startedAt) return;
    }
    const pending = store.prepare("SELECT 1 FROM state,json_each(CASE WHEN json_valid(state.value) THEN state.value ELSE '[]' END) AS item WHERE state.key IN ('codexManager.autoResumeSessionIds','codexManager.autoResumeOpenSessionIds') AND item.value=? LIMIT 1");
    for (const id of ids) {
      if (pending.get(id) || store.prepare("SELECT 1 FROM running_turns WHERE session_id=?").get(id) || store.prepare("SELECT 1 FROM session_turns WHERE home=? AND session_id=? AND status IN ('starting','running') AND updated_at>=? LIMIT 1").get(getCodexHomeStateKey(home), id, Date.now() - 24 * 60 * 60_000)) continue;
      store.prepare("DELETE FROM session_status WHERE home=? AND session_id=?").run(getCodexHomeStateKey(home), id);
      store.prepare("DELETE FROM session_turns WHERE home=? AND session_id=? AND device_id=''").run(getCodexHomeStateKey(home), id);
      store.prepare("DELETE FROM session_catalogue_rows WHERE home=? AND session_id=?").run(getCodexHomeStateKey(home), id);
    }
  });
}

export function readSessionDiscovery(store:SqliteStateStore,home:string):Discovery|undefined {
  const value = store.get<Discovery>("session-discovery",getCodexHomeStateKey(home));
  const age = value ? Date.now()-value.checkedAt : Infinity;
  return value && age>=0 && age<30_000 && value.bootAt>=Date.now()-os.uptime()*1000-60_000 &&
    Number.isFinite(value.startedAt) && value.startedAt>=0 && value.startedAt<=value.checkedAt && Array.isArray(value.ids) && value.ids.length<=20_000 &&
    value.ids.every(id=>typeof id === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) ? value : undefined;
}

export function saveSessionDiscovery(store:SqliteStateStore,home:string,ids:string[],startedAt:number):void {
  initializeSessionStorage(store);
  const scope = getCodexHomeStateKey(home);
  store.transaction(()=>{
    if ((readSessionDiscovery(store,home)?.startedAt ?? 0)>startedAt) return;
    const current = new Set(ids);
    for (const row of store.prepare("SELECT session_id,status FROM session_status WHERE home=? AND checked_at>=?").all(scope,startedAt)) {
      const id=String(row["session_id"]),status=String(row["status"]);
      if (status === "running" || status === "starting") current.add(id);
      else if (status === "idle") current.delete(id);
      else if (current.has(id)) { store.set("session-discovery",scope,undefined); return; }
    }
    store.set("session-discovery",scope,{ids:[...current],startedAt,checkedAt:Date.now(),bootAt:Date.now()-os.uptime()*1000});
    for (const key of store.keys("session-discovery")) {
      const entry = store.get<Discovery>("session-discovery",key);
      if (!Number.isFinite(entry?.checkedAt) || (entry?.checkedAt ?? 0)>Date.now()+5_000 || Date.now()-(entry?.checkedAt ?? 0)>=30_000) store.set("session-discovery",key,undefined);
    }
  });
}

function restored(row: Record<string,unknown>): DashboardCodexSessionLiveState {
  const state = JSON.parse(String(row["data"])) as DashboardCodexSessionLiveState;
  if (!isCodexSessionLiveState(state)) throw new Error("Stored live session state is invalid.");
  if (state.status !== "running" && state.status !== "starting") return state;
  let stale = Number(row["boot_at"]) < Date.now()-os.uptime()*1000-60_000 || (Number(row["owner_pid"]) === process.pid && row["owner_instance"] !== instance);
  try { process.kill(Number(row["owner_pid"]),0); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") stale = true;
    else if (code !== "EPERM" && code !== "EACCES") throw error;
    // EPERM/EACCES means the process exists but Windows denied inspection.
    // Keep the snapshot live; the native session check will establish its state.
  }
  if ((state.status === "running" || state.status === "starting") && stale)
    return { ...state,sequence:Math.min(Number.MAX_SAFE_INTEGER,state.sequence+1),updatedAt:state.updatedAt+1,status:"disconnected",error:"Recovered session snapshot; running state must be verified again." };
  return { ...state,status:row["status"] as DashboardCodexSessionLiveState["status"] };
}

export function readStoredSessionLive(store: SqliteStateStore, home: string, id: string): DashboardCodexSessionLiveState | undefined {
  initializeSessionStorage(store);
  const row = store.prepare("SELECT * FROM session_turns WHERE home=? AND device_id='' AND session_id=? ORDER BY updated_at DESC LIMIT 1").get(getCodexHomeStateKey(home),id.toLowerCase());
  return row ? restored(row) : undefined;
}

export function listStoredSessionLive(store: SqliteStateStore, home: string): DashboardCodexSessionLiveState[] {
  initializeSessionStorage(store);
  return store.prepare(`SELECT candidate.* FROM session_turns AS candidate
    WHERE home=? AND device_id='' AND (status IN ('starting','running') OR updated_at>=?)
    AND NOT EXISTS (SELECT 1 FROM session_turns AS newer WHERE newer.home=candidate.home
      AND newer.device_id=candidate.device_id AND newer.session_id=candidate.session_id
      AND (newer.updated_at>candidate.updated_at OR (newer.updated_at=candidate.updated_at AND newer.rowid>candidate.rowid)))
    ORDER BY updated_at DESC LIMIT 30`)
    .all(getCodexHomeStateKey(home),Date.now()-5*60_000).map(restored)
    .filter(state=>state.status === "running" || state.status === "starting" || state.updatedAt>=Date.now()-5*60_000);
}

export function readAccountSessionStats(store: SqliteStateStore, accountId: string): Record<string,unknown> {
  initializeSessionStorage(store);
  return store.prepare(`SELECT COUNT(*) AS turns,COALESCE(SUM(input_tokens),0) AS input_tokens,
    COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(cached_tokens),0) AS cached_tokens,
    COALESCE(SUM(total_tokens),0) AS total_tokens FROM session_turns WHERE account_id=?`).get(accountId)!;
}

export function readSessionStatus(store:SqliteStateStore,home:string,id:string): string {
  initializeSessionStorage(store);
  const row = store.prepare("SELECT status,checked_at FROM session_status WHERE home=? AND session_id=?").get(getCodexHomeStateKey(home),id.toLowerCase());
  const age = row ? Date.now()-Number(row["checked_at"]) : Infinity;
  return row && age >= -5_000 && age < 30_000 && Number(row["checked_at"]) >= Date.now()-os.uptime()*1000-1000 ? String(row["status"]) : "unknown";
}

/** One bounded status read keeps catalogue age separate from current activity. */
export function readSessionStatuses(store:SqliteStateStore,home:string): Map<string,string> {
  initializeSessionStorage(store);
  const now = Date.now();
  return new Map(store.prepare("SELECT session_id,status FROM session_status WHERE home=? AND checked_at>? AND checked_at<=?")
    .all(getCodexHomeStateKey(home),Math.max(now-30_000,now-os.uptime()*1000-1000),now+5_000)
    .map(row => [String(row["session_id"]),String(row["status"])]));
}

export function readRunningTurnRows(store:SqliteStateStore):TrackedCliTurn[] {
  initializeSessionStorage(store);
  return store.prepare("SELECT data FROM running_turns ORDER BY started_at DESC").all().map(row=>JSON.parse(String(row["data"])) as TrackedCliTurn);
}

export function saveRunningTurnRows(store:SqliteStateStore,turns:readonly TrackedCliTurn[]):void {
  initializeSessionStorage(store);
  const ids = new Set(turns.map(turn=>turn.id));
  store.transaction(()=>{
    for (const row of store.prepare("SELECT session_id FROM running_turns").all())
      if (!ids.has(String(row["session_id"]))) store.prepare("DELETE FROM running_turns WHERE session_id=?").run(String(row["session_id"]));
    const write = store.prepare(`INSERT INTO running_turns(session_id,started_at,owner_pid,child_pid,project_path,data) VALUES(?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET started_at=excluded.started_at,owner_pid=excluded.owner_pid,child_pid=excluded.child_pid,project_path=excluded.project_path,data=excluded.data WHERE running_turns.data!=excluded.data`);
    for (const turn of turns) write.run(turn.id,turn.startedAt,turn.ownerPid ?? null,turn.childPid ?? null,turn.projectPath,JSON.stringify(turn));
    store.set("migrations","running-turn-rows-v1",true);
    store.set("files","codex-manager-running-turns.json",undefined);
  });
}

/** Read timing metadata only; compacted transcripts retain their recorded run spans. */
export function readSessionRunTimings(store: SqliteStateStore, home: string, ids: string[]): Map<string, { firstStartedAt: number; lastObservedAt: number; durationMs: number; runCount: number }> {
  initializeSessionStorage(store);
  const result = new Map<string, { firstStartedAt: number; lastObservedAt: number; durationMs: number; runCount: number }>();
  const unique = [...new Set(ids.map(id => id.toLowerCase()))];
  for (let offset = 0; offset < unique.length; offset += 200) {
    const chunk = unique.slice(offset, offset + 200);
    const rows = store.prepare(`SELECT session_id,MIN(first_at) AS first_at,MAX(last_at) AS last_at,
      SUM(MAX(0,last_at-first_at)) AS duration,COUNT(*) AS runs FROM (
      SELECT session_id,MIN(started_at) AS first_at,MAX(updated_at) AS last_at FROM session_turns
      WHERE home=? AND device_id='' AND session_id IN (${chunk.map(() => '?').join(',')}) AND started_at IS NOT NULL
      AND started_at<=updated_at GROUP BY session_id,COALESCE(NULLIF(turn_id,''),stream_id)) GROUP BY session_id`).all(getCodexHomeStateKey(home), ...chunk);
    for (const row of rows) result.set(String(row['session_id']), { firstStartedAt: Number(row['first_at']), lastObservedAt: Number(row['last_at']), durationMs: Number(row['duration']), runCount: Number(row['runs']) });
  }
  return result;
}
