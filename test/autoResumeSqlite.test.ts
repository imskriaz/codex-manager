import { appendFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as vscode from "vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureSqliteStateStore, createSqliteMemento, SqliteStateStore } from "../src/storage/sqliteState";
import { configureCrossWindowOperationCoordinator } from "../src/utils/crossWindowOperations";
import { AUTO_RESUME_METADATA_KEY as metadata, AUTO_RESUME_SESSION_IDS_KEY as queue, AUTO_RESUME_OPEN_SESSION_IDS_KEY as snapshot, closeCodexSessionsForExtensionHostRestart, formatAutoResumeResult, persistOpenCodexSessions, persistRunningCodexSessions, registerCodexSessionAutoResumeTracking, resumePersistedCodexSessions } from "../src/services/codexSessionAutoResume";
import { saveSessionDiscovery, saveSessionStatus } from "../src/storage/sqliteSessions";
import { disposeSessionRecording } from "../src/services/sessionRecording";
import { removeTestDirectory } from "./testFilesystem";
import * as sessionEditor from "../src/services/codexSessionResume";
vi.mock("../src/services/codexSessionRecovery", () => ({ resumeCodexSessionWork: vi.fn().mockResolvedValue("idle") }));
import { resumeCodexSessionWork } from "../src/services/codexSessionRecovery";

const ids = ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb","cccccccc-cccc-cccc-cccc-cccccccccccc"];
const namespace = "workspace:auto-resume-integration";
let root:string, store:SqliteStateStore;
let restoreTabs:typeof vscode.window.tabGroups;
let tabs:Array<{input:{viewType:string;uri:{scheme:string;authority:string;path:string}}}>;
const disposables:Array<{dispose():void}> = [];
function context() {
  return { workspaceState:createSqliteMemento(store,namespace,{keys:()=>[],get:()=>undefined,update:async()=>undefined}) };
}
beforeEach(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"codex-auto-resume-sqlite-"));
  vi.stubEnv("CODEX_HOME",root);
  store=await SqliteStateStore.open(path.join(root,"manager.sqlite"));configureSqliteStateStore(store);
  await configureCrossWindowOperationCoordinator(root);
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({get:(key:string)=>key!=="cliIntegrationEnabled"} as never);
  await mkdir(path.join(root,"sessions"));
  for(const [index,id] of ids.entries())await writeFile(path.join(root,"sessions",`rollout-${id}.jsonl`),
    JSON.stringify({type:"session_meta",payload:{id,source:index===2?{subagent:{thread_spawn:{parent_thread_id:ids[0]}}}:"vscode",cwd:root}})+"\n"+
    JSON.stringify({type:"event_msg",payload:{type:"task_started",turn_id:"quota-turn"}})+"\n"+
    JSON.stringify({type:"event_msg",payload:{type:"task_failed",turn_id:"quota-turn",error:{code:"usage_limit_reached"}}})+"\n");
  const goals=new DatabaseSync(path.join(root,"goals_1.sqlite"));
  goals.exec("CREATE TABLE thread_goals(thread_id TEXT PRIMARY KEY,status TEXT)");
  for(const id of ids)goals.prepare("INSERT INTO thread_goals VALUES(?,?)").run(id,"usage_limited");goals.close();
  tabs=ids.map(id=>({input:{viewType:"chatgpt.conversationEditor",uri:{scheme:"openai-codex",authority:"route",path:`/local/${id}`}}}));
  restoreTabs=vscode.window.tabGroups;
  Object.assign(vscode.window,{tabGroups:{get all(){return [{tabs}];},close:vi.fn(async()=>{tabs=[];return true;}),onDidChangeTabs:()=>({dispose(){}})}});
  vi.mocked(vscode.extensions.getExtension).mockReturnValue({isActive:true,exports:{},activate:async()=>({})} as never);
  vi.mocked(vscode.commands.executeCommand).mockImplementation(async (command,...args)=>{
    if(command==="vscode.openWith" && !tabs.some(tab => tab.input.uri.path === (args[0] as {path:string}).path))
      tabs.push({input:{viewType:"chatgpt.conversationEditor",uri:args[0] as never}});
  });
});
afterEach(async()=>{
  for(const item of disposables.splice(0))item.dispose();
  disposeSessionRecording();configureSqliteStateStore(undefined);store.close();
  Object.assign(vscode.window,{tabGroups:restoreTabs});vi.unstubAllEnvs();vi.restoreAllMocks();
  await removeTestDirectory(root);
});

