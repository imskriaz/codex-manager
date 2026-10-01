import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EncryptedSyncManager,
  encryptSyncPayload,
  getEncryptedSyncSettingsFailure,
  type SyncPayload
} from "../src/services/encryptedSync";
import { createSyncAccountEnablement, type SyncAccountEnablement } from "../src/services/syncEnablementRegistry";

const SYNC_KEY = "codexManager.encryptedSync.v1";
const LOCAL_KEY = "codexManager.encryptedSync.localEnablement.v1";
const PASSWORD = "settings-sync-regression-password";
const managers: EncryptedSyncManager[] = [];

function payload(entries: SyncAccountEnablement[]): SyncPayload {
  return {
    format: "codex-manager-encrypted-sync",
    version: 1,
    updatedAt: Date.now(),
    deviceId: "peer",
    accounts: [],
    enablementRegistry: entries
  };
}

function fixture(raw?: string, entries: SyncAccountEnablement[] = [], deviceId = "local") {
  const state = new Map<string, unknown>([[LOCAL_KEY, entries]]);
  if (raw) state.set(SYNC_KEY, raw);
  const context = {
    subscriptions: [],
    globalState: {
      get: <T>(key: string, fallback?: T) => (state.has(key) ? (state.get(key) as T) : fallback),
      update: vi.fn(async (key: string, value: unknown) => {
        state.set(key, value);
      }),
      setKeysForSync: vi.fn()
    },
    secrets: {
      get: vi.fn(async (key: string) => (key.endsWith("passphrase") ? PASSWORD : deviceId)),
      store: vi.fn(),
      delete: vi.fn()
    }
  } as unknown as vscode.ExtensionContext;
  const repo = {
    listAccounts: vi.fn(async () => []),
    invalidateCachedIndex: vi.fn(),
    flush: vi.fn(async () => undefined)
  };
  const manager = new EncryptedSyncManager(context, repo as never);
  managers.push(manager);
  return { manager, context, state };
}

