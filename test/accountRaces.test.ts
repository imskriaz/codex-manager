import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountsRepository } from "../src/storage";
import { configureSqliteStateStore, SqliteStateStore } from "../src/storage/sqliteState";
import { configureCrossWindowOperationCoordinator } from "../src/utils/crossWindowOperations";
import { removeTestDirectory } from "./testFilesystem";
import * as usageStorage from "../src/storage/sqliteUsage";
import { applyRemoteProfileToAccount } from "../src/storage/accountMetadata";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), writeAuth: vi.fn(), profile: vi.fn() }));
vi.mock("../src/auth/oauth", async (original) => ({
  ...(await original<typeof import("../src/auth/oauth")>()),
  refreshTokens: mocks.refresh
}));
vi.mock("../src/codex", async (original) => ({
  ...(await original<typeof import("../src/codex")>()),
  writeAuthFile: mocks.writeAuth
}));
vi.mock("../src/services/profile", () => ({ fetchRemoteAccountProfile: mocks.profile }));

let folder: string, store: SqliteStateStore, repo: AccountsRepository, other: AccountsRepository;
let secrets: Map<string, string>;
let beforeStore: ((key: string, value: string) => Promise<void>) | undefined;
const oldHome = process.env.CODEX_HOME;
function tokens(name = "a", version = "old", expired = false) {
  const jwt = `header.${Buffer.from(
    JSON.stringify({
      email: `${name}@example.test`,
      exp: Date.now() / 1000 + (expired ? -60 : 3600),
      "https://api.openai.com/auth": { chatgpt_account_id: name }
    })
  ).toString("base64url")}.sig`;
  return { idToken: jwt, accessToken: `${jwt}-${version}`, refreshToken: `${name}-${version}`, accountId: name };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.profile.mockResolvedValue(undefined);
  mocks.writeAuth.mockResolvedValue(undefined);
  folder = await mkdtemp(join(tmpdir(), "manager-account-races-"));
  process.env.CODEX_HOME = join(folder, "codex");
  store = await SqliteStateStore.open(join(folder, "manager.sqlite"));
  configureSqliteStateStore(store);
  await configureCrossWindowOperationCoordinator(folder);
  secrets = new Map();
  beforeStore = undefined;
  const context = {
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        await beforeStore?.(key, value);
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      }
    }
  };
  repo = new AccountsRepository(context as never, join(folder, "accounts-index.json"));
  other = new AccountsRepository(context as never, join(folder, "accounts-index.json"));
});
afterEach(async () => {
  repo.dispose();
  other.dispose();
  configureSqliteStateStore(undefined);
  store.close();
  if (oldHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = oldHome;
  vi.restoreAllMocks();
  await removeTestDirectory(folder);
});

it("joins renewal across repository instances without holding a switch write lock", async () => {
  const saved = await repo.upsertFromTokens(tokens("a", "old", true));
  const pending = deferred<ReturnType<typeof tokens>>();
  mocks.refresh.mockReturnValue(pending.promise);
  const renewal = repo.refreshAccountTokens(saved.id, { force: true });
  await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  const switched = other.switchAccount(saved.id);
  const fresh = tokens("a", "fresh");
  pending.resolve(fresh);
  await renewal;
  await expect(switched).resolves.toMatchObject({ isActive: true });
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(mocks.writeAuth).toHaveBeenLastCalledWith(fresh);
});

it("does not let a late renewal replace reauthorized credentials", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  const pending = deferred<ReturnType<typeof tokens>>();
  mocks.refresh.mockReturnValue(pending.promise);
  const renewal = repo.refreshAccountTokens(saved.id, { force: true });
  const outcome = expect(renewal).rejects.toThrow("newer credentials were preserved");
  await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  const reauthorized = tokens("a", "reauthorized");
  await other.updateTokens(saved.id, reauthorized);
  pending.resolve(tokens("a", "late"));
  await outcome;
  expect(await repo.getTokens(saved.id, { bypassCache: true })).toEqual(reauthorized);
});

it("keeps the new active account when another account's rotation completes", async () => {
  const a = await repo.upsertFromTokens(tokens());
  const b = await repo.upsertFromTokens(tokens("b"));
  await repo.switchAccount(a.id);
  const pending = deferred<ReturnType<typeof tokens>>();
  mocks.refresh.mockReturnValue(pending.promise);
  const renewal = repo.refreshAccountTokens(a.id, { force: true });
  await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  await other.switchAccount(b.id);
  const writes = mocks.writeAuth.mock.calls.length;
  pending.resolve(tokens("a", "fresh"));
  await renewal;
  expect(mocks.writeAuth).toHaveBeenCalledTimes(writes);
  expect((await repo.listAccounts()).filter((a) => a.isActive).map((a) => a.id)).toEqual([b.id]);
});

