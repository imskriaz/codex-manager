import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { readAccountRow, saveAccountIndex } from "../src/storage/sqliteAccounts";
import { initializeSessionStorage, pruneSessionCache, readAccountSessionStats, readSessionDiscovery, saveSessionDiscovery, saveSessionStatus, readSessionStatus, readSessionStatuses } from "../src/storage/sqliteSessions";
import { recordNativeSessionStatus, recordSessionLive, flushSessionRecording, disposeSessionRecording } from "../src/services/sessionRecording";
import { readRecentRunningCodexSessionIds } from "../src/services/codexSessionResume";
import { cleanupManagerStorage } from "../src/storage/storageCleanup";
import { AccountsRepository } from "../src/storage/accounts";
import { removeTestDirectory } from "./testFilesystem";
import type { DashboardCodexSessionLiveState } from "../src/domain/dashboard/types";
import { replaceUsageRows } from "../src/storage/sqliteUsage";

let root:string,store:SqliteStateStore;
const peers:SqliteStateStore[]=[];
const sessionId="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function state(n:number):DashboardCodexSessionLiveState {
  return {sessionId,streamId:`${n.toString(16).padStart(8,"0")}-bbbb-bbbb-bbbb-bbbbbbbbbbbb`,sequence:1,updatedAt:Date.now()+n,status:"completed",messages:[],tokenUsage:{total:10}};
}
beforeEach(async()=>{
  root=await fs.mkdtemp(path.join(os.tmpdir(),"shared-manager-sqlite-"));
  store=await SqliteStateStore.open(path.join(root,"manager.sqlite"));
  configureSqliteStateStore(store);
});
afterEach(async()=>{
  disposeSessionRecording();
  configureSqliteStateStore(undefined);
  store.close();for(const peer of peers.splice(0))peer.close();
  vi.useRealTimers();vi.restoreAllMocks();
  await removeTestDirectory(root);
});

