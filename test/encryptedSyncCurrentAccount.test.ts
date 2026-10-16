import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import * as windowAccounts from "../src/services/windowAccountMode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock("undici", async (original) => ({ ...(await original<typeof import("undici")>()), fetch: fetchMock }));
import { EncryptedSyncManager } from "../src/services/encryptedSync";
import { AccountClaimAuthority } from "../src/services/accountClaimAuthority";
import { createSyncAccountEnablement } from "../src/services/syncEnablementRegistry";
import { configureCrossWindowOperationCoordinator, runCrossWindowExclusive } from "../src/utils/crossWindowOperations";
import { getCodexHomeStateKey } from "../src/codex/authFile";
import { subscribeDashboardRealtime } from "../src/services/dashboardRealtime";
import { consumeDashboardActionNotice, withDashboardNotificationSuppression } from "../src/utils/notificationPolicy";

let folder: string;
let manager: EncryptedSyncManager;
let state: Map<string, unknown>;
let active: string;
let disabled: Set<string>;
const registryKey = "codexManager.encryptedSync.localEnablement.v1";
const reconcile = () => (manager as unknown as { reconcileCurrentAccountClaim(): Promise<void> }).reconcileCurrentAccountClaim();

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "current-account-sync-"));
  await configureCrossWindowOperationCoordinator(folder);
  active = "previous";
  disabled = new Set();
  state = new Map([
    [
      registryKey,
      ["previous", "next"].map((accountId) =>
        createSyncAccountEnablement({ accountId, deviceId: "local-pc", deviceName: "Local PC", enabled: true })
      )
    ]
  ]);
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: (key: string, fallback?: unknown) =>
      key === "encryptedSyncClaimAllAccountsEnabled"
        ? false
        : key === "cloudflaredDomain"
          ? "https://dashboard.example"
          : fallback
  } as never);
  manager = new EncryptedSyncManager(
    {
      globalState: {
        get: (key: string, fallback?: unknown) => state.get(key) ?? fallback,
        update: async (key: string, value: unknown) => {
          state.set(key, value);
        }
      },
      secrets: {
        get: async (key: string) => (key.endsWith("deviceId") ? "local-pc" : "shared-password"),
        store: vi.fn()
      },
      subscriptions: []
    } as never,
    {
      listAccounts: async () => ["previous", "next"].map((id) => ({ id, isActive: id === active, enabled: !disabled.has(id) }))
    } as never
  );
  const authority = new AccountClaimAuthority(path.join(folder, "claims.json"), () =>
    manager.getRealtimeEnablementRegistry()
  );
  fetchMock.mockReset().mockImplementation(async (_url: unknown, options: { body: string }) => {
    const body = JSON.parse(options.body);
    const result = await authority.request(body.request);
    return new Response(
      JSON.stringify({ result, signature: await manager.signRealtimePeerPayload(JSON.stringify(result)) }),
      { headers: { "content-type": "application/json" } }
    );
  });
});
afterEach(async () => {
  manager.dispose();
  await (manager as unknown as { currentClaimTask?: Promise<void> }).currentClaimTask?.catch(() => undefined);
  await vi.waitFor(() => expect((manager as unknown as { currentClaimRefreshInFlight: boolean }).currentClaimRefreshInFlight).toBe(false));
  vi.restoreAllMocks();
  vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
    get: (key: string, fallback?: unknown) => key === "encryptedSyncClaimAllAccountsEnabled" ? true : fallback
  } as never);
  await rm(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("current account only sync", () => {
  it("yields stalled background claim renewal to a manual account switch", async () => {
    fetchMock.mockImplementationOnce((_url: unknown, options: { signal: AbortSignal }) =>
      new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }))
    );
    const background = (manager as unknown as { reconcileCurrentAccountClaim(): Promise<void> }).reconcileCurrentAccountClaim();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(runCrossWindowExclusive(`account:switch:${getCodexHomeStateKey()}`, "Account switch", async () => "switched", { waitMs: 2_000 })).resolves.toBe("switched");
    await background;
  });
  it("releases all local claims with no active account and preserves foreign ownership", async () => {
    active = "";
    const foreign = createSyncAccountEnablement({ accountId: "remote", deviceId: "remote-pc", deviceName: "Remote PC", enabled: true });
    state.set(registryKey, [...manager.getRealtimeEnablementRegistry(), foreign]);
    await (manager as unknown as { reconcileCurrentAccountClaim(): Promise<void> }).reconcileCurrentAccountClaim();
    expect(manager.getRealtimeEnablementRegistry().filter(entry => entry.enabled)).toEqual([foreign]);
  });

  it("releases stale saved-account claims even when the current claim conflicts", async () => {
    const foreign = createSyncAccountEnablement({ accountId: active, deviceId: "remote-pc", deviceName: "Remote PC", enabled: true });
    state.set(registryKey, [...manager.getRealtimeEnablementRegistry().filter(entry => entry.accountId !== active), foreign]);
    await expect((manager as unknown as { reconcileCurrentAccountClaim(): Promise<void> }).reconcileCurrentAccountClaim()).rejects.toThrow("Remote PC");
    expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === "next")?.enabled).toBe(false);
    expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === active)).toEqual(foreign);
  });

  it("continues independent cleanup when one claim release fails", async () => {
    active = "";
    fetchMock.mockRejectedValueOnce(new Error("release offline"));
    await expect(reconcile()).rejects.toThrow("release offline");
    expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === "previous")?.enabled).toBe(false);
    expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === "next")?.enabled).toBe(true);
    await reconcile();
    expect(manager.getRealtimeEnablementRegistry().every(entry => !entry.enabled)).toBe(true);
  });

  it("preserves host fencing when toggling all-account claims and releases through the host", async () => {
    await reconcile();
    const claim = manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === active)!;
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => key === "encryptedSyncClaimAllAccountsEnabled" ? true : key === "cloudflaredDomain" ? "https://dashboard.example" : fallback
    } as never);
    await manager.completeAccountEnablement(active, true);
    expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === active)).toEqual(claim);
    disabled.add(active);
    await manager.completeAccountEnablement(active, false);
    await reconcile();
    expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === active)).toMatchObject({ enabled: false, claimToken: claim.claimToken });
    disabled.delete(active);
    await manager.completeAccountEnablement(active, true);
    await reconcile();
    expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === active)).toMatchObject({ enabled: true, currentOnly: true });
  });

  it("never manufactures saved-account claims while building a lightweight vault", async () => {
    state.set(registryKey, []);
    const raw = await manager.getRealtimeEncryptedVault();
    const { decryptSyncPayload } = await import("../src/services/encryptedSync");
    expect(await decryptSyncPayload(raw!, "shared-password")).toMatchObject({ accounts: [], enablementRegistry: [] });
  });

  it("switches locally before claiming and releases previous ownership in the background", async () => {
    await manager.prepareAccountSwitch("next");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === "next")?.currentOnly).toBeUndefined();
    active = "next";
    await manager.completeAccountSwitch("next");
    await vi.waitFor(() => expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === "previous")?.enabled).toBe(false));
    expect(
      manager
        .getRealtimeEnablementRegistry()
        .filter((entry) => entry.enabled)
        .map((entry) => entry.accountId)
    ).toEqual(["next"]);
    expect(manager.getRealtimeEnablementRegistry().find((entry) => entry.accountId === "previous")).toMatchObject({
      enabled: false
    });
  });

  it("cancels preparation without making remote requests or releasing the prior account", async () => {
    state.set(
      registryKey,
      manager
        .getRealtimeEnablementRegistry()
        .map((entry) => (entry.accountId === "next" ? { ...entry, enabled: false } : entry))
    );
    await manager.prepareAccountSwitch("next");
    await manager.cancelAccountSwitch("next");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(manager.getRealtimeEnablementRegistry().find((entry) => entry.accountId === "next")?.enabled).toBe(false);
    expect(manager.getRealtimeEnablementRegistry().find((entry) => entry.accountId === "previous")?.enabled).toBe(true);
  });

  it.each([401, 403, 404, 503, "offline"])("completes local switching with a warning when claim confirmation fails with %s", async failure => {
    fetchMock.mockImplementation(async () => {
      if (failure === "offline") throw new Error("host offline");
      return new Response(JSON.stringify({ error: "claim unavailable" }), { status: failure, headers: { "content-type": "application/json" } });
    });
    const notices = vi.fn();
    const unsubscribe = subscribeDashboardRealtime(notices);
    try {
      await manager.prepareAccountSwitch("next");
      expect(fetchMock).not.toHaveBeenCalled();
      active = "next";
      const notice = await withDashboardNotificationSuppression(async () => {
        await manager.completeAccountSwitch("next");
        return consumeDashboardActionNotice();
      });
      expect(notice).toMatchObject({ level: "warning", message: expect.stringContaining("switched locally") });
      expect(notices).toHaveBeenCalledWith(expect.objectContaining({ type: "dashboard:notice", level: "warning" }));
      await expect(reconcile()).rejects.toThrow();
      expect(active).toBe("next");
      expect(manager.getRealtimeEnablementRegistry().some(entry => entry.currentOnly)).toBe(false);
    } finally { unsubscribe(); }
  });

  it("keeps forged background confirmations out of the registry after a local switch", async () => {
    await manager.prepareAccountSwitch("next");
    active = "next";
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { requestId: "wrong-request", ok: true }, signature: "forged" }), { headers: { "content-type": "application/json" } })
    );
    await expect(reconcile()).rejects.toThrow("could not confirm");
    expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === "next")?.currentOnly).toBeUndefined();
    expect(active).toBe("next");
  });

  it("rejects known foreign ownership before local switching without contacting the host", async () => {
    state.set(registryKey, [createSyncAccountEnablement({ accountId: "next", deviceId: "remote-pc", deviceName: "Remote PC", enabled: true, lastSyncedAt: Date.now() })]);
    await expect(manager.prepareAccountSwitch("next")).rejects.toThrow("Remote PC");
    expect(active).toBe("previous");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows local preparation with missing or expired ownership without fabricating a claim", async () => {
    state.set(registryKey, []);
    await manager.prepareAccountSwitch("next");
    await manager.cancelAccountSwitch("next");
    state.set(registryKey, [{ ...createSyncAccountEnablement({ accountId: "next", deviceId: "remote-pc", deviceName: "Remote PC", enabled: true, lastSyncedAt: Date.now() - 31 * 60_000 }), currentOnly: true }]);
    await manager.prepareAccountSwitch("next");
    await manager.cancelAccountSwitch("next");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(manager.getRealtimeEnablementRegistry()[0]?.deviceId).toBe("remote-pc");
  });

  it("does not await a stalled background registry mutation during local preparation", async () => {
    (manager as unknown as { mutationChain: Promise<void> }).mutationChain = new Promise(() => undefined);
    await expect(manager.prepareAccountSwitch("next")).resolves.toBeUndefined();
    await manager.cancelAccountSwitch("next");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows switching while background confirmation is stalled and retries after reconnect", async () => {
    fetchMock.mockImplementationOnce((_url: unknown, options: { signal: AbortSignal }) =>
      new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }))
    );
    const background = reconcile();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await manager.prepareAccountSwitch("next");
    active = "next";
    await manager.completeAccountSwitch("next");
    expect(active).toBe("next");
    await runCrossWindowExclusive(`account:switch:${getCodexHomeStateKey()}`, "Account switch", async () => undefined, { waitMs: 2_000 });
    await background;
    await reconcile();
    expect(manager.getRealtimeEnablementRegistry().find(entry => entry.accountId === "next")).toMatchObject({ enabled: true, currentOnly: true });
  });

  it("serializes concurrent peer registry updates without losing unrelated claims", async () => {
    const foreign = ["remote-a", "remote-b"].map((accountId) =>
      createSyncAccountEnablement({ accountId, deviceId: accountId, deviceName: accountId, enabled: true })
    );
    await Promise.all(foreign.map((entry) => manager.applyRealtimeEnablementRegistry([entry])));
    expect(manager.getRealtimeEnablementRegistry().map((entry) => entry.accountId)).toEqual([
      "next",
      "previous",
      "remote-a",
      "remote-b"
    ]);
  });
  it("never releases another PC's claim when that account is disabled locally", async () => {
    vi.mocked(vscode.workspace.getConfiguration).mockReturnValue({
      get: (key: string, fallback?: unknown) => key === "encryptedSyncClaimAllAccountsEnabled" ? true : fallback
    } as never);
    const foreign = createSyncAccountEnablement({
      accountId: "next",
      deviceId: "remote-pc",
      deviceName: "Remote PC",
      enabled: true,
      lastSyncedAt: Date.now()
    });
    state.set(registryKey, [foreign]);
    await manager.completeAccountEnablement("next", false);
    expect(manager.getRealtimeEnablementRegistry()).toEqual([foreign]);
  });
  it("preserves accounts still current in another live window on this PC", async () => {
    vi.spyOn(windowAccounts, "readCrossWindowActiveAccountIds").mockResolvedValue(["previous", "next"]);
    await manager.prepareAccountSwitch("next");
    active = "next";
    await manager.completeAccountSwitch("next");
    await reconcile();
    expect(manager.getRealtimeEnablementRegistry().filter((entry) => entry.enabled).map((entry) => entry.accountId)).toEqual(["next", "previous"]);
  });

  it("retains an account being prepared for a switch during background renewal", async () => {
    await manager.prepareAccountSwitch("next");
    await (manager as unknown as { reconcileCurrentAccountClaim(): Promise<void> }).reconcileCurrentAccountClaim();
    expect(manager.getRealtimeEnablementRegistry().find((entry) => entry.accountId === "next")?.enabled).toBe(true);
    await manager.cancelAccountSwitch("next");
  });

});
