import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as vscode from "vscode";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureSqliteStateStore, createSqliteMemento, SqliteStateStore } from "../src/storage/sqliteState";
import { configureCrossWindowOperationCoordinator } from "../src/utils/crossWindowOperations";
import { AUTO_RESUME_SESSION_IDS_KEY as queue, AUTO_RESUME_OPEN_SESSION_IDS_KEY as snapshot, persistOpenCodexSessions, persistRunningCodexSessions, registerCodexSessionAutoResumeTracking, resumePersistedCodexSessions } from "../src/services/codexSessionAutoResume";
import { saveSessionStatus } from "../src/storage/sqliteSessions";
import { disposeSessionRecording } from "../src/services/sessionRecording";
import { removeTestDirectory } from "./testFilesystem";
import * as sessionEditor from "../src/services/codexSessionResume";

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
  await persistOpenCodexSessions(context());
  expect(store.get(namespace,snapshot)).toEqual(ids.slice(0,2));
  store.close();store=await SqliteStateStore.open(path.join(root,"manager.sqlite"));configureSqliteStateStore(store);
  const result=await resumePersistedCodexSessions(context());
  expect(result).toEqual({attempted:2,opened:2,failed:[]});
  expect(tabs.map(tab=>tab.input.uri.path)).toEqual(ids.map(id=>`/local/${id}`));
  expect(vscode.window.tabGroups.close).not.toHaveBeenCalled();
  expect(vi.mocked(vscode.commands.executeCommand).mock.calls.filter(([command]) => command === "vscode.openWith").map(([, uri]) => (uri as {path:string}).path)).toEqual(ids.slice(0,2).map(id=>`/local/${id}`));
  expect(store.get(namespace,queue)).toBeUndefined();expect(store.get(namespace,snapshot)).toBeUndefined();
  expect((await resumePersistedCodexSessions(context())).attempted).toBe(0);
});

it("captures quota-interrupted open tabs even when native running inspection is offline",async()=>{
  const running=vi.spyOn(sessionEditor,"readRunningCodexSessionIds").mockRejectedValue(new Error("native IPC offline"));
  await persistOpenCodexSessions(context());
  expect(running).not.toHaveBeenCalled();expect(store.get(namespace,snapshot)).toEqual(ids.slice(0,2));
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