describe("Settings Sync request budget", () => {
  beforeEach(() => {
    vi.mocked(vscode.commands.executeCommand).mockReset().mockResolvedValue(undefined);
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => (key === "encryptedSyncEnabled" ? true : fallback),
      update: vi.fn(),
      inspect: vi.fn()
    } as unknown as vscode.WorkspaceConfiguration);
    vi.mocked(vscode.workspace.onDidChangeConfiguration).mockReturnValue({ dispose: vi.fn() });
  });

  afterEach(async () => {
    for (const manager of managers.splice(0)) manager.dispose();
    vi.useRealTimers();
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const reset = new EncryptedSyncManager({} as vscode.ExtensionContext, {} as never);
    await (reset as unknown as { ensureSettingsSyncReady(): Promise<boolean> }).ensureSettingsSyncReady();
    reset.dispose();
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("merges downloads without network requests or changing the downloaded ciphertext", async () => {
    const claim = createSyncAccountEnablement({
      accountId: "account",
      deviceId: "local",
      deviceName: "Local PC",
      enabled: true,
      now: 100
    });
    const raw = await encryptSyncPayload(payload([claim]), PASSWORD);
    vi.useFakeTimers();
    const receiver = fixture(undefined, [claim]);
    await receiver.manager.start();
    const sync = vi.spyOn(receiver.manager, "syncNow");
    receiver.state.set(SYNC_KEY, raw);
    await vi.advanceTimersByTimeAsync(5000);
    expect(sync).toHaveBeenCalledOnce();
    await expect(sync.mock.results[0]?.value).resolves.toBe(true);
    expect(receiver.state.get(SYNC_KEY)).toBe(raw);
    expect(receiver.state.get(LOCAL_KEY)).toEqual([claim]);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    vi.mocked(receiver.context.globalState.update).mockClear();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(receiver.context.globalState.update).not.toHaveBeenCalled();
  });

  it("converges two PCs and ignores equivalent reencrypted or repeated peer snapshots", async () => {
    const claims = ["one", "two"].map((deviceId) =>
      createSyncAccountEnablement({ accountId: deviceId, deviceId, deviceName: "PC", enabled: true, now: 100 })
    );
    const raw = await encryptSyncPayload(payload(claims), PASSWORD);
    const one = fixture(raw, claims, "one");
    const two = fixture(raw, claims, "two");
    const outbound = await one.manager.getRealtimeEncryptedVault();
    const echo = await encryptSyncPayload({ ...payload(claims), updatedAt: Date.now() + 1 }, PASSWORD);
    await expect(two.manager.applyRealtimeEncryptedVault(outbound!)).resolves.toBe(true);
    await expect(one.manager.applyRealtimeEncryptedVault(echo)).resolves.toBe(true);
    await expect(two.manager.applyRealtimeEncryptedVault(outbound!)).resolves.toBe(true);
    expect(one.state.get(SYNC_KEY)).toBe(raw);
    expect(two.state.get(SYNC_KEY)).toBe(raw);
    expect(one.state.get(LOCAL_KEY)).toEqual(claims);
    expect(two.state.get(LOCAL_KEY)).toEqual(claims);
    expect(await one.manager.getRealtimeEncryptedVault()).toBe(outbound);
    expect(vscode.commands.executeCommand).not.toHaveBeenCalled();
    expect(one.context.globalState.update).not.toHaveBeenCalledWith(SYNC_KEY, expect.anything());
    expect(two.context.globalState.update).not.toHaveBeenCalledWith(SYNC_KEY, expect.anything());
  });

  it("applies a real peer revision once, then ignores its echoes", async () => {
    const claim = createSyncAccountEnablement({
      accountId: "account",
      deviceId: "peer",
      deviceName: "PC",
      enabled: true,
      now: 100
    });
    const raw = await encryptSyncPayload(payload([claim]), PASSWORD);
    const changed = { ...claim, revision: 2, enabled: false, updatedAt: 200 };
    const inbound = await encryptSyncPayload(payload([changed]), PASSWORD);
    const { manager, state, context } = fixture(raw, [claim]);
    await expect(manager.applyRealtimeEncryptedVault(inbound)).resolves.toBe(true);
    const applied = state.get(SYNC_KEY);
    expect(applied).not.toBe(raw);
    expect(state.get(LOCAL_KEY)).toEqual([changed]);
    vi.mocked(context.globalState.update).mockClear();
    await expect(manager.applyRealtimeEncryptedVault(inbound)).resolves.toBe(true);
    expect(state.get(SYNC_KEY)).toBe(applied);
    expect(context.globalState.update).not.toHaveBeenCalled();
  });

  it("renews durable activity at bounded intervals only during explicit network sync", async () => {
    const now = Date.now();
    const claim = createSyncAccountEnablement({
      accountId: "account",
      deviceId: "local",
      deviceName: "PC",
      enabled: true,
      now,
      lastSyncedAt: now
    });
    const raw = await encryptSyncPayload(payload([claim]), PASSWORD);
    const { manager, state } = fixture(raw, [claim]);
    await expect(manager.syncNow(true, false, true)).resolves.toBe(true);
    expect(state.get(SYNC_KEY)).toBe(raw);
    vi.useFakeTimers();
    vi.setSystemTime(now + 31 * 60 * 1000);
    await expect(manager.syncNow(false, false, false)).resolves.toBe(true);
    expect(state.get(SYNC_KEY)).toBe(raw);
    await expect(manager.syncNow(true, false, true)).resolves.toBe(true);
    expect(state.get(SYNC_KEY)).not.toBe(raw);
    expect(state.get(LOCAL_KEY)).toEqual([{ ...claim, lastSyncedAt: now + 31 * 60 * 1000 }]);
  });

  it("preserves pending changes across restart and retries storage failure after batching", async () => {
    vi.useFakeTimers();
    const { manager, state } = fixture();
    state.set("codexManager.encryptedSync.vaultDirty.v1", ["enablement-changed"]);
    const sync = vi.spyOn(manager, "syncNow").mockRejectedValueOnce(new Error("Disk full")).mockResolvedValue(true);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await manager.start();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1);
    expect(sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.get("codexManager.encryptedSync.vaultDirty.v1")).toEqual(["enablement-changed"]);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenCalledWith(false, false, false);
  });

  it("stops forcing sync after device suspension and gives manual callers restart guidance", async () => {
    vi.mocked(vscode.commands.executeCommand).mockRejectedValue(
      Object.assign(new Error("Request blocked"), { code: "LocalTooManyRequests" })
    );
    const { manager } = fixture();
    await expect(manager.syncNow(true, false, true)).resolves.toBe(false);
    await expect(manager.syncNow(true, false, true)).resolves.toBe(false);
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(1);
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("Restart Visual Studio Code"));
    expect(getEncryptedSyncSettingsFailure()).toMatch(/suspended/);
    vi.mocked(vscode.commands.executeCommand).mockResolvedValue(undefined);
    const restarted = fixture();
    await restarted.manager.syncNow(true, false, true);
    expect(vscode.commands.executeCommand).toHaveBeenCalledTimes(2);
    expect(getEncryptedSyncSettingsFailure()).toBeUndefined();
  });
});