describe("shared SQLite reads, writes and subscriptions",()=>{
  it("shares one poll, batches local notifications and ignores rollbacks, unchanged values and leases",async()=>{
    vi.useFakeTimers();
    const first=vi.fn(),second=vi.fn();
    const stopFirst=store.subscribe(["state"],first),stopSecond=store.subscribe(["state"],second);
    expect(vi.getTimerCount()).toBe(1);
    store.transaction(()=>{store.set("global","a",1);store.set("global","b",2);});
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toHaveBeenCalledOnce();expect(second).toHaveBeenCalledOnce();
    store.set("global","a",1);store.set("operation-leases","unrelated",{pid:process.pid});
    expect(()=>store.transaction(()=>{store.set("global","a",3);throw new Error("rollback");})).toThrow("rollback");
    await vi.advanceTimersByTimeAsync(250);
    expect(first).toHaveBeenCalledOnce();expect(store.get("global","a")).toBe(1);
    stopFirst();stopSecond();expect(vi.getTimerCount()).toBe(0);
  });

  it("observes only committed peer changes and releases queued callbacks and timers on close",async()=>{
    vi.useFakeTimers();
    const peer=await SqliteStateStore.open(store.file);peers.push(peer);
    const seen:number[]=[];
    store.subscribe(["state"],()=>seen.push(store.get<number>("global","a")!));
    peer.database.exec("BEGIN IMMEDIATE");peer.set("global","a",7);
    await vi.advanceTimersByTimeAsync(250);expect(seen).toEqual([]);
    peer.database.exec("COMMIT");await vi.advanceTimersByTimeAsync(250);expect(seen).toEqual([7]);
    store.set("global","a",8);store.close();
    await vi.advanceTimersByTimeAsync(500);expect(seen).toEqual([7]);expect(vi.getTimerCount()).toBe(0);
  });

  it("rolls back nested failures without discarding other writes and isolates failed listeners",async()=>{
    vi.useFakeTimers();
    const healthy=vi.fn();vi.spyOn(console,"warn").mockImplementation(()=>undefined);
    store.subscribe(["state"],()=>{throw new Error("listener failure");});store.subscribe(["state"],healthy);
    store.transaction(()=>{
      store.set("global","kept",true);
      expect(()=>store.transaction(()=>{store.set("global","discarded",true);throw new Error("inner");})).toThrow("inner");
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.get("global","kept")).toBe(true);expect(store.get("global","discarded")).toBeUndefined();expect(healthy).toHaveBeenCalledOnce();
  });

  it("reuses prepared queries and keeps account cache reads fresh before the notification poll",async()=>{
    saveAccountIndex(store,{accounts:[{id:"a",email:"a@example.com",createdAt:1,updatedAt:1}]});
    const repo=new AccountsRepository({secrets:{get:vi.fn(),store:vi.fn(),delete:vi.fn()}} as never,path.join(root,"accounts-index.json"));
    try {
      await repo.listAccounts();await repo.listAccounts();
      store.get("global","missing");
      const prepare=vi.spyOn(store.database,"prepare");
      for(let i=0;i<100;i++)store.get("global","missing");
      expect(prepare).not.toHaveBeenCalled();
      const peer=await SqliteStateStore.open(store.file);peers.push(peer);
      saveAccountIndex(peer,{accounts:[{id:"a",email:"a@example.com",enabled:false,createdAt:1,updatedAt:2}]});
      expect((await repo.listAccounts())[0]?.enabled).toBe(false);
      expect(readAccountRow(store,"a","home")?.enabled).toBe(false);
    } finally {repo.dispose();}
  });
});

describe("batched session persistence",()=>{
  it("reads only fresh statuses for the requested home and rejects expired and future activity",()=>{
    const now=Date.now(),other="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    saveSessionStatus(store,root,sessionId,"running",now);
    saveSessionStatus(store,root,other,"idle",now-31_000);
    saveSessionStatus(store,root,"cccccccc-cccc-cccc-cccc-cccccccccccc","running",now+60_000);
    saveSessionStatus(store,path.join(root,"other"),other,"running",now);
    expect([...readSessionStatuses(store,root)]).toEqual([[sessionId,"running"]]);
    saveSessionStatus(store,root,sessionId,"unknown",now+1);
    expect(readSessionStatuses(store,root).get(sessionId)).toBe("unknown");
    const plan=store.prepare("EXPLAIN QUERY PLAN SELECT session_id,status FROM session_status WHERE home=? AND checked_at>? AND checked_at<=?").all(root,now-30_000,now+5_000);
    expect(plan.some(row=>String(row["detail"]).includes("session_status_fresh"))).toBe(true);
  });

  it("commits many turns and coalesced native status changes once",()=>{
    initializeSessionStorage(store);
    const exec=vi.spyOn(store.database,"exec");
    for(let n=0;n<32;n++)recordSessionLive(state(n),"a");
    recordNativeSessionStatus(root,sessionId,true);recordNativeSessionStatus(root,sessionId,false);
    expect(exec.mock.calls.filter(([sql])=>sql==="BEGIN IMMEDIATE")).toHaveLength(0);
    expect(flushSessionRecording(32)).toBe(true);
    expect(exec.mock.calls.filter(([sql])=>sql==="BEGIN IMMEDIATE")).toHaveLength(1);
    expect(readAccountSessionStats(store,"a")).toMatchObject({turns:32,total_tokens:320});
    expect(readSessionStatus(store,root,sessionId)).toBe("idle");
  });

  it("retains an entire failed batch for retry without committing its earlier rows",()=>{
    initializeSessionStorage(store);
    const pages=Number(store.database.prepare("PRAGMA page_count").get()?.["page_count"]);
    store.database.exec(`PRAGMA max_page_count=${pages}`);
    recordSessionLive(state(1),"a");
    recordSessionLive({...state(2),messages:Array.from({length:30},(_,n)=>({id:String(n),text:"x".repeat(12_000)}))},"a");
    vi.spyOn(console,"warn").mockImplementation(()=>undefined);
    expect(flushSessionRecording()).toBe(false);expect(readAccountSessionStats(store,"a")["turns"]).toBe(0);
    store.database.exec("PRAGMA max_page_count=1073741823");
    expect(flushSessionRecording()).toBe(true);expect(readAccountSessionStats(store,"a")["turns"]).toBe(2);
  });

  it("shares discovery with other windows, incorporates native transitions and invalidates uncertain running state",()=>{
    const started=Date.now()-100;
    saveSessionDiscovery(store,root,[sessionId],started);
    expect(readRecentRunningCodexSessionIds(root)).toEqual([sessionId]);
    const peer= new DatabaseSync(store.file);
    try {expect(peer.prepare("SELECT COUNT(*) AS n FROM state WHERE namespace='session-discovery'").get()?.n).toBe(1);}finally{peer.close();}
    saveSessionStatus(store,root,sessionId,"idle");expect(readSessionDiscovery(store,root)?.ids).toEqual([]);
    saveSessionStatus(store,root,sessionId,"running",Date.now()+1);expect(readRecentRunningCodexSessionIds(root)).toEqual([sessionId]);
    saveSessionStatus(store,root,sessionId,"unknown",Date.now()+2);expect(readRecentRunningCodexSessionIds(root)).toBeUndefined();
    saveSessionDiscovery(store,root,[sessionId],started-1);expect(readSessionDiscovery(store,root)).toBeUndefined();
  });

  it("bounds pending native statuses and resumes recording after the queue drains",()=>{
    const warning=vi.spyOn(console,"warn").mockImplementation(()=>undefined);
    for(let n=0;n<1025;n++)recordNativeSessionStatus(root,`${n.toString(16).padStart(8,"0")}-cccc-cccc-cccc-cccccccccccc`,true);
    expect(warning).toHaveBeenCalledWith(expect.any(String),expect.objectContaining({message:expect.stringContaining("queue is full")}));
    expect(flushSessionRecording(128)).toBe(true);
    expect(store.prepare("SELECT COUNT(*) AS n FROM session_status").get()?.["n"]).toBe(1024);
    expect(readSessionStatus(store,root,"00000400-cccc-cccc-cccc-cccccccccccc")).toBe("running");
    recordNativeSessionStatus(root,sessionId,false);expect(flushSessionRecording()).toBe(true);
    expect(readSessionStatus(store,root,sessionId)).toBe("idle");
  });
});

describe("safe cleanup and credential read races",()=>{
  it("bounds queued live snapshots by bytes and recovers after flushing", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const messages = Array.from({ length: 75 }, (_, n) => ({ id: String(n), text: "x".repeat(12_000) }));
    for (let n = 1; n <= 12; n++) recordSessionLive({ ...state(n), messages });
    expect(warning).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringContaining("byte limit") }));
    flushSessionRecording(128);
    expect(Number(store.prepare("SELECT COUNT(*) AS n FROM session_turns").get()?.["n"])).toBeLessThan(12);
    recordSessionLive(state(99)); expect(flushSessionRecording()).toBe(true);
    expect(store.prepare("SELECT COUNT(*) AS n FROM session_turns WHERE stream_id=?").get(state(99).streamId)?.["n"]).toBe(1);
  });
  it("expires bounded runtime caches without deleting recovery or token statistics", () => {
    const now = Date.now();
    saveSessionStatus(store, root, sessionId, "running", now - 2 * 24 * 60 * 60_000);
    saveSessionStatus(store, root, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "idle", now);
    store.set("session-discovery", "old-home", { checkedAt: now - 60_000, ids: [sessionId] });
    store.set("workspace:test", "codexManager.autoResumeSessionIds", [sessionId]);
    recordSessionLive({ ...state(1), updatedAt: now - 10 * 60_000, messages: [{ id: "old", text: "Large preview" }] }, "a");
    flushSessionRecording();
    pruneSessionCache(store, now);
    expect(store.prepare("SELECT COUNT(*) AS n FROM session_status WHERE checked_at < ?").get(now - 24 * 60 * 60_000)?.["n"]).toBe(0);
    expect(store.get("session-discovery", "old-home")).toBeUndefined();
    expect(store.get("workspace:test", "codexManager.autoResumeSessionIds")).toEqual([sessionId]);
    expect(readAccountSessionStats(store, "a")).toMatchObject({ turns: 1, total_tokens: 10 });
    expect(JSON.parse(String(store.prepare("SELECT data FROM session_turns").get()?.["data"])).messages).toEqual([]);
  });
  it("removes only retired data and verified duplicate recovery copies",()=>{
    const archive=(name:string,text:string)=>{const bytes=Buffer.from(text);store.set("legacy-files",name,{path:name,base64:bytes.toString("base64"),sha256:createHash("sha256").update(bytes).digest("hex")});};
    store.set("files","announcements/announcement_cache.json",{text:"retired"});archive("announcements/announcement_cache.json","retired");
    store.set("legacy-database-conflicts",JSON.stringify(["files","announcements/announcement_cache.json"]),{text:"retired conflict"});
    store.set("legacy-database-conflicts",JSON.stringify(["files","accounts/recovery.json"]),{text:"keep recovery"});
    store.set("legacy-database-conflicts","malformed",{text:"keep unknown"});
    store.set("files","logging-settings.json",{text:'{"enabled":true}'});archive("logging-settings.json",'{"enabled":true}');
    archive("accounts-index.json.tmp-unverified",'{"accounts":[]}');archive("unknown.bin","unknown");
    store.set("files","accounts/deleted.json",{text:null});archive("accounts/deleted.json","stale secret");
    const key="codexManager.dashboardUsageHistory.v1",samples=[{accountId:"a",at:1,hourly:20}];
    store.set("global",key,samples);replaceUsageRows(store,samples,key);
    expect(cleanupManagerStorage(store)).toEqual({retired:3,duplicates:3});
    expect(store.keys("legacy-database-conflicts").sort()).toEqual([JSON.stringify(["files","accounts/recovery.json"]),"malformed"]);
    expect(store.keys("legacy-files").sort()).toEqual(["accounts-index.json.tmp-unverified","unknown.bin"]);
    expect(store.get("legacy-state",key)).toBeUndefined();
  });

  it("coalesces credential reads and prevents a stale completion from repopulating an invalidated cache",async()=>{
    let resolveOld!:(value:string)=>void,changed!:(event:{key:string})=>void;
    const tokens=(accessToken:string)=>JSON.stringify({idToken:"id",accessToken,refreshToken:"refresh"});
    const get=vi.fn().mockImplementationOnce(()=>new Promise<string>(resolve=>{resolveOld=resolve;})).mockResolvedValue(tokens("new"));
    const dispose=vi.fn();
    const repo=new AccountsRepository({secrets:{get,store:vi.fn(),delete:vi.fn(),onDidChange:(listener:typeof changed)=>{changed=listener;return{dispose};}}} as never,path.join(root,"accounts-index.json"));
    try {
      const first=repo.getTokens("a"),joined=repo.getTokens("a");expect(get).toHaveBeenCalledOnce();
      changed({key:"codex.account.a"});
      expect((await repo.getTokens("a"))?.accessToken).toBe("new");
      resolveOld(tokens("old"));await Promise.all([first,joined]);
      expect((await repo.getTokens("a"))?.accessToken).toBe("new");expect(get).toHaveBeenCalledTimes(2);
    } finally {repo.dispose();}
    expect(dispose).toHaveBeenCalledOnce();await expect(repo.getTokens("a")).rejects.toThrow();
  });

  it("rolls back incomplete cleanup and leaves recovery data available for retry",()=>{
    store.set("files","announcements/announcement_cache.json",{text:"retired"});
    store.set("files","announcements/announcement_read_ids.json",{text:"retired ids"});
    const write=store.set.bind(store);let count=0;
    const failure=vi.spyOn(store,"set").mockImplementation((...args)=>{if(++count===2)throw new Error("disk full");write(...args);});
    expect(()=>cleanupManagerStorage(store)).toThrow("disk full");failure.mockRestore();
    expect(store.keys("files")).toHaveLength(2);
    expect(cleanupManagerStorage(store).retired).toBe(2);
  });
});
