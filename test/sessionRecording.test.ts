import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { readSessionDiscovery, readSessionStatus, saveSessionDiscovery } from "../src/storage/sqliteSessions";
import { disposeSessionRecording, recordNativeSessionStatus, registerSessionRecording } from "../src/services/sessionRecording";
import * as sessions from "../src/services/codexSessionResume";
import * as nativeFs from "node:fs";
import { EventEmitter } from "node:events";

vi.mock("node:fs", async importOriginal => ({ ...await importOriginal<typeof import("node:fs")>() }));
import { removeTestDirectory } from "./testFilesystem";

vi.mock("../src/utils/crossWindowOperations", async importOriginal => {
  const original=await importOriginal<typeof import("../src/utils/crossWindowOperations")>();
  return {...original,runCrossWindowExclusive:async (_key:string,_label:string,task:(signal:AbortSignal)=>Promise<unknown>)=>task(new AbortController().signal)};
});

const id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
let root:string,store:SqliteStateStore;
let subscriptions:Array<{dispose():void}>;
beforeEach(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"session-recording-"));
  store=await SqliteStateStore.open(path.join(root,"manager.sqlite"));configureSqliteStateStore(store);
  vi.stubEnv("CODEX_HOME",root);subscriptions=[];vi.useFakeTimers();
  vi.spyOn(nativeFs,"watch").mockImplementation(() => Object.assign(new EventEmitter(), { close: vi.fn(), unref: vi.fn() }) as never);
});
afterEach(async()=>{
  for(const subscription of subscriptions)subscription.dispose();
  disposeSessionRecording();configureSqliteStateStore(undefined);store.close();
  vi.useRealTimers();vi.unstubAllEnvs();vi.restoreAllMocks();await removeTestDirectory(root);
});

it("discovers and renews native activity before expiry without any dashboard, then disposes cleanly",async()=>{
  let running=true;
  const scan=vi.spyOn(sessions,"readRunningCodexSessionIds").mockImplementation(async(home)=>{
    recordNativeSessionStatus(home!,id,running);
    const ids=running?[id]:[];saveSessionDiscovery(store,home!,ids,Date.now());return ids;
  });
  registerSessionRecording({subscriptions} as never);
  await vi.advanceTimersByTimeAsync(1_300);
  expect(scan).toHaveBeenCalledOnce();expect(readSessionStatus(store,root,id)).toBe("running");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(scan).toHaveBeenCalledTimes(2);expect(readSessionStatus(store,root,id)).toBe("running");
  running=false;await vi.advanceTimersByTimeAsync(10_000);
  expect(readSessionStatus(store,root,id)).toBe("idle");expect(readSessionDiscovery(store,root)?.ids).toEqual([]);
  subscriptions.pop()!.dispose();disposeSessionRecording();
  const calls=scan.mock.calls.length;await vi.advanceTimersByTimeAsync(60_000);
  expect(scan).toHaveBeenCalledTimes(calls);expect(vi.getTimerCount()).toBe(0);
});

it.each(["offline","timeout"])("retains saved discovery after %s inspection and retries on the next background tick",async failure=>{
  saveSessionDiscovery(store,root,[id],Date.now()-10_000);
  await vi.advanceTimersByTimeAsync(6_000);
  const scan=vi.spyOn(sessions,"readRunningCodexSessionIds").mockRejectedValueOnce(new Error(failure)).mockImplementation(async(home)=>{
    saveSessionDiscovery(store,home!,[],Date.now());return [];
  });
  vi.spyOn(console,"warn").mockImplementation(()=>undefined);
  registerSessionRecording({subscriptions} as never);
  await vi.advanceTimersByTimeAsync(1_100);
  expect(readSessionDiscovery(store,root)?.ids).toEqual([id]);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(scan).toHaveBeenCalledTimes(2);expect(readSessionDiscovery(store,root)?.ids).toEqual([]);
});

it("reuses a peer's fresh discovery and picks up scanning when it ages",async()=>{
  saveSessionDiscovery(store,root,[id],Date.now());
  const scan=vi.spyOn(sessions,"readRunningCodexSessionIds").mockResolvedValue([id]);
  registerSessionRecording({subscriptions} as never);
  await vi.advanceTimersByTimeAsync(1_100);expect(scan).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10_000);expect(scan).toHaveBeenCalledOnce();
});

it("backs off full-history discovery while idle and checks new file activity without a full scan",async()=>{
  const callbacks:Array<(event:string,file:string)=>void>=[];
  vi.mocked(nativeFs.watch).mockImplementation(((_home:unknown,_options:unknown,callback:(event:string,file:string)=>void)=>{
    callbacks.push(callback); return Object.assign(new EventEmitter(),{close:vi.fn(),unref:vi.fn()});
  }) as typeof nativeFs.watch);
  const scan=vi.spyOn(sessions,"readRunningCodexSessionIds").mockImplementation(async(home,_signal,ids)=>{
    if(!ids)saveSessionDiscovery(store,home!,[],Date.now());return [];
  });
  registerSessionRecording({subscriptions} as never);
  await vi.advanceTimersByTimeAsync(1_300);expect(scan).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(30_000);expect(scan).toHaveBeenCalledOnce();
  callbacks[0]!("change",`sessions/rollout-${id}.jsonl`);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(scan).toHaveBeenLastCalledWith(root,expect.any(AbortSignal),[id]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(scan.mock.calls.filter(call=>call[2]===undefined)).toHaveLength(2);
});

it("keeps the idle fallback when the watcher fails and never scans on Manager database writes",async()=>{
  let callback:((event:string,file:string)=>void)|undefined;
  const watcher=Object.assign(new EventEmitter(),{close:vi.fn(),unref:vi.fn()});
  vi.mocked(nativeFs.watch).mockImplementation(((_home:unknown,_options:unknown,fn:typeof callback)=>{callback=fn;return watcher;}) as typeof nativeFs.watch);
  const scan=vi.spyOn(sessions,"readRunningCodexSessionIds").mockImplementation(async(home)=>{saveSessionDiscovery(store,home!,[],Date.now());return [];});
  registerSessionRecording({subscriptions} as never);
  await vi.advanceTimersByTimeAsync(1_300);
  callback!("change","manager.sqlite-wal");await vi.advanceTimersByTimeAsync(15_000);expect(scan).toHaveBeenCalledOnce();
  watcher.emit("error",new Error("offline watcher"));expect(watcher.close).toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(50_000);expect(scan).toHaveBeenCalledTimes(2);
});