it("captures quota-stopped parents, survives a fresh connection, verifies native editor opens, and consumes recovery",async()=>{
  store.set(namespace,snapshot,ids.slice(0,2));
  await persistOpenCodexSessions(context());
  expect(store.get(namespace,snapshot)).toEqual(ids.slice(0,2));
  store.close();store=await SqliteStateStore.open(path.join(root,"manager.sqlite"));configureSqliteStateStore(store);
  const result=await resumePersistedCodexSessions(context());
  expect(result).toEqual({attempted:2,opened:2,failed:[]});
  expect(resumeCodexSessionWork).toHaveBeenCalledWith(ids[0], expect.any(AbortSignal));
  expect(resumeCodexSessionWork).toHaveBeenCalledWith(ids[1], expect.any(AbortSignal));
  expect(tabs.map(tab=>tab.input.uri.path)).toEqual(ids.slice(0,2).map(id=>`/local/${id}`));
  expect(vscode.window.tabGroups.close).toHaveBeenCalledOnce();
  expect(vi.mocked(vscode.commands.executeCommand).mock.calls.filter(([command]) => command === "vscode.openWith").map(([, uri]) => (uri as {path:string}).path)).toEqual([...ids,...ids.slice(0,2)].map(id=>`/local/${id}`));
  expect(store.get(namespace,queue)).toBeUndefined();expect(store.get(namespace,snapshot)).toBeUndefined();
  expect((await resumePersistedCodexSessions(context())).attempted).toBe(0);
});

it.each([true, false])("keeps native capacity errors durable through capture and restart with goal-only=%s", async goalOnly => {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string) => key === "autoResumeGoalOnlyEnabled" ? goalOnly : key !== "cliIntegrationEnabled" } as never);
  const goals = new DatabaseSync(path.join(root, "goals_1.sqlite"));
  goals.exec("UPDATE thread_goals SET status='complete'");
  if (goalOnly) goals.prepare("UPDATE thread_goals SET status='active' WHERE thread_id=?").run(ids[0]!);
  else goals.prepare("DELETE FROM thread_goals WHERE thread_id=?").run(ids[0]!);
  goals.close();
  const transcript = path.join(root, "sessions", `rollout-${ids[0]}.jsonl`);
  await appendFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "restored-turn" } }) + "\n" +
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "restored-turn", error: { message: "Selected model is at capacity. Please try a different model.", codex_error_info: "server_overloaded" } } }) + "\n");
  tabs = [];
  store.set(namespace, snapshot, [ids[0]]);
  await persistOpenCodexSessions(context());
  expect(store.get(namespace, snapshot)).toEqual([ids[0]]);
  await closeCodexSessionsForExtensionHostRestart(context());
  store.close(); store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
  const opened = vi.fn(async () => undefined);
  expect(await resumePersistedCodexSessions(context(), opened)).toEqual({ attempted: 1, opened: 1, failed: [] });
  expect(opened).toHaveBeenCalledExactlyOnceWith(ids[0], expect.any(AbortSignal));
  expect(store.get(namespace, queue)).toBeUndefined();
});

it("seals goal recovery before reload cleanup and restores after the open-tab snapshot is replaced", async () => {
  store.set(namespace,snapshot,ids.slice(0,2));
  await persistOpenCodexSessions(context());
  await closeCodexSessionsForExtensionHostRestart(context());
  expect(tabs).toEqual([]);
  expect(store.get(namespace, queue)).toEqual(ids.slice(0, 2));
  store.set(namespace, snapshot, undefined);
  store.close(); store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
  expect(await resumePersistedCodexSessions(context())).toEqual({ attempted: 2, opened: 2, failed: [] });
  expect(tabs.map(tab => tab.input.uri.path)).toEqual(ids.slice(0, 2).map(id => `/local/${id}`));
  expect(store.get(namespace, queue)).toBeUndefined();
});

it("persists titles and projects across restarts, uses them offline, and removes consumed metadata", async () => {
  const read = vi.spyOn(sessionEditor, "readCodexCliSessionRecoveryMetadata").mockResolvedValue({
    [ids[0]!]: { title: "Pending outside project", projectPath: root, updatedAt: Date.now() }
  });
  await persistOpenCodexSessions(context(), async () => [ids[0]!]);
  expect(store.get<Record<string, unknown>>(namespace, metadata)?.[ids[0]!]).toMatchObject({ title: "Pending outside project", projectPath: root });
  store.close(); store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
  read.mockClear().mockRejectedValue(new Error("offline"));
  const failed = await resumePersistedCodexSessions(context(), async () => { throw new Error("editor offline"); });
  expect(read).not.toHaveBeenCalled();
  expect(formatAutoResumeResult(failed)).toContain("Pending outside project");
  expect(store.get(namespace, metadata)).toBeDefined();
  expect((await resumePersistedCodexSessions(context(), async () => undefined)).opened).toBe(1);
  expect(store.get(namespace, metadata)).toBeUndefined();
});