it("does not restore active auth after sign-out while renewal is in flight", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  await repo.switchAccount(saved.id);
  const pending = deferred<ReturnType<typeof tokens>>();
  mocks.refresh.mockReturnValue(pending.promise);
  const renewal = repo.refreshAccountTokens(saved.id, { force: true });
  await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  // The auth writer is mocked, so the temporary home has no auth.json after sign-out.
  await other.syncActiveAccountFromAuthFile();
  const writes = mocks.writeAuth.mock.calls.length;
  pending.resolve(tokens("a", "fresh"));
  await renewal;
  expect(mocks.writeAuth).toHaveBeenCalledTimes(writes);
  expect((await repo.listAccounts()).some((account) => account.isActive)).toBe(false);
});

it("merges unrelated account edits made while a credential save is pending", async () => {
  const a = await repo.upsertFromTokens(tokens()),
    b = await repo.upsertFromTokens(tokens("b"));
  const pending = deferred<void>();
  let entered = false;
  beforeStore = async (_key, value) => {
    if (value.includes("a-fresh")) {
      entered = true;
      await pending.promise;
    }
  };
  const save = repo.updateTokens(a.id, tokens("a", "fresh"));
  await vi.waitFor(() => expect(entered).toBe(true));
  await other.setAccountQueuePriority(b.id, true);
  pending.resolve();
  await save;
  expect(await repo.getAccount(b.id)).toMatchObject({ queuePriority: true });
});

it("rejects old quota and profile results after credentials change", async () => {
  const old = tokens(),
    saved = await repo.upsertFromTokens(old);
  const pending = deferred<Record<string, unknown>>();
  mocks.profile.mockReturnValueOnce(pending.promise);
  const profile = repo.refreshAccountProfileMetadata(saved.id);
  const outcome = expect(profile).rejects.toThrow("account changed");
  await vi.waitFor(() => expect(mocks.profile).toHaveBeenCalledTimes(2));
  await other.updateTokens(saved.id, tokens("a", "reauthorized"));
  pending.resolve({ planType: "team" });
  await outcome;
  await expect(
    repo.updateQuota(saved.id, { hourlyPercentage: 99 }, undefined, undefined, undefined, undefined, old)
  ).rejects.toThrow("changed");
  expect((await repo.getAccount(saved.id))?.quotaSummary).toBeUndefined();
});

it("fences stale reset snapshots and deletion until a pending redemption is verified", async () => {
  const saved = await repo.upsertFromTokens(tokens());
  await repo.updateQuota(saved.id, { resetCreditsAvailable: 2 });
  await repo.beginResetCreditAttempt(saved.id, "reset-1", 2);
  const account = (await other.getAccount(saved.id))!;
  await repo.upsertFromTokens(tokens("a", "reauthorized"));
  expect(await other.getAccount(saved.id)).toMatchObject({
    resetCreditAttempt: { requestId: "reset-1" },
    resetCreditsGeneration: account.resetCreditsGeneration
  });
  expect(await other.updateResetCreditsSnapshot(saved.id, 9, undefined, [], Date.now(), 0)).toBe(false);
  expect(await other.updateResetCreditsSnapshot(saved.id, 9, undefined, [], 1, account.resetCreditsGeneration)).toBe(
    false
  );
  await expect(other.removeAccount(saved.id)).rejects.toThrow("pending quota reset");
  expect(
    await repo.updateResetCreditsSnapshot(
      saved.id,
      1,
      undefined,
      ["remaining"],
      Date.now(),
      account.resetCreditsGeneration
    )
  ).toBe(true);
  await repo.completeResetCreditAttempt(saved.id, "reset-1");
  await other.removeAccount(saved.id);
  expect(await repo.getAccount(saved.id)).toBeUndefined();
});

it("discards an old optional profile after a newer explicit profile was committed", () => {
  const account = {
    id: "a",
    email: "a@example.test",
    isActive: false,
    createdAt: 1,
    updatedAt: 1,
    planType: "team",
    profileRequestAt: 200
  };
  expect(
    applyRemoteProfileToAccount({ account, claims: {}, remoteProfile: { planType: "free", requestStartedAt: 100 } })
  ).toBe(false);
  expect(account.planType).toBe("team");
  expect(
    applyRemoteProfileToAccount({ account, claims: {}, remoteProfile: { planType: "plus", requestStartedAt: 300 } })
  ).toBe(true);
  expect(account).toMatchObject({ planType: "plus", profileRequestAt: 300 });
});


it('retains the historical account name when removing credentials and preserves deletion on storage failure', async () => {
  const saved=await repo.upsertFromTokens(tokens());
  usageStorage.upsertDailyUsageRow(store,{accountId:saved.id,fetchedAt:Date.now(),usage:{days:1,points:[]}},'');
  const retain=vi.spyOn(usageStorage,'retainDailyUsageAccountLabel').mockImplementationOnce(()=>{throw new Error('Usage storage full');});
  await expect(repo.removeAccount(saved.id)).rejects.toThrow('Usage storage full');
  expect(await repo.getAccount(saved.id)).toBeDefined();expect(await repo.getTokens(saved.id)).toBeDefined();
  retain.mockRestore();await repo.removeAccount(saved.id);
  expect(await repo.getAccount(saved.id)).toBeUndefined();expect(await repo.getTokens(saved.id,{bypassCache:true})).toBeUndefined();
  expect(usageStorage.readDailyUsageRow(store,saved.id)).toMatchObject({accountId:saved.id,accountLabel:'a@example.test'});
});
