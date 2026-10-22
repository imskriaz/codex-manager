import { buildAccountStorageId } from "../src/utils/accountIdentity";
import * as vscode from "vscode";
import { beforeEach, describe, expect, it, vi } from "vitest";

const oauthMocks = vi.hoisted(() => ({
  complete: vi.fn(),
  listen: vi.fn(),
  prepare: vi.fn()
}));
const quotaMocks = vi.hoisted(() => ({ refresh: vi.fn() }));
const activationMocks = vi.hoisted(() => ({ activate: vi.fn() }));

vi.mock("../src/auth/oauth", () => ({
  completeOAuthLoginSession: oauthMocks.complete,
  listenForPreparedOAuthLoginSession: oauthMocks.listen,
  prepareOAuthLoginSession: oauthMocks.prepare,
  runPreparedOAuthLoginSession: vi.fn()
}));
vi.mock("../src/application/accounts/quota", () => ({
  refreshImportedAccountQuota: quotaMocks.refresh
}));
vi.mock("../src/application/accounts/queuedAccountActivation", () => ({
  activateQueuedAccountIfCurrentMissing: activationMocks.activate
}));

import { DashboardOAuthCoordinator } from "../src/presentation/dashboard/oauthCoordinator";

describe("dashboard OAuth encrypted sync", () => {
  it("shares duplicate listeners and commits concurrent callback completion once", async () => {
    let finish!: (tokens: Record<string, string>) => void;
    const pending = new Promise<Record<string, string>>(resolve => { finish = resolve; });
    oauthMocks.listen.mockReturnValue(pending);
    oauthMocks.complete.mockReturnValue(pending);
    const repo = { upsertFromTokens: vi.fn().mockResolvedValue({ id: "one", email: "one@example.com" }) };
    const notify = vi.fn(), coordinator = new DashboardOAuthCoordinator(repo as never, vi.fn(), undefined, notify);
    const id = coordinator.prepareSession(key => key)?.oauthSession?.sessionId;
    const first = coordinator.startAutoFlow(id, key => key), duplicate = coordinator.startAutoFlow(id, key => key);
    const manual = coordinator.completeSession(id, "http://localhost/callback?code=ok", key => key);
    finish({ idToken: "id", accessToken: "access" });
    const results = await Promise.all([first, duplicate, manual]);
    expect(results.every(result => result?.email === "one@example.com")).toBe(true);
    expect(oauthMocks.listen).toHaveBeenCalledOnce(); expect(repo.upsertFromTokens).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce(); expect(quotaMocks.refresh).toHaveBeenCalledOnce();
    await expect(coordinator.completeSession(id, "http://localhost/callback?code=ok", key => key)).resolves.toEqual(results[0]);
    coordinator.dispose();
  });

  it("keeps the selected reauthorization identity after session cancellation during exchange", async () => {
    let finish!: (tokens: Record<string, string>) => void;
    oauthMocks.complete.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const repo = { upsertFromTokens: vi.fn(), updateTokens: vi.fn() };
    const coordinator = new DashboardOAuthCoordinator(repo as never, vi.fn());
    const id = coordinator.prepareSession(key => key, "expected-account")?.oauthSession?.sessionId;
    const pending = coordinator.completeSession(id, "http://localhost/callback?code=ok", key => key);
    const outcome = expect(pending).rejects.toThrow("message.oauthCallbackFailed");
    coordinator.cancelSession(id); finish({ idToken: "wrong-account", accessToken: "access" });
    await outcome; expect(repo.upsertFromTokens).not.toHaveBeenCalled(); expect(repo.updateTokens).not.toHaveBeenCalled();
    coordinator.dispose();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    oauthMocks.prepare.mockReturnValue({
      authUrl: "https://auth.example.test",
      redirectUri: "http://localhost/callback",
      state: "state",
      verifier: "verifier"
    });
    oauthMocks.complete.mockResolvedValue({
      idToken: "id-token",
      accessToken: "access-token",
      refreshToken: "refresh-token"
    });
    oauthMocks.listen.mockResolvedValue({
      idToken: "id-token",
      accessToken: "access-token",
      refreshToken: "refresh-token"
    });
    quotaMocks.refresh.mockResolvedValue({});
    activationMocks.activate.mockResolvedValue({ status: "not-needed" });
  });

  it("uses the newly visible account as OAuth success feedback", async () => {
    const repo = {
      upsertFromTokens: vi.fn().mockResolvedValue({ id: "one", email: "one@example.com" })
    };
    const syncAccountChange = vi.fn().mockResolvedValue(true);
    const coordinator = new DashboardOAuthCoordinator(repo as never, vi.fn(), syncAccountChange);
    const prepared = coordinator.prepareSession((key) => key);

    const result = await coordinator.completeSession(
      prepared?.oauthSession?.sessionId,
      "http://localhost/callback?code=ok",
      (key) => key
    );

    expect(syncAccountChange).toHaveBeenCalledOnce();
    expect(syncAccountChange.mock.invocationCallOrder[0]).toBeGreaterThan(
      quotaMocks.refresh.mock.invocationCallOrder[0] ?? 0
    );
    expect(result?.email).toBe("one@example.com");
    expect(result?.notice).toBeUndefined();
    expect(vscode.window.showInformationMessage).not.toHaveBeenCalled();
  });

  it("starts the callback listener for a prepared link without opening the browser", async () => {
    const repo = {
      upsertFromTokens: vi.fn().mockResolvedValue({ id: "one", email: "one@example.com" })
    };
    const coordinator = new DashboardOAuthCoordinator(repo as never, vi.fn());
    const prepared = coordinator.prepareSession((key) => key);

    await expect(coordinator.startAutoFlow(prepared?.oauthSession?.sessionId, (key) => key)).resolves.toMatchObject({
      email: "one@example.com"
    });

    expect(oauthMocks.listen).toHaveBeenCalledOnce();
    expect(oauthMocks.listen).toHaveBeenCalledWith(
      expect.objectContaining({ authUrl: "https://auth.example.test" }),
      expect.any(Object)
    );
  });

  it("reports durable authorization before slower account follow-up work finishes", async () => {
    let finishQuota!: () => void;
    quotaMocks.refresh.mockImplementationOnce(
      () => new Promise<void>((resolve) => { finishQuota = resolve; })
    );
    const repo = {
      upsertFromTokens: vi.fn().mockResolvedValue({ id: "one", email: "one@example.com" })
    };
    const notifyAuthorized = vi.fn();
    const coordinator = new DashboardOAuthCoordinator(repo as never, vi.fn(), undefined, notifyAuthorized);
    const prepared = coordinator.prepareSession((key) => key);

    const completion = coordinator.startAutoFlow(prepared?.oauthSession?.sessionId, (key) => key);
    await vi.waitFor(() => expect(notifyAuthorized).toHaveBeenCalledOnce());

    expect(notifyAuthorized).toHaveBeenCalledWith(prepared?.oauthSession?.sessionId, "one@example.com");
    finishQuota();
    await expect(completion).resolves.toMatchObject({ email: "one@example.com" });
  });

  it("returns a warning to the browser dashboard when credential sync needs retry", async () => {
    const repo = {
      upsertFromTokens: vi.fn().mockResolvedValue({ id: "one", email: "one@example.com" })
    };
    const coordinator = new DashboardOAuthCoordinator(repo as never, vi.fn(), vi.fn().mockResolvedValue(false));
    const prepared = coordinator.prepareSession((key) => key);

    const result = await coordinator.completeSession(
      prepared?.oauthSession?.sessionId,
      "http://localhost/callback?code=ok",
      (key) => key
    );

    expect(result?.notice?.level).toBe("warning");
    expect(result?.notice?.message).toMatch(/run Sync Cross-PC Claims Now/i);
    expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringMatching(/run Sync Cross-PC Claims Now/i)
    );
  });
  it('reauthorizes a legacy token using its selected workspace identity', async () => {
    const idToken = 'head.' + Buffer.from(JSON.stringify({email:'legacy@example.test'})).toString('base64url') + '.sig';
    const id = buildAccountStorageId('legacy@example.test','workspace');
    const repo = {getAccount:vi.fn(async()=>({id,accountId:'workspace'})),updateTokens:vi.fn(async()=>({id})),upsertFromTokens:vi.fn()};
    const coordinator = new DashboardOAuthCoordinator(repo as never,vi.fn());
    const internal = coordinator as unknown as {upsertAuthorizedAccount(tokens:{idToken:string;accessToken:string;accountId:string},expectedId:string):Promise<unknown>};
    await internal.upsertAuthorizedAccount({idToken,accessToken:idToken,accountId:'workspace'},id);
    expect(repo.updateTokens).toHaveBeenCalledWith(id,expect.objectContaining({accountId:'workspace'}));
    expect(repo.upsertFromTokens).not.toHaveBeenCalled();
    coordinator.dispose();
  });

});