it("cleans orphaned and invalid metadata without deleting failed recovery", async () => {
  store.set(namespace, queue, [ids[0]]);
  store.set(namespace, metadata, {
    [ids[0]!]: { title: "Retry this", updatedAt: Date.now() },
    [ids[1]!]: { title: "Orphaned", updatedAt: Date.now() },
    invalid: { title: "Bad", updatedAt: "yesterday" }
  });
  await resumePersistedCodexSessions(context(), async () => { throw new Error("offline"); });
  expect(Object.keys(store.get<Record<string, unknown>>(namespace, metadata)!)).toEqual([ids[0]]);
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: () => false } as never);
  await resumePersistedCodexSessions(context());
  expect(store.get(namespace, metadata)).toBeUndefined();
  expect(store.get(namespace, queue)).toBeUndefined();
});

it("does not put legacy ID placeholders in auto-resume notifications", async () => {
  store.set(namespace, queue, [ids[0]]);
  store.set(namespace, metadata, { [ids[0]!]: { title: `Codex session ${ids[0]!.slice(0, 8)}`, updatedAt: Date.now() } });
  const result = await resumePersistedCodexSessions(context(), async () => undefined);
  expect(formatAutoResumeResult(result)).toContain("Untitled conversation");
  expect(formatAutoResumeResult(result)).not.toContain(ids[0]!.slice(0, 8));
});

it("retains previously recorded quota recovery when native running inspection is offline",async()=>{
  store.set(namespace,snapshot,ids.slice(0,2));
  const running=vi.spyOn(sessionEditor,"readRunningCodexSessionIds").mockRejectedValue(new Error("native IPC offline"));
  await expect(persistOpenCodexSessions(context())).rejects.toThrow("native IPC offline");
  expect(store.get(namespace,snapshot)).toEqual(ids.slice(0,2));
});

it("does not add idle quota goals without a previously running record",async()=>{
  await persistOpenCodexSessions(context());
  expect(store.get(namespace,snapshot)).toBeUndefined();
});

it.each(["active", "usage_limited"])("keeps a previously running %s goal durable between turns until its goal completes", async status => {
  tabs = [];
  const goals = new DatabaseSync(path.join(root, "goals_1.sqlite"));
  try {
    goals.exec("UPDATE thread_goals SET status='complete'");
    goals.prepare("UPDATE thread_goals SET status=? WHERE thread_id=?").run(status, ids[0]!);
    const transcript = path.join(root, "sessions", `rollout-${ids[0]}.jsonl`);
    await appendFile(transcript, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "last-turn" } }) + "\n" +
      JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "last-turn" } }) + "\n");
    saveSessionStatus(store, root, ids[0]!, "idle");
    saveSessionDiscovery(store, root, [], Date.now());
    await persistOpenCodexSessions(context());
    expect(store.get(namespace, snapshot)).toBeUndefined();
    store.set(namespace, snapshot, [ids[0]]);
    await persistOpenCodexSessions(context());
    store.close(); store = await SqliteStateStore.open(path.join(root, "manager.sqlite")); configureSqliteStateStore(store);
    expect(store.get(namespace, snapshot)).toEqual([ids[0]]);
    goals.prepare("UPDATE thread_goals SET status='complete' WHERE thread_id=?").run(ids[0]!);
    await persistOpenCodexSessions(context());
    expect(store.get(namespace, snapshot)).toBeUndefined();
  } finally { goals.close(); }
});

