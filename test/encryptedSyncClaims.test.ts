import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeTestDirectory } from "./testFilesystem";
import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptedSyncManager, getSyncedAccountLeases } from "../src/services/encryptedSync";
import { getSqliteStateStore, createSqliteMemento, SqliteStateStore } from "../src/storage/sqliteState";
import { fetch as claimFetch } from "undici";

vi.mock("undici", async importOriginal => ({ ...await importOriginal<typeof import("undici")>(), fetch: vi.fn() }));
vi.mock("../src/storage/sqliteState", async importOriginal => ({ ...await importOriginal<typeof import("../src/storage/sqliteState")>(), getSqliteStateStore: vi.fn() }));
const managers: EncryptedSyncManager[] = [];
const claim = { accountId: "one", deviceId: "peer", deviceName: "Other PC", enabled: true, revision: 1, updatedAt: 1000, lastSyncedAt: Date.now() };
function fixture() {
  const state = new Map<string, unknown>();
  const context = { subscriptions: [], globalState: { get: (key: string, fallback?: unknown) => state.get(key) ?? fallback,
    update: vi.fn(async (key: string, value: unknown) => { state.set(key, value); }), setKeysForSync: vi.fn() },
    secrets: { get: vi.fn(async (key: string) => key.endsWith("deviceId") ? "local" : undefined), store: vi.fn() } };
  const manager = new EncryptedSyncManager(context as never, { flush: vi.fn(async () => undefined) } as never);
  managers.push(manager);
  return { manager, state, internal: manager as any };
}
beforeEach(() => {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({ get: (key: string, fallback: unknown) =>
    key === "cloudflaredDomain" ? "https://dashboard.example" : ["encryptedSyncEnabled", "encryptedSyncClaimAllAccountsEnabled"].includes(key) ? true : fallback } as never);
  vi.mocked(getSqliteStateStore).mockReturnValue(undefined);
});
afterEach(() => { for (const manager of managers.splice(0)) manager.dispose(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("claim recovery and manual sync priority", () => {
  it.each(["prepareAccountSwitch", "prepareAccountEnablement"] as const)("bounds %s before a stalled storage commit and never runs it late", async method => {
    vi.useFakeTimers();
    const { manager, internal } = fixture();
    let finish!: () => void;
    internal.mutationChain = new Promise<void>(resolve => { finish = resolve; });
    const refresh = vi.spyOn(internal, "refreshEnablementFromDownloadedVault");
    const pending = method === "prepareAccountSwitch" ? manager.prepareAccountSwitch("one") : manager.prepareAccountEnablement("one", true);
    const result = expect(pending).rejects.toThrow("Account storage is still committing");
    await vi.advanceTimersByTimeAsync(500);
    await result;
    finish();
    await Promise.resolve();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("reports a stalled storage commit during manual sync without clearing pending changes", async () => {
    vi.useFakeTimers();
    const { manager, state, internal } = fixture();
    internal.mutationChain = new Promise<void>(() => undefined);
    vi.spyOn(internal, "getOrPromptForPassphrase").mockResolvedValue("shared-password");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const showError = vi.spyOn(vscode.window, "showErrorMessage");
    state.set("codexManager.encryptedSync.vaultDirty.v1", ["local-change"]);
    const result = manager.syncNow(true, false, false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toBe(false);
    expect(showError).toHaveBeenCalledWith(expect.stringContaining("Account storage is still committing"));
    expect(state.get("codexManager.encryptedSync.vaultDirty.v1")).toEqual(["local-change"]);
  });

  it.each([404, 405, 501])("identifies incompatible shared hosts without treating HTTP %s as browser expiry", async status => {
    const { manager, internal } = fixture();
    vi.spyOn(manager, "signRealtimePeerPayload").mockResolvedValue("signed");
    const cancel = vi.fn(async () => undefined);
    vi.mocked(claimFetch).mockResolvedValueOnce({ status, ok: false, body: { cancel } } as never);
    await expect(internal.requestCurrentClaim("acquire", "one")).rejects.toThrow("Update and reload Codex Manager on the PC hosting");
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.mocked(claimFetch).mock.lastCall?.[1]?.headers).not.toHaveProperty("Cookie");
  });

  it("reports HTTP 401 as claim authentication failure without requiring browser login or an update", async () => {
    const { manager, internal } = fixture();
    vi.spyOn(manager, "signRealtimePeerPayload").mockResolvedValue("signed");
    const cancel = vi.fn(async () => undefined);
    vi.mocked(claimFetch).mockResolvedValueOnce({ status: 401, body: { cancel } } as never);
    await expect(internal.requestCurrentClaim("acquire", "one")).rejects.toThrow("authentication was rejected (HTTP 401)");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not accept a signed response granting another device's claim", async () => {
    const { manager, internal } = fixture();
    vi.spyOn(manager, "signRealtimePeerPayload").mockResolvedValue("signed");
    vi.spyOn(manager, "verifyRealtimePeerPayload").mockResolvedValue(true);
    const apply = vi.spyOn(manager, "applyRealtimeEnablementRegistry");
    vi.mocked(claimFetch).mockImplementationOnce(async (_url, init) => ({ status: 200, ok: true,
      headers: new Headers({ "content-type": "application/json" }), json: async () => ({ result: { ok: true,
        requestId: JSON.parse(String(init?.body)).request.requestId, claim }, signature: "signed" }) } as never));
    await expect(internal.requestCurrentClaim("acquire", "one")).rejects.toThrow("rejected");
    expect(apply).not.toHaveBeenCalled();
  });

  it("refreshes committed claims from another local window without waiting for polling", async () => {
    const { manager, state } = fixture();
    let changed!: () => void;
    vi.mocked(getSqliteStateStore).mockReturnValue({ subscribe: (_topics: unknown, listener: () => void) => { changed = listener; return vi.fn(); } } as never);
    state.set("codexManager.encryptedSync.localEnablement.v1", [claim]);
    await manager.start();
    expect(getSyncedAccountLeases()).toHaveLength(1);
    const notify = vi.fn(); manager.setOnStateChanged(notify);
    state.set("codexManager.encryptedSync.localEnablement.v1", [{ ...claim, enabled: false, revision: 2 }]);
    changed();
    expect(getSyncedAccountLeases()).toEqual([]);
    expect(notify).toHaveBeenCalledOnce();
    changed();
    expect(notify).toHaveBeenCalledOnce();
  });

  it("bounds VS Code Settings Sync and reuses an unacknowledged command", async () => {
    vi.useFakeTimers();
    const { internal } = fixture();
    let finish!: () => void;
    vi.mocked(vscode.commands.executeCommand).mockReset().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    const first = internal.ensureSettingsSyncReady(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toBe(false);
    const retry = internal.ensureSettingsSyncReady(false);
    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
    finish();
    expect(await retry).toBe(true);
  });

  it("starts manual sync after cancelling an optional background Settings Sync wait", async () => {
    const { manager, internal } = fixture();
    let waiting!: () => void;
    const ready = new Promise<void>(resolve => { waiting = resolve; });
    let finish!: () => void;
    vi.mocked(vscode.commands.executeCommand).mockReset().mockImplementation(() => new Promise<void>(resolve => { finish = resolve; waiting(); }));
    const perform = vi.spyOn(internal, "performSyncNow").mockImplementation(async (interactive: unknown) => {
      if (!interactive) { await internal.ensureSettingsSyncReady(false); return false; }
      return true;
    });
    const background = manager.syncNow(false, false, true);
    await ready;
    await expect(manager.syncNow(true)).resolves.toBe(true);
    await expect(background).resolves.toBe(false);
    expect(perform).toHaveBeenCalledTimes(2);
    expect(vscode.commands.executeCommand).toHaveBeenCalledOnce();
    finish();
  });
  it("atomically retains newer claims committed by another window", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "claim-merge-"));
    const store = await SqliteStateStore.open(path.join(root, "manager.sqlite"));
    try {
      const { internal } = fixture();
      const legacy = { keys: () => [], get: () => undefined, update: async () => undefined };
      internal.context.globalState = createSqliteMemento(store, "global", legacy as never);
      const key = "codexManager.encryptedSync.localEnablement.v1";
      store.set("global", key, [{ ...claim, enabled: false, revision: 3 }]);
      await internal.storeLocalEnablement([{ ...claim, enabled: true, revision: 1 }], "local");
      expect(store.get("global", key)).toEqual([{ ...claim, enabled: false, revision: 3 }]);
      expect(getSyncedAccountLeases()).toEqual([]);
    } finally { store.close(); await removeTestDirectory(root); }
  });

});

it.each([false,true])('does not create or advertise claims while Sync and Claim is off (claim-all: %s)', async claimAll => {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({get:(key:string,fallback:unknown)=>key==='encryptedSyncEnabled'?false:key==='encryptedSyncClaimAllAccountsEnabled'?claimAll:fallback} as never);
  const {manager,state,internal}=fixture();state.set('codexManager.encryptedSync.localEnablement.v1',[claim]);
  const acquire=vi.spyOn(internal,'requestCurrentClaim');
  await manager.prepareAccountSwitch('one');await manager.prepareAccountEnablement('one',true);await manager.completeAccountEnablement('new',true);
  manager.onAccountsMutated({addedAccountIds:['new'],removedAccountIds:[]});await internal.mutationChain;
  expect(manager.getRealtimeEnablementRegistry()).toEqual([]);
  expect(state.get('codexManager.encryptedSync.localEnablement.v1')).toEqual([claim]);
  expect(acquire).not.toHaveBeenCalled();
});
it('rechecks disabled claims after waiting for an earlier write', async () => {
  let enabled=true;vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({get:(key:string,fallback:unknown)=>key==='encryptedSyncEnabled'?enabled:key==='encryptedSyncClaimAllAccountsEnabled'?true:fallback} as never);
  const {manager,state,internal}=fixture();let finish!:()=>void;
  internal.mutationChain=new Promise<void>(resolve=>{finish=resolve;});
  const pending=manager.completeAccountEnablement('one',true);enabled=false;finish();await pending;
  expect(state.get('codexManager.encryptedSync.localEnablement.v1')).toBeUndefined();
});
it('does not acquire after Sync and Claim turns off while password storage is pending', async () => {
  let enabled=true;vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({get:(key:string,fallback:unknown)=>key==='encryptedSyncEnabled'?enabled:key==='cloudflaredDomain'?'https://dashboard.example':fallback} as never);
  const {manager,internal}=fixture();let finish!:(value:string)=>void;
  const sign=vi.spyOn(manager,'signRealtimePeerPayload').mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  vi.mocked(claimFetch).mockClear();const pending=internal.requestCurrentClaim('acquire','one');
  await vi.waitFor(()=>expect(sign).toHaveBeenCalled());enabled=false;finish('signed');
  await expect(pending).rejects.toThrow('Sync and Claim is off');expect(claimFetch).not.toHaveBeenCalled();
});

it('releases only this PC’s legacy claims while disabled and forwards release records for stale peers', async () => {
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({get:(key:string,fallback:unknown)=>key==='encryptedSyncEnabled'?false:fallback} as never);
  const {manager,state,internal}=fixture();
  const own={...claim,accountId:'local-account',deviceId:'local',deviceName:'Local PC'};
  state.set('codexManager.encryptedSync.localEnablement.v1',[claim,own]);
  await internal.reconcileCurrentAccountClaim();
  expect(manager.getRealtimeEnablementRegistry()).toEqual([expect.objectContaining({accountId:'local-account',deviceId:'local',enabled:false})]);
  expect((state.get('codexManager.encryptedSync.localEnablement.v1') as typeof claim[]).find(entry=>entry.accountId==='one')).toEqual(claim);
});
