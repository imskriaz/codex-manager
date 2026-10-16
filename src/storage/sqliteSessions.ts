import { randomUUID } from "crypto";
import * as os from "os";
import type { DashboardCodexSessionLiveState } from "../domain/dashboard/types";
import { isCodexSessionLiveState, isNewerCodexSessionLiveState } from "../domain/codexSessionLive";
import { getCodexHomeStateKey } from "../codex/authFile";
import type { SqliteStateStore } from "./sqliteState";
import type { TrackedCliTurn } from "../services/codexSessionResume";

const instance = randomUUID();
const initialized = new WeakSet<SqliteStateStore>();
const lastPruned = new WeakMap<SqliteStateStore, number>();

function schema(store: SqliteStateStore): void {
  if (initialized.has(store)) return;
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
  ); CREATE INDEX IF NOT EXISTS session_running ON session_status(home,status,checked_at);`);
  store.database.exec("CREATE TABLE IF NOT EXISTS running_turns (session_id TEXT PRIMARY KEY,started_at REAL NOT NULL,owner_pid INTEGER,child_pid INTEGER,project_path TEXT NOT NULL,data TEXT NOT NULL)");
  initialized.add(store);
}

export function currentSessionAccountId(store: SqliteStateStore, home: string): string | undefined {
  const header = store.get<{ currentAccountId?: string; activeAccountIdsByCodexHome?: Record<string,string>; activeAccountStateVersion?: number }>("account-index", "header");
  return header?.activeAccountStateVersion === 1 ? header.activeAccountIdsByCodexHome?.[getCodexHomeStateKey(home)] : header?.currentAccountId;
}

export function saveSessionLive(store: SqliteStateStore, home: string, state: DashboardCodexSessionLiveState, accountId?: string): boolean {
  if (!isCodexSessionLiveState(state)) throw new Error("Invalid live session state.");
  state = { ...state, sessionId: state.sessionId.toLowerCase(), streamId: state.streamId.toLowerCase() };
  schema(store);
  const scope = getCodexHomeStateKey(home);
  const device = state.deviceId ?? "";
  return store.transaction(() => {
    const own = store.database.prepare("SELECT data FROM session_turns WHERE home=? AND device_id=? AND stream_id=?").get(scope,device,state.streamId);
    if (own && !isNewerCodexSessionLiveState(state,JSON.parse(String(own["data"])) as DashboardCodexSessionLiveState)) return false;
    const previous = store.database.prepare("SELECT data FROM session_turns WHERE home=? AND device_id=? AND session_id=? ORDER BY updated_at DESC LIMIT 1").get(scope,device,state.sessionId);
    const latest = previous ? JSON.parse(String(previous["data"])) as DashboardCodexSessionLiveState : undefined;
    const current = !latest || isNewerCodexSessionLiveState(state,latest);
    if (current) store.database.prepare("UPDATE session_turns SET status='disconnected',data=json_set(data,'$.status','disconnected') WHERE home=? AND device_id=? AND session_id=? AND stream_id!=? AND status IN ('starting','running')").run(scope,device,state.sessionId,state.streamId);
    const snapshot = !current && (state.status === "running" || state.status === "starting") ? { ...state,status:"disconnected" as const } : state;
    store.database.prepare(`INSERT INTO session_turns(home,device_id,session_id,stream_id,sequence,updated_at,status,account_id,owner_pid,owner_instance,boot_at,input_tokens,output_tokens,cached_tokens,total_tokens,data)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(home,device_id,stream_id) DO UPDATE SET
      sequence=excluded.sequence,updated_at=excluded.updated_at,status=excluded.status,
      account_id=COALESCE(session_turns.account_id,excluded.account_id),owner_pid=excluded.owner_pid,owner_instance=excluded.owner_instance,boot_at=excluded.boot_at,
      input_tokens=excluded.input_tokens,output_tokens=excluded.output_tokens,cached_tokens=excluded.cached_tokens,total_tokens=excluded.total_tokens,data=excluded.data,compacted=0`)
      .run(scope,device,state.sessionId,state.streamId,state.sequence,state.updatedAt,snapshot.status,accountId ?? null,process.pid,instance,Date.now()-os.uptime()*1000,
        state.tokenUsage?.input ?? null,state.tokenUsage?.output ?? null,state.tokenUsage?.cachedInput ?? null,state.tokenUsage?.total ?? null,JSON.stringify(snapshot));
    if (!device && current) saveSessionStatus(store,home,state.sessionId,state.status === "running" ? "running" : state.status === "starting" ? "starting" : state.status === "disconnected" ? "unknown" : "idle",state.updatedAt);
    if (Date.now() - (lastPruned.get(store) ?? 0) > 60_000) {
      // Codex owns full transcripts; retain durable turn statistics after the replay window.
      store.database.prepare("UPDATE session_turns SET compacted=1,data=json_set(json_remove(data,'$.diff','$.plan'),'$.messages',json('[]'),'$.truncated',json('true')) WHERE compacted=0 AND status NOT IN ('starting','running') AND updated_at < ?").run(Date.now()-5*60_000);
      lastPruned.set(store,Date.now());
    }
    return true;
  });
}

export function saveSessionStatus(store: SqliteStateStore, home: string, id: string, status: "starting" | "running" | "idle" | "unknown", at = Date.now()): void {
  schema(store);
  store.database.prepare(`INSERT INTO session_status(home,session_id,status,checked_at) VALUES(?,?,?,?)
    ON CONFLICT(home,session_id) DO UPDATE SET status=excluded.status,checked_at=excluded.checked_at WHERE excluded.checked_at >= session_status.checked_at`).run(getCodexHomeStateKey(home),id.toLowerCase(),status,at);
}

function restored(row: Record<string,unknown>): DashboardCodexSessionLiveState {
  const state = JSON.parse(String(row["data"])) as DashboardCodexSessionLiveState;
  if (!isCodexSessionLiveState(state)) throw new Error("Stored live session state is invalid.");
  let stale = Number(row["boot_at"]) < Date.now()-os.uptime()*1000-60_000 || (Number(row["owner_pid"]) === process.pid && row["owner_instance"] !== instance);
  try { process.kill(Number(row["owner_pid"]),0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") stale = true; else throw error; }
  if ((state.status === "running" || state.status === "starting") && stale)
    return { ...state,status:"disconnected",error:"Recovered session snapshot; running state must be verified again." };
  return { ...state,status:row["status"] as DashboardCodexSessionLiveState["status"] };
}

export function readStoredSessionLive(store: SqliteStateStore, home: string, id: string): DashboardCodexSessionLiveState | undefined {
  schema(store);
  const row = store.database.prepare("SELECT * FROM session_turns WHERE home=? AND device_id='' AND session_id=? ORDER BY updated_at DESC LIMIT 1").get(getCodexHomeStateKey(home),id.toLowerCase());
  return row ? restored(row) : undefined;
}

export function listStoredSessionLive(store: SqliteStateStore, home: string): DashboardCodexSessionLiveState[] {
  schema(store);
  return store.database.prepare(`SELECT * FROM (SELECT *,ROW_NUMBER() OVER(PARTITION BY device_id,session_id ORDER BY updated_at DESC) AS latest
    FROM session_turns WHERE home=? AND device_id='') WHERE latest=1 AND (status IN ('starting','running') OR updated_at>=?) ORDER BY updated_at DESC LIMIT 30`)
    .all(getCodexHomeStateKey(home),Date.now()-5*60_000).map(restored);
}

export function readAccountSessionStats(store: SqliteStateStore, accountId: string): Record<string,unknown> {
  schema(store);
  return store.database.prepare(`SELECT COUNT(*) AS turns,COALESCE(SUM(input_tokens),0) AS input_tokens,
    COALESCE(SUM(output_tokens),0) AS output_tokens,COALESCE(SUM(cached_tokens),0) AS cached_tokens,
    COALESCE(SUM(total_tokens),0) AS total_tokens FROM session_turns WHERE account_id=?`).get(accountId)!;
}

export function readSessionStatus(store:SqliteStateStore,home:string,id:string): string {
  schema(store);
  const row = store.database.prepare("SELECT status,checked_at FROM session_status WHERE home=? AND session_id=?").get(getCodexHomeStateKey(home),id.toLowerCase());
  const age = row ? Date.now()-Number(row["checked_at"]) : Infinity;
  return row && age >= -5_000 && age < 30_000 ? String(row["status"]) : "unknown";
}

export function readRunningTurnRows(store:SqliteStateStore):TrackedCliTurn[] {
  schema(store);
  return store.database.prepare("SELECT data FROM running_turns ORDER BY started_at DESC").all().map(row=>JSON.parse(String(row["data"])) as TrackedCliTurn);
}

export function saveRunningTurnRows(store:SqliteStateStore,turns:readonly TrackedCliTurn[]):void {
  schema(store);
  const ids = new Set(turns.map(turn=>turn.id));
  store.transaction(()=>{
    for (const row of store.database.prepare("SELECT session_id FROM running_turns").all())
      if (!ids.has(String(row["session_id"]))) store.database.prepare("DELETE FROM running_turns WHERE session_id=?").run(String(row["session_id"]));
    const write = store.database.prepare(`INSERT INTO running_turns(session_id,started_at,owner_pid,child_pid,project_path,data) VALUES(?,?,?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET started_at=excluded.started_at,owner_pid=excluded.owner_pid,child_pid=excluded.child_pid,project_path=excluded.project_path,data=excluded.data WHERE running_turns.data!=excluded.data`);
    for (const turn of turns) write.run(turn.id,turn.startedAt,turn.ownerPid ?? null,turn.childPid ?? null,turn.projectPath,JSON.stringify(turn));
    store.set("migrations","running-turn-rows-v1",true);
    store.set("files","codex-manager-running-turns.json",undefined);
  });
}