it("records native non-goal sidebar chats without an editor or dashboard and clears confirmed completion",async()=>{
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({get:(key:string)=>key!=="autoResumeGoalOnlyEnabled" && key!=="cliIntegrationEnabled"} as never);
  tabs=[];
  const goals=new DatabaseSync(path.join(root,"goals_1.sqlite"));goals.exec("DELETE FROM thread_goals");goals.close();
  saveSessionStatus(store,root,ids[0]!,"running");
  saveSessionDiscovery(store,root,[ids[0]!],Date.now());
  await persistOpenCodexSessions(context());
  expect(store.get(namespace,snapshot)).toEqual([ids[0]]);
  store.close();store=await SqliteStateStore.open(path.join(root,"manager.sqlite"));configureSqliteStateStore(store);
  expect(store.get(namespace,snapshot)).toEqual([ids[0]]);
  const transcript=path.join(root,"sessions",`rollout-${ids[0]}.jsonl`);
  await writeFile(transcript,JSON.stringify({type:"session_meta",payload:{id:ids[0],source:"vscode",cwd:root}})+"\n"+JSON.stringify({type:"event_msg",payload:{type:"task_complete",turn_id:"quota-turn"}})+"\n");
  saveSessionStatus(store,root,ids[0]!,"idle",Date.now()+1);
  await persistOpenCodexSessions(context());
  expect(store.get(namespace,snapshot)).toBeUndefined();
});
it("keeps recording in the same workspace while startup restoration is waiting for a native editor",async()=>{
  store.set(namespace,snapshot,[ids[0]]);
  const state=context();
  let release!:()=>void;
  const restoring=resumePersistedCodexSessions(state,()=>new Promise<void>(resolve=>{release=resolve;}));
  await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
  for(const id of ids)saveSessionStatus(store,root,id,id===ids[1]?"running":"idle");
  saveSessionDiscovery(store,root,[ids[1]!],Date.now());
  disposables.push(registerCodexSessionAutoResumeTracking(state));
  try {
    await vi.waitFor(()=>expect(store.get<string[]>(namespace,snapshot)).toContain(ids[1]));
    expect(store.get(namespace,queue)).toEqual([ids[0]]);
  } finally {release();await restoring;}
  expect(store.get(namespace,queue)).toBeUndefined();
});
it("does not overwrite a newer title committed while a metadata capture was waiting",async()=>{
  const state=context(),now=Date.now();
  let finish!:(value:Record<string,{title:string;updatedAt:number}>)=>void;
  vi.spyOn(sessionEditor,"readCodexCliSessionRecoveryMetadata").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const capture=persistOpenCodexSessions(state,async()=>[ids[0]!]);
  await vi.waitFor(()=>expect(finish).toBeTypeOf("function"));
  store.set(namespace,metadata,{[ids[0]!]:{title:"Newer native title",updatedAt:now+1}});
  finish({[ids[0]!]:{title:"Older capture",updatedAt:now}});
  await capture;
  expect(store.get<Record<string,{title:string}>>(namespace,metadata)?.[ids[0]!]!.title).toBe("Newer native title");
});

it("rolls back the snapshot transfer before opening tabs when its second write fails",async()=>{
  store.set(namespace,snapshot,[ids[0]]);
  const write=store.set.bind(store);
  vi.spyOn(store,"set").mockImplementation((ns,key,value)=>{if(key===snapshot&&value===undefined)throw new Error("storage full");write(ns,key,value);});
  const open=vi.fn();
  await expect(resumePersistedCodexSessions(context(),open)).rejects.toThrow("storage full");
  expect(open).not.toHaveBeenCalled();expect(store.get(namespace,snapshot)).toEqual([ids[0]]);expect(store.get(namespace,queue)).toBeUndefined();
});

it("retains peer captures and failed opens while preventing concurrent workspace restoration",async()=>{
  store.set(namespace,snapshot,[ids[0]]);
  let release!:()=>void;
  const open=vi.fn(()=>new Promise<void>(resolve=>{release=resolve;}));
  const first=resumePersistedCodexSessions(context(),open);
  await vi.waitFor(()=>expect(release).toBeTypeOf("function"));
  await expect(resumePersistedCodexSessions(context(),vi.fn())).rejects.toThrow("still in progress");
  await persistRunningCodexSessions(context(),async()=>[ids[1]!]);
  release();expect((await first).opened).toBe(1);
  expect(store.get(namespace,queue)).toEqual([ids[1]]);
  expect((await resumePersistedCodexSessions(context(),async()=>{throw new Error("editor offline");})).failed).toHaveLength(1);
  expect(store.get(namespace,queue)).toEqual([ids[1]]);
  expect((await resumePersistedCodexSessions(context(),async()=>undefined)).opened).toBe(1);
});

it("retains recovery when an isolated Codex home changes instead of dropping missing goals",async()=>{
  await persistOpenCodexSessions(context(),async()=>[ids[0]!]);
  vi.stubEnv("CODEX_HOME",path.join(root,"different-home"));
  const open=vi.fn();
  await expect(resumePersistedCodexSessions(context(),open)).rejects.toThrow("different Codex home");
  expect(open).not.toHaveBeenCalled();expect(store.get(namespace,snapshot)).toEqual([ids[0]]);
});

it("refreshes open-tab recovery on a committed status update and releases its subscriptions",async()=>{
  store.set(namespace,snapshot,ids.slice(0,2));
  const state=context();
  disposables.push(registerCodexSessionAutoResumeTracking(state));
  await vi.waitFor(()=>expect(store.get(namespace,snapshot)).toEqual(ids.slice(0,2)));
  const goals=new DatabaseSync(path.join(root,"goals_1.sqlite"));goals.prepare("UPDATE thread_goals SET status='complete' WHERE thread_id=?").run(ids[0]!);goals.close();
  tabs=tabs.filter(tab=>!tab.input.uri.path.endsWith(ids[0]!));
  saveSessionStatus(store,root,ids[1]!,"idle");
  await vi.waitFor(()=>expect(store.get(namespace,snapshot)).toEqual([ids[1]]));
  disposables.pop()!.dispose();
  expect(store.database.prepare("PRAGMA integrity_check").get()?.["integrity_check"]).toBe("ok");
});
